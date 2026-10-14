// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Marp } from '@marp-team/marp-core';
import {
  buildDeck, themeClasses, deckPath, titleFromName, BUILTIN_THEMES,
  splitDeck, parseTemplates, genericTemplates, variantClasses, frontmatterValue,
} from '../newDeck.js';
import { isMarpDoc, slideStarts } from '../marp.js';

function render(md, themes = []) {
  const marp = new Marp({ html: true, script: false });
  for (const css of themes) marp.themeSet.add(css);
  const { html } = marp.render(md);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('svg[data-marpit-svg]')].map((s) => s.querySelector('section'));
}

const builtinCss = (name) => new Marp().themeSet.get(name)?.css || '';

// A theme with its own slide kinds, and a templates deck showing each one.
const BRAND_CSS = "/* @theme brand */\n@import 'default';\nsection.cover {}\nsection.divider {}\nsection.kpi {}\nsection.light {}\nsection.dark {}\n.card {}";
const BRAND_TEMPLATES = `---
marp: true
html: true
theme: brand
paginate: true
footer: "brand theme · demo"
class: light
style: |
  section { font-size: 20px; }
---

<!-- _class: cover -->

# brand theme
## Every component

---

<!-- template: Section divider -->
<!-- _class: divider -->

# 1. Typography

---

# Cards

<div class="grid">
<div class="card">A</div>
</div>

\`\`\`yaml
---
not: a slide break
\`\`\`

---

<!-- _class: kpi light -->

# Metrics

---

# Cards

second slide with the same heading`;

describe('parseTemplates', () => {
  const { frontmatter, templates } = parseTemplates(BRAND_TEMPLATES);

  it('makes one template per slide, named by its comment or first heading', () => {
    expect(templates.map((t) => t.name)).toEqual(['brand theme', 'Section divider', 'Cards', 'Metrics', 'Cards (2)']);
    expect(templates.map((t) => t.classes[0] || '')).toEqual(['cover', 'divider', '', 'kpi', '']);
  });

  it('drops the template comment from the slide and keeps the rest verbatim', () => {
    expect(templates[1].body).toBe('<!-- _class: divider -->\n\n# 1. Typography');
    expect(templates[2].body).toContain('<div class="grid">');
    expect(templates[2].body).toContain('not: a slide break');
  });

  it('reads the front matter, multi-line values included', () => {
    expect(frontmatterValue(frontmatter, 'footer')).toBe('brand theme · demo');
    expect(frontmatterValue(frontmatter, 'class')).toBe('light');
    expect(frontmatter.find((f) => f.key === 'style').raw).toBe('style: |\n  section { font-size: 20px; }');
  });

  it('copes with no front matter and with nothing at all', () => {
    expect(parseTemplates('# A\n\n---\n\n# B').templates.map((t) => t.name)).toEqual(['A', 'B']);
    expect(parseTemplates('').templates).toEqual([]);
    expect(splitDeck(undefined).slides).toEqual([]);
  });
});

describe('buildDeck from templates', () => {
  const { frontmatter, templates } = parseTemplates(BRAND_TEMPLATES);

  it('writes one slide per picked template, each keeping its own class', () => {
    const md = buildDeck({
      title: 'Quarterly review', theme: 'brand', variant: 'light', footer: 'Team', frontmatter,
      slides: templates.map((t) => t.body),
    });
    expect(isMarpDoc(md)).toBe(true);
    expect(slideStarts(md).starts).toHaveLength(templates.length);
    const sections = render(md, [BRAND_CSS]);
    expect(sections).toHaveLength(5);
    const cls = sections.map((s) => s.className.split(' ').filter(Boolean));
    expect(cls[0]).toEqual(['cover']);
    expect(cls[1]).toEqual(['divider']);
    expect(cls[2]).toEqual(['light']);
    expect(cls[3]).toEqual(['kpi', 'light']);
    expect(sections[0].querySelector('h1').textContent).toBe('Quarterly review');
    expect(sections.every((s) => s.getAttribute('data-theme') === 'brand')).toBe(true);
  });

  it('keeps the templates deck front matter it does not manage, and applies the choices', () => {
    const md = buildDeck({ theme: 'brand', variant: 'dark', paginate: false, size: '4:3', footer: 'Mine', frontmatter, slides: [templates[2].body] });
    expect(md.startsWith('---\nmarp: true\nhtml: true\nstyle: |\n  section { font-size: 20px; }\ntheme: brand\npaginate: false\nsize: 4:3\nfooter: "Mine"\nclass: dark\n---\n\n# Cards\n')).toBe(true);
    expect(md).not.toContain('brand theme · demo');
  });

  it('a subset in the order picked', () => {
    const md = buildDeck({ theme: 'brand', frontmatter, slides: [templates[3].body, templates[0].body] });
    const sections = render(md, [BRAND_CSS]);
    expect(sections.map((s) => s.querySelector('h1').textContent)).toEqual(['Metrics', 'brand theme']);
  });
});

