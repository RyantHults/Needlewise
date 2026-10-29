import { beforeEach, describe, expect, it } from 'vitest';
import { CellKind, createDocument, createPatternFragment, LayerType } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { clearClipboard, readClipboard, subscribeClipboard, writeClipboard, type ClipboardEntry } from './clipboard-store';

function entry(): ClipboardEntry {
  const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
  document.kind[0] = CellKind.Full;
  document.colors[0] = 1;
  return {
    fragment: createPatternFragment(document, { x: 0, y: 0, width: 2, height: 1 }),
    selection: { kind: 'rect', rect: { x: 0, y: 0, width: 2, height: 1 } },
    layerType: LayerType.Stitch,
    multiLayer: false,
    palette: document.palette
  };
}

beforeEach(clearClipboard);

describe('clipboard store', () => {
  it('starts empty and holds a copy isolated from both writer and readers', () => {
    expect(readClipboard()).toBeUndefined();
    const written = entry();
    writeClipboard(written);
    written.fragment.colors[0] = 9;
    const read = readClipboard()!;
    expect(read.fragment.colors[0]).toBe(1);
    expect(read).toMatchObject({ layerType: LayerType.Stitch, selection: written.selection, palette: [{ id: 1, name: 'Red' }] });
    read.fragment.kind[0] = CellKind.Empty;
    expect(readClipboard()!.fragment.kind[0]).toBe(CellKind.Full);
    expect(readClipboard()!.palette[0]).not.toBe(written.palette[0]);
  });

  it('notifies subscribers on write and clear until they unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeClipboard(() => { calls += 1; });
    writeClipboard(entry());
    clearClipboard();
    expect(readClipboard()).toBeUndefined();
    // Clearing an empty clipboard changes nothing, so it does not notify.
    clearClipboard();
    expect(calls).toBe(2);
    unsubscribe();
    writeClipboard(entry());
    expect(calls).toBe(2);
  });
});
