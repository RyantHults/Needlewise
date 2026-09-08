import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DMC_CATALOG_PROVENANCE, searchDmcColors } from '../catalog';
import type { DisplayUnits, PatternDocument, PatternMetrics, PaletteMetrics } from '../domain';
import type { ProgressActivity } from '../persistence';
import type { SessionProgressStats } from '../application/progress';
import type { ProjectWorkspace } from '../application/workspace';

interface Props { document: PatternDocument; metrics: PatternMetrics | null; sessionStats: SessionProgressStats | null; activity: ProgressActivity | null; execute: (command: { type: string; [key: string]: unknown }) => Promise<unknown>; workspace: ProjectWorkspace }

const number = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
const YARDS_PER_METER = 1.09361;
function materialLine(material: PaletteMetrics['material'] | Omit<PaletteMetrics['material'], 'paletteId'> | undefined): string {
  if (!material || material.estimatedMeters === undefined || material.estimatedSkeins === undefined) return 'Physical estimate unavailable';
  const skeinRange = material.estimateRange?.skeins;
  if (skeinRange) {
    // Collapse ranges that round identically (e.g. zero-to-zero) to one value.
    const min = number(skeinRange.min);
    const max = number(skeinRange.max);
    return min === max ? `${min} skeins` : `${min}–${max} skeins`;
  }
  return `${number(material.estimatedSkeins)} skeins`;
}
function materialYardage(material: PaletteMetrics['material'] | Omit<PaletteMetrics['material'], 'paletteId'> | undefined): string | null {
  if (!material || material.estimatedMeters === undefined) return null;
  const range = material.estimateRange?.meters;
  if (range) {
    const min = number(range.min * YARDS_PER_METER);
    const max = number(range.max * YARDS_PER_METER);
    return min === max ? `${min} yd` : `${min}–${max} yd`;
  }
  return `${number(material.estimatedMeters * YARDS_PER_METER)} yd`;
}

