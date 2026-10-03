import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import candidatesAsset from '../symbols/candidates.generated.json';
import selectionAsset from '../symbols/selection.json';
import './symbol-picker.css';

/**
 * The symbol pool curation tool, served at /__symbols in dev only.
 *
 * The pool is the selection in src/symbols/selection.json, and the page has two
 * modes for looking at it, which share one mark: a codepoint drawn by a compared
 * font is a mark, set in that font, and a mark is the tick target.
 *
 * Browsing is a wall of those marks grouped by codepoint, ascending. A codepoint
 * two compared fonts both draw is one group of two adjacent marks, so the
 * variants can be compared in place, and a codepoint only one font draws is a
 * group of one. Each group carries a collapsed expander holding the things the
 * wall does not show: the codepoint, the name, the block, and, per font, the
 * family name and the samples at 24, 16 and 8 pixels. The mark the samples are
 * sizes of stays on the wall, so the detail never draws it a second time. The
 * description is also one hover away on every mark, so a curator scanning
 * thousands of codepoints is not reading, and opening a group is the deliberate
 * act.
 *
 * Reviewing drops the groups and shows the ticked marks alone in one dense grid,
 * so the chosen set can be judged as a whole — whether the weights, the rhythm
 * and the shapes hold together. Each mark is drawn from the outline the build
 * emits for it, fetched from /__symbols/outlines, because a font's own text is
 * neither extent-normalized nor able to show an adjustment. Clicking a mark opens
 * it in the adjust panel beside the grid, which holds a large preview, the 24, 16
 * and 8 pixel samples, a boldness slider and a size slider, Reset, and Untick.
 * Moving a slider refetches that one outline, and a crop or validation error
 * shows in the panel while the last good outline stays drawn. A mark with an
 * adjustment carries a dot. Saving sends the selection together with the
 * adjustments of the entries still in it.
 *
 * Which fonts to compare is a multi-select rather than a filter: any number of
 * them can be on at once, and a codepoint is in the grid whenever at least one
 * compared font can draw it. Narrowing the fonts therefore narrows the grid, and
 * a codepoint no compared font holds is simply not there.
 *
 * The number of ticked fonts reaches the stylesheet as --compared-fonts, which
 * bounds one mark's track to a fair share of the wall, so a group of many fonts
 * cannot outgrow the row it is on. A group's own width is that track times the
 * fonts it holds.
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
 * Browsing shows glyphs with an @font-face of the vendored fonts rather than the
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

/** The per-glyph adjustments the selection file may carry, in cell units. */
interface Adjustment {
  readonly embolden?: number;
  readonly scale?: number;
  readonly offset?: readonly [number, number];
}

interface SelectionFile {
  readonly version: number;
  readonly selection: readonly string[];
  readonly adjustments?: Readonly<Record<string, Adjustment>>;
}

/** What the outlines route returns for one entry, and what the page keeps of it. */
type OutlineResult = { readonly d: string } | { readonly error: string };

interface Outline {
  /** The last outline that built, kept drawn while a newer adjustment fails. */
  readonly d?: string;
  readonly error?: string;
}

/** One group of the wall: a codepoint, the mark each compared font has for it, and its details. */
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

const authoredFile = selectionAsset as unknown as SelectionFile;
const authored = new Set(authoredFile.selection);

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

const familyOf = (slug: string): string => fonts[slug]?.family ?? slug;

/**
 * The one description of a glyph, used as its hover text and as its accessible
 * name in both modes, so the two can never disagree about what a mark is.
 */
const describeVariant = (variant: Candidate, name: string, block: string): string =>
  `${familyOf(variant.font)} · ${formatCodepoint(variant.codepoint)} · ${name} · ${block}`;

const EMBOLDEN_RANGE = { min: 0, max: 0.06, step: 0.005 } as const;
const SCALE_RANGE = { min: 0.5, max: 1.3, step: 0.05 } as const;
const DEFAULT_TILE_VIEW = 0.5;
const OUTLINE_DEBOUNCE_MS = 150;
const SAMPLE_SIZES = [24, 16, 8] as const;

