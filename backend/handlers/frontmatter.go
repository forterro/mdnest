package handlers

import (
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Frontmatter is the small set of note metadata mdnest understands from a
// leading YAML frontmatter block. Read-only: mdnest never writes or rewrites
// this block — users author it by hand (same as Marp's own `marp: true`).
type Frontmatter struct {
	Title  string   `json:"title,omitempty" yaml:"title"`
	Author string   `json:"author,omitempty" yaml:"author"`
	Icon   string   `json:"icon,omitempty" yaml:"icon"`
	Type   string   `json:"type,omitempty" yaml:"type"`
	Tags   []string `json:"tags,omitempty" yaml:"tags"`
}

// Leading frontmatter: optional BOM, `---`, a YAML body, closing `---` on its
// own line. Mirrors the block frontend/src/marp.js's isMarpDoc detects.
var frontmatterRegex = regexp.MustCompile(`(?s)\A\x{FEFF}?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(\r?\n|\z)`)

// ExtractFrontmatter parses the leading YAML frontmatter block, if any. It
// never errors out to callers — a missing block or malformed YAML both simply
// yield nil, since a broken frontmatter block must not break tree listing or
// note viewing. defaultAuthor fills the author field when the block omits it.
func ExtractFrontmatter(content string, defaultAuthor string) *Frontmatter {
	m := frontmatterRegex.FindStringSubmatchIndex(content)
	if m == nil {
		return nil
	}

	var fm Frontmatter
	if err := yaml.Unmarshal([]byte(content[m[2]:m[3]]), &fm); err != nil {
		return nil
	}

	fm.Title = strings.TrimSpace(fm.Title)
	fm.Author = strings.TrimSpace(fm.Author)
	fm.Icon = strings.TrimSpace(fm.Icon)
	fm.Type = strings.ToLower(strings.TrimSpace(fm.Type))
	if fm.Author == "" {
		fm.Author = defaultAuthor
	}
	return &fm
}
