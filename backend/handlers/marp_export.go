package handlers

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/mdnest/mdnest/backend/storage"
)

// maxExportBytes caps the deck markdown accepted for a single export. Decks are
// text; anything larger is almost certainly abuse.
const maxExportBytes = 5 * 1024 * 1024

// exportRunTimeout bounds a single marp-cli invocation.
const exportRunTimeout = 30 * time.Second

var exportNameRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// MarpExportHandler renders a deck to a real, standalone Marp presentation by
// shelling out to the marp CLI (bespoke template — arrow/touch navigation,
// fullscreen, presenter view, progress). The output is the exact HTML marp-cli
// produces, not a hand-rolled approximation.
type MarpExportHandler struct {
	store   storage.Storage
	marpBin string
}

// NewMarpExportHandler builds the handler. The marp binary is resolved from
// MARP_BIN (default "marp", expected on PATH in the runtime image).
func NewMarpExportHandler(store storage.Storage) *MarpExportHandler {
	bin := os.Getenv("MARP_BIN")
	if bin == "" {
		bin = "marp"
	}
	return &MarpExportHandler{store: store, marpBin: bin}
}

type marpExportRequest struct {
	Content  string `json:"content"`
	Filename string `json:"filename"`
}

// HandleHTML serves POST /api/marp/export: body {content, filename}, returns the
// rendered standalone HTML as a download.
func (h *MarpExportHandler) HandleHTML(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, maxExportBytes))
	if err != nil {
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}
	var req marpExportRequest
	if err := json.Unmarshal(raw, &req); err != nil || strings.TrimSpace(req.Content) == "" {
		http.Error(w, `{"error":"content is required"}`, http.StatusBadRequest)
		return
	}

	dir, err := os.MkdirTemp("", "marp-export-*")
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(dir)

	deckPath := filepath.Join(dir, "deck.md")
	if err := os.WriteFile(deckPath, []byte(req.Content), 0o600); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	outPath := filepath.Join(dir, "deck.html")

	// --html enables the raw HTML the centralized themes rely on (cards, grids,
	// etc.). We deliberately do NOT pass --allow-local-files: without it marp-cli
	// cannot read arbitrary server files referenced by a crafted deck, and HTML
	// output never launches a browser or fetches remote URLs server-side.
	args := []string{"--html"}
	if themesDir, ok := h.writeThemes(r.Context(), dir); ok {
		args = append(args, "--theme-set", themesDir)
	}
	args = append(args, "-o", outPath, deckPath)

	ctx, cancel := context.WithTimeout(r.Context(), exportRunTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, h.marpBin, args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("marp export: %s failed: %v: %s", h.marpBin, err, strings.TrimSpace(string(out)))
		http.Error(w, `{"error":"failed to render deck"}`, http.StatusInternalServerError)
		return
	}

	html, err := os.ReadFile(outPath)
	if err != nil {
		http.Error(w, `{"error":"render produced no output"}`, http.StatusInternalServerError)
		return
	}

	name := exportBaseName(req.Filename)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.html"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(html)
}

// writeThemes materializes the centralized theme catalog into <dir>/themes so
// marp-cli can resolve `theme: <name>`. Best-effort: ok=false (and no error)
// when the reserved namespace is absent or empty — the built-in Marp themes
// (default/gaia/uncover) still work.
func (h *MarpExportHandler) writeThemes(ctx context.Context, dir string) (string, bool) {
	entries, err := h.store.ReadDir(ctx, storage.SystemNamespaceMarpThemes, "")
	if err != nil {
		return "", false
	}
	themesDir := filepath.Join(dir, "themes")
	wrote := false
	for _, e := range entries {
		if e.IsDir || !strings.HasSuffix(e.Name, ".css") {
			continue
		}
		data, rerr := h.store.ReadFile(ctx, storage.SystemNamespaceMarpThemes, e.Name)
		if rerr != nil {
			continue
		}
		if !wrote {
			if err := os.MkdirAll(themesDir, 0o700); err != nil {
				return "", false
			}
		}
		if err := os.WriteFile(filepath.Join(themesDir, e.Name), data, 0o600); err == nil {
			wrote = true
		}
	}
	return themesDir, wrote
}

// exportBaseName sanitizes a user-supplied filename into a safe download stem.
func exportBaseName(name string) string {
	b := name
	if i := strings.LastIndexAny(b, `/\`); i >= 0 {
		b = b[i+1:]
	}
	b = strings.TrimSuffix(b, ".md")
	b = exportNameRe.ReplaceAllString(b, "-")
	b = strings.Trim(b, "-.")
	if b == "" {
		b = "deck"
	}
	if len(b) > 80 {
		b = b[:80]
	}
	return b
}
