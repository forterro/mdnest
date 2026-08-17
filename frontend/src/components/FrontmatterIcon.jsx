import { useState, useEffect } from 'react';
import { fetchMdiIcon } from '../frontmatter.js';
import { sanitizeSvg } from '../sanitize.js';

// Renders a note's frontmatter `icon: md:<slug>` reference as an inline MDI
// SVG (fetched from the Pictogrammers CDN, sanitized, and cached — see
// frontmatter.js). Renders `fallback` while loading or on failure/absence, so
// callers can use it as a drop-in replacement for a default icon.
function FrontmatterIcon({ icon, className, fallback = null }) {
  const [svg, setSvg] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    if (!icon) return undefined;
    fetchMdiIcon(icon, sanitizeSvg).then((result) => {
      if (!cancelled) setSvg(result);
    });
    return () => { cancelled = true; };
  }, [icon]);

  if (!svg) return fallback;
  return (
    <span
      className={`frontmatter-icon${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default FrontmatterIcon;
