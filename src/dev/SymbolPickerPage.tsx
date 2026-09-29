import { useDeferredValue, useMemo, useRef, useState } from 'react';

import candidatesAsset from '../symbols/candidates.generated.json';
import selectionAsset from '../symbols/selection.json';
import './symbol-picker.css';

/**
 * The symbol pool curation tool, served at /__symbols in dev only.
 *
 * The pool is the selection in src/symbols/selection.json. The list is a list of
 * codepoints in ascending order, and each one shows what every compared font can
 * draw at it, side by side, at the sizes a chart actually uses, so a mark that
 * turns to mush at 8 pixels can be left out before it ever reaches a pattern.
 *
 * Which fonts to compare is a multi-select rather than a filter: any number of
 * them can be on at once, and a codepoint is in the list whenever at least one
 * compared font can draw it. Narrowing the fonts therefore narrows the list,
 * and a codepoint no compared font holds is simply not there.
 *
 * A selection entry is "<font-slug>:U+XXXX", because two fonts can both hold the
 * same codepoint and choosing one must not hide the other. Every control in the
 * page is therefore keyed on that entry string, never on the codepoint.
 *
 * There is no near-duplicate filter and no visual similarity ranking. The fonts
 * contain thousands of deliberate variants — the fourteen diamonds, the dozen
 * circled letters — and a filter that judged them too similar would quietly
 * remove glyphs someone wanted. Search is the only tool offered.
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

/** One row of the list: a codepoint and the glyph each compared font has for it. */
interface CodepointRow {
  readonly codepoint: number;
  readonly name: string;
  readonly block: string;
  /** How many fonts in the whole pool can draw this codepoint, compared or not. */
  readonly poolSize: number;
  readonly variants: readonly Candidate[];
}

const catalog = (candidatesAsset as unknown as CandidatesFile);
const candidates = catalog.candidates;
const fonts = catalog.fonts;
const fontSlugs = Object.keys(fonts);

const authored = new Set((selectionAsset as unknown as SelectionFile).selection);

/** The codepoints any font can draw, ascending, each mapped to its per-font glyph. */
const glyphsByCodepoint = new Map<number, Map<string, Candidate>>();
for (const candidate of candidates) {
  const glyphs = glyphsByCodepoint.get(candidate.codepoint) ?? new Map<string, Candidate>();
  glyphs.set(candidate.font, candidate);
  glyphsByCodepoint.set(candidate.codepoint, glyphs);
}

const codepoints = [...glyphsByCodepoint.keys()].sort((a, b) => a - b);

/** The first font to name a codepoint gives its row a title. */
const names = new Map<number, { name: string; block: string }>();
for (const candidate of candidates) {
  if (!names.has(candidate.codepoint)) names.set(candidate.codepoint, { name: candidate.name, block: candidate.block });
}

/** How many codepoints each font adds to the list on its own. */
const codepointsPerFont = new Map<string, number>(fontSlugs.map((slug) => [slug, 0]));
for (const glyphs of glyphsByCodepoint.values()) {
  for (const slug of glyphs.keys()) codepointsPerFont.set(slug, (codepointsPerFont.get(slug) ?? 0) + 1);
}

const formatCodepoint = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

const toCodepoint = (value: string): number => Number.parseInt(value.replace(/^U\+/i, ''), 16);

const toEntry = (candidate: Candidate): string => `${candidate.font}:${formatCodepoint(candidate.codepoint)}`;

/** How many codepoints to paint at once, so the page stays responsive on first paint. */
const PAGE_SIZE = 200;

function matches(candidate: Candidate, needle: string, asCodepoint: number | null): boolean {
  return candidate.name.includes(needle)
    || candidate.block.toLowerCase().includes(needle)
    || candidate.id.includes(needle)
    || fonts[candidate.font]?.family.toLowerCase().includes(needle) === true
    || (asCodepoint !== null && candidate.codepoint === asCodepoint)
    || String.fromCodePoint(candidate.codepoint) === needle;
}

