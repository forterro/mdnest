package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// NamespaceHandler lists and creates namespaces via the storage backend.
type NamespaceHandler struct {
	store storage.Storage
	perms *middleware.PermissionChecker // nil in single mode
}

// NewNamespaceHandler creates a new namespace handler.
func NewNamespaceHandler(store storage.Storage, perms *middleware.PermissionChecker) *NamespaceHandler {
	return &NamespaceHandler{store: store, perms: perms}
}

// Handle routes GET (list) and POST (create) on /api/namespaces.
func (h *NamespaceHandler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.ListNamespaces(w, r)
	case http.MethodPost:
		h.CreateNamespace(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// ListNamespaces handles GET /api/namespaces.
func (h *NamespaceHandler) ListNamespaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	names, err := h.store.ListNamespaces(r.Context())
	if err != nil {
		http.Error(w, `{"error":"failed to read namespaces"}`, http.StatusInternalServerError)
		return
	}

	// In multi mode, filter to namespaces the user has access to
	if h.perms != nil {
		names = h.perms.FilterNamespaces(r, names)
		if names == nil {
			names = []string{}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(names)
}

// CreateNamespace handles POST /api/namespaces. The name is taken from the
// "name" query parameter or a JSON body {"name":"..."}. In multi mode only
// superadmins may create namespaces; in single mode the sole operator is
// already fully trusted.
func (h *NamespaceHandler) CreateNamespace(w http.ResponseWriter, r *http.Request) {
	if h.perms != nil {
		uc := middleware.UserFromContext(r.Context())
		if uc == nil || uc.Role != "superadmin" {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
	}

	name := r.URL.Query().Get("name")
	if name == "" {
		var req struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		name = req.Name
	}
	if !ValidNamespaceName(name) {
		http.Error(w, `{"error":"invalid namespace name"}`, http.StatusBadRequest)
		return
	}

	if err := h.store.CreateNamespace(r.Context(), name); err != nil {
		if errors.Is(err, storage.ErrExist) {
			http.Error(w, `{"error":"namespace already exists"}`, http.StatusConflict)
			return
		}
		http.Error(w, `{"error":"failed to create namespace"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "created", "namespace": name})
}