/** An adjustment that changes nothing is the same as none, so it earns no indicator. */
const isAdjusted = (adjustment: Adjustment | undefined): boolean => adjustment !== undefined
  && ((adjustment.embolden ?? 0) > 0
    || (adjustment.scale ?? 1) !== 1
    || (adjustment.offset ?? [0, 0]).some((axis) => axis !== 0));

/** A pool outline in the cell it was built for, filled like every symbol the app draws. */
function OutlineSvg({ d, tileView, className, size }: {
  d: string | undefined;
  tileView: number;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      viewBox={`${-tileView} ${-tileView} ${2 * tileView} ${2 * tileView}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {d && <path d={d} fill="currentColor" />}
    </svg>
  );
}

/** How many codepoints to paint at once, so the page stays responsive on first paint. */
const PAGE_SIZE = 600;

function matches(candidate: Candidate, needle: string, asCodepoint: number | null): boolean {
  return candidate.name.includes(needle)
    || candidate.block.toLowerCase().includes(needle)
    || candidate.id.includes(needle)
    || fonts[candidate.font]?.family.toLowerCase().includes(needle) === true
    || (asCodepoint !== null && candidate.codepoint === asCodepoint)
    || String.fromCodePoint(candidate.codepoint) === needle;
}

/** The entry's candidate, for its description, from the catalog. */
const candidateByEntry = new Map(candidates.map((candidate) => [toEntry(candidate), candidate]));

/**
 * The docked panel beside the review grid: one entry's outline at preview size
 * and at the chart sizes, and the two sliders that adjust it. It stays beside
 * the grid while the grid scrolls, and sits above it at narrow widths.
 */
function AdjustPanel({ entry, adjustment, outline, tileView, onAdjust, onReset, onUntick }: {
  entry: string | null;
  adjustment: Adjustment | undefined;
  outline: Outline | undefined;
  tileView: number;
  onAdjust: (entry: string, patch: Adjustment) => void;
  onReset: (entry: string) => void;
  onUntick: (entry: string) => void;
}) {
  const candidate = entry ? candidateByEntry.get(entry) : undefined;
  if (!entry || !candidate) {
    return (
      <aside className="symbol-picker-adjust" aria-label="Adjust symbol">
        <p className="symbol-picker-adjust-hint">Pick a mark to adjust its boldness and size.</p>
      </aside>
    );
  }
  const embolden = adjustment?.embolden ?? 0;
  const scale = adjustment?.scale ?? 1;
  const { name, block } = names.get(candidate.codepoint)!;
  const description = describeVariant(candidate, name, block);
  return (
    <aside className="symbol-picker-adjust" aria-label={`Adjust ${description}`}>
      <div className="symbol-picker-adjust-view">
        <OutlineSvg d={outline?.d} tileView={tileView} className="symbol-picker-adjust-preview" />
        <span className="symbol-picker-sizes" aria-hidden="true">
          {SAMPLE_SIZES.map((size) => (
            <OutlineSvg key={size} d={outline?.d} tileView={tileView} size={size} />
          ))}
        </span>
      </div>
      <div className="symbol-picker-adjust-controls">
        <h2 className="symbol-picker-adjust-title">
          <span className="symbol-picker-codepoint">{formatCodepoint(candidate.codepoint)}</span>
          <span className="symbol-picker-detail-name">{name}</span>
          <span className="symbol-picker-detail-block">{familyOf(candidate.font)}</span>
        </h2>
        <div className="symbol-picker-slider">
          <label htmlFor="symbol-picker-embolden">Boldness</label>
          <input
            id="symbol-picker-embolden"
            type="range"
            {...EMBOLDEN_RANGE}
            value={embolden}
            onChange={(event) => onAdjust(entry, { embolden: Number(event.target.value) })}
          />
          <output htmlFor="symbol-picker-embolden">{embolden.toFixed(3)}</output>
        </div>
        <div className="symbol-picker-slider">
          <label htmlFor="symbol-picker-scale">Size</label>
          <input
            id="symbol-picker-scale"
            type="range"
            {...SCALE_RANGE}
            value={scale}
            onChange={(event) => onAdjust(entry, { scale: Number(event.target.value) })}
          />
          <output htmlFor="symbol-picker-scale">{scale.toFixed(2)}×</output>
        </div>
        <p className="symbol-picker-adjust-error" role="alert">{outline?.error ?? ''}</p>
        <div className="symbol-picker-adjust-actions">
          <button type="button" onClick={() => onReset(entry)} disabled={!isAdjusted(adjustment)}>Reset</button>
          <button type="button" onClick={() => onUntick(entry)}>Untick</button>
        </div>
      </div>
    </aside>
  );
}

export default function SymbolPickerPage() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(authored));
  const [compared, setCompared] = useState<ReadonlySet<string>>(() => new Set(fontSlugs));
  const [query, setQuery] = useState('');
  // The two modes: browsing codepoints as grouped marks, or reviewing the ticked
  // marks on their own.
  const [review, setReview] = useState(false);
  // Which groups have their details open, by codepoint. A group is opened one at
  // a time on purpose, so a curator comparing thousands of codepoints is not
  // reading a wall of detail by accident.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  // The adjustments start as the authored file has them, and the page never
  // forgets one on an untick, so a re-tick finds it again. Only the entries
  // still selected are saved.
  const [adjustments, setAdjustments] = useState<Readonly<Record<string, Adjustment>>>(
    () => ({ ...authoredFile.adjustments })
  );
  const [outlines, setOutlines] = useState<Readonly<Record<string, Outline>>>({});
  const [tileView, setTileView] = useState(DEFAULT_TILE_VIEW);
  const [pending, setPending] = useState(0);
  // The entry open in the adjust panel.
  const [active, setActive] = useState<string | null>(null);
  // A response only lands if no newer request for its entry has gone out, so a
  // slow answer for an old slider position cannot overwrite a newer one.
  const requests = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, number>());
  // Typing in the search box should not rebuild a list of thousands of rows.
  const deferredQuery = useDeferredValue(query);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scheduled = timers.current;
    return () => { for (const timer of scheduled.values()) window.clearTimeout(timer); };
  }, []);
  // The tick state is a filter input only while reviewing, so a tick while
  // browsing leaves the row list alone.
  const reviewed = review ? selected : null;

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
  const activeEntry = review && active !== null && selected.has(active) ? active : null;

  const emptyMessage = compared.size === 0
    ? 'No fonts are being compared. Tick a font above to see what it can draw.'
    : review
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

  function toggleDetails(codepoint: number) {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(codepoint)) next.add(codepoint);
      return next;
    });
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

  /** Switching to reviewing drops the search, which rarely survives a whole-set read. */
  function toggleReview() {
    setReview((current) => !current);
    if (!review) {
      setQuery('');
      void loadOutlines([...selected], adjustments);
    }
    resetView();
  }

  /** Build the outlines for these entries on the server and keep what comes back. */
  async function loadOutlines(entries: readonly string[], toApply: Readonly<Record<string, Adjustment>>) {
    if (entries.length === 0) return;
    const sent = new Map(entries.map((entry) => [entry, (requests.current.get(entry) ?? 0) + 1]));
    for (const [entry, serial] of sent) requests.current.set(entry, serial);
    setPending((count) => count + 1);
    try {
      const response = await fetch('/__symbols/outlines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries,
          adjustments: Object.fromEntries(entries.filter((entry) => entry in toApply).map((entry) => [entry, toApply[entry]]))
        })
      });
      const payload = await response.json() as {
        tileView?: number;
        outlines?: Record<string, OutlineResult>;
        error?: string;
      };
      if (!response.ok || !payload.outlines) {
        setStatus(payload.error ?? 'The outlines could not be built.');
        return;
      }
      const built = payload.outlines;
      if (payload.tileView) setTileView(payload.tileView);
      setOutlines((current) => {
        const next = { ...current };
        for (const [entry, serial] of sent) {
          const result = built[entry];
          if (!result || requests.current.get(entry) !== serial) continue;
          next[entry] = 'd' in result ? { d: result.d } : { d: current[entry]?.d, error: result.error };
        }
        return next;
      });
    } catch {
      setStatus('The outlines could not be built. Is the dev server running?');
    } finally {
      setPending((count) => count - 1);
    }
  }

  /** Change one entry's adjustment and refetch its outline once the slider settles. */
  function adjust(entry: string, patch: Adjustment) {
    const next = { ...adjustments[entry], ...patch };
    setAdjustments((current) => ({ ...current, [entry]: next }));
    setStatus('');
    window.clearTimeout(timers.current.get(entry));
    timers.current.set(entry, window.setTimeout(() => {
      timers.current.delete(entry);
      void loadOutlines([entry], { [entry]: next });
    }, OUTLINE_DEBOUNCE_MS));
  }

  function reset(entry: string) {
    window.clearTimeout(timers.current.get(entry));
    timers.current.delete(entry);
    setAdjustments((current) => {
      const next = { ...current };
      delete next[entry];
      return next;
    });
    setStatus('');
    void loadOutlines([entry], {});
  }

  function untick(entry: string) {
    toggle(entry);
    setActive(null);
  }

  async function save() {
    setSaving(true);
    setStatus('Saving…');
    try {
      const response = await fetch('/__symbols/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selection: [...selected].sort(),
          adjustments: Object.fromEntries(
            Object.entries(adjustments).filter(([entry, adjustment]) => selected.has(entry) && isAdjusted(adjustment))
          )
        })
      });
      const payload = await response.json() as {
        saved?: number;
        adjusted?: number;
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
        payload.adjusted ? `${payload.adjusted} adjusted` : null,
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
        <label
          className={review ? 'symbol-picker-chip is-on' : 'symbol-picker-chip'}
          title="Review the ticked symbols as bare glyphs, to see whether the set holds together"
        >
          <input
            type="checkbox"
            checked={review}
            onChange={toggleReview}
          />
          Selected only
          <span className="symbol-picker-chip-count">{selected.size.toLocaleString()}</span>
        </label>
        <button type="button" className="symbol-picker-save" onClick={() => void save()} disabled={saving || selected.size === 0}>
          {saving ? 'Saving…' : 'Save selection.json'}
        </button>
      </div>

      <p className="symbol-picker-status" role="status">{status}</p>

      <div className={review ? 'symbol-picker-body is-reviewing' : 'symbol-picker-body'}>
      <div
        className={review ? 'symbol-picker-grid is-marks' : 'symbol-picker-grid is-wall'}
        role="region"
        aria-label={review ? 'Ticked symbols' : 'Codepoints'}
        ref={scroller}
        style={{ '--compared-fonts': compared.size } as CSSProperties}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop + element.clientHeight >= element.scrollHeight - 400) {
            setLimit((current) => current + PAGE_SIZE);
          }
        }}
      >
        {review
          ? visible.flatMap((row) => row.variants.map((variant) => {
            const entry = toEntry(variant);
            const description = describeVariant(variant, row.name, row.block);
            const outline = outlines[entry];
            const classes = ['symbol-picker-mark', 'is-selected'];
            if (isAdjusted(adjustments[entry])) classes.push('is-adjusted');
            if (outline?.error) classes.push('is-error');
            if (entry === activeEntry) classes.push('is-active');
            return (
              <button
                key={variant.id}
                type="button"
                className={classes.join(' ')}
                aria-pressed={entry === activeEntry}
                aria-label={description}
                title={description}
                onClick={() => setActive(entry)}
              >
                <OutlineSvg d={outline?.d} tileView={tileView} />
              </button>
            );
          }))
          : visible.map((row) => {
            const expanded = open.has(row.codepoint);
            const detailId = `symbol-picker-detail-${row.codepoint}`;
            const ticks = row.variants.filter((variant) => selected.has(toEntry(variant))).length;
            return (
              <article
                className={expanded ? 'symbol-picker-group is-open' : 'symbol-picker-group'}
                key={row.codepoint}
                style={{ '--group-fonts': row.variants.length } as CSSProperties}
              >
                <div className="symbol-picker-group-head">
                  <div className="symbol-picker-group-marks">
                    {row.variants.map((variant) => {
                      const entry = toEntry(variant);
                      const on = selected.has(entry);
                      const description = describeVariant(variant, row.name, row.block);
                      return (
                        <button
                          key={variant.id}
                          type="button"
                          className={on ? 'symbol-picker-mark is-selected' : 'symbol-picker-mark'}
                          aria-pressed={on}
                          aria-label={description}
                          title={description}
                          style={{ fontFamily: `"${variant.font}", serif` }}
                          onClick={() => toggle(entry)}
                        >
                          {String.fromCodePoint(variant.codepoint)}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="symbol-picker-expander"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    aria-label={`Details for ${formatCodepoint(row.codepoint)}, ${row.name}`}
                    title={expanded ? `Hide the details of ${formatCodepoint(row.codepoint)}` : `Show what ${formatCodepoint(row.codepoint)} is and how large it draws`}
                    onClick={() => toggleDetails(row.codepoint)}
                  >
                    <span className="symbol-picker-caret" aria-hidden="true" />
                  </button>
                </div>
                {expanded && <div className="symbol-picker-detail" id={detailId}>
                  <h2 className="symbol-picker-detail-title">
                    <span className="symbol-picker-codepoint">{formatCodepoint(row.codepoint)}</span>
                    <span className="symbol-picker-detail-name">{row.name}</span>
                    <span className="symbol-picker-detail-block">{row.block}</span>
                    {ticks > 0 && ticks < row.poolSize && (
                      <span className="symbol-picker-tick-count">{ticks} of {row.poolSize} in pool</span>
                    )}
                  </h2>
                  {/* The mark itself is on the wall directly above, so a variant
                      is named by its font and sized against it, with the largest
                      sample leading the row. */}
                  <div className="symbol-picker-detail-variants">
                    {row.variants.map((variant) => {
                      const face = `"${variant.font}", serif`;
                      return (
                        <div
                          key={variant.id}
                          className={selected.has(toEntry(variant)) ? 'symbol-picker-detail-variant is-selected' : 'symbol-picker-detail-variant'}
                        >
                          <span className="symbol-picker-font-name">{familyOf(variant.font)}</span>
                          <span className="symbol-picker-sizes" aria-hidden="true">
                            <b style={{ fontFamily: face, fontSize: 24 }}>{String.fromCodePoint(variant.codepoint)}</b>
                            <b style={{ fontFamily: face, fontSize: 16 }}>{String.fromCodePoint(variant.codepoint)}</b>
                            <b style={{ fontFamily: face, fontSize: 8 }}>{String.fromCodePoint(variant.codepoint)}</b>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>}
              </article>
            );
          })}
        {review && pending > 0 && <p className="symbol-picker-more">Building outlines…</p>}
        {visible.length === 0 && <p className="symbol-picker-empty">{emptyMessage}</p>}
        {visible.length < rows.length && (
          <p className="symbol-picker-more">Showing {visible.length.toLocaleString()} of {rows.length.toLocaleString()}. Scroll for more.</p>
        )}
      </div>
      {review && (
        <AdjustPanel
          entry={activeEntry}
          adjustment={activeEntry ? adjustments[activeEntry] : undefined}
          outline={activeEntry ? outlines[activeEntry] : undefined}
          tileView={tileView}
          onAdjust={adjust}
          onReset={reset}
          onUntick={untick}
        />
      )}
      </div>
    </div>
  );
}
