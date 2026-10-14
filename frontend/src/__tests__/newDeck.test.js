// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Marp } from '@marp-team/marp-core';
import {
  buildDeck, themeClasses, deckPath, titleFromName, BUILTIN_THEMES, MAX_CONTENT_SLIDES,
} from '../newDeck.js';
import { isMarpDoc, slideStarts } from '../marp.js';

function render(md, themes = []) {
  const marp = new Marp({ html: true, script: false });
  for (const css of themes) marp.themeSet.add(css);
  const { html } = marp.render(md);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('svg[data-marpit-svg]')];
}

const builtinCss = (name) => new Marp().themeSet.get(name)?.css || '';

describe('buildDeck', () => {
  it('writes a short front matter for a plain deck', () => {
    expect(buildDeck({ title: 'Hello' })).toBe(
      '---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# Hello\n',
    );
  });

  it('is a Marp note the deck view opens, with one slide per requested slide', () => {
    const md = buildDeck({ title: 'Q3', contentSlides: 3 });
    expect(isMarpDoc(md)).toBe(true);
    expect(slideStarts(md).starts).toHaveLength(4);
    expect(render(md)).toHaveLength(4);
  });

  it('writes every chosen option, and Marp applies them', () => {
    const md = buildDeck({
      title: 'Review',
      theme: 'gaia',
      classes: ['invert'],
      titleClass: 'lead',
      paginate: false,
      size: '4:3',
      header: 'Team: "Platform" #1',
      footer: 'Confidential',
      contentSlides: 1,
    });
    expect(md).toContain('theme: gaia\nclass: invert\npaginate: false\nsize: 4:3\n');
    expect(md).toContain('header: "Team: \\"Platform\\" #1"\nfooter: "Confidential"\n');
    expect(md).toContain('<!-- _class: lead invert -->\n\n# Review');

    const slides = render(md);
    expect(slides).toHaveLength(2);
    expect(slides[0].getAttribute('viewBox')).toBe('0 0 960 720');
    const first = slides[0].querySelector('section');
    expect(first.getAttribute('data-theme')).toBe('gaia');
    expect(first.className.split(' ')).toEqual(expect.arrayContaining(['invert', 'lead']));
    expect(first.querySelector('header').textContent).toBe('Team: "Platform" #1');
    expect(first.querySelector('footer').textContent).toBe('Confidential');
    expect(first.hasAttribute('data-paginate')).toBe(false);
    const second = slides[1].querySelector('section').className.split(' ');
    expect(second).toContain('invert');
    expect(second).not.toContain('lead');
  });

  it('keeps header, footer and title on one line', () => {
    const md = buildDeck({ title: 'A\nB', header: 'x\ny', footer: '\tz ' });
    expect(md).toContain('header: "x y"');
    expect(md).toContain('footer: "z"');
    expect(md).toContain('# A B');
  });

  it('never writes a theme or class that could break the front matter', () => {
    const md = buildDeck({ theme: 'x\nmarp: false', classes: ['ok', 'bad class', 'a:b'], titleClass: '--> <b>' });
    expect(md).toContain('theme: default\nclass: ok\n');
    expect(md).not.toContain('marp: false');
    expect(md).not.toContain('_class');
    expect(isMarpDoc(md)).toBe(true);
  });

  it('defaults the title and clamps the number of slides', () => {
    expect(buildDeck({})).toContain('# Untitled deck');
    expect(slideStarts(buildDeck({ contentSlides: 999 })).starts).toHaveLength(MAX_CONTENT_SLIDES + 1);
    expect(slideStarts(buildDeck({ contentSlides: -4 })).starts).toHaveLength(1);
  });

  it('applies a catalog theme by name', () => {
    const css = "/* @theme brand */\n@import 'default';\nsection.cover { color: red; }";
    const md = buildDeck({ theme: 'brand', titleClass: 'cover' });
    const [slide] = render(md, [css]);
    const section = slide.querySelector('section');
    expect(section.getAttribute('data-theme')).toBe('brand');
    expect(section.className).toContain('cover');
  });
});

describe('themeClasses', () => {
  it('finds the classes of the built-in themes', () => {
    expect(themeClasses(builtinCss('gaia'))).toEqual(expect.arrayContaining(['invert', 'gaia', 'lead']));
    expect(themeClasses(builtinCss('default'))).toEqual(['invert']);
    expect(themeClasses(builtinCss('uncover'))).toEqual(['invert']);
  });

  it('finds section.class selectors and adds those of an imported theme', () => {
    const css = "/* @theme brand */\n@import 'gaia';\nsection.lead { x: 1 }\nsection.two-columns > div {}\nsection:is(.dark) {}";
    const classes = themeClasses(css, (name) => (BUILTIN_THEMES.includes(name) ? builtinCss(name) : ''));
    expect(classes).toEqual(expect.arrayContaining(['lead', 'two-columns', 'dark', 'invert', 'gaia']));
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('ignores selectors on other elements and survives import cycles', () => {
    expect(themeClasses('div.card {} p.note {} h1.big {}')).toEqual([]);
    const a = "@import 'b';\nsection.a {}";
    const b = "@import 'a';\nsection.b {}";
    expect(themeClasses(a, (n) => (n === 'b' ? b : a)).sort()).toEqual(['a', 'b']);
    expect(themeClasses(undefined)).toEqual([]);
  });
});

describe('deckPath and titleFromName', () => {
  it('appends .md and places the deck in the folder', () => {
    expect(deckPath('talks/', 'q3-review')).toBe('talks/q3-review.md');
    expect(deckPath('', '/q3.md')).toBe('q3.md');
    expect(deckPath('a/', 'Deck.MD')).toBe('a/Deck.MD');
    expect(deckPath('a/', '  ')).toBe('');
    expect(deckPath('a/', '.md')).toBe('');
  });

  it('suggests a title from the file name', () => {
    expect(titleFromName('q3-review.md')).toBe('Q3 review');
    expect(titleFromName('talks/team_update')).toBe('Team update');
    expect(titleFromName('')).toBe('');
  });
});
