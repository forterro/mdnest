package handlers

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/mdnest/mdnest/backend/storage"
)

// TaskHandler aggregates GitHub-flavoured task-list items ("- [ ] ...") across
// every note in a namespace and exposes them as a flat list (for a task view)
// or grouped into board columns (for a kanban view). The markdown notes remain
// the single source of truth: a task's column is derived from its checkbox
// state and an optional status tag on the same line (e.g. "#doing"). Moving a
// card between columns rewrites that line in the owning note, so the two views
// are just projections of the same data.
//
// Column definitions live in a per-namespace sidecar (.mdnest/board.json),
// mirroring the .mdnest/comments convention. When the sidecar is absent a
// default To Do / Doing / Done board is used.
type TaskHandler struct {
	store storage.Storage
}

// NewTaskHandler creates a task/board handler backed by the given storage.
func NewTaskHandler(store storage.Storage) *TaskHandler {
	return &TaskHandler{store: store}
}

// BoardColumn is a single kanban column. Tag is the status marker matched on a
// task line (e.g. "doing" matches "#doing"). Done marks the column that holds
// checked items ("- [x] ...").
type BoardColumn struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Tag   string `json:"tag"`
	Done  bool   `json:"done,omitempty"`
}

// BoardConfig is the per-namespace column layout stored in .mdnest/board.json.
type BoardConfig struct {
	Version int           `json:"version"`
	Columns []BoardColumn `json:"columns"`
}

// Task is one aggregated task-list item.
type Task struct {
	ID      string `json:"id"`      // content-stable id (namespace-relative path + text)
	Path    string `json:"path"`    // note that owns the item
	Line    int    `json:"line"`    // 1-based line number within the note
	Raw     string `json:"raw"`     // exact source line, used for optimistic mutation
	Text    string `json:"text"`    // item text without checkbox or status tag
	Checked bool   `json:"checked"` // "- [x]" vs "- [ ]"
	Column  string `json:"column"`  // resolved column id
}

// TasksResponse is the payload of GET /api/tasks.
type TasksResponse struct {
	Board BoardConfig `json:"board"`
	Tasks []Task      `json:"tasks"`
}

// taskMutation is the body of PATCH /api/tasks. Exactly one of ToColumn or
// Checked must be set. Path is taken from the query string (for per-file
// authorization); Line + Raw pin the exact source line optimistically.
type taskMutation struct {
	Line     int    `json:"line"`
	Raw      string `json:"raw"`
	ToColumn string `json:"toColumn,omitempty"`
	Checked  *bool  `json:"checked,omitempty"`
}

// taskLineRe matches a GFM task-list item: indent, bullet, checkbox, rest.
var taskLineRe = regexp.MustCompile(`^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$`)

func defaultBoard() BoardConfig {
	return BoardConfig{
		Version: 1,
		Columns: []BoardColumn{
			{ID: "todo", Title: "To Do", Tag: "todo"},
			{ID: "doing", Title: "Doing", Tag: "doing"},
			{ID: "done", Title: "Done", Tag: "done", Done: true},
		},
	}
}

func (h *TaskHandler) boardFile() string {
	return path.Join(".mdnest", "board.json")
}

func (h *TaskHandler) loadBoard(ctx context.Context, ns string) BoardConfig {
	data, err := h.store.ReadFile(ctx, ns, h.boardFile())
	if err != nil {
		return defaultBoard()
	}
	var b BoardConfig
	if json.Unmarshal(data, &b) != nil || len(b.Columns) == 0 {
		return defaultBoard()
	}
	return b
}

func (h *TaskHandler) saveBoard(ctx context.Context, ns string, b BoardConfig) error {
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	return h.store.WriteFile(ctx, ns, h.boardFile(), append(data, '\n'))
}

// parseTaskLine reports whether line is a task-list item and returns its
// checkbox state and the text following the checkbox.
func parseTaskLine(line string) (checked bool, rest string, ok bool) {
	m := taskLineRe.FindStringSubmatch(line)
	if m == nil {
		return false, "", false
	}
	return m[3] == "x" || m[3] == "X", m[4], true
}

