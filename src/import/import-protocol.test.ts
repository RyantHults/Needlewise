import { describe, expect, it } from 'vitest';
import {
  PATTERN_IMPORT_PROTOCOL,
  deserializeImportError,
  isPatternImportRequest,
  isPatternImportResponse,
  serializeImportError,
  transferableAnalysis
} from './import-protocol';
import { ImportError, type ImportAnalysis } from './types';

const envelope = { protocol: PATTERN_IMPORT_PROTOCOL, requestId: 'r1' };

function analysis(cells: Uint16Array): ImportAnalysis {
  return {
    format: 'fake', pages: [],
    chart: { width: 2, height: 2, cells, symbols: [], key: [], warnings: [] }
  };
}

describe('pattern import protocol', () => {
  it('accepts well-formed requests', () => {
    expect(isPatternImportRequest({ ...envelope, type: 'open', file: new Blob(['x']), fileName: 'a.pdf' })).toBe(true);
    expect(isPatternImportRequest({ ...envelope, type: 'reanalyze', overrides: { pageRoles: { 0: 'chart' } } })).toBe(true);
    expect(isPatternImportRequest({ ...envelope, type: 'cancel' })).toBe(true);
  });

  it('rejects malformed requests', () => {
    expect(isPatternImportRequest(null)).toBe(false);
    expect(isPatternImportRequest({ ...envelope, protocol: 'other', type: 'cancel' })).toBe(false);
    expect(isPatternImportRequest({ ...envelope, type: 'nope' })).toBe(false);
    expect(isPatternImportRequest({ ...envelope, type: 'open', file: 'x', fileName: 'a' })).toBe(false);
    expect(isPatternImportRequest({ ...envelope, type: 'reanalyze', overrides: { pageRoles: { 0: 'bad' } } })).toBe(false);
    expect(isPatternImportRequest({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'cancel' })).toBe(false);
  });

  it('validates responses', () => {
    expect(isPatternImportResponse({ ...envelope, type: 'progress', progress: { stage: 'reading', done: 1, total: 2 } })).toBe(true);
    expect(isPatternImportResponse({ ...envelope, type: 'progress', progress: { stage: 'x', done: 1, total: 2 } })).toBe(false);
    expect(isPatternImportResponse({ ...envelope, type: 'result', analysis: analysis(new Uint16Array(4)) })).toBe(true);
    expect(isPatternImportResponse({ ...envelope, type: 'result', analysis: { format: 'x' } })).toBe(false);
    expect(isPatternImportResponse({ ...envelope, type: 'cancelled' })).toBe(true);
    expect(isPatternImportResponse({ ...envelope, type: 'error', error: { code: 'invalid-pdf', message: 'm' } })).toBe(true);
    expect(isPatternImportResponse({ ...envelope, type: 'error', error: { code: 'bogus', message: 'm' } })).toBe(false);
  });

  it('round-trips ImportError codes', () => {
    const serialized = serializeImportError(new ImportError('encrypted-pdf', 'locked'));
    expect(serialized).toEqual({ code: 'encrypted-pdf', message: 'locked' });
    const error = deserializeImportError(serialized);
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe('encrypted-pdf');
  });

  it('keeps plain errors plain', () => {
    const error = deserializeImportError(serializeImportError(new Error('boom')));
    expect(error).not.toBeInstanceOf(ImportError);
    expect(error.message).toBe('boom');
  });

  it('transfers owned cell buffers and copies views', () => {
    const owned = new Uint16Array(4);
    expect(transferableAnalysis(analysis(owned)).transfer).toEqual([owned.buffer]);
    const view = new Uint16Array(new ArrayBuffer(16), 8, 4);
    const result = transferableAnalysis(analysis(view));
    expect(result.analysis.chart.cells.buffer).not.toBe(view.buffer);
    expect(result.transfer).toEqual([result.analysis.chart.cells.buffer]);
  });

  it('carries Blob page thumbnails in a result without transferring them', () => {
    const thumbnail = new Blob(['png'], { type: 'image/png' });
    const pages = [
      { index: 0, role: 'chart', detectedRole: 'chart', width: 612, height: 792, thumbnail },
      { index: 1, role: 'key', detectedRole: 'key', width: 612, height: 792 }
    ] as const;
    const prepared = transferableAnalysis({ ...analysis(new Uint16Array(4)), pages });
    expect(prepared.transfer).toEqual([prepared.analysis.chart.cells.buffer]);
    const message: unknown = { ...envelope, type: 'result', analysis: prepared.analysis };
    expect(isPatternImportResponse(message)).toBe(true);
    if (!isPatternImportResponse(message) || message.type !== 'result') throw new Error('expected result');
    expect(message.analysis.pages[0]?.thumbnail).toBe(thumbnail);
    expect(message.analysis.pages[1]?.thumbnail).toBeUndefined();

    const badThumbnail = { ...prepared.analysis, pages: [{ ...pages[0], thumbnail: 'data:image/png' }] };
    expect(isPatternImportResponse({ ...envelope, type: 'result', analysis: badThumbnail })).toBe(false);
  });
});
