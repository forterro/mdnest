package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// fakeWSStore is an in-memory store.WorkspaceStore recording the last write.
type fakeWSStore struct {
	personal   map[int]*store.Workspace
	byNS       map[string]*store.Workspace
	lastCreate store.WorkspaceInput
	created    bool
}

func (f *fakeWSStore) List() ([]store.Workspace, error)  { return nil, nil }
func (f *fakeWSStore) Get(int) (*store.Workspace, error) { return nil, nil }
func (f *fakeWSStore) GetByNamespace(ns string) (*store.Workspace, error) {
	return f.byNS[ns], nil
}
func (f *fakeWSStore) GetPersonalByOwner(id int) (*store.Workspace, error) {
	return f.personal[id], nil
}
func (f *fakeWSStore) Create(in store.WorkspaceInput) (*store.Workspace, error) {
	f.lastCreate = in
	f.created = true
	owner := in.OwnerID
	return &store.Workspace{Namespace: in.Namespace, OwnerID: owner, IsPersonal: in.IsPersonal, GitEnabled: in.GitEnabled}, nil
}
func (f *fakeWSStore) Update(_ int, in store.WorkspaceInput) (*store.Workspace, error) {
	f.lastCreate = in
	return &store.Workspace{Namespace: in.Namespace, IsPersonal: in.IsPersonal}, nil
}
func (f *fakeWSStore) Delete(int) (bool, error) { return true, nil }
func (f *fakeWSStore) RemoteForNamespace(string) (*store.WorkspaceRemote, error) {
	return nil, nil
}

func mineReq(userID int, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPut, "/api/me/workspace", strings.NewReader(body))
	return middleware.WithUser(r, &middleware.UserContext{ID: userID, Username: "u", Role: "collaborator"})
}

// A personal-workspace PUT ignores a client-supplied namespace and always
// stores the caller's derived namespace, owned by the caller, is_personal.
func TestMinePutForcesOwnerAndDerivedNamespace(t *testing.T) {
	fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, nil, nil)

	body := `{"namespace":"someone-elses","git_enabled":true,"transport":"https","remote_url":"https://gitlab.com/me/notes.git","credential":"glpat-x"}`
	w := httptest.NewRecorder()
	h.HandleMine(w, mineReq(7, body))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if !fs.created {
		t.Fatal("expected a create")
	}
	if fs.lastCreate.Namespace != "user-7" {
		t.Fatalf("namespace = %q, want user-7 (client value must be ignored)", fs.lastCreate.Namespace)
	}
	if !fs.lastCreate.IsPersonal || fs.lastCreate.OwnerID == nil || *fs.lastCreate.OwnerID != 7 {
		t.Fatalf("owner/personal not enforced: %+v", fs.lastCreate)
	}
}

// git_enabled with a bad remote is rejected before any store write.
func TestMinePutRejectsBadRemote(t *testing.T) {
	fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, nil, nil)
	body := `{"git_enabled":true,"transport":"https","remote_url":"http://insecure.example/x.git"}`
	w := httptest.NewRecorder()
	h.HandleMine(w, mineReq(7, body))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if fs.created {
		t.Fatal("stored a workspace despite an invalid remote")
	}
}

func TestAdminCreateRejectsReservedPrefix(t *testing.T) {
	fs := &fakeWSStore{byNS: map[string]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, nil, nil)
	body := `{"namespace":"user-1","git_enabled":false}`
	r := httptest.NewRequest(http.MethodPost, "/api/admin/workspaces", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleAdmin(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for reserved user- prefix", w.Code)
	}
}

func TestValidateRemote(t *testing.T) {
	h := NewWorkspaceHandler(nil, nil, []string{"gitlab.forterro.com"})
	cases := []struct {
		transport, url string
		ok             bool
	}{
		{"https", "https://gitlab.forterro.com/g/ns.git", true},
		{"https", "http://gitlab.forterro.com/g/ns.git", false}, // not https
		{"https", "https://evil.example.com/g/ns.git", false},   // not allow-listed
		{"ssh", "git@gitlab.forterro.com:g/ns.git", true},
		{"ssh", "ssh://git@gitlab.forterro.com/g/ns.git", true},
		{"ssh", "git@evil.example.com:g/ns.git", false},
		{"https", "", false},
	}
	for _, c := range cases {
		err := h.validateRemote(c.transport, c.url)
		if (err == nil) != c.ok {
			t.Fatalf("validateRemote(%q,%q) err=%v, want ok=%v", c.transport, c.url, err, c.ok)
		}
	}
}

func TestHandleMineMethodNotAllowed(t *testing.T) {
	h := NewWorkspaceHandler(&fakeWSStore{}, nil, nil)
	r := httptest.NewRequest(http.MethodPatch, "/api/me/workspace", nil)
	r = middleware.WithUser(r, &middleware.UserContext{ID: 1, Role: "collaborator"})
	w := httptest.NewRecorder()
	h.HandleMine(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}

func TestMineGetDefaultWhenNone(t *testing.T) {
	h := NewWorkspaceHandler(&fakeWSStore{personal: map[int]*store.Workspace{}}, nil, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/me/workspace", nil)
	r = middleware.WithUser(r, &middleware.UserContext{ID: 5, Role: "collaborator"})
	w := httptest.NewRecorder()
	h.HandleMine(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var got map[string]any
	json.Unmarshal(w.Body.Bytes(), &got)
	if got["namespace"] != "user-5" || got["configured"] != false {
		t.Fatalf("unexpected default: %v", got)
	}
}
