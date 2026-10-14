// Pure helpers behind "+ Slides". A new deck is assembled from slide
// templates: the slides of the theme's templates deck (Admin > Marp Themes),
// or generic ones for a theme without such a deck. Each picked template gives
// one slide that keeps its own class; the deck's class (its variant, e.g.
// light or dark) is a single choice in the front matter.

// Marp's built-in themes. They are always available, catalog or not.
export const BUILTIN_THEMES = ['default', 'gaia', 'uncover'];

export const SLIDE_SIZES = ['16:9', '4:3'];

// Front matter keys the dialog sets; any other key of the templates deck
// (html, math, style…) is kept as written.
const MANAGED_KEYS = ['marp', 'theme', 'class', 'paginate', 'size', 'header', 'footer'];

// One line, no control characters: header, footer and title are single-line
// values in the front matter and the title slide.
function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

// A theme name or class goes into the front matter unquoted, so only keep
// names that are plain identifiers (the theme catalog enforces the same).
function isIdent(value) {
  return /^[A-Za-z_][\w-]*$/.test(value);
}

// themeClasses lists the slide classes a theme stylesheet styles, in order of
// first appearance: `section.lead` and `section:where(.invert)` (the form
// Marp's built-in themes use). Classes of an `@import`ed theme are included
// when resolveImport returns that theme's CSS.
export function themeClasses(css, resolveImport = () => '', seen = new Set()) {
  const out = [];
  const add = (name) => { if (isIdent(name) && !out.includes(name)) out.push(name); };
  const text = String(css || '');
  for (const m of text.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    for (const c of themeClasses(resolveImport(name), resolveImport, seen)) add(c);
  }
  for (const m of text.matchAll(/section(?:\.([A-Za-z_][\w-]*)|:(?:where|is)\(\s*\.([A-Za-z_][\w-]*))/g)) {
    add(m[1] || m[2]);
  }
  return out;
}

// splitDeck separates Marp markdown into its front matter (the lines between
// the leading `---` fences) and its slides. A slide ends at a `---` line that
// follows a blank line, outside fenced code: the rule the deck view uses
// (marp.js slideStarts).
export function splitDeck(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let fm = [];
  if (/^\uFEFF?---\s*$/.test(lines[0] || '')) {
    let j = 1;
    while (j < lines.length && !/^---\s*$/.test(lines[j])) j++;
    if (j < lines.length) { fm = lines.slice(1, j); i = j + 1; }
  }
  const slides = [];
  let cur = [];
  let inFence = false;
  let prevBlank = true;
  for (let k = i; k < lines.length; k++) {
    const line = lines[k];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && prevBlank && /^---\s*$/.test(line)) {
      slides.push(cur.join('\n').trim());
      cur = [];
      prevBlank = true;
      continue;
    }
    cur.push(line);
    prevBlank = line.trim() === '';
  }
  slides.push(cur.join('\n').trim());
  return { frontmatter: parseFrontmatter(fm), slides: slides.filter((s) => s !== '') };
}

// parseFrontmatter keeps each top-level key with its raw text (continuation
// lines included, e.g. a `style: |` block) and a plain value for prefills.
function parseFrontmatter(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (m) {
      out.push({ key: m[1], raw: line, value: unquote(m[2].trim()) });
    } else if (out.length) {
      out[out.length - 1].raw += '\n' + line;
    }
  }
  return out;
}

