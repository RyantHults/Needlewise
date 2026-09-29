import { useDeferredValue, useMemo, useRef, useState } from 'react';

import candidatesAsset from '../symbols/candidates.generated.json';
import selectionAsset from '../symbols/selection.json';
import './symbol-picker.css';

/**
 * The symbol pool curation tool, served at /__symbols in dev only.
 *
 * The pool is the selection in src/symbols/selection.json, and until this
 * existed, changing it meant hand-editing a list of codepoints with no way to
 * see what they looked like. This page shows every glyph the font can draw at
 * the sizes a chart actually uses, so a mark that turns to mush at 8 pixels can
 * be left out before it ever reaches a pattern.
 *
 * There is no near-duplicate filter and no visual similarity ranking. The font
 * contains thousands of deliberate variants — the fourteen diamonds, the dozen
 * circled letters — and a filter that judged them too similar would quietly
 * remove glyphs someone wanted. Search is the only tool offered.
 *
 * The glyphs are shown with an @font-face of the vendored font rather than the
 * pool's own outlines, so a codepoint is visible even before it is selected and
 * even when the committed pool no longer contains it.
 */

interface Candidate {
  readonly id: string;
  readonly codepoint: number;
  readonly name: string;
  readonly block: string;
}

interface SelectionFile {
  readonly font: { readonly family: string; readonly file: string; readonly sha256: string; readonly license: string };
  readonly selection: readonly string[];
}

const candidates = (candidatesAsset as unknown as {
  total: number;
  font: SelectionFile['font'];
  candidates: Candidate[];
}).candidates;

const authored = (selectionAsset as unknown as SelectionFile).selection;

const formatCodepoint = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

const toCodepoint = (value: string): number => Number.parseInt(value.replace(/^U\+/i, ''), 16);

/** How many candidates to paint at once, so the page stays responsive on first paint. */
const PAGE_SIZE = 400;

export default function SymbolPickerPage() {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(authored.map(toCodepoint)));
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  // Typing in the search box should not rebuild a grid of thousands of nodes.
  const deferredQuery = useDeferredValue(query);
  const gridTop = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return candidates;
    const asCodepoint = needle.startsWith('u+') ? toCodepoint(needle) : null;
    return candidates.filter((candidate) =>
      candidate.name.includes(needle)
      || candidate.block.toLowerCase().includes(needle)
      || candidate.id.includes(needle)
      || (asCodepoint !== null && candidate.codepoint === asCodepoint)
      || String.fromCodePoint(candidate.codepoint) === needle);
  }, [deferredQuery]);

  const visible = matches.slice(0, limit);

  function toggle(codePoint: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(codePoint)) next.add(codePoint);
      return next;
    });
    setStatus('');
  }

  function selectVisible() {
    setSelected((current) => new Set([...current, ...visible.map((candidate) => candidate.codepoint)]));
  }

  function clearVisible() {
    setSelected((current) => {
      const next = new Set(current);
      for (const candidate of visible) next.delete(candidate.codepoint);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setStatus('Saving…');
    try {
      const response = await fetch('/__symbols/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection: [...selected].sort((a, b) => a - b).map(formatCodepoint) })
      });
      const payload = await response.json() as { saved?: number; next?: string; error?: string };
      if (!response.ok) {
        setStatus(payload.error ?? 'The selection could not be saved.');
        return;
      }
      setStatus(`Saved ${payload.saved} symbols to ${'src/symbols/selection.json'}. Run: ${payload.next}`);
    } catch {
      setStatus('The selection could not be saved. Is the dev server running?');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="symbol-picker">
      <style>{`
        @font-face {
          font-family: "Libertinus Math";
          src: url("/__symbols/LibertinusMath-Regular.ttf") format("truetype");
          font-display: block;
        }
      `}</style>
      <header className="symbol-picker-header">
        <h1>Symbol pool</h1>
        <p>
          Every glyph <strong>Libertinus Math</strong> can draw: {candidates.length.toLocaleString()} candidates.
          Tick the ones worth stitching, save, then run the build. Search matches names, blocks, ids, and
          U+ codepoints.
        </p>
      </header>

      <div className="symbol-picker-controls">
        <label htmlFor="symbol-picker-search">Search</label>
        <input
          id="symbol-picker-search"
          value={query}
          placeholder="heart, or U+2665"
          autoComplete="off"
          onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }}
        />
        <span className="symbol-picker-count">
          {selected.size} selected
          {deferredQuery.trim() ? ` · ${matches.length.toLocaleString()} matching` : ''}
        </span>
        <button type="button" onClick={selectVisible} disabled={visible.length === 0}>Select shown</button>
        <button type="button" onClick={clearVisible} disabled={visible.length === 0}>Clear shown</button>
        <button type="button" className="symbol-picker-save" onClick={() => void save()} disabled={saving || selected.size === 0}>
          {saving ? 'Saving…' : 'Save selection.json'}
        </button>
      </div>

      <p className="symbol-picker-status" role="status">{status}</p>

      <div
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
          const on = selected.has(candidate.codepoint);
          return (
            <button
              key={candidate.id}
              type="button"
              className={on ? 'symbol-picker-cell is-selected' : 'symbol-picker-cell'}
              aria-pressed={on}
              title={`${candidate.name} · ${formatCodepoint(candidate.codepoint)} · ${candidate.block}`}
              onClick={() => toggle(candidate.codepoint)}
            >
              <span className="symbol-picker-glyph" style={{ fontFamily: '"Libertinus Math", serif' }} aria-hidden="true">
                {String.fromCodePoint(candidate.codepoint)}
              </span>
              <span className="symbol-picker-label">{candidate.name}</span>
              <span className="symbol-picker-meta">
                {formatCodepoint(candidate.codepoint)} · {candidate.block}
              </span>
              <span className="symbol-picker-sizes" aria-hidden="true">
                <b style={{ fontFamily: '"Libertinus Math", serif', fontSize: 8 }}>{String.fromCodePoint(candidate.codepoint)}</b>
                <b style={{ fontFamily: '"Libertinus Math", serif', fontSize: 16 }}>{String.fromCodePoint(candidate.codepoint)}</b>
                <b style={{ fontFamily: '"Libertinus Math", serif', fontSize: 24 }}>{String.fromCodePoint(candidate.codepoint)}</b>
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
