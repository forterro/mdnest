package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
)

func themeReq(h *MarpThemeHandler, method, query, body string, uc *middleware.UserContext) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, "/api/marp/themes?"+query, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, "/api/marp/themes?"+query, nil)
	}
	if uc != nil {
		r = middleware.WithUser(r, uc)
	}
	w := httptest.NewRecorder()
	h.Handle(w, r)
	return w
}

func TestMarpThemeHandler(t *testing.T) {
	h := NewMarpThemeHandler(localStore(t, t.TempDir()))
	super := &middleware.UserContext{ID: 1, Username: "root", Role: "superadmin"}
	collab := &middleware.UserContext{ID: 2, Username: "bob", Role: "collaborator"}

	css := `/* @theme sample */ section { color: #111; }`

	// A non-superadmin cannot write a theme.
	if w := themeReq(h, http.MethodPost, "", `{"name":"sample","css":"x"}`, collab); w.Code != http.StatusForbidden {
		t.Fatalf("collab write: want 403, got %d (%s)", w.Code, w.Body.String())
	}

	// An unsafe / traversal name is rejected.
	if w := themeReq(h, http.MethodPost, "", `{"name":"../evil","css":"x"}`, super); w.Code != http.StatusBadRequest {
		t.Fatalf("bad name: want 400, got %d", w.Code)
	}

	// Superadmin upsert succeeds.
	if w := themeReq(h, http.MethodPost, "", `{"name":"sample","css":`+jsonStr(css)+`}`, super); w.Code != http.StatusOK {
		t.Fatalf("upsert: want 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Any authenticated user can read the catalog.
	w := themeReq(h, http.MethodGet, "", "", collab)
	if w.Code != http.StatusOK {
		t.Fatalf("list: want 200, got %d", w.Code)
	}
	var got []marpTheme
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Name != "sample" || got[0].CSS != css {
		t.Fatalf("want 1 theme sample with css, got %+v", got)
	}

	// Delete (superadmin) then the catalog is empty.
	if w := themeReq(h, http.MethodDelete, "name=sample", "", super); w.Code != http.StatusOK {
		t.Fatalf("delete: want 200, got %d", w.Code)
	}
	w = themeReq(h, http.MethodGet, "", "", super)
	var after []marpTheme
	if err := json.Unmarshal(w.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode after: %v", err)
	}
	if len(after) != 0 {
		t.Fatalf("after delete want 0 themes, got %d", len(after))
	}
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// A theme's slide templates are stored with it, returned by the catalog, kept
// by an upsert that does not mention them (an older client), removed by an
// empty string, and deleted with the theme.
func TestMarpThemeTemplates(t *testing.T) {
	h := NewMarpThemeHandler(localStore(t, t.TempDir()))
	super := &middleware.UserContext{ID: 1, Username: "root", Role: "superadmin"}
	collab := &middleware.UserContext{ID: 2, Username: "bob", Role: "collaborator"}
	css := `/* @theme brand */ section { color: #111; }`
	tpl := "---\nmarp: true\nhtml: true\n---\n\n<!-- _class: title -->\n\n# Title\n\n---\n\n# Cards\n"

	list := func() []marpTheme {
		t.Helper()
		w := themeReq(h, http.MethodGet, "", "", collab)
		var got []marpTheme
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return got
	}

	if w := themeReq(h, http.MethodPost, "", `{"name":"brand","css":`+jsonStr(css)+`,"templates":`+jsonStr(tpl)+`}`, super); w.Code != http.StatusOK {
		t.Fatalf("upsert with templates: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	if got := list(); len(got) != 1 || got[0].Templates != tpl {
		t.Fatalf("templates not returned: %+v", got)
	}

	// An upsert without the field (an older admin page) keeps them.
	if w := themeReq(h, http.MethodPost, "", `{"name":"brand","css":`+jsonStr(css+" ")+`}`, super); w.Code != http.StatusOK {
		t.Fatalf("css-only upsert: want 200, got %d", w.Code)
	}
	if got := list(); len(got) != 1 || got[0].Templates != tpl || got[0].CSS != css+" " {
		t.Fatalf("css-only upsert lost the templates or the css: %+v", got)
	}

	// The templates file is not listed as a theme of its own.
	if got := list(); len(got) != 1 {
		t.Fatalf("want 1 theme, got %d", len(got))
	}

	// Oversized templates are refused.
	big := strings.Repeat("x", maxTemplatesBytes+1)
	if w := themeReq(h, http.MethodPost, "", `{"name":"brand","css":"x","templates":`+jsonStr(big)+`}`, super); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("big templates: want 413, got %d", w.Code)
	}

	// An empty string removes them.
	if w := themeReq(h, http.MethodPost, "", `{"name":"brand","css":`+jsonStr(css)+`,"templates":""}`, super); w.Code != http.StatusOK {
		t.Fatalf("clear templates: want 200, got %d", w.Code)
	}
	if got := list(); got[0].Templates != "" {
		t.Fatalf("templates not cleared: %q", got[0].Templates)
	}

	// Deleting the theme deletes its templates: a new theme of the same name
	// starts without them.
	themeReq(h, http.MethodPost, "", `{"name":"brand","css":`+jsonStr(css)+`,"templates":`+jsonStr(tpl)+`}`, super)
	if w := themeReq(h, http.MethodDelete, "name=brand", "", super); w.Code != http.StatusOK {
		t.Fatalf("delete: want 200, got %d", w.Code)
	}
	themeReq(h, http.MethodPost, "", `{"name":"brand","css":`+jsonStr(css)+`}`, super)
	if got := list(); len(got) != 1 || got[0].Templates != "" {
		t.Fatalf("templates survived the theme's deletion: %+v", got)
	}
}