describe('buildDeck basics', () => {
  it('writes a short front matter for a plain deck', () => {
    expect(buildDeck({ title: 'Hello', slides: genericTemplates([]).map((t) => t.body).slice(0, 1) })).toBe(
      '---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# Hello\n\nSubtitle\n',
    );
  });

  it('quotes header and footer and keeps them on one line', () => {
    const md = buildDeck({ header: 'Team: "A" #1', footer: 'x\ny' });
    expect(md).toContain('header: "Team: \\"A\\" #1"\nfooter: "x y"\n');
    const [section] = render(md);
    expect(section.querySelector('header').textContent).toBe('Team: "A" #1');
  });

  it('never writes a theme or class that could break the front matter', () => {
    const md = buildDeck({ theme: 'x\nmarp: false', variant: 'ok a:b' });
    expect(md).toContain('theme: default\npaginate: true\nclass: ok\n');
    expect(md).not.toContain('marp: false');
    expect(isMarpDoc(md)).toBe(true);
  });

  it('renders 4:3 and the deck variant', () => {
    const md = buildDeck({ theme: 'gaia', variant: 'invert', size: '4:3', slides: ['# A'] });
    const [section] = render(md);
    expect(section.closest('svg').getAttribute('viewBox')).toBe('0 0 960 720');
    expect(section.className).toContain('invert');
  });
});

describe('genericTemplates and variantClasses', () => {
  it('a title slide with the theme title class, repeating the variant', () => {
    const [title, content] = genericTemplates(['invert', 'gaia', 'lead'], 'invert');
    expect(title.body).toBe('<!-- _class: lead invert -->\n\n# Title\n\nSubtitle');
    expect(content.name).toBe('Content');
    const md = buildDeck({ theme: 'gaia', variant: 'invert', slides: [title.body, content.body] });
    const cls = render(md).map((s) => s.className.split(' '));
    expect(cls[0]).toEqual(expect.arrayContaining(['lead', 'invert']));
    expect(cls[1]).toEqual(['invert']);
  });

  it('no class directive when the theme has no title class', () => {
    expect(genericTemplates(['invert'])[0].body).toBe('# Title\n\nSubtitle');
  });

  it('variants are the classes templates do not use as a slide type', () => {
    const { templates } = parseTemplates(BRAND_TEMPLATES);
    expect(variantClasses(themeClasses(BRAND_CSS), templates)).toEqual(['light', 'dark']);
    expect(variantClasses(themeClasses(builtinCss('gaia')), genericTemplates(['lead']))).toEqual(['invert', 'gaia']);
  });
});

describe('themeClasses', () => {
  it('finds the classes of the built-in themes', () => {
    expect(themeClasses(builtinCss('gaia'))).toEqual(expect.arrayContaining(['invert', 'gaia', 'lead']));
    expect(themeClasses(builtinCss('default'))).toEqual(['invert']);
    expect(themeClasses(builtinCss('uncover'))).toEqual(['invert']);
  });

  it('adds the classes of an imported theme and survives import cycles', () => {
    const css = "/* @theme b */\n@import 'gaia';\nsection.two-columns > div {}\nsection:is(.dark) {}";
    const classes = themeClasses(css, (name) => (BUILTIN_THEMES.includes(name) ? builtinCss(name) : ''));
    expect(classes).toEqual(expect.arrayContaining(['two-columns', 'dark', 'invert', 'gaia', 'lead']));
    const a = "@import 'b';\nsection.a {}";
    const b = "@import 'a';\nsection.b {}";
    expect(themeClasses(a, (n) => (n === 'b' ? b : a)).sort()).toEqual(['a', 'b']);
    expect(themeClasses('div.card {} p.note {}')).toEqual([]);
  });
});

describe('deckPath and titleFromName', () => {
  it('appends .md and places the deck in the folder', () => {
    expect(deckPath('talks/', 'q3-review')).toBe('talks/q3-review.md');
    expect(deckPath('', '/q3.md')).toBe('q3.md');
    expect(deckPath('a/', '  ')).toBe('');
  });

  it('suggests a title from the file name', () => {
    expect(titleFromName('q3-review.md')).toBe('Q3 review');
    expect(titleFromName('')).toBe('');
  });
});
