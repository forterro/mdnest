import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createNoteWithContent } from '../api.js';
import { loadWithRetry } from '../lazyWithRetry.js';
import ChunkErrorBoundary from './ChunkErrorBoundary.jsx';
import {
  BUILTIN_THEMES, SLIDE_SIZES, buildDeck, deckPath, themeClasses, titleFromName,
  parseTemplates, genericTemplates, variantClasses, frontmatterValue,
} from '../newDeck.js';

// The preview is the deck viewer itself, so it shows exactly what the note
// will look like. It carries the Marp engine and loads only with the dialog.
const loadDeckModule = () => loadWithRetry(() => import('./MarpDeck.jsx'));
const MarpDeck = lazy(loadDeckModule);

// NewDeckModal — "+ Slides": a new Marp deck built from slide templates.
//
// A catalog theme (Admin > Marp Themes) can carry a templates deck, one slide
// per kind of slide; each is offered here and every one picked becomes a
// slide of the new deck, keeping its own class (title, metrics, …). Themes
// without one (the built-in ones) get a title and a content template. The
// deck's variant (e.g. light or dark) is one class for the whole deck; the
// templates deck's front matter sets the starting values.
export default function NewDeckModal({ namespace, dir, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);
  const [theme, setTheme] = useState('default');
  const [variant, setVariant] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [paginate, setPaginate] = useState(true);
  const [size, setSize] = useState(SLIDE_SIZES[0]);
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  const [catalog, setCatalog] = useState([]); // [{name, css, templates}]
  const [builtinCss, setBuiltinCss] = useState({}); // name -> css
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Escape closes the dialog wherever the focus is (a button that was
  // disabled while creating drops it to the page).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  useEffect(() => {
    let cancelled = false;
    // The deck module (loaded for the preview anyway) has the theme catalog,
    // cached for every deck, and the built-in themes' stylesheets.
    loadDeckModule()
      .then(async (m) => {
        const css = m.builtinThemeCss(BUILTIN_THEMES);
        const themes = await m.loadThemes();
        if (cancelled) return;
        const list = Array.isArray(themes) ? themes : [];
        setBuiltinCss(css);
        setCatalog(list);
        // A catalog theme with templates is the house style: start from it.
        const first = list.find((t) => (t.templates || '').trim()) || list[0];
        if (first) setTheme(first.name);
      })
      .catch(() => { /* built-in themes only; the preview says why */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const cssByName = useMemo(() => {
    const m = { ...builtinCss };
    for (const t of catalog) m[t.name] = t.css;
    return m;
  }, [builtinCss, catalog]);

  // Catalog themes first: on an install that has them, they are the house style.
  const themeNames = useMemo(() => {
    const names = catalog.map((t) => t.name);
    for (const n of BUILTIN_THEMES) if (!names.includes(n)) names.push(n);
    return names;
  }, [catalog]);

  const classes = useMemo(
    () => themeClasses(cssByName[theme], (n) => cssByName[n] || ''),
    [cssByName, theme],
  );

  const fromTheme = useMemo(
    () => parseTemplates(catalog.find((t) => t.name === theme)?.templates || ''),
    [catalog, theme],
  );
  const hasOwnTemplates = fromTheme.templates.length > 0;
  const templates = hasOwnTemplates ? fromTheme.templates : genericTemplates(classes, variant);
  const variants = useMemo(() => variantClasses(classes, templates), [classes, templates]);

  // A theme change starts over from that theme: every template picked, and
  // the front matter of its templates deck as the starting values.
  useEffect(() => {
    const fm = fromTheme.frontmatter;
    setPicked(new Set((hasOwnTemplates ? fromTheme.templates : genericTemplates(classes)).map((t) => t.id)));
    setVariant(frontmatterValue(fm, 'class'));
    setFooter(frontmatterValue(fm, 'footer'));
    setHeader(frontmatterValue(fm, 'header'));
    setPaginate(frontmatterValue(fm, 'paginate') !== 'false');
    setSize(SLIDE_SIZES.includes(frontmatterValue(fm, 'size')) ? frontmatterValue(fm, 'size') : SLIDE_SIZES[0]);
  }, [theme, fromTheme, hasOwnTemplates, classes]);

  const effectiveTitle = titleEdited ? title : titleFromName(name);
  const chosen = templates.filter((t) => picked.has(t.id));
  const content = useMemo(() => buildDeck({
    title: effectiveTitle, theme, variant, paginate, size, header, footer,
    frontmatter: fromTheme.frontmatter, slides: chosen.map((t) => t.body),
  }), [effectiveTitle, theme, variant, paginate, size, header, footer, fromTheme, chosen]);

  const path = deckPath(dir, name);

  const create = async () => {
    if (!path || !chosen.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const { status, body } = await createNoteWithContent(namespace, path, content);
      if (status >= 200 && status < 300) {
        await onCreated(path);
        return;
      }
      if (status === 409) setError(body?.error === 'file already exists' ? `"${path}" already exists. Choose another name.` : (body?.error || 'This name is taken.'));
      else if (status === 403) setError('You cannot create notes in this folder.');
      else setError(body?.error || `Could not create the deck (HTTP ${status}).`);
    } catch (e) {
      setError(`Could not create the deck: ${e.message}`);
    }
    setBusy(false);
  };

  const toggle = (id) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal modal-wide newdeck-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New slides"
        data-testid="new-deck-modal"
      >
        <h3>New slides</h3>
        <div className="newdeck-where">In <code>{namespace}:/{dir}</code></div>

        <div className="newdeck-grid">
          <label className="newdeck-field">
            <span>Name</span>
            <input
              type="text"
              className="modal-input"
              placeholder="e.g. quarterly-review"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }}
              disabled={busy}
              data-testid="new-deck-name"
            />
          </label>
          <label className="newdeck-field">
            <span>Title</span>
            <input
              type="text"
              className="modal-input"
              placeholder="Untitled deck"
              value={effectiveTitle}
              onChange={(e) => { setTitleEdited(true); setTitle(e.target.value); }}
              disabled={busy}
              data-testid="new-deck-title"
            />
          </label>
          <label className="newdeck-field">
            <span>Theme</span>
            <select className="modal-input" value={theme} onChange={(e) => setTheme(e.target.value)} disabled={busy || !loaded} data-testid="new-deck-theme">
              {themeNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="newdeck-field">
            <span>Look of the deck</span>
            <select className="modal-input" value={variant} onChange={(e) => setVariant(e.target.value)} disabled={busy} data-testid="new-deck-variant">
              <option value="">Theme default</option>
              {variant && !variants.includes(variant) && <option value={variant}>{variant}</option>}
              {variants.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          <div className="newdeck-field newdeck-wide">
            <div className="newdeck-slides-head">
              <span>Slides ({chosen.length} of {templates.length}){hasOwnTemplates ? '' : ' · this theme has no slide templates'}</span>
              <span className="newdeck-slides-bulk">
                <button type="button" className="newdeck-link" onClick={() => setPicked(new Set(templates.map((t) => t.id)))} disabled={busy} data-testid="new-deck-all">All</button>
                <button type="button" className="newdeck-link" onClick={() => setPicked(new Set())} disabled={busy} data-testid="new-deck-none">None</button>
              </span>
            </div>
            <div className="newdeck-slides" data-testid="new-deck-templates">
              {templates.map((t) => (
                <label key={t.id} className="newdeck-check" title={t.name + (t.classes.length ? ` (class: ${t.classes.join(' ')})` : '')}>
                  <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} disabled={busy} />
                  <span className="newdeck-slide-name">{t.name}</span>
                  {t.classes[0] && <span className="newdeck-slide-class">{t.classes[0]}</span>}
                </label>
              ))}
            </div>
          </div>

          <label className="newdeck-field">
            <span>Size</span>
            <select className="modal-input" value={size} onChange={(e) => setSize(e.target.value)} disabled={busy} data-testid="new-deck-size">
              {SLIDE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="newdeck-check newdeck-paginate">
            <input type="checkbox" checked={paginate} onChange={(e) => setPaginate(e.target.checked)} disabled={busy} data-testid="new-deck-paginate" />
            Slide numbers
          </label>
          <label className="newdeck-field">
            <span>Header</span>
            <input type="text" className="modal-input" value={header} onChange={(e) => setHeader(e.target.value)} disabled={busy} data-testid="new-deck-header" />
          </label>
          <label className="newdeck-field">
            <span>Footer</span>
            <input type="text" className="modal-input" value={footer} onChange={(e) => setFooter(e.target.value)} disabled={busy} data-testid="new-deck-footer" />
          </label>
        </div>

        <div className="newdeck-preview" data-testid="new-deck-preview">
          {chosen.length ? (
            <ChunkErrorBoundary label="the slide preview">
              <Suspense fallback={<div className="editor-loading">Loading preview…</div>}>
                <MarpDeck content={content} title={path || 'New slides'} exportable={false} />
              </Suspense>
            </ChunkErrorBoundary>
          ) : (
            <div className="newdeck-empty">Pick at least one slide.</div>
          )}
        </div>

        {error && <div className="modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="modal-btn-primary" onClick={create} disabled={!path || !chosen.length || busy} data-testid="new-deck-create">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
