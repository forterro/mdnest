import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createNoteWithContent } from '../api.js';
import { loadWithRetry } from '../lazyWithRetry.js';
import ChunkErrorBoundary from './ChunkErrorBoundary.jsx';
import {
  BUILTIN_THEMES, SLIDE_SIZES, MAX_CONTENT_SLIDES, buildDeck, deckPath, themeClasses, titleFromName,
} from '../newDeck.js';

// The preview is the deck viewer itself, so it shows exactly what the note
// will look like. It carries the Marp engine and loads only with the dialog.
const loadDeckModule = () => loadWithRetry(() => import('./MarpDeck.jsx'));
const MarpDeck = lazy(loadDeckModule);

// NewDeckModal — "+ Slides": names a new Marp deck and sets its front matter
// (theme, slide styles, size, slide numbers, header, footer) and a starter
// outline, with a live preview, then creates the note in `dir`.
//
// Themes are Marp's built-in ones plus the theme catalog (Admin > Marp Themes,
// when enabled). The styles offered are the slide classes the chosen theme's
// stylesheet defines, including those of a theme it @imports.
export default function NewDeckModal({ namespace, dir, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);
  const [theme, setTheme] = useState('default');
  const [classes, setClasses] = useState([]);
  const [titleClass, setTitleClass] = useState('');
  const [paginate, setPaginate] = useState(true);
  const [size, setSize] = useState(SLIDE_SIZES[0]);
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  const [contentSlides, setContentSlides] = useState(2);
  const [catalog, setCatalog] = useState([]); // [{name, css}]
  const [builtinCss, setBuiltinCss] = useState({}); // name -> css
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pickedTitleClass = useRef(false);

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
        setBuiltinCss(css);
        setCatalog(Array.isArray(themes) ? themes : []);
      })
      .catch(() => { /* built-in themes only, styles unknown; the preview says why */ });
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

  const available = useMemo(
    () => themeClasses(cssByName[theme], (n) => cssByName[n] || ''),
    [cssByName, theme],
  );

  // Changing theme drops styles the new theme does not have, and suggests
  // `lead` for the title slide (Marp's usual title style) until the user picks.
  useEffect(() => {
    setClasses((cur) => cur.filter((c) => available.includes(c)));
    if (!pickedTitleClass.current) setTitleClass(available.includes('lead') ? 'lead' : '');
    else setTitleClass((cur) => (available.includes(cur) ? cur : ''));
  }, [available]);

  const effectiveTitle = titleEdited ? title : titleFromName(name);
  const content = useMemo(() => buildDeck({
    title: effectiveTitle, theme, classes, titleClass, paginate, size, header, footer, contentSlides,
  }), [effectiveTitle, theme, classes, titleClass, paginate, size, header, footer, contentSlides]);

  const path = deckPath(dir, name);

  const create = async () => {
    if (!path || busy) return;
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

  const toggleClass = (c) => setClasses((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

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
          <label className="newdeck-field newdeck-wide">
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
          <label className="newdeck-field newdeck-wide">
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
            <select className="modal-input" value={theme} onChange={(e) => setTheme(e.target.value)} disabled={busy} data-testid="new-deck-theme">
              {themeNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="newdeck-field">
            <span>Title slide style</span>
            <select
              className="modal-input"
              value={titleClass}
              onChange={(e) => { pickedTitleClass.current = true; setTitleClass(e.target.value); }}
              disabled={busy}
              data-testid="new-deck-title-class"
            >
              <option value="">Same as the others</option>
              {available.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {available.length > 0 && (
            <div className="newdeck-field newdeck-wide">
              <span>Style of every slide</span>
              <div className="newdeck-classes" data-testid="new-deck-classes">
                {available.map((c) => (
                  <label key={c} className="newdeck-check">
                    <input type="checkbox" checked={classes.includes(c)} onChange={() => toggleClass(c)} disabled={busy} />
                    {c}
                  </label>
                ))}
              </div>
            </div>
          )}
          <label className="newdeck-field">
            <span>Size</span>
            <select className="modal-input" value={size} onChange={(e) => setSize(e.target.value)} disabled={busy} data-testid="new-deck-size">
              {SLIDE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="newdeck-field">
            <span>Content slides</span>
            <input
              type="number"
              className="modal-input"
              min={0}
              max={MAX_CONTENT_SLIDES}
              value={contentSlides}
              onChange={(e) => setContentSlides(Math.max(0, Math.min(MAX_CONTENT_SLIDES, Number(e.target.value) || 0)))}
              disabled={busy}
              data-testid="new-deck-slides"
            />
          </label>
          <label className="newdeck-field">
            <span>Header</span>
            <input type="text" className="modal-input" value={header} onChange={(e) => setHeader(e.target.value)} disabled={busy} data-testid="new-deck-header" />
          </label>
          <label className="newdeck-field">
            <span>Footer</span>
            <input type="text" className="modal-input" value={footer} onChange={(e) => setFooter(e.target.value)} disabled={busy} data-testid="new-deck-footer" />
          </label>
          <label className="newdeck-check newdeck-wide">
            <input type="checkbox" checked={paginate} onChange={(e) => setPaginate(e.target.checked)} disabled={busy} data-testid="new-deck-paginate" />
            Slide numbers
          </label>
        </div>

        <div className="newdeck-preview" data-testid="new-deck-preview">
          <ChunkErrorBoundary label="the slide preview">
            <Suspense fallback={<div className="editor-loading">Loading preview…</div>}>
              <MarpDeck content={content} title={path || 'New slides'} exportable={false} />
            </Suspense>
          </ChunkErrorBoundary>
        </div>

        {error && <div className="modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="modal-btn-primary" onClick={create} disabled={!path || busy} data-testid="new-deck-create">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
