package handlers

import "testing"

func TestExportBaseName(t *testing.T) {
	cases := map[string]string{
		"marp-forterro-demo.md": "marp-forterro-demo",
		"decks/quarterly.md":    "quarterly",
		`..\..\etc\passwd`:      "passwd",
		`evil".md`:              "evil",
		"a\"; rm -rf /\n.md":    "deck",
		"":                      "deck",
		"   ":                   "deck",
		"...":                   "deck",
		"héllo wörld.md":        "h-llo-w-rld",
	}
	for in, want := range cases {
		if got := exportBaseName(in); got != want {
			t.Errorf("exportBaseName(%q) = %q, want %q", in, got, want)
		}
	}

	// The result must never carry characters that could break out of the
	// Content-Disposition filename or a shell/path.
	for _, in := range []string{"a/b", `c\d`, "e\"f", "g\nh", "i;j", "k`l"} {
		got := exportBaseName(in)
		for _, bad := range []rune{'/', '\\', '"', '\n', ';', '`'} {
			for _, r := range got {
				if r == bad {
					t.Errorf("exportBaseName(%q) = %q contains forbidden %q", in, got, string(bad))
				}
			}
		}
	}
}
