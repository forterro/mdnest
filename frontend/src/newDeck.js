// Pure helpers behind "+ Slides": the new-deck dialog builds the note with
// buildDeck and offers the slide classes themeClasses finds in a theme.

// Marp's built-in themes. They are always available, catalog or not.
export const BUILTIN_THEMES = ['default', 'gaia', 'uncover'];

export const SLIDE_SIZES = ['16:9', '4:3'];

export const MAX_CONTENT_SLIDES = 20;

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

// buildDeck returns the markdown of a new Marp deck: the front matter, a title
// slide and `contentSlides` placeholder slides. Options that are left at
// Marp's default are not written, so a plain deck stays short.
export function buildDeck({
  title = '',
  theme = 'default',
  classes = [],
  titleClass = '',
  paginate = true,
  size = '16:9',
  header = '',
  footer = '',
  contentSlides = 0,
} = {}) {
  const fm = ['---', 'marp: true'];
  fm.push(`theme: ${isIdent(theme) ? theme : 'default'}`);
  const deckClasses = (Array.isArray(classes) ? classes : []).filter(isIdent);
  if (deckClasses.length) fm.push(`class: ${deckClasses.join(' ')}`);
  fm.push(`paginate: ${paginate ? 'true' : 'false'}`);
  if (SLIDE_SIZES.includes(size) && size !== SLIDE_SIZES[0]) fm.push(`size: ${size}`);
  // JSON strings are valid YAML double-quoted scalars, so any text is safe.
  if (oneLine(header)) fm.push(`header: ${JSON.stringify(oneLine(header))}`);
  if (oneLine(footer)) fm.push(`footer: ${JSON.stringify(oneLine(footer))}`);
  fm.push('---');

  const first = [];
  // A slide's `_class` replaces the deck's `class` rather than adding to it,
  // so the title slide repeats the deck classes to keep their look.
  if (isIdent(titleClass)) {
    const own = [titleClass, ...deckClasses.filter((c) => c !== titleClass)];
    first.push(`<!-- _class: ${own.join(' ')} -->`, '');
  }
  first.push(`# ${oneLine(title) || 'Untitled deck'}`);
  const slides = [first.join('\n')];
  const n = Math.max(0, Math.min(MAX_CONTENT_SLIDES, Math.floor(Number(contentSlides) || 0)));
  for (let i = 1; i <= n; i++) slides.push(`## Slide ${i + 1}\n\n- Point one\n- Point two`);

  return fm.join('\n') + '\n\n' + slides.join('\n\n---\n\n') + '\n';
}
