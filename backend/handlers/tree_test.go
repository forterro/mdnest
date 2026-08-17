package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// treeGroupStore is a store.GroupStore whose only meaningful behaviour is
// MemberGroupGrants: it hands back the grants a user inherits from their groups.
type treeGroupStore struct {
	// grants maps userID -> namespace -> the group grants the user inherits.
	grants map[int]map[string][]store.GroupGrant
}

func (treeGroupStore) CreateGroup(string, string) (*store.AccessGroup, error) { return nil, nil }
func (treeGroupStore) UpdateGroup(int, string, string) error                  { return nil }
func (treeGroupStore) DeleteGroup(int) error                                  { return nil }
func (treeGroupStore) GetGroup(int) (*store.AccessGroup, error)               { return nil, nil }
func (treeGroupStore) ListGroups() ([]store.AccessGroup, error)               { return nil, nil }
func (treeGroupStore) AddUserMember(int, int) error                           { return nil }
func (treeGroupStore) AddOIDCMember(int, string, string) error                { return nil }
func (treeGroupStore) RemoveUserMember(int, int) error                        { return nil }
func (treeGroupStore) RemoveOIDCMember(int, string) error                     { return nil }
func (treeGroupStore) ListMembers(int) ([]store.GroupMember, error)           { return nil, nil }
func (treeGroupStore) CreateGroupGrant(int, string, string, string, *int) (*store.GroupGrant, error) {
	return nil, nil
}
func (treeGroupStore) UpdateGroupGrantPermission(int, string) error        { return nil }
func (treeGroupStore) DeleteGroupGrant(int) error                          { return nil }
func (treeGroupStore) ListGrantsForGroup(int) ([]store.GroupGrant, error)  { return nil, nil }
func (treeGroupStore) DeleteGroupGrantsForNamespace(string) (int64, error) { return 0, nil }
func (treeGroupStore) CheckGroupAccess(int, []string, string, string, string) bool {
	return false
}
func (s treeGroupStore) GetAccessibleNamespacesForGroups(userID int, _ []string) ([]string, error) {
	var out []string
	for ns := range s.grants[userID] {
		out = append(out, ns)
	}
	return out, nil
}
func (s treeGroupStore) MemberGroupGrants(userID int, _ []string, namespace string) ([]store.GroupGrant, error) {
	return s.grants[userID][namespace], nil
}

// notesDirWithTree builds <tmp>/team/{readme.md,docs/guide.md} on disk.
func notesDirWithTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	docs := filepath.Join(root, "team", "docs")
	if err := os.MkdirAll(docs, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", docs, err)
	}
	if err := os.WriteFile(filepath.Join(root, "team", "readme.md"), []byte("# readme"), 0o644); err != nil {
		t.Fatalf("write readme: %v", err)
	}
	if err := os.WriteFile(filepath.Join(docs, "guide.md"), []byte("# guide"), 0o644); err != nil {
		t.Fatalf("write guide: %v", err)
	}
	return root
}

// countLeaves returns the number of file (non-folder) nodes in the tree.
func countLeaves(n *TreeNode) int {
	if n.Type != "folder" {
		return 1
	}
	total := 0
	for _, c := range n.Children {
		total += countLeaves(c)
	}
	return total
}

func serveTree(h *TreeHandler, uc *middleware.UserContext, ns string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/api/tree?ns="+ns, nil)
	if uc != nil {
		r = middleware.WithUser(r, uc)
	}
	w := httptest.NewRecorder()
	h.GetTree(w, r)
	return w
}

// A user who can reach a namespace only through an access group must see its
// notes, not just the namespace. Before the fix the tree was filtered against
// the user's direct grants alone, so a group-only member got an empty tree —
// they saw the namespace in the list but none of the notes inside it.
func TestGetTreeIncludesGroupInheritedNotes(t *testing.T) {
	notesDir := notesDirWithTree(t)
	stg := localStore(t, notesDir)
	grantStore := &fakeGrantStore{userID: 0, namespace: ""} // no direct grants
	groupStore := treeGroupStore{grants: map[int]map[string][]store.GroupGrant{
		7: {"team": {{Namespace: "team", Path: "/", Permission: "read"}}},
	}}
	h := NewTreeHandler(stg, grantStore, groupStore)

	member := &middleware.UserContext{ID: 7, Username: "carol", Role: "collaborator"}

	w := serveTree(h, member, "team")
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var root TreeNode
	if err := json.Unmarshal(w.Body.Bytes(), &root); err != nil {
		t.Fatalf("decode tree: %v", err)
	}
	if got := countLeaves(&root); got != 2 {
		t.Fatalf("group-only member should see all 2 notes, got %d: %s", got, w.Body.String())
	}
}

