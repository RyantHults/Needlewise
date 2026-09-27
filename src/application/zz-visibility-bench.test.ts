import { it } from 'vitest';
import { CellKind, createLayeredDocument, DocumentEditor, LayerType, applyLayerStructureCommand, layerAddCommand, type LayeredDocument, type StitchLayer } from '../domain';
import type { PersistencePreparationClient, ProjectMetadata, SaveResult } from '../persistence';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { ProjectSession } from './session';
import { ProgressMetricsService } from './progress';
import { ProjectWorkspace } from './workspace';
import type { WorkspaceRepository } from './types';

const prep: PersistencePreparationClient = { prepare: () => Promise.reject(new Error('x')), getRequestId: () => '', dispose: () => undefined };

function doc(side: number): LayeredDocument {
  const d = createLayeredDocument({ width: side, height: side, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'R', color: '#d33' }, { id: 2, name: 'B', color: '#36c' }] });
  applyLayerStructureCommand(d, layerAddCommand(LayerType.Stitch, { id: 3 }));
  const full = d.layers.find((l) => l.id === 1) as StitchLayer;
  full.kind.fill(CellKind.Full);
  for (let i = 0; i < full.kind.length; i += 1) full.colors[i * 4] = 1;
  const partial = d.layers.find((l) => l.id === 3) as StitchLayer;
  for (let i = 0; i < partial.kind.length; i += 7) { partial.kind[i] = CellKind.Full; partial.colors[i * 4] = 2; }
  return d;
}

function time<T>(stats: Record<string, number>, key: string, fn: () => T): T {
  const t = performance.now();
  try { return fn(); } finally { stats[key] = (stats[key] ?? 0) + performance.now() - t; }
}

for (const side of [200, 1000]) {
  it(`visibility toggle ${String(side)}`, async () => {
    const repository = { save: async (_i: string, _m: ProjectMetadata, d: LayeredDocument): Promise<SaveResult> => ({ committed: true, stale: false, revision: d.revision }) } as unknown as WorkspaceRepository;
    const d = doc(side);
    const session = new ProjectSession({ repository, metadata: { id: 'b', title: 'b', notes: '', createdAt: 0, updatedAt: 0, revision: d.revision }, document: d, preparationClient: prep, clock: { now: () => 0 }, debounceMs: 60_000 });
    const workspace = new ProjectWorkspace({ repository, preparationClient: prep });
    (workspace as unknown as { setActive(s: ProjectSession): void }).setActive(session);
    const stats: Record<string, number> = {};
    const exec = DocumentEditor.prototype.execute;
    const applyComposite = ProgressMetricsService.prototype.applyComposite;
    DocumentEditor.prototype.execute = function (this: DocumentEditor, ...a: Parameters<typeof exec>) { return time(stats, 'editor.execute', () => exec.apply(this, a)); };
    ProgressMetricsService.prototype.applyComposite = function (this: ProgressMetricsService, ...a: Parameters<typeof applyComposite>) { return time(stats, 'metrics', () => applyComposite.apply(this, a)); };
    workspace.subscribe(() => undefined);
    const runs = 6;
    for (let r = 0; r < runs; r += 1) time(stats, 'toggle full layer', () => workspace.setLayerVisibility(1, r % 2 === 1));
    stats['metrics(full)'] = stats.metrics; stats['execute(full)'] = stats['editor.execute']; stats.metrics = 0; stats['editor.execute'] = 0;
    for (let r = 0; r < runs; r += 1) time(stats, 'toggle sparse layer', () => workspace.setLayerVisibility(3, r % 2 === 1));
    DocumentEditor.prototype.execute = exec;
    ProgressMetricsService.prototype.applyComposite = applyComposite;
    const { cloneLayeredDocument, deriveProjectSummary, encodeDocument } = await import('../persistence');
    const layered = session.layeredDocument;
    time(stats, 'save: cloneLayeredDocument', () => cloneLayeredDocument(layered));
    time(stats, 'save: deriveProjectSummary', () => deriveProjectSummary(layered));
    time(stats, 'save: encodeDocument', () => encodeDocument(layered));
    time(stats, 'save: exportHistoryEnvelope', () => (session as unknown as { exportHistoryEnvelope(): unknown }).exportHistoryEnvelope());
    for (const key of Object.keys(stats)) if (key.startsWith('save:')) stats[key] *= runs;
    const fs = await import('node:fs');
    fs.appendFileSync(process.env.BENCH_OUT ?? 'bench.txt', `${String(side)} ${JSON.stringify(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, (v / runs).toFixed(1) + 'ms'])))}\n`);
    await session.dispose();
  }, 120_000);
}
