package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
)

// NamespaceHandler lists available namespaces (top-level dirs in NOTES_DIR).
type NamespaceHandler struct {
	notesDir string
	perms    *middleware.PermissionChecker // nil in single mode
}

// NewNamespaceHandler creates a new namespace handler.
func NewNamespaceHandler(notesDir string, perms *middleware.PermissionChecker) *NamespaceHandler {
	return &NamespaceHandler{notesDir: notesDir, perms: perms}
}

// ListNamespaces handles GET /api/namespaces.
func (h *NamespaceHandler) ListNamespaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	entries, err := os.ReadDir(h.notesDir)
	if err != nil {
		http.Error(w, `{"error":"failed to read notes directory"}`, http.StatusInternalServerError)
		return
	}

	names := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	// In multi mode, filter to namespaces the user has access to. The
	// management plane (?scope=manage) instead lists the namespaces the
	// caller may administer — a superadmin manages every namespace but no
	// longer has implicit data access, so the admin UI needs this wider list.
	if h.perms != nil {
		if r.URL.Query().Get("scope") == "manage" {
			names = h.perms.FilterManageableNamespaces(r, names)
		} else {
			names = h.perms.FilterNamespaces(r, names)
		}
		if names == nil {
			names = []string{}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(names)
}