function unquote(v) {
  if (/^".*"$/.test(v)) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

const TEMPLATE_RE = /^[ \t]*<!--\s*template:\s*(.*?)\s*-->[ \t]*\n?/m;
const CLASS_RE = /<!--\s*_class:\s*([^>]*?)\s*-->/;

// headingText returns the first markdown heading of a slide, without markup.
function headingText(body) {
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    const m = !inFence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].replace(/<[^>]+>/g, '').replace(/[*_`~]/g, '').trim();
  }
  return '';
}

// parseTemplates reads a theme's templates deck: one template per slide,
// named by `<!-- template: Name -->` (removed from the slide) or else by its
// first heading. Returns the deck's front matter and the templates.
export function parseTemplates(markdown) {
  const { frontmatter, slides } = splitDeck(markdown);
  const seen = new Map();
  const templates = slides.map((raw, idx) => {
    const named = raw.match(TEMPLATE_RE);
    const body = named ? raw.replace(TEMPLATE_RE, '').trim() : raw;
    let name = (named && named[1]) || headingText(body) || `Slide ${idx + 1}`;
    // Two slides with the same heading stay distinguishable in the list.
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    const cls = (body.match(CLASS_RE) || [])[1] || '';
    return { id: `t${idx}`, name, body, classes: cls.split(/\s+/).filter(Boolean) };
  });
  return { frontmatter, templates };
}

// genericTemplates are offered for a theme without a templates deck: a title
// slide (with the theme's `lead` or `title` class when it has one) and a
// content slide. A slide's `_class` replaces the deck's class in Marp, so the
// title slide repeats the variant to keep its look.
export function genericTemplates(classes = [], variant = '') {
  const titleClass = ['lead', 'title'].find((c) => classes.includes(c)) || '';
  const own = [titleClass, isIdent(variant) && variant !== titleClass ? variant : ''].filter(Boolean);
  const title = (own.length ? `<!-- _class: ${own.join(' ')} -->\n\n` : '') + '# Title\n\nSubtitle';
  return [
    { id: 'title', name: 'Title', body: title, classes: own },
    { id: 'content', name: 'Content', body: '## Slide title\n\n- Point one\n- Point two', classes: [] },
  ];
}

// variantClasses are the classes offered as the deck's variant: the theme's
// classes, minus those its templates use as their own slide type.
export function variantClasses(classes, templates) {
  const used = new Set((templates || []).map((t) => t.classes[0]).filter(Boolean));
  for (const c of ['lead', 'title']) used.add(c);
  return (classes || []).filter((c) => !used.has(c));
}

// deckPath turns what the user typed into the note path: ".md" appended,
// leading slashes dropped, placed in dir. Empty when nothing usable was typed.
export function deckPath(dir, name) {
  let base = String(name || '').trim().replace(/^\/+/, '');
  if (!base || base === '.md') return '';
  if (!base.toLowerCase().endsWith('.md')) base += '.md';
  return (dir || '') + base;
}

// titleFromName suggests a title from the file name: "q3-review.md" -> "Q3 review".
export function titleFromName(name) {
  const base = String(name || '').split('/').pop().replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return base ? base[0].toUpperCase() + base.slice(1) : '';
}

// withTitle puts the deck title in the first heading-1 of the first slide.
function withTitle(body, title) {
  const t = oneLine(title);
  if (!t) return body;
  let inFence = false;
  let done = false;
  return body.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!done && !inFence && /^#\s+/.test(line)) { done = true; return `# ${t}`; }
    return line;
  }).join('\n');
}

// buildDeck returns the markdown of a new Marp deck: the front matter (the
// templates deck's own keys kept, the dialog's choices on top) and one slide
// per picked template, in order. The title goes into the first slide.
export function buildDeck({
  title = '',
  theme = 'default',
  variant = '',
  paginate = true,
  size = '16:9',
  header = '',
  footer = '',
  frontmatter = [],
  slides = [],
} = {}) {
  const fm = ['---', 'marp: true'];
  for (const f of frontmatter) if (!MANAGED_KEYS.includes(f.key)) fm.push(f.raw);
  fm.push(`theme: ${isIdent(theme) ? theme : 'default'}`);
  fm.push(`paginate: ${paginate ? 'true' : 'false'}`);
  if (SLIDE_SIZES.includes(size) && size !== SLIDE_SIZES[0]) fm.push(`size: ${size}`);
  // JSON strings are valid YAML double-quoted scalars, so any text is safe.
  if (oneLine(header)) fm.push(`header: ${JSON.stringify(oneLine(header))}`);
  if (oneLine(footer)) fm.push(`footer: ${JSON.stringify(oneLine(footer))}`);
  const classes = String(variant || '').split(/\s+/).filter(isIdent);
  if (classes.length) fm.push(`class: ${classes.join(' ')}`);
  fm.push('---');

  const bodies = (slides.length ? slides : ['# Untitled deck']).map((s) => String(s).trim());
  bodies[0] = withTitle(bodies[0], title);
  return fm.join('\n') + '\n\n' + bodies.join('\n\n---\n\n') + '\n';
}

// frontmatterValue reads one key of a parsed front matter ('' when absent).
export function frontmatterValue(frontmatter, key) {
  return (frontmatter || []).find((f) => f.key === key)?.value ?? '';
}
