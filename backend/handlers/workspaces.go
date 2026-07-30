package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// WorkspaceHandler serves per-workspace git remote configuration (multi mode).
//
//   - /api/admin/workspaces  (superadmin) — CRUD over shared/team workspaces.
//   - /api/me/workspace      (any user)   — the caller's own personal workspace.
//
// The stored credential (PAT / SSH key) is never returned to a client; responses
// only report has_credential so the UI can show "configured".
type WorkspaceHandler struct {
	store     store.WorkspaceStore
	userStore store.UserStore
	// allowedHosts, when non-empty, restricts remote URLs to these hosts
	// (defence-in-depth against SSRF; the primary control is the writer's
	// egress NetworkPolicy). Empty = any host allowed.
	allowedHosts []string
}

// NewWorkspaceHandler builds a workspace handler. allowedHosts may be nil.
func NewWorkspaceHandler(ws store.WorkspaceStore, us store.UserStore, allowedHosts []string) *WorkspaceHandler {
	lower := make([]string, 0, len(allowedHosts))
	for _, h := range allowedHosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			lower = append(lower, h)
		}
	}
	return &WorkspaceHandler{store: ws, userStore: us, allowedHosts: lower}
}

// namespacePattern bounds admin-supplied namespace names to a safe charset (no
// path separators, no traversal).
var namespacePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type workspaceRequest struct {
	Namespace  string `json:"namespace"` // admin create only
	GitEnabled bool   `json:"git_enabled"`
	Transport  string `json:"transport"`
	RemoteURL  string `json:"remote_url"`
	Username   string `json:"username"`
	Branch     string `json:"branch"`
	KnownHosts string `json:"known_hosts"`
	// Credential is the plaintext PAT (https) or SSH private key. Omit / null to
	// keep the stored credential unchanged on update; send a value to replace it
	// (empty string clears it).
	Credential *string `json:"credential"`
}

// --- admin CRUD: /api/admin/workspaces (superadmin) ------------------------

func (h *WorkspaceHandler) HandleAdmin(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.adminList(w, r)
	case http.MethodPost:
		h.adminCreate(w, r)
	case http.MethodPut:
		h.adminUpdate(w, r)
	case http.MethodDelete:
		h.adminDelete(w, r)
	default:
		wsError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *WorkspaceHandler) adminList(w http.ResponseWriter, _ *http.Request) {
	list, err := h.store.List()
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to list workspaces")
		return
	}
	wsJSON(w, http.StatusOK, list)
}

func (h *WorkspaceHandler) adminCreate(w http.ResponseWriter, r *http.Request) {
	var req workspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		wsError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	ns := strings.TrimSpace(req.Namespace)
	if !namespacePattern.MatchString(ns) {
		wsError(w, http.StatusBadRequest, "invalid namespace (allowed: letters, digits, . _ -)")
		return
	}
	if strings.HasPrefix(ns, "user-") {
		wsError(w, http.StatusBadRequest, "the user- prefix is reserved for personal workspaces")
		return
	}
	if existing, _ := h.store.GetByNamespace(ns); existing != nil {
		wsError(w, http.StatusConflict, "a workspace already exists for this namespace")
		return
	}
	in, err := h.inputFrom(req, req.GitEnabled)
	if err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	in.Namespace = ns
	in.OwnerID = nil // shared/team workspace
	in.IsPersonal = false
	ws, err := h.store.Create(in)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to create workspace")
		return
	}
	wsJSON(w, http.StatusCreated, ws)
}

func (h *WorkspaceHandler) adminUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	existing, err := h.store.Get(id)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if existing == nil {
		wsError(w, http.StatusNotFound, "workspace not found")
		return
	}
	if existing.IsPersonal {
		wsError(w, http.StatusForbidden, "personal workspaces are managed by their owner via /api/me/workspace")
		return
	}
	var req workspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		wsError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	in, err := h.inputFrom(req, req.GitEnabled)
	if err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	ws, err := h.store.Update(id, in)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to update workspace")
		return
	}
	wsJSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) adminDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	existing, _ := h.store.Get(id)
	if existing != nil && existing.IsPersonal {
		wsError(w, http.StatusForbidden, "personal workspaces are managed by their owner")
		return
	}
	deleted, err := h.store.Delete(id)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to delete workspace")
		return
	}
	if !deleted {
		wsError(w, http.StatusNotFound, "workspace not found")
		return
	}
	wsJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// --- personal workspace: /api/me/workspace (any authenticated user) --------

