package handlers

import "testing"

func TestParseTaskLine(t *testing.T) {
	cases := []struct {
		line        string
		wantOK      bool
		wantChecked bool
		wantRest    string
	}{
		{"- [ ] buy milk", true, false, "buy milk"},
		{"- [x] shipped", true, true, "shipped"},
		{"- [X] shipped upper", true, true, "shipped upper"},
		{"  * [ ] nested star", true, false, "nested star"},
		{"\t+ [ ] tabbed plus", true, false, "tabbed plus"},
		{"- [ ]", true, false, ""},
		{"- not a task", false, false, ""},
		{"just text", false, false, ""},
		{"<!-- mdnest:abc -->", false, false, ""},
	}
	for _, c := range cases {
		checked, rest, ok := parseTaskLine(c.line)
		if ok != c.wantOK || checked != c.wantChecked || rest != c.wantRest {
			t.Errorf("parseTaskLine(%q) = (%v,%q,%v), want (%v,%q,%v)",
				c.line, checked, rest, ok, c.wantChecked, c.wantRest, c.wantOK)
		}
	}
}

func TestHasStatusTag(t *testing.T) {
	if !hasStatusTag("do it #doing", "doing") {
		t.Error("expected #doing to be detected")
	}
	if hasStatusTag("code #doingfast", "doing") {
		t.Error("substring should not match a whole-token tag")
	}
	if hasStatusTag("no tag here", "doing") {
		t.Error("unexpected match")
	}
	if !hasStatusTag("#todo first", "todo") {
		t.Error("tag at start of line should match")
	}
}

func TestStripStatusTags(t *testing.T) {
	b := defaultBoard()
	cases := []struct{ in, want string }{
		{"buy milk #doing", "buy milk"},
		{"#todo urgent", "urgent"},
		{"plain #project note", "plain #project note"}, // unrelated hashtag preserved
		{"do #doing and #done", "do and"},
	}
	for _, c := range cases {
		if got := stripStatusTags(b, c.in); got != c.want {
			t.Errorf("stripStatusTags(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestResolveColumn(t *testing.T) {
	b := defaultBoard()
	cases := []struct {
		checked bool
		rest    string
		want    string
	}{
		{false, "no tag", "todo"},         // default first non-done column
		{false, "work #doing", "doing"},   // explicit tag
		{false, "planned #todo", "todo"},  // explicit todo tag
		{true, "anything", "done"},        // checked always maps to done column
		{true, "checked #doing", "done"},  // checked wins over stale tag
	}
	for _, c := range cases {
		if got := resolveColumn(b, c.checked, c.rest); got != c.want {
			t.Errorf("resolveColumn(%v,%q) = %q, want %q", c.checked, c.rest, got, c.want)
		}
	}
}

func TestApplyColumn(t *testing.T) {
	b := defaultBoard()

	// To a done column: check the box and drop status tags.
	got, ok := applyColumn(b, "- [ ] ship it #doing", "done")
	if !ok || got != "- [x] ship it" {
		t.Errorf("applyColumn done = (%q,%v)", got, ok)
	}

	// To a non-done column: uncheck and set the column tag.
	got, ok = applyColumn(b, "- [x] revert this", "doing")
	if !ok || got != "- [ ] revert this #doing" {
		t.Errorf("applyColumn doing = (%q,%v)", got, ok)
	}

	// Between non-done columns: swap the tag, preserve indent/bullet.
	got, ok = applyColumn(b, "  * [ ] nested #doing", "todo")
	if !ok || got != "  * [ ] nested #todo" {
		t.Errorf("applyColumn swap = (%q,%v)", got, ok)
	}

	// Unknown column is rejected.
	if _, ok := applyColumn(b, "- [ ] x", "missing"); ok {
		t.Error("expected unknown column to fail")
	}

	// Non-task line is rejected.
	if _, ok := applyColumn(b, "plain text", "todo"); ok {
		t.Error("expected non-task line to fail")
	}
}

func TestSetChecked(t *testing.T) {
	got, ok := setChecked("- [ ] task #doing", true)
	if !ok || got != "- [x] task #doing" {
		t.Errorf("setChecked true = (%q,%v)", got, ok)
	}
	got, ok = setChecked("- [x] task", false)
	if !ok || got != "- [ ] task" {
		t.Errorf("setChecked false = (%q,%v)", got, ok)
	}
	if _, ok := setChecked("not a task", true); ok {
		t.Error("expected non-task to fail")
	}
}

func TestValidBoard(t *testing.T) {
	if validBoard(BoardConfig{}) {
		t.Error("empty board should be invalid")
	}
	if validBoard(BoardConfig{Columns: []BoardColumn{{ID: "", Title: "x"}}}) {
		t.Error("empty id should be invalid")
	}
	if validBoard(BoardConfig{Columns: []BoardColumn{{ID: "a", Title: "A"}, {ID: "a", Title: "B"}}}) {
		t.Error("duplicate id should be invalid")
	}
	if !validBoard(defaultBoard()) {
		t.Error("default board should be valid")
	}
}