export default function SymbolPickerPage() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(authored));
  const [compared, setCompared] = useState<ReadonlySet<string>>(() => new Set(fontSlugs));
  const [query, setQuery] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  // Typing in the search box should not rebuild a list of thousands of rows.
  const deferredQuery = useDeferredValue(query);
  const scroller = useRef<HTMLDivElement>(null);
  // The tick state is a filter input only while the review view is on, so a tick
  // in browse mode leaves the row list alone.
  const reviewed = onlySelected ? selected : null;

  const rows = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const asCodepoint = needle.startsWith('u+') ? toCodepoint(needle) : null;
    const chosen = fontSlugs.filter((slug) => compared.has(slug));
    const out: CodepointRow[] = [];
    for (const codepoint of codepoints) {
      const glyphs = glyphsByCodepoint.get(codepoint);
      if (!glyphs) continue;
      const variants: Candidate[] = [];
      for (const slug of chosen) {
        const candidate = glyphs.get(slug);
        if (!candidate) continue;
        // The review view is the pool itself, so a row holds only ticked glyphs.
        if (reviewed && !reviewed.has(toEntry(candidate))) continue;
        variants.push(candidate);
      }
      // Nothing to show means no row: the compared fonts may not draw this
      // codepoint, or the review view holds none of its glyphs.
      if (variants.length === 0) continue;
      if (needle && !variants.some((variant) => matches(variant, needle, asCodepoint))) continue;
      const { name, block } = names.get(codepoint)!;
      out.push({ codepoint, name, block, poolSize: glyphs.size, variants });
    }
    return out;
  }, [deferredQuery, compared, reviewed]);

  const visible = rows.slice(0, limit);

  const emptyMessage = compared.size === 0
    ? 'No fonts are being compared. Tick a font above to see what it can draw.'
    : onlySelected
      ? 'Nothing is ticked in the fonts being compared.'
      : 'No codepoints match this search.';

  const perFont = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of selected) {
      const font = entry.slice(0, entry.indexOf(':'));
      counts.set(font, (counts.get(font) ?? 0) + 1);
    }
    return counts;
  }, [selected]);

  /** A narrower list means a fresh page of rows, read from the top of the scroller. */
  function resetView() {
    setLimit(PAGE_SIZE);
    if (scroller.current) scroller.current.scrollTop = 0;
  }

  function toggleFont(slug: string) {
    setCompared((current) => {
      const next = new Set(current);
      if (!next.delete(slug)) next.add(slug);
      return next;
    });
    resetView();
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
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visible) for (const variant of row.variants) next.add(toEntry(variant));
      return next;
    });
  }

  function clearVisible() {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visible) for (const variant of row.variants) next.delete(toEntry(variant));
      return next;
    });
  }

  /** Entering the review view drops the search, which rarely survives a 160-item read. */
  function toggleOnlySelected() {
    setOnlySelected((current) => !current);
    if (!onlySelected) setQuery('');
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
          Every codepoint the vendored fonts can draw: {codepoints.length.toLocaleString()} codepoints from{' '}
          {candidates.length.toLocaleString()} glyphs across {fontSlugs.length} font
          {fontSlugs.length === 1 ? '' : 's'}. Tick the ones worth stitching, save, then run the build. Search
          matches names, blocks, ids, font names, and U+ codepoints.
        </p>
      </header>

      <div className="symbol-picker-fonts" role="group" aria-label="Fonts to compare">
        <span className="symbol-picker-fonts-label">Compare</span>
        {fontSlugs.map((slug) => (
          <label
            key={slug}
            className={compared.has(slug) ? 'symbol-picker-chip is-on' : 'symbol-picker-chip'}
          >
            <input
              type="checkbox"
              checked={compared.has(slug)}
              onChange={() => toggleFont(slug)}
            />
            {fonts[slug].family}
            <span className="symbol-picker-chip-count">
              {(codepointsPerFont.get(slug) ?? 0).toLocaleString()}
            </span>
          </label>
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
          {deferredQuery.trim() ? ` · ${rows.length.toLocaleString()} matching` : ''}
        </span>
        <button type="button" onClick={selectVisible} disabled={visible.length === 0}>Select shown</button>
        <button type="button" onClick={clearVisible} disabled={visible.length === 0}>Clear shown</button>
        <label className={onlySelected ? 'symbol-picker-chip is-on' : 'symbol-picker-chip'}>
          <input
            type="checkbox"
            checked={onlySelected}
            onChange={toggleOnlySelected}
          />
          Selected only
          <span className="symbol-picker-chip-count">{selected.size.toLocaleString()}</span>
        </label>
        <button type="button" className="symbol-picker-save" onClick={() => void save()} disabled={saving || selected.size === 0}>
          {saving ? 'Saving…' : 'Save selection.json'}
        </button>
      </div>

      <p className="symbol-picker-status" role="status">{status}</p>

      <div
        className="symbol-picker-grid"
        role="region"
        aria-label="Codepoints"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop + element.clientHeight >= element.scrollHeight - 400) {
            setLimit((current) => current + PAGE_SIZE);
          }
        }}
      >
        {visible.map((row) => {
          const ticks = row.variants.filter((variant) => selected.has(toEntry(variant))).length;
          return (
            <article className="symbol-picker-item" key={row.codepoint}>
              <h2 className="symbol-picker-item-title">
                <span className="symbol-picker-codepoint">{formatCodepoint(row.codepoint)}</span>
                <span className="symbol-picker-item-name">{row.name}</span>
                <span className="symbol-picker-item-block">{row.block}</span>
                {ticks > 0 && ticks < row.poolSize && (
                  <span className="symbol-picker-tick-count">{ticks} of {row.poolSize} in pool</span>
                )}
              </h2>
              <div className="symbol-picker-variants">
                {row.variants.map((variant) => {
                  const entry = toEntry(variant);
                  const on = selected.has(entry);
                  const family = fonts[variant.font]?.family ?? variant.font;
                  const face = `"${variant.font}", serif`;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      className={on ? 'symbol-picker-variant is-selected' : 'symbol-picker-variant'}
                      aria-pressed={on}
                      aria-label={`${family} ${formatCodepoint(row.codepoint)} ${row.name}`}
                      title={`${family} · ${formatCodepoint(row.codepoint)} · ${row.name} · ${row.block}`}
                      onClick={() => toggle(entry)}
                    >
                      <span className="symbol-picker-glyph" style={{ fontFamily: face }} aria-hidden="true">
                        {String.fromCodePoint(variant.codepoint)}
                      </span>
                      <span className="symbol-picker-font-name">{family}</span>
                      <span className="symbol-picker-sizes" aria-hidden="true">
                        <b style={{ fontFamily: face, fontSize: 8 }}>{String.fromCodePoint(variant.codepoint)}</b>
                        <b style={{ fontFamily: face, fontSize: 16 }}>{String.fromCodePoint(variant.codepoint)}</b>
                        <b style={{ fontFamily: face, fontSize: 24 }}>{String.fromCodePoint(variant.codepoint)}</b>
                      </span>
                    </button>
                  );
                })}
              </div>
            </article>
          );
        })}
        {visible.length === 0 && <p className="symbol-picker-empty">{emptyMessage}</p>}
        {visible.length < rows.length && (
          <p className="symbol-picker-more">Showing {visible.length.toLocaleString()} of {rows.length.toLocaleString()}. Scroll for more.</p>
        )}
      </div>
    </div>
  );
}
