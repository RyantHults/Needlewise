import { describe, expect, it } from 'vitest';
import { findImporter, importerAccept } from './registry';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('import registry', () => {
  it('finds the PDF importer by header, even after leading bytes, and accepts PDFs', () => {
    expect(findImporter(bytes('%PDF-1.7\n'))?.id).toBe('pdf');
    expect(findImporter(bytes('\n\n%PDF-1.4'))?.id).toBe('pdf');
    expect(findImporter(bytes('PK\u0003\u0004'))).toBeUndefined();
    expect(findImporter(new Uint8Array(0))).toBeUndefined();
    expect(importerAccept().split(',')).toEqual(expect.arrayContaining(['.pdf', 'application/pdf']));
  });
});
