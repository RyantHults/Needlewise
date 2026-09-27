import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { it, vi } from 'vitest';
import { applyLayerStructureCommand, CellKind, createLayeredDocument, layerAddCommand, layerSetVisibilityCommand, type LayeredDocument, type StitchLayer } from '../../domain';
import * as thumbs from '../../rendering/layer-thumbnail';
import { LayersPanel } from './LayersPanel';

const catalog = { catalogId: 'test', brandLabel: 'Test', colorCount: 500 } as never;
const make = (size: number): LayeredDocument => {
  const d = createLayeredDocument({ width: size, height: size, catalog, palette: [{ name: 'Red', color: '#FF0000' }, { name: 'Blue', color: '#0000FF' }] });
  applyLayerStructureCommand(d, layerAddCommand('stitch', { name: 'Top' }));
  const full = d.layers.find((l) => l.id === 1) as StitchLayer;
  for (let i = 0; i < size * size; i += 1) { full.kind[i] = CellKind.Full; full.colors[i * 4] = d.palette[i % 2]!.id; }
  return d;
};
const panel = (d: LayeredDocument) => <LayersPanel document={d} activeLayerId={1} backgroundColor="#fff" reference={{ present: false, visible: true }} onSelect={vi.fn()} onToggleVisibility={vi.fn()} onToggleReferenceVisibility={vi.fn()} onAddReference={vi.fn()} onMove={vi.fn()} onAdd={vi.fn()} />;

for (const size of [200, 1000]) {
  it(`perf ${size}`, async () => {
    const d = make(size);
    let t = performance.now();
    for (const l of d.layers) thumbs.renderLayerThumbnailPixels(d, l);
    process.stderr.write("\n" + [size, 'thumbnail compute all layers ms', (performance.now() - t).toFixed(1)].join(" ") + "\n");
    const spy = vi.spyOn(thumbs, 'renderLayerThumbnailPixels');
    const view = render(<StrictMode>{panel(d)}</StrictMode>);
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    process.stderr.write("\n" + [size, 'initial thumbnail computes', spy.mock.calls.length].join(" ") + "\n");
    spy.mockClear();
    applyLayerStructureCommand(d, layerSetVisibilityCommand(3, false));
    const next = { ...d };
    t = performance.now();
    view.rerender(<StrictMode>{panel(next)}</StrictMode>);
    process.stderr.write("\n" + [size, 'panel rerender on toggle ms', (performance.now() - t).toFixed(1)].join(" ") + "\n");
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    process.stderr.write("\n" + [size, 'thumbnail computes after toggle', spy.mock.calls.length].join(" ") + "\n");
  });
}
