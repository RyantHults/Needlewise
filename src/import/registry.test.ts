import { describe, expect, it } from 'vitest';
import { findImporter, importerAccept, listImporters, registerImporter } from './registry';
import type { PatternImporter } from './types';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('import registry', () => {
  it('registers the PDF importer by default', () => {
    expect(listImporters().map((importer) => importer.id)).toContain('pdf');
    expect(importerAccept().split(',')).toEqual(expect.arrayContaining(['.pdf', 'application/pdf']));
  });

  it('finds the PDF importer by header, even after leading bytes', () => {
    expect(findImporter(bytes('%PDF-1.7\n'))?.id).toBe('pdf');
    expect(findImporter(bytes('\n\n%PDF-1.4'))?.id).toBe('pdf');
    expect(findImporter(bytes('PK\u0003\u0004'))).toBeUndefined();
    expect(findImporter(new Uint8Array(0))).toBeUndefined();
  });

  it('registers other importers and replaces by id', () => {
    const make = (label: string): PatternImporter => ({
      id: 'test-format',
      label,
      accept: ['.tst'],
      sniff: (head) => head[0] === 0x54,
      open: () => Promise.reject(new Error('unused'))
    });
    registerImporter(make('first'));
    registerImporter(make('second'));
    expect(listImporters().filter((importer) => importer.id === 'test-format')).toHaveLength(1);
    expect(findImporter(bytes('T'))?.label).toBe('second');
    expect(importerAccept()).toContain('.tst');
  });
});