func (h *WorkspaceHandler) HandleMine(w http.ResponseWriter, r *http.Request) {
	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		wsError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.mineGet(w, uc.ID)
	case http.MethodPut:
		h.minePut(w, r, uc.ID)
	case http.MethodDelete:
		h.mineDelete(w, uc.ID)
	default:
		wsError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *WorkspaceHandler) mineGet(w http.ResponseWriter, userID int) {
	ws, err := h.store.GetPersonalByOwner(userID)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if ws == nil {
		// A user with no personal workspace yet gets the derived namespace so
		// the UI can show where their notes would live once they attach a remote.
		wsJSON(w, http.StatusOK, map[string]any{
			"namespace":      store.PersonalNamespace(userID),
			"is_personal":    true,
			"git_enabled":    false,
			"has_credential": false,
			"configured":     false,
		})
		return
	}
	wsJSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) minePut(w http.ResponseWriter, r *http.Request, userID int) {
	var req workspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		wsError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	in, err := h.inputFrom(req, req.GitEnabled)
	if err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	// A personal workspace is always owned by the caller and named from their
	// id — never taken from the request, so a user can't target another
	// namespace.
	in.Namespace = store.PersonalNamespace(userID)
	in.OwnerID = &userID
	in.IsPersonal = true

	existing, err := h.store.GetPersonalByOwner(userID)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	var ws *store.Workspace
	if existing == nil {
		ws, err = h.store.Create(in)
	} else {
		ws, err = h.store.Update(existing.ID, in)
	}
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to save workspace")
		return
	}
	wsJSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) mineDelete(w http.ResponseWriter, userID int) {
	existing, err := h.store.GetPersonalByOwner(userID)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if existing == nil {
		wsError(w, http.StatusNotFound, "no personal workspace")
		return
	}
	if _, err := h.store.Delete(existing.ID); err != nil {
		wsError(w, http.StatusInternalServerError, "failed to delete workspace")
		return
	}
	wsJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// --- shared helpers --------------------------------------------------------

// inputFrom builds a store.WorkspaceInput from a request, normalising the
// transport and validating the remote when git is enabled.
func (h *WorkspaceHandler) inputFrom(req workspaceRequest, gitEnabled bool) (store.WorkspaceInput, error) {
	transport := strings.ToLower(strings.TrimSpace(req.Transport))
	if transport != "ssh" {
		transport = "https"
	}
	remoteURL := strings.TrimSpace(req.RemoteURL)
	if gitEnabled {
		if err := h.validateRemote(transport, remoteURL); err != nil {
			return store.WorkspaceInput{}, err
		}
	}
	return store.WorkspaceInput{
		GitEnabled: gitEnabled,
		Transport:  transport,
		RemoteURL:  remoteURL,
		Username:   strings.TrimSpace(req.Username),
		Branch:     strings.TrimSpace(req.Branch),
		KnownHosts: req.KnownHosts,
		Credential: req.Credential,
	}, nil
}

// validateRemote checks the URL shape per transport and enforces the optional
// host allow-list.
func (h *WorkspaceHandler) validateRemote(transport, remoteURL string) error {
	if remoteURL == "" {
		return errors.New("remote_url is required when git is enabled")
	}
	var host string
	if transport == "ssh" {
		if strings.HasPrefix(remoteURL, "ssh://") {
			u, err := url.Parse(remoteURL)
			if err != nil {
				return fmt.Errorf("invalid ssh url: %w", err)
			}
			host = u.Hostname()
		} else {
			// scp-like: user@host:path
			at := strings.Index(remoteURL, "@")
			colon := strings.Index(remoteURL, ":")
			if at <= 0 || colon <= at {
				return errors.New("invalid ssh remote (want user@host:path or ssh://…)")
			}
			host = remoteURL[at+1 : colon]
		}
	} else {
		u, err := url.Parse(remoteURL)
		if err != nil {
			return fmt.Errorf("invalid url: %w", err)
		}
		if u.Scheme != "https" {
			return errors.New("https transport requires an https:// url")
		}
		host = u.Hostname()
	}
	if host == "" {
		return errors.New("remote_url has no host")
	}
	if len(h.allowedHosts) > 0 && !slices.Contains(h.allowedHosts, strings.ToLower(host)) {
		return fmt.Errorf("git host %q is not allowed", host)
	}
	return nil
}

// workspaceID reads and validates the ?id= query parameter.
func workspaceID(w http.ResponseWriter, r *http.Request) (int, bool) {
	id, err := strconv.Atoi(r.URL.Query().Get("id"))
	if err != nil || id <= 0 {
		wsError(w, http.StatusBadRequest, "missing or invalid id")
		return 0, false
	}
	return id, true
}

func wsError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func wsJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
