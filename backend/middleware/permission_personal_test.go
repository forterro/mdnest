package middleware

import (
	"testing"

	"github.com/mdnest/mdnest/backend/store"
)

// A user always has read/write access to their own personal workspace (excluded
// from grants), and never to another user's.
func TestPersonalNamespaceImplicitAccess(t *testing.T) {
	pc := newChecker()
	// ID 3 has a grant on "gamma" in the fixture, but not on user-3.
	alice := &UserContext{ID: 3, Username: "alice", Role: "collaborator"}

	if !pc.CheckWrite(reqAs(alice), store.PersonalNamespace(3), "note.md") {
		t.Fatal("owner denied write to their own personal namespace")
	}
	if !pc.CheckRead(reqAs(alice), "user-3", "note.md") {
		t.Fatal("owner denied read to their own personal namespace")
	}
	if pc.CheckWrite(reqAs(alice), "user-1", "note.md") {
		t.Fatal("user gained access to another user's personal namespace")
	}
}

// The caller's personal namespace is surfaced in FilterNamespaces even with no
// grants.
func TestPersonalNamespaceInFilter(t *testing.T) {
	pc := newChecker()
	bob := &UserContext{ID: 9, Username: "bob", Role: "collaborator"}
	got := pc.FilterNamespaces(reqAs(bob), []string{"user-9", "other"})
	if len(got) != 1 || got[0] != "user-9" {
		t.Fatalf("want [user-9], got %v", got)
	}
}
