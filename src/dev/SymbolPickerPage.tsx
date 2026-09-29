import { useDeferredValue, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import candidatesAsset from '../symbols/candidates.generated.json';
import selectionAsset from '../symbols/selection.json';
import './symbol-picker.css';

/**
 * The symbol pool curation tool, served at /__symbols in dev only.
 *
 * The pool is the selection in src/symbols/selection.json. This page shows every
 * glyph the vendored fonts can draw at the sizes a chart actually uses, so a
 * mark that turns to mush at 8 pixels can be left out before it ever reaches a
 * pattern.
 *
 * There is no near-duplicate filter and no visual similarity ranking. The fonts
 * contain thousands of deliberate variants — the fourteen diamonds, the dozen
 * circled letters — and a filter that judged them too similar would quietly
 * remove glyphs someone wanted. Search is the only tool offered.
 *
 * A selection entry is "<font-slug>:U+XXXX", because two fonts can both hold the
 * same codepoint and choosing one must not hide the other. Every control in the
 * page is therefore keyed on that entry string, never on the codepoint.
 *
 * The glyphs are shown with an @font-face of the vendored fonts rather than the
 * pool's own outlines, so a codepoint is visible even before it is selected and
 * even when the committed pool does not contain it.
 */

interface Candidate {
  readonly id: string;
  readonly font: string;
  readonly codepoint: number;
  readonly name: string;
  readonly block: string;
}

interface FontInfo {
  readonly family: string;
  readonly file: string;
}

interface CandidatesFile {
  readonly fonts: Readonly<Record<string, FontInfo>>;
  readonly total: number;
  readonly candidates: readonly Candidate[];
}

interface SelectionFile {
  readonly version: number;
  readonly selection: readonly string[];
}

const catalog = (candidatesAsset as unknown as CandidatesFile);
const candidates = catalog.candidates;
const fonts = catalog.fonts;
const fontSlugs = Object.keys(fonts);

const authored = new Set((selectionAsset as unknown as SelectionFile).selection);

const formatCodepoint = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

const toCodepoint = (value: string): number => Number.parseInt(value.replace(/^U\+/i, ''), 16);

const toEntry = (candidate: Candidate): string => `${candidate.font}:${formatCodepoint(candidate.codepoint)}`;

/** The tab that shows every font's candidates, alongside one tab per font. */
const ALL_FONTS = 'all';

/** How many candidates to paint at once, so the page stays responsive on first paint. */
const PAGE_SIZE = 400;

const candidateCounts = new Map<string, number>(fontSlugs.map((slug) => [slug, 0]));
for (const candidate of candidates) {
  candidateCounts.set(candidate.font, (candidateCounts.get(candidate.font) ?? 0) + 1);
}

export default function SymbolPickerPage() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(authored));
  const [query, setQuery] = useState('');
  const [fontFilter, setFontFilter] = useState<string>(ALL_FONTS);
  const [onlySelected, setOnlySelected] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  // Typing in the search box should not rebuild a grid of thousands of nodes.
  const deferredQuery = useDeferredValue(query);
  const gridTop = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const matches = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return candidates.filter((candidate) => {
      // The review view deliberately spans the whole pool, so a font tab left
      // over from browsing it does not hide the other font's ticked glyphs.
      if (!onlySelected && fontFilter !== ALL_FONTS && candidate.font !== fontFilter) return false;
      if (onlySelected && !selected.has(toEntry(candidate))) return false;
      if (!needle) return true;
      const asCodepoint = needle.startsWith('u+') ? toCodepoint(needle) : null;
      return candidate.name.includes(needle)
        || candidate.block.toLowerCase().includes(needle)
        || candidate.id.includes(needle)
        || fonts[candidate.font]?.family.toLowerCase().includes(needle) === true
        || (asCodepoint !== null && candidate.codepoint === asCodepoint)
        || String.fromCodePoint(candidate.codepoint) === needle;
    });
  }, [deferredQuery, fontFilter, onlySelected, selected]);

  const visible = matches.slice(0, limit);

  const perFont = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of selected) {
      const font = entry.slice(0, entry.indexOf(':'));
      counts.set(font, (counts.get(font) ?? 0) + 1);
    }
    return counts;
  }, [selected]);

  /** A narrower set means a fresh page of results, read from the top of the grid. */
  function resetView() {
    setLimit(PAGE_SIZE);
    if (gridTop.current) gridTop.current.scrollTop = 0;
  }

  function chooseFont(slug: string) {
    setFontFilter(slug);
    resetView();
  }

  /** Arrow keys walk the tab strip and pick the tab they land on, as a tablist should. */
  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const order = [ALL_FONTS, ...fontSlugs];
    const current = order.indexOf(fontFilter);
    let next: number;
    if (event.key === 'ArrowRight') next = (current + 1) % order.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + order.length) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    else return;
    event.preventDefault();
    chooseFont(order[next]);
    tabRefs.current[next]?.focus();
  }

  function toggle(entry: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(entry)) next.add(entry);
      return next;
    });
    setStatus('');
  }

  function selectVisible() {
    setSelected((current) => new Set([...current, ...visible.map(toEntry)]));
  }

  function clearVisible() {
    setSelected((current) => {
      const next = new Set(current);
      for (const candidate of visible) next.delete(toEntry(candidate));
      return next;
    });
  }

  /** Entering the review view drops the search and font filters, which rarely suit it. */
  function toggleOnlySelected() {
    const entering = !onlySelected;
    setOnlySelected(entering);
    if (entering) {
      setQuery('');
      setFontFilter(ALL_FONTS);
    }
    resetView();
  }

  async function save() {
    setSaving(true);
    setStatus('Saving…');
    try {
      const response = await fetch('/__symbols/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection: [...selected].sort() })
      });
      const payload = await response.json() as {
        saved?: number;
        perFont?: Record<string, number>;
        file?: string;
        next?: string;
        error?: string;
      };
      if (!response.ok) {
        setStatus(payload.error ?? 'The selection could not be saved.');
        return;
      }
      const breakdown = Object.entries(payload.perFont ?? {})
        .map(([slug, count]) => `${fonts[slug]?.family ?? slug} ${count}`)
        .join(' · ');
      const saved = [
        `Saved ${payload.saved} symbols to ${payload.file ?? 'src/symbols/selection.json'}`,
        breakdown || null,
        `Run: ${payload.next}`
      ].filter(Boolean).join('. ');
      setStatus(saved);
    } catch {
      setStatus('The selection could not be saved. Is the dev server running?');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="symbol-picker">
      <style>{fontSlugs.map((slug) => `
        @font-face {
          font-family: "${slug}";
          src: url("/__symbols/font/${slug}.ttf") format("truetype");
          font-display: block;
        }
      `).join('')}</style>
      <header className="symbol-picker-header">
        <h1>Symbol pool</h1>
        <p>
          Every glyph the vendored fonts can draw: {candidates.length.toLocaleString()} candidates across{' '}
          {fontSlugs.length} font{fontSlugs.length === 1 ? '' : 's'}. Tick the ones worth stitching, save, then
          run the build. Search matches names, blocks, ids, font names, and U+ codepoints.
        </p>
      </header>

      <div className="symbol-picker-tabs" role="tablist" aria-label="Font" onKeyDown={onTabKeyDown}>
        <button
          ref={(node) => { tabRefs.current[0] = node; }}
          type="button"
          role="tab"
          aria-selected={fontFilter === ALL_FONTS}
          aria-controls="symbol-picker-grid"
          tabIndex={fontFilter === ALL_FONTS ? 0 : -1}
          className={fontFilter === ALL_FONTS ? 'is-active' : ''}
          onClick={() => chooseFont(ALL_FONTS)}
        >
          All fonts
          <span className="symbol-picker-tab-count">{candidates.length.toLocaleString()}</span>
        </button>
        {fontSlugs.map((slug, index) => (
          <button
            key={slug}
            ref={(node) => { tabRefs.current[index + 1] = node; }}
            type="button"
            role="tab"
            aria-selected={fontFilter === slug}
            aria-controls="symbol-picker-grid"
            tabIndex={fontFilter === slug ? 0 : -1}
            className={fontFilter === slug ? 'is-active' : ''}
            onClick={() => chooseFont(slug)}
          >
            {fonts[slug].family}
            <span className="symbol-picker-tab-count">
              {(candidateCounts.get(slug) ?? 0).toLocaleString()}
            </span>
          </button>
        ))}
      </div>

      <div className="symbol-picker-controls">
        <label htmlFor="symbol-picker-search">Search</label>
        <input
          id="symbol-picker-search"
          value={query}
          placeholder="heart, or U+2665"
          autoComplete="off"
          onChange={(event) => { setQuery(event.target.value); resetView(); }}
        />
        <span className="symbol-picker-count">
          {selected.size} selected
          {perFont.size > 1 && ` (${[...perFont].map(([slug, n]) => `${fonts[slug]?.family ?? slug} ${n}`).join(' · ')})`}
          {deferredQuery.trim() ? ` · ${matches.length.toLocaleString()} matching` : ''}
        </span>
        <button type="button" onClick={selectVisible} disabled={visible.length === 0}>Select shown</button>
        <button type="button" onClick={clearVisible} disabled={visible.length === 0}>Clear shown</button>
        <label className={onlySelected ? 'symbol-picker-toggle is-on' : 'symbol-picker-toggle'}>
          <input
            type="checkbox"
            checked={onlySelected}
            onChange={toggleOnlySelected}
          />
          Selected only
          <span className="symbol-picker-toggle-count">{selected.size.toLocaleString()}</span>
        </label>
        <button type="button" className="symbol-picker-save" onClick={() => void save()} disabled={saving || selected.size === 0}>
          {saving ? 'Saving…' : 'Save selection.json'}
        </button>
      </div>

      <p className="symbol-picker-status" role="status">{status}</p>

      <div
        id="symbol-picker-grid"
        role="tabpanel"
        aria-label="Candidates"
        className="symbol-picker-grid"
        ref={gridTop}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop + element.clientHeight >= element.scrollHeight - 400) {
            setLimit((current) => current + PAGE_SIZE);
          }
        }}
      >
        {visible.map((candidate) => {
          const entry = toEntry(candidate);
          const on = selected.has(entry);
          const family = fonts[candidate.font]?.family ?? candidate.font;
          const face = `"${candidate.font}", serif`;
          return (
            <button
              key={candidate.id}
              type="button"
              className={on ? 'symbol-picker-cell is-selected' : 'symbol-picker-cell'}
              aria-pressed={on}
              title={`${candidate.name} · ${formatCodepoint(candidate.codepoint)} · ${candidate.block} · ${family}`}
              onClick={() => toggle(entry)}
            >
              <span className="symbol-picker-glyph" style={{ fontFamily: face }} aria-hidden="true">
                {String.fromCodePoint(candidate.codepoint)}
              </span>
              <span className="symbol-picker-label">{candidate.name}</span>
              <span className="symbol-picker-meta">
                {formatCodepoint(candidate.codepoint)} · {family}
              </span>
              <span className="symbol-picker-sizes" aria-hidden="true">
                <b style={{ fontFamily: face, fontSize: 8 }}>{String.fromCodePoint(candidate.codepoint)}</b>
                <b style={{ fontFamily: face, fontSize: 16 }}>{String.fromCodePoint(candidate.codepoint)}</b>
                <b style={{ fontFamily: face, fontSize: 24 }}>{String.fromCodePoint(candidate.codepoint)}</b>
              </span>
            </button>
          );
        })}
        {visible.length < matches.length && (
          <p className="symbol-picker-more">Showing {visible.length.toLocaleString()} of {matches.length.toLocaleString()}. Scroll for more.</p>
        )}
      </div>
    </div>
  );
}
