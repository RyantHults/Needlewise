import { useEffect, useRef, useState } from 'react';
import { createCatalogReference, type CatalogDefinition, type CatalogRecord } from '../catalog';
import type { DisplayUnits, PatternDocument, PatternMetrics, PaletteMetrics } from '../domain';
import type { ProgressActivity } from '../persistence';
import type { SessionProgressStats } from '../application/progress';
import type { ProjectWorkspace } from '../application/workspace';
import { ColorPickerModal } from './ColorPickerModal';
import { Modal } from './Modal';

interface Props { document: PatternDocument; metrics: PatternMetrics | null; sessionStats: SessionProgressStats | null; activity: ProgressActivity | null; execute: (command: { type: string; [key: string]: unknown }) => Promise<unknown>; workspace: ProjectWorkspace; open?: boolean; onClose?: () => void }

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

export function Phase3Panel({ document, metrics, execute, workspace, open: controlledOpen, onClose }: Props) {
  const materialsOpen = controlledOpen ?? true;
  const [open, setOpen] = useState(false);
  const catalogs = workspace.availableCatalogs();
  const primaryCatalog = workspace.catalogFor(document);
  const defaultCatalogId = catalogs.some((item) => item.association.catalogId === primaryCatalog?.association.catalogId)
    ? primaryCatalog!.association.catalogId
    : catalogs[0]?.association.catalogId ?? '';
  const [notice, setNotice] = useState('');
  const launcher = useRef<HTMLButtonElement>(null);
  const settings = workspace.materialSettings ?? { strands: 1, waste: 0 };
  const [form, setForm] = useState({ strands: String(settings.strands), waste: String(settings.waste * 100) });
  const active = document.palette.filter((entry) => entry.active);
  const catalogIdsByCode = new Map<string, Set<string>>();
  for (const entry of active) {
    if (!entry.catalog) continue;
    const ids = catalogIdsByCode.get(entry.catalog.code) ?? new Set<string>();
    ids.add(entry.catalog.catalogId);
    catalogIdsByCode.set(entry.catalog.code, ids);
  }
  const duplicateCodes = new Set([...catalogIdsByCode].filter(([, ids]) => ids.size > 1).map(([code]) => code));
  const catalogDefinition = catalogs.find((item) => item.association.catalogId === defaultCatalogId);

  // Material inputs belong to the active project. Do not carry a previous
  // project's draft form into this panel while the workspace is switching.
  useEffect(() => setForm({ strands: String(settings.strands), waste: String(settings.waste * 100) }), [workspace.activeProjectId, settings.strands, settings.waste]);

  const create = async (command: { type: 'palette-create'; [key: string]: unknown }) => {
    try {
      await execute(command);
      setOpen(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'This color could not be added.'); }
  };
  const add = (color: CatalogRecord, catalog: CatalogDefinition) => create({ type: 'palette-create', name: color.name, color: color.hex, catalog: createCatalogReference(catalog, color) });
  const addCustom = (hex: string, match: CatalogRecord | undefined, catalog: CatalogDefinition | undefined) =>
    match && catalog ? add(match, catalog) : create({ type: 'palette-create', name: hex, color: hex });
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

  if (!materialsOpen) return null;
  return <Modal className="materials-dialog" titleId="materials-title" eyebrow="Materials & progress" title="Plan the thread" closeLabel="Close materials and progress" onClose={() => onClose?.()} initialFocus=".modal-close" returnFocus={false}>
    <section className="phase3-panel" aria-labelledby="materials-title">
      <div className="phase3-heading"><p className="catalog-disclaimer">{catalogDefinition ? `${catalogDefinition.association.brandLabel}-compatible colors are available in this pattern.` : 'Catalog unavailable'}</p></div>
      <div className="phase3-grid"><section className="palette-manager" aria-labelledby="palette-title"><div className="palette-title-row"><h3 id="palette-title">{active.length ? active.map((entry) => entry.name).join(' and ') : 'Palette'} </h3><button ref={launcher} className="add-palette-button" type="button" aria-label="Add a color to the palette" disabled={!catalogs.length} onClick={() => { setNotice(''); setOpen(true); }}>+</button></div>
       {active.map((entry) => { const item = paletteMetrics.get(entry.id); const yards = materialYardage(item?.material); const brand = entry.catalog && duplicateCodes.has(entry.catalog.code) ? workspace.catalogById(entry.catalog.catalogId)?.association.brandLabel : undefined; return <div className="material-row" key={entry.id}><span className="swatch" style={{ background: entry.color }} /><span className="material-main"><strong>{entry.name}{brand && <small className="material-catalog-brand">{brand} · {entry.catalog?.code}</small>}</strong><span>{item ? `${item.full} full · ${item.half} half · ${item.quarter} quarter · ${item.threeQuarter ?? 0} 3/4 · ${item.backstitch} backstitch` : 'No stitches yet'}</span></span><span className="material-estimate">{materialLine(item?.material)}{yards !== null && <span className="material-yards">{yards}</span>}</span></div>; })}
    </section><aside className="catalog-box"><h3>Material model</h3><form onSubmit={(event) => void save(event)}><label htmlFor="material-strands">Strands per stitch</label><input id="material-strands" type="number" min="1" step="1" value={form.strands} onChange={(event) => setForm({ ...form, strands: event.target.value })} /><label htmlFor="material-waste">Waste allowance (%)</label><input id="material-waste" type="number" min="0" step="1" value={form.waste} onChange={(event) => setForm({ ...form, waste: event.target.value })} /><button className="button button-secondary" type="submit">Save material settings</button></form></aside></div>
    <div className="estimate-card"><strong>Finished size and thread total</strong><p>{finishedSize ?? 'Finished size unavailable — no Aida count is set.'}</p><p>Total: {materialLine(total)}{totalYards !== null && <span className="material-yards">{totalYards}</span>}</p><p className="material-note">{modelNote}</p></div>
    {metrics?.progress && <div className="progress-strip"><div><span>Progress</span><strong>{number(metrics.progress.percent)}%</strong><progress max="100" value={metrics.progress.percent} /></div><div><span>Completed</span><strong>{metrics.progress.completedComponents}</strong></div><div><span>Remaining</span><strong>{metrics.progress.remainingComponents}</strong></div><div><span>Total</span><strong>{metrics.progress.totalComponents}</strong></div></div>}
    {open && <ColorPickerModal
      eyebrow="Color Catalog"
      title="Add a thread color"
      catalogs={catalogs}
      defaultCatalogId={defaultCatalogId}
      verb="Add"
      onPickCatalogColor={(color, catalog) => void add(color, catalog)}
      onPickCustomColor={(hex, match, catalog) => void addCustom(hex, match, catalog)}
      customActionLabel={(hex, match) => match ? `Add ${match.name}` : hex ? `Add ${hex}` : 'Add custom color'}
      notice={notice}
      onClose={() => setOpen(false)}
      returnFocus={launcher}
    />}
    </section></Modal>;
}
