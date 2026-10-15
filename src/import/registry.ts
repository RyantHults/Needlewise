import type { ImportRunOptions, ImportSession, PatternImporter } from './types';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
/** The PDF spec lets the header sit anywhere in the first 1024 bytes. */
const PDF_HEADER_WINDOW = 1024;

// A descriptor only: the parser (and pdf.js behind it) loads when a file is opened.
const pdfDescriptor: PatternImporter = {
  id: 'pdf',
  label: 'PDF',
  accept: ['.pdf', 'application/pdf'],
  sniff(head) {
    const end = Math.min(head.length, PDF_HEADER_WINDOW) - PDF_MAGIC.length;
    for (let start = 0; start <= end; start += 1) {
      if (PDF_MAGIC.every((byte, offset) => head[start + offset] === byte)) return true;
    }
    return false;
  },
  async open(bytes, options?: ImportRunOptions & { readonly fileName?: string }): Promise<ImportSession> {
    const { pdfImporter } = await import('./pdf/pdf-importer');
    return pdfImporter.open(bytes, options);
  }
};

const importers: PatternImporter[] = [pdfDescriptor];

/** Adds an importer; one with the same id replaces the earlier one. */
export function registerImporter(importer: PatternImporter): void {
  const existing = importers.findIndex((candidate) => candidate.id === importer.id);
  if (existing === -1) importers.push(importer);
  else importers[existing] = importer;
}

export function listImporters(): readonly PatternImporter[] {
  return importers;
}

/** Joined `accept` list for an `<input accept>`. */
export function importerAccept(): string {
  return [...new Set(importers.flatMap((importer) => importer.accept))].join(',');
}

export function findImporter(head: Uint8Array): PatternImporter | undefined {
  return importers.find((importer) => importer.sniff(head));
}
