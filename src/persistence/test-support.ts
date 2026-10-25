import { createDocument as createDomainDocument, layeredFromSurface, type CatalogAssociation, type CreateDocumentOptions, type LayeredDocument, type PatternDocument } from '../domain';
import { applyCommand, cell, PERSISTENCE_TEST_CATALOG } from '../domain/test-fixtures';

export function createDocument(options: Omit<CreateDocumentOptions, 'catalog'> & { catalog?: CatalogAssociation }): PatternDocument {
  return createDomainDocument({ ...options, catalog: options.catalog ?? PERSISTENCE_TEST_CATALOG });
}

export function document(x: number, y: number): LayeredDocument {
  const original = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
  return layeredFromSurface(applyCommand(original, cell(original, { type: 'set-full', x, y, color: 1 })).document);
}
