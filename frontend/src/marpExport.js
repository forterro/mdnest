// marpExport — export a Marp deck as a single, dependency-free file.
//
//   - HTML: one self-contained .html (theme CSS inlined, note images inlined as
//     data-URIs, system fonts). Opens offline in any browser.
//   - PPTX: one .pptx (a self-contained zip) with one full-bleed image per
//     slide. Each slide's Marp SVG is made standalone (CSS + images inlined),
//     rasterized to PNG in the browser, and placed on a 16:9 slide. pptxgenjs
//     is lazy-loaded so it never weighs on the normal app bundle.
import { Marp } from '@marp-team/marp-core';
import { getToken, exportMarpHtml } from './api.js';

const SLIDE_W = 1280;
const SLIDE_H = 720;

function renderWithThemes(content, themes) {
  const marp = new Marp({ html: true, script: false });
  for (const t of themes || []) {
    try { marp.themeSet.add(t.css); } catch { /* skip malformed theme */ }
  }
  return marp.render(content); // { html, css }
}

// fetchAsDataURI fetches a same-origin/app URL (with the auth token) and returns
// a data: URI, or null on failure (the original URL is then left as-is).
async function fetchAsDataURI(url) {
  try {
    const headers = {};
    const token = getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// collectUrls finds candidate image URLs in html + css that should be inlined:
// http(s), root-relative (/api/files/...), skipping data: and blob:.
function collectUrls(html, css) {
  const urls = new Set();
  const push = (u) => {
    if (!u) return;
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    urls.add(u);
  };
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  const cssUrlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let m;
  while ((m = imgRe.exec(html))) push(m[1]);
  while ((m = cssUrlRe.exec(css))) push(m[1]);
  while ((m = cssUrlRe.exec(html))) push(m[1]);
  return [...urls];
}

// inlineAssets replaces every inlinable image URL in html+css with a data-URI.
async function inlineAssets(html, css) {
  const urls = collectUrls(html, css);
  const map = new Map();
  await Promise.all(urls.map(async (u) => {
    const data = await fetchAsDataURI(u);
    if (data) map.set(u, data);
  }));
  const replaceAll = (s) => {
    for (const [u, data] of map) s = s.split(u).join(data);
    return s;
  };
  return { html: replaceAll(html), css: replaceAll(css) };
}

function baseName(path) {
  const b = String(path || 'deck').split('/').pop() || 'deck';
  return b.replace(/\.md$/i, '') || 'deck';
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// exportHtml downloads a real, standalone Marp presentation. The rendering is
// done server-side by the marp CLI (bespoke template: keyboard/touch
// navigation, fullscreen, presenter view), so the result is a genuine,
// self-contained deck rather than a static dump of slide images.
export async function exportHtml(content, title) {
  const blob = await exportMarpHtml(content, baseName(title));
  downloadBlob(`${baseName(title)}.html`, blob);
}

// slideToPng makes one Marp slide SVG standalone (inlines the theme CSS) and
// rasterizes it to a PNG data-URI via an <img> + <canvas>. Images must already
// be data-URIs (see inlineAssets) or the canvas would taint.
async function slideToPng(svgOuter, css) {
  const doc = new DOMParser().parseFromString(svgOuter, 'text/html');
  const svg = doc.querySelector('svg');
  if (!svg) return null;
  svg.setAttribute('width', String(SLIDE_W));
  svg.setAttribute('height', String(SLIDE_H));
  const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent = css;
  svg.insertBefore(styleEl, svg.firstChild);
  const serialized = new XMLSerializer().serializeToString(svg);
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialized);

  const img = new Image();
  img.width = SLIDE_W;
  img.height = SLIDE_H;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('slide rasterization failed'));
    img.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = SLIDE_W;
  canvas.height = SLIDE_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SLIDE_W, SLIDE_H);
  ctx.drawImage(img, 0, 0, SLIDE_W, SLIDE_H);
  return canvas.toDataURL('image/png');
}

function extractSlides(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = doc.querySelectorAll('svg[data-marpit-svg]');
  return Array.from(nodes).map((n) => n.outerHTML);
}

export async function exportPptx(content, themes, title) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const { html, css } = renderWithThemes(content, themes);
  const inlined = await inlineAssets(html, css);
  const slides = extractSlides(inlined.html);

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'MARP16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'MARP16x9';

  for (const svg of slides) {
    let png = null;
    try {
      png = await slideToPng(svg, inlined.css);
    } catch {
      png = null;
    }
    const slide = pptx.addSlide();
    if (png) {
      slide.addImage({ data: png, x: 0, y: 0, w: 13.333, h: 7.5 });
    }
  }
  await pptx.writeFile({ fileName: `${baseName(title)}.pptx` });
}