export function Phase3Panel({ document, metrics, execute, workspace }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const launcher = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const settings = workspace.materialSettings ?? { strands: 1, waste: 0 };
  const [form, setForm] = useState({ strands: String(settings.strands), waste: String(settings.waste * 100) });
  const active = document.palette.filter((entry) => entry.active);
  const results = useMemo(() => searchDmcColors(query, { limit: 8 }), [query]);

  // Material inputs belong to the active project. Do not carry a previous
  // project's draft form into this panel while the workspace is switching.
  useEffect(() => setForm({ strands: String(settings.strands), waste: String(settings.waste * 100) }), [workspace.activeProjectId, settings.strands, settings.waste]);

  useEffect(() => {
    if (!open) return;
    const root = globalThis.document.querySelector<HTMLElement>('[data-application]');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const el = dialog.current;
    if (!el) return () => { if (root) root.inert = wasInert; };
    const focusable = () => [...el.querySelectorAll<HTMLElement>('button, input')].filter((item) => !item.hasAttribute('disabled') && item.tabIndex >= 0);
    el.querySelector<HTMLInputElement>('#catalog-search')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const all = focusable(); const first = all[0]; const last = all.at(-1);
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    el.addEventListener('keydown', key);
    return () => { el.removeEventListener('keydown', key); if (root) root.inert = wasInert; };
  }, [open]);

  const close = () => { setOpen(false); window.setTimeout(() => launcher.current?.focus(), 0); };
  const add = async (color: ReturnType<typeof searchDmcColors>[number]) => {
    try {
      await execute({ type: 'palette-create', name: color.name, color: color.hex, catalog: { catalogId: 'dmc-compatible-screen-approximation', sourceId: color.sourceId, code: color.code, name: color.name, hex: color.hex, rgb: color.rgb } });
      close();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'This color could not be added.'); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    await workspace.updateActiveMaterialSettings({ strands: Number(form.strands), waste: Number(form.waste) / 100 });
  };
  const paletteMetrics = new Map(metrics?.palettes.map((entry) => [entry.paletteId, entry]));
  const total = metrics?.totalMaterial;
  const totalYards = materialYardage(total);
  const modelNote = total?.assumptions?.note ?? 'Physical length is unavailable until an Aida count or manual stitch-length calibration is supplied.';
  const units: DisplayUnits = workspace.metadata?.units ?? 'metric';
  const finished = metrics?.finishedSize;
  const finishedSize = finished === undefined ? null : `${units === 'metric'
    ? `${number(finished.widthCm)} × ${number(finished.heightCm)} cm`
    : `${number(finished.widthInches)} × ${number(finished.heightInches)} in`}, based on ${number(total?.assumptions?.aidaCount ?? document.width / finished.widthInches)}-count Aida.`;

  const catalog = open ? createPortal(
    <div className="modal-backdrop" role="presentation">
      <div ref={dialog} className="catalog-dialog create-modal" role="dialog" aria-modal="true" aria-labelledby="catalog-title">
        <button className="modal-close" type="button" aria-label="Close catalog dialog" onClick={close}>×</button>
        <p className="section-label">Offline catalog</p><h2 id="catalog-title">Add a thread color</h2>
        <div className="catalog-box"><label htmlFor="catalog-search">Search offline catalog</label><input id="catalog-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or DMC code" />
          <ul className="catalog-results">{results.map((color) => <li key={color.code}><span className="swatch" style={{ background: color.hex }} /><span>{color.name} <small>#{color.code}</small></span><button className="small-action" type="button" aria-label={`Add ${color.name}`} onClick={() => void add(color)}>Add</button></li>)}</ul>
        </div>
        <p className="catalog-helper">{DMC_CATALOG_PROVENANCE.status.description} This catalog stays on your device.</p>{notice && <p className="modal-error" role="alert">{notice}</p>}
      </div>
    </div>, globalThis.document.body) : null;

  return <section className="phase3-panel" aria-labelledby="materials-title">
    <div className="phase3-heading"><div><p className="section-label">Materials &amp; progress</p><h2 id="materials-title">Plan the thread</h2></div><p className="catalog-disclaimer">Offline DMC-compatible colors are screen approximations. Confirm a real skein before buying.</p></div>
    <div className="phase3-grid"><section className="palette-manager" aria-labelledby="palette-title"><div className="palette-title-row"><h3 id="palette-title">{active.length ? active.map((entry) => entry.name).join(' and ') : 'Palette'} </h3><button ref={launcher} className="add-palette-button" type="button" aria-label="Add a color to the palette" onClick={() => { setNotice(''); setOpen(true); }}>+</button></div>
      {active.map((entry) => { const item = paletteMetrics.get(entry.id); const yards = materialYardage(item?.material); return <div className="material-row" key={entry.id}><span className="swatch" style={{ background: entry.color }} /><span className="material-main"><strong>{entry.name}</strong><span>{item ? `${item.full} full · ${item.half} half · ${item.quarter} quarter · ${item.backstitch} backstitch` : 'No stitches yet'}</span></span><span className="material-estimate">{materialLine(item?.material)}{yards !== null && <span className="material-yards">{yards}</span>}</span></div>; })}
    </section><aside className="catalog-box"><h3>Material model</h3><form onSubmit={(event) => void save(event)}><label htmlFor="material-strands">Strands per stitch</label><input id="material-strands" type="number" min="1" step="1" value={form.strands} onChange={(event) => setForm({ ...form, strands: event.target.value })} /><label htmlFor="material-waste">Waste allowance (%)</label><input id="material-waste" type="number" min="0" step="1" value={form.waste} onChange={(event) => setForm({ ...form, waste: event.target.value })} /><button className="button button-secondary" type="submit">Save material settings</button></form></aside></div>
    <div className="estimate-card"><strong>Finished size and thread total</strong><p>{finishedSize ?? 'Finished size unavailable — no Aida count is set.'}</p><p>Total: {materialLine(total)}{totalYards !== null && <span className="material-yards">{totalYards}</span>}</p><p className="material-note">{modelNote}</p></div>
    {metrics?.progress && <div className="progress-strip"><div><span>Progress</span><strong>{number(metrics.progress.percent)}%</strong><progress max="100" value={metrics.progress.percent} /></div><div><span>Completed</span><strong>{metrics.progress.completedComponents}</strong></div><div><span>Remaining</span><strong>{metrics.progress.remainingComponents}</strong></div><div><span>Total</span><strong>{metrics.progress.totalComponents}</strong></div></div>}
    {catalog}
  </section>;
}
