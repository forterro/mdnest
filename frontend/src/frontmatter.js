// Frontmatter support — a leading YAML block (`---\n...\n---`) that mdnest
// reads for display metadata (title/icon/type/tags; author is parsed
// server-side but has no UI yet). Read-only: users hand-edit the block, same
// as Marp's `marp: true` today. Actual YAML parsing happens server-side
// (backend/handlers/frontmatter.go) and rides along on `getTree()` / `getNote()`
// responses — this module only needs to (a) strip the block for rendering and
// (b) resolve/fetch the `icon: md:<slug>` reference, both of which are pure,
// content-only operations that don't need a YAML parser.

// splitFrontmatterBlock separates a leading frontmatter block (raw, including
// delimiters) from the rest of the content. Returns { block: '', body: content }
// when there's no leading block. Used to keep the block out of the Live
// editor's Milkdown document entirely (see stripFrontmatterBlock below and
// App.jsx) — round-tripping `---`/YAML through Milkdown's serializer mangles
// it (thematic-break/setext-heading reformatting), the same corruption Marp
// frontmatter was already known to suffer there.
export function splitFrontmatterBlock(content) {
  if (typeof content !== 'string') return { block: '', body: content };
  const m = content.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return { block: '', body: content };
  return { block: m[0], body: content.slice(m[0].length) };
}

// stripFrontmatterBlock removes a leading frontmatter block from markdown
// content, if present. Used before handing content to marked() — without
// this, the `---` delimiters render as a spurious <hr>.
export function stripFrontmatterBlock(content) {
  return splitFrontmatterBlock(content).body;
}

// mdiIconUrl validates an `icon: md:<slug>` frontmatter value and returns the
// CDN URL to fetch its SVG from, or null if the value doesn't match the
// strict allow-list. The slug is attacker-controlled (it's user-authored note
// content), so it must never be interpolated into a URL without validation —
// only a fixed host/path with a `[a-z0-9-]+` slug is ever allowed.
const MDI_ICON_RE = /^md:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function mdiIconUrl(icon) {
  if (typeof icon !== 'string') return null;
  const m = icon.trim().match(MDI_ICON_RE);
  if (!m) return null;
  return `https://cdn.jsdelivr.net/npm/@mdi/svg/svg/${m[1]}.svg`;
}

// Session-lived cache: icon slug -> sanitized SVG markup, or null on failure.
// Avoids re-fetching the same icon for every tree row / toolbar render.
const iconCache = new Map();

// fetchMdiIcon resolves an `icon: md:<slug>` value to sanitized, inline-able
// SVG markup. Returns null for an invalid slug or if the fetch fails (e.g. no
// network / a privately-hosted install with no outbound access) — icons are
// best-effort and must degrade silently, never break note rendering.
export async function fetchMdiIcon(icon, sanitizeSvg) {
  const url = mdiIconUrl(icon);
  if (!url) return null;
  if (iconCache.has(url)) return iconCache.get(url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`icon fetch failed: ${res.status}`);
    const svg = sanitizeSvg(await res.text());
    iconCache.set(url, svg);
    return svg;
  } catch {
    iconCache.set(url, null);
    return null;
  }
}