// hasStatusTag reports whether rest carries the "#tag" status marker as a
// standalone token (so it will not match arbitrary "#hashtags" in prose).
func hasStatusTag(rest, tag string) bool {
	if tag == "" {
		return false
	}
	re := regexp.MustCompile(`(?i)(^|\s)#` + regexp.QuoteMeta(tag) + `(\s|$)`)
	return re.MatchString(rest)
}

// stripStatusTags removes every "#tag" token whose tag matches a board column,
// leaving unrelated hashtags untouched.
func stripStatusTags(b BoardConfig, rest string) string {
	out := rest
	for _, c := range b.Columns {
		if c.Tag == "" {
			continue
		}
		re := regexp.MustCompile(`(?i)\s*#` + regexp.QuoteMeta(c.Tag) + `(\s|$)`)
		out = re.ReplaceAllString(out, "$1")
	}
	return strings.TrimSpace(out)
}

// resolveColumn maps a task's checkbox + status tag to a board column id.
func resolveColumn(b BoardConfig, checked bool, rest string) string {
	if checked {
		for _, c := range b.Columns {
			if c.Done {
				return c.ID
			}
		}
		if n := len(b.Columns); n > 0 {
			return b.Columns[n-1].ID
		}
		return ""
	}
	for _, c := range b.Columns {
		if hasStatusTag(rest, c.Tag) {
			return c.ID
		}
	}
	for _, c := range b.Columns {
		if !c.Done {
			return c.ID
		}
	}
	if len(b.Columns) > 0 {
		return b.Columns[0].ID
	}
	return ""
}

func taskID(relPath, text string) string {
	sum := sha1.Sum([]byte(relPath + "\x00" + text))
	return hex.EncodeToString(sum[:])[:12]
}

// applyColumn rewrites a task line so it belongs to the target column: checking
// the box for a "done" column, otherwise unchecking it and setting the column's
// status tag. It returns the rewritten line, or ok=false if line is not a task
// or the column is unknown.
func applyColumn(b BoardConfig, line, toColumnID string) (string, bool) {
	m := taskLineRe.FindStringSubmatch(line)
	if m == nil {
		return line, false
	}
	var target *BoardColumn
	for i := range b.Columns {
		if b.Columns[i].ID == toColumnID {
			target = &b.Columns[i]
			break
		}
	}
	if target == nil {
		return line, false
	}
	indent, bullet, rest := m[1], m[2], m[4]
	stripped := stripStatusTags(b, rest)
	box := " "
	if target.Done {
		box = "x"
	} else if target.Tag != "" {
		if stripped != "" {
			stripped += " "
		}
		stripped += "#" + target.Tag
	}
	return indent + bullet + " [" + box + "] " + stripped, true
}

// setChecked flips the checkbox on a task line.
func setChecked(line string, checked bool) (string, bool) {
	m := taskLineRe.FindStringSubmatch(line)
	if m == nil {
		return line, false
	}
	box := " "
	if checked {
		box = "x"
	}
	return m[1] + m[2] + " [" + box + "] " + m[4], true
}