// A collaborator with neither a direct grant nor a group grant still sees an
// empty tree — the group fallback must not hand out access it wasn't given.
func TestGetTreeHidesNotesWithoutAnyGrant(t *testing.T) {
	notesDir := notesDirWithTree(t)
	stg := localStore(t, notesDir)
	grantStore := &fakeGrantStore{userID: 0, namespace: ""}
	groupStore := treeGroupStore{grants: map[int]map[string][]store.GroupGrant{}}
	h := NewTreeHandler(stg, grantStore, groupStore)

	stranger := &middleware.UserContext{ID: 9, Username: "dave", Role: "collaborator"}

	w := serveTree(h, stranger, "team")
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var root TreeNode
	if err := json.Unmarshal(w.Body.Bytes(), &root); err != nil {
		t.Fatalf("decode tree: %v", err)
	}
	if got := countLeaves(&root); got != 0 {
		t.Fatalf("ungranted member should see no notes, got %d: %s", got, w.Body.String())
	}
}

// notesDirWithFrontmatter builds one markdown file carrying a full
// frontmatter block and one plain markdown file without.
func notesDirWithFrontmatter(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	ns := filepath.Join(root, "alpha")
	if err := os.MkdirAll(ns, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", ns, err)
	}
	withFm := "---\ntitle: My Note\nicon: md:cog\ntype: basic\ntags:\n  - infra\n---\n\n# Body\n"
	if err := os.WriteFile(filepath.Join(ns, "with-frontmatter.md"), []byte(withFm), 0o644); err != nil {
		t.Fatalf("write with-frontmatter.md: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ns, "plain.md"), []byte("# Just a note\n"), 0o644); err != nil {
		t.Fatalf("write plain.md: %v", err)
	}
	return root
}

func findChild(node *TreeNode, name string) *TreeNode {
	for _, c := range node.Children {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestBuildTreePopulatesFrontmatter(t *testing.T) {
	root := notesDirWithFrontmatter(t)
	stg := localStore(t, root)
	h := NewTreeHandler(stg, nil, nil)
	ctx := context.Background()

	tree, err := h.buildTree(ctx, "alpha", "", "")
	if err != nil {
		t.Fatalf("buildTree: %v", err)
	}

	withFm := findChild(tree, "with-frontmatter.md")
	if withFm == nil || withFm.Frontmatter == nil {
		t.Fatalf("expected frontmatter on with-frontmatter.md, got %+v", withFm)
	}
	if withFm.Frontmatter.Title != "My Note" || withFm.Frontmatter.Icon != "md:cog" {
		t.Errorf("unexpected frontmatter: %+v", withFm.Frontmatter)
	}

	plain := findChild(tree, "plain.md")
	if plain == nil {
		t.Fatalf("plain.md not found in tree")
	}
	if plain.Frontmatter != nil {
		t.Errorf("expected nil frontmatter on plain.md, got %+v", plain.Frontmatter)
	}
}

// The frontmatter cache must not serve stale data forever — InvalidateCache
// (wired in main.go alongside the search cache) is what keeps it correct
// after a note is edited.
func TestBuildTreeFrontmatterCacheInvalidation(t *testing.T) {
	root := notesDirWithFrontmatter(t)
	stg := localStore(t, root)
	h := NewTreeHandler(stg, nil, nil)
	ctx := context.Background()

	tree, err := h.buildTree(ctx, "alpha", "", "")
	if err != nil {
		t.Fatalf("buildTree: %v", err)
	}
	if got := findChild(tree, "with-frontmatter.md").Frontmatter.Title; got != "My Note" {
		t.Fatalf("expected initial title 'My Note', got %q", got)
	}

	notePath := filepath.Join(root, "alpha", "with-frontmatter.md")
	if err := os.WriteFile(notePath, []byte("---\ntitle: Renamed\n---\nbody"), 0o644); err != nil {
		t.Fatalf("rewrite file: %v", err)
	}
	tree, _ = h.buildTree(ctx, "alpha", "", "")
	if got := findChild(tree, "with-frontmatter.md").Frontmatter.Title; got != "My Note" {
		t.Fatalf("expected stale cached title 'My Note' before invalidation, got %q", got)
	}

	h.InvalidateCache("alpha")
	tree, _ = h.buildTree(ctx, "alpha", "", "")
	if got := findChild(tree, "with-frontmatter.md").Frontmatter.Title; got != "Renamed" {
		t.Fatalf("expected fresh title 'Renamed' after invalidation, got %q", got)
	}
}
