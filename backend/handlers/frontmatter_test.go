package handlers

import (
	"reflect"
	"testing"
)

func TestExtractFrontmatter(t *testing.T) {
	tests := []struct {
		name          string
		content       string
		defaultAuthor string
		want          *Frontmatter
	}{
		{
			name: "full block",
			content: "---\n" +
				"title: My Note\n" +
				"author: Alice\n" +
				"icon: md:cog\n" +
				"type: marp\n" +
				"tags:\n  - infra\n  - k8s\n" +
				"---\n\n# Body\n",
			want: &Frontmatter{Title: "My Note", Author: "Alice", Icon: "md:cog", Type: "marp", Tags: []string{"infra", "k8s"}},
		},
		{
			name:          "missing fields default author",
			content:       "---\ntitle: Just a Title\n---\nbody",
			defaultAuthor: "bob",
			want:          &Frontmatter{Title: "Just a Title", Author: "bob"},
		},
		{
			name:    "inline tag list",
			content: "---\ntags: [a, b, c]\n---\nbody",
			want:    &Frontmatter{Tags: []string{"a", "b", "c"}},
		},
		{
			name:    "no frontmatter",
			content: "# Just a note\n\ntitle: not frontmatter\n",
			want:    nil,
		},
		{
			name:    "empty content",
			content: "",
			want:    nil,
		},
		{
			name:    "frontmatter not at top of file",
			content: "# Title\n\n---\ntitle: nope\n---\n",
			want:    nil,
		},
		{
			name:    "malformed yaml does not error",
			content: "---\ntitle: [unterminated\n---\nbody",
			want:    nil,
		},
		{
			name:    "unknown extra keys are ignored",
			content: "---\ntitle: Foo\nunknown: bar\n---\nbody",
			want:    &Frontmatter{Title: "Foo"},
		},
		{
			name:    "type is lowercased",
			content: "---\ntype: MARP\n---\nbody",
			want:    &Frontmatter{Type: "marp"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractFrontmatter(tt.content, tt.defaultAuthor)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("ExtractFrontmatter() = %+v, want %+v", got, tt.want)
			}
		})
	}
}