// HandleTasks serves GET (aggregate) and PATCH (mutate a single task).
func (h *TaskHandler) HandleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.aggregate(w, r)
	case http.MethodPatch:
		h.mutate(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *TaskHandler) aggregate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	board := h.loadBoard(ctx, ns)

	var files []string
	h.store.Walk(ctx, ns, "", func(relPath string, info storage.FileInfo) error {
		if info.IsDir {
			if relPath != "" && strings.HasPrefix(info.Name, ".") {
				return storage.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(strings.ToLower(info.Name), ".md") {
			files = append(files, relPath)
		}
		return nil
	})

	var (
		mu    sync.Mutex
		tasks []Task
		wg    sync.WaitGroup
		sem   = make(chan struct{}, 8)
	)
	for _, f := range files {
		wg.Add(1)
		sem <- struct{}{}
		go func(fp string) {
			defer wg.Done()
			defer func() { <-sem }()

			data, err := h.store.ReadFile(ctx, ns, fp)
			if err != nil {
				return
			}
			var local []Task
			for i, line := range strings.Split(string(data), "\n") {
				checked, rest, ok := parseTaskLine(line)
				if !ok {
					continue
				}
				text := stripStatusTags(board, rest)
				local = append(local, Task{
					ID:      taskID(fp, text),
					Path:    fp,
					Line:    i + 1,
					Raw:     line,
					Text:    strings.TrimSpace(text),
					Checked: checked,
					Column:  resolveColumn(board, checked, rest),
				})
			}
			if len(local) > 0 {
				mu.Lock()
				tasks = append(tasks, local...)
				mu.Unlock()
			}
		}(f)
	}
	wg.Wait()

	sort.SliceStable(tasks, func(i, j int) bool {
		if tasks[i].Path != tasks[j].Path {
			return tasks[i].Path < tasks[j].Path
		}
		return tasks[i].Line < tasks[j].Line
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(TasksResponse{Board: board, Tasks: tasks})
}

func (h *TaskHandler) mutate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	relPath, ok := SafeRelPath(r.URL.Query().Get("path"))
	if !ok {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	var mut taskMutation
	if err := json.NewDecoder(r.Body).Decode(&mut); err != nil {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}
	if mut.ToColumn == "" && mut.Checked == nil {
		http.Error(w, `{"error":"toColumn or checked is required"}`, http.StatusBadRequest)
		return
	}

	data, err := h.store.ReadFile(ctx, ns, relPath)
	if err != nil {
		http.Error(w, `{"error":"note not found"}`, http.StatusNotFound)
		return
	}
	lines := strings.Split(string(data), "\n")
	if mut.Line < 1 || mut.Line > len(lines) || lines[mut.Line-1] != mut.Raw {
		// The note changed under us; the client must refetch.
		http.Error(w, `{"error":"task line is stale; refresh"}`, http.StatusConflict)
		return
	}

	board := h.loadBoard(ctx, ns)
	var newLine string
	if mut.ToColumn != "" {
		newLine, ok = applyColumn(board, lines[mut.Line-1], mut.ToColumn)
		if !ok {
			http.Error(w, `{"error":"unknown column or not a task"}`, http.StatusBadRequest)
			return
		}
	} else {
		newLine, ok = setChecked(lines[mut.Line-1], *mut.Checked)
		if !ok {
			http.Error(w, `{"error":"not a task"}`, http.StatusBadRequest)
			return
		}
	}
	lines[mut.Line-1] = newLine
	if err := h.store.WriteFile(ctx, ns, relPath, []byte(strings.Join(lines, "\n"))); err != nil {
		http.Error(w, `{"error":"failed to write note"}`, http.StatusInternalServerError)
		return
	}

	checked, rest, _ := parseTaskLine(newLine)
	text := stripStatusTags(board, rest)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Task{
		ID:      taskID(relPath, text),
		Path:    relPath,
		Line:    mut.Line,
		Raw:     newLine,
		Text:    strings.TrimSpace(text),
		Checked: checked,
		Column:  resolveColumn(board, checked, rest),
	})
}

// HandleBoard serves GET (column layout) and PUT (replace column layout).
func (h *TaskHandler) HandleBoard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(h.loadBoard(ctx, ns))
	case http.MethodPut:
		var b BoardConfig
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
			return
		}
		if !validBoard(b) {
			http.Error(w, `{"error":"board must have columns with unique non-empty ids"}`, http.StatusBadRequest)
			return
		}
		if b.Version == 0 {
			b.Version = 1
		}
		if err := h.saveBoard(ctx, ns, b); err != nil {
			http.Error(w, `{"error":"failed to save board"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(b)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func validBoard(b BoardConfig) bool {
	if len(b.Columns) == 0 {
		return false
	}
	seen := make(map[string]bool, len(b.Columns))
	for _, c := range b.Columns {
		if c.ID == "" || c.Title == "" || seen[c.ID] {
			return false
		}
		seen[c.ID] = true
	}
	return true
}
