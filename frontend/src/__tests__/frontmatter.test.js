import { describe, it, expect } from 'vitest';
import { stripFrontmatterBlock, splitFrontmatterBlock, mdiIconUrl } from '../frontmatter.js';

describe('splitFrontmatterBlock', () => {
  it('splits the raw block (with delimiters) from the body', () => {
    const src = '---\ntitle: Plex\nicon: md:cog\n---\n\n# Body\n';
    const { block, body } = splitFrontmatterBlock(src);
    expect(block).toBe('---\ntitle: Plex\nicon: md:cog\n---\n');
    expect(body).toBe('\n# Body\n');
    // Round-trips byte-identical — this is what keeps the Live editor
    // (which never sees `block`) from mangling the frontmatter block on
    // save, since it can only ever rewrite `body`.
    expect(block + body).toBe(src);
  });

  it('returns an empty block when there is no frontmatter', () => {
    const src = '# Just a note\n';
    expect(splitFrontmatterBlock(src)).toEqual({ block: '', body: src });
  });
});

describe('stripFrontmatterBlock', () => {
  it('removes a leading frontmatter block', () => {
    const src = '---\ntitle: Foo\n---\n\n# Body\n';
    expect(stripFrontmatterBlock(src)).toBe('\n# Body\n');
  });

  it('tolerates a BOM before the block', () => {
    const src = '\uFEFF---\ntitle: Foo\n---\nbody';
    expect(stripFrontmatterBlock(src)).toBe('body');
  });

  it('leaves content with no frontmatter unchanged', () => {
    const src = '# Just a note\n\ntitle: not frontmatter\n';
    expect(stripFrontmatterBlock(src)).toBe(src);
  });

  it('does not strip a --- block that is not at the top of the file', () => {
    const src = '# Title\n\n---\ntitle: nope\n---\n';
    expect(stripFrontmatterBlock(src)).toBe(src);
  });

  it('handles a frontmatter-only file', () => {
    const src = '---\ntitle: Foo\n---\n';
    expect(stripFrontmatterBlock(src)).toBe('');
  });

  it('is a no-op for non-string input', () => {
    expect(stripFrontmatterBlock(null)).toBe(null);
    expect(stripFrontmatterBlock(undefined)).toBe(undefined);
  });
});

describe('mdiIconUrl', () => {
  it('builds the jsdelivr URL for a valid md: slug', () => {
    expect(mdiIconUrl('md:cog')).toBe('https://cdn.jsdelivr.net/npm/@mdi/svg/svg/cog.svg');
  });

  it('allows multi-word hyphenated slugs', () => {
    expect(mdiIconUrl('md:file-pdf-box')).toBe('https://cdn.jsdelivr.net/npm/@mdi/svg/svg/file-pdf-box.svg');
  });

  it('rejects values without the md: prefix', () => {
    expect(mdiIconUrl('cog')).toBeNull();
    expect(mdiIconUrl('fa:cog')).toBeNull();
  });

  it('rejects path traversal and non-slug characters', () => {
    expect(mdiIconUrl('md:../../etc/passwd')).toBeNull();
    expect(mdiIconUrl('md:cog/../../x')).toBeNull();
    expect(mdiIconUrl('md:cog?x=1')).toBeNull();
    expect(mdiIconUrl('md:')).toBeNull();
  });

  it('rejects protocol-relative or absolute-URL smuggling attempts', () => {
    expect(mdiIconUrl('md://evil.com/x')).toBeNull();
    expect(mdiIconUrl('md:http://evil.com')).toBeNull();
  });

  it('rejects uppercase and invalid types', () => {
    expect(mdiIconUrl('md:COG')).toBeNull();
    expect(mdiIconUrl(null)).toBeNull();
    expect(mdiIconUrl(undefined)).toBeNull();
    expect(mdiIconUrl(42)).toBeNull();
  });
});
