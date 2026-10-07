import { DEFAULT_PATTERN_SETTINGS, MAX_PERSISTABLE_CELL_COUNT, flattenDocument, type LayeredDocument, type PatternDocument } from '../domain';
import type { ProjectMetadata, ProjectThumbnailSummary } from './types';

export const PROJECT_THUMBNAIL_VERSION = 2 as const;
export const PROJECT_THUMBNAIL_MAX_AXIS = 512;
export const PROJECT_THUMBNAIL_MAX_CELLS = PROJECT_THUMBNAIL_MAX_AXIS * PROJECT_THUMBNAIL_MAX_AXIS;
/** A stable, deliberately unbranded color for cells without a stitch. */
export const PROJECT_THUMBNAIL_FABRIC_COLOR = '#f3eee5';
export const DEFAULT_FABRIC_COLOR = PROJECT_THUMBNAIL_FABRIC_COLOR;
/**
 * Samples that land in a hole of a non-rectangular canvas. The summary format
 * is opaque hex only, so holes match the editor's default off-canvas color.
 */
export const PROJECT_THUMBNAIL_OFF_CANVAS_COLOR = '#e4e1dc';

export interface ProjectDocumentSummary {
  width: number;
  height: number;
  thumbnail: ProjectThumbnailSummary;
}

export type ProjectSummary = ProjectDocumentSummary;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

/** Validate dimensions as a pair without multiplying attacker-controlled values. */
function hasValidProjectDimensions(width: unknown, height: unknown): boolean {
  return isPositiveSafeInteger(width)
    && isPositiveSafeInteger(height)
    && width <= Math.floor(MAX_PERSISTABLE_CELL_COUNT / height);
}

/** Normalize the two CSS hex spellings accepted by thumbnail metadata. */
export function normalizeThumbnailColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  return undefined;
}

function cloneThumbnail(thumbnail: ProjectThumbnailSummary): ProjectThumbnailSummary {
  return {
    version: PROJECT_THUMBNAIL_VERSION,
    revision: thumbnail.revision,
    columns: thumbnail.columns,
    rows: thumbnail.rows,
    palette: [...thumbnail.palette],
    indices: thumbnail.indices.slice()
  };
}

function createThumbnailIndices(paletteLength: number, length: number): Uint8Array | Uint16Array {
  return paletteLength <= 256 ? new Uint8Array(length) : new Uint16Array(length);
}

/**
 * Return a normalized copy, or undefined when an optional thumbnail is unsafe.
 * A stored v1 record (a plain number array) is converted to v2.
 */
export function sanitizeProjectThumbnail(value: unknown, expectedRevision?: number): ProjectThumbnailSummary | undefined {
  if (!isRecord(value)
    || (value.version !== PROJECT_THUMBNAIL_VERSION && value.version !== 1)
    || !isNonNegativeSafeInteger(value.revision)
    || (expectedRevision !== undefined && value.revision !== expectedRevision)
    || !isPositiveSafeInteger(value.columns)
    || value.columns > PROJECT_THUMBNAIL_MAX_AXIS
    || !isPositiveSafeInteger(value.rows)
    || value.rows > PROJECT_THUMBNAIL_MAX_AXIS
    || !isPlainArray(value.palette)
    || value.palette.length < 1
    || value.palette.length > PROJECT_THUMBNAIL_MAX_CELLS + 1) return undefined;

  const length = value.columns * value.rows;
  const palette: string[] = [];
  for (const color of value.palette) {
    const normalized = normalizeThumbnailColor(color);
    if (normalized === undefined) return undefined;
    palette.push(normalized);
  }
  const source = value.indices as ArrayLike<unknown>;
  if (value.version === 1) {
    if (!isPlainArray(source) || source.length !== length) return undefined;
  } else {
    // The narrowest typed-array kind that holds the palette. Compared by tag
    // rather than constructor identity, because IndexedDB clones can come from
    // another realm; ArrayBuffer.isView checks the internal slot.
    const expectedTag = palette.length <= 256 ? '[object Uint8Array]' : '[object Uint16Array]';
    if (!ArrayBuffer.isView(source) || Object.prototype.toString.call(source) !== expectedTag || source.length !== length) return undefined;
  }
  const indices = createThumbnailIndices(palette.length, length);
  for (let i = 0; i < length; i += 1) {
    const index = source[i];
    if (!isNonNegativeSafeInteger(index) || index >= palette.length) return undefined;
    indices[i] = index;
  }
  return {
    version: PROJECT_THUMBNAIL_VERSION,
    revision: value.revision,
    columns: value.columns,
    rows: value.rows,
    palette,
    indices
  };
}

/** Field-wise and element-wise equality of two thumbnail summaries. */
export function projectThumbnailsEqual(a: ProjectThumbnailSummary | undefined, b: ProjectThumbnailSummary | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.version !== b.version || a.revision !== b.revision || a.columns !== b.columns || a.rows !== b.rows
    || a.palette.length !== b.palette.length || a.indices.length !== b.indices.length) return false;
  for (let i = 0; i < a.palette.length; i += 1) if (a.palette[i] !== b.palette[i]) return false;
  for (let i = 0; i < a.indices.length; i += 1) if (a.indices[i] !== b.indices[i]) return false;
  return true;
}

export function isValidProjectThumbnail(value: unknown, expectedRevision?: number): value is ProjectThumbnailSummary {
  return sanitizeProjectThumbnail(value, expectedRevision) !== undefined;
}

/** The thumbnail grid derived for a pattern of this size: 1:1 up to the axis cap, downsampled beyond it. */
export function expectedThumbnailDimensions(width: number, height: number): { columns: number; rows: number } {
  const scale = Math.min(1, PROJECT_THUMBNAIL_MAX_AXIS / width, PROJECT_THUMBNAIL_MAX_AXIS / height);
  return {
    columns: Math.max(1, Math.min(PROJECT_THUMBNAIL_MAX_AXIS, Math.round(width * scale))),
    rows: Math.max(1, Math.min(PROJECT_THUMBNAIL_MAX_AXIS, Math.round(height * scale)))
  };
}

function isLayeredDocument(document: LayeredDocument | PatternDocument): document is LayeredDocument {
  return 'layers' in document;
}

/**
 * Derive a small color-only overview without encoding or decoding the
 * document. The document is authoritative; progress, backstitches, and source
 * images intentionally do not participate in this summary. A layered document
 * is flattened first, so hidden layers never appear.
 */
export function deriveProjectThumbnail(source: LayeredDocument | PatternDocument): ProjectThumbnailSummary {
  const document = isLayeredDocument(source) ? flattenDocument(source) : source;
  const { columns, rows } = expectedThumbnailDimensions(document.width, document.height);
  const fabricColor = normalizeThumbnailColor(document.settings?.backgroundColor)
    ?? normalizeThumbnailColor(DEFAULT_PATTERN_SETTINGS.backgroundColor)
    ?? PROJECT_THUMBNAIL_FABRIC_COLOR;
  const paletteById = new Map<number, string>();
  for (const entry of document.palette) {
    const normalized = normalizeThumbnailColor(entry.color);
    if (normalized !== undefined) paletteById.set(entry.id, normalized);
  }

  const palette = [fabricColor];
  const paletteIndices = new Map<string, number>();
  paletteIndices.set(fabricColor, 0);
  const sampled = new Uint16Array(columns * rows);
  let cursor = 0;
  for (let row = 0; row < rows; row += 1) {
    // Sampling the center of a destination cell chooses the source cell that
    // contains that center, rather than repeatedly favoring its top edge.
    const sourceY = Math.min(document.height - 1, Math.floor((row + 0.5) * document.height / rows));
    for (let column = 0; column < columns; column += 1) {
      const sourceX = Math.min(document.width - 1, Math.floor((column + 0.5) * document.width / columns));
      const offset = (sourceY * document.width + sourceX) * 4;
      let color = fabricColor;
      if (document.canvasMask !== undefined && document.canvasMask[sourceY * document.width + sourceX] !== 1) {
        color = PROJECT_THUMBNAIL_OFF_CANVAS_COLOR;
      }
      let firstNonZeroColorId = 0;
      for (let slot = 0; slot < 4; slot += 1) {
        const colorId = document.colors[offset + slot];
        if (colorId !== 0) {
          firstNonZeroColorId = colorId;
          break;
        }
      }
      // The first occupied slot is authoritative. An unknown palette ID (or
      // a palette entry with an invalid color) means fabric for this sample;
      // do not let a later physical slot change the result.
      if (firstNonZeroColorId !== 0) {
        color = paletteById.get(firstNonZeroColorId) ?? fabricColor;
      }
      let paletteIndex = paletteIndices.get(color);
      if (paletteIndex === undefined) {
        paletteIndex = palette.length;
        palette.push(color);
        paletteIndices.set(color, paletteIndex);
      }
      sampled[cursor] = paletteIndex;
      cursor += 1;
    }
  }
  return {
    version: PROJECT_THUMBNAIL_VERSION,
    revision: document.revision,
    columns,
    rows,
    palette,
    indices: palette.length <= 256 ? Uint8Array.from(sampled) : sampled
  };
}

export const createProjectThumbnail = deriveProjectThumbnail;

export function deriveProjectSummary(document: LayeredDocument | PatternDocument): ProjectDocumentSummary {
  return { width: document.width, height: document.height, thumbnail: deriveProjectThumbnail(document) };
}

export const summarizeProjectDocument = deriveProjectSummary;

export function withProjectSummary(metadata: ProjectMetadata, summary: ProjectDocumentSummary): ProjectMetadata {
  const safe = sanitizeProjectMetadata(metadata);
  return {
    ...safe,
    width: summary.width,
    height: summary.height,
    thumbnail: cloneThumbnail(summary.thumbnail)
  };
}

export const canonicalizeProjectMetadata = withProjectSummary;

/**
 * Clone metadata at the persistence boundary. Invalid derived fields are
 * discarded without allowing a legacy or damaged cache to hide a valid
 * project from metadata-only listing.
 */
export function sanitizeProjectMetadata(metadata: ProjectMetadata): ProjectMetadata {
  const safe: ProjectMetadata = { ...metadata };
  const validDimensions = hasValidProjectDimensions(metadata.width, metadata.height);
  if (!validDimensions) {
    delete safe.width;
    delete safe.height;
    delete safe.thumbnail;
  } else if (metadata.thumbnail !== undefined) {
    const thumbnail = sanitizeProjectThumbnail(metadata.thumbnail, metadata.revision);
    if (thumbnail === undefined) delete safe.thumbnail;
    else safe.thumbnail = thumbnail;
  }
  if (metadata.materialSettings !== undefined) safe.materialSettings = { ...metadata.materialSettings };
  if (metadata.sourceImage !== undefined) {
    safe.sourceImage = {
      ...metadata.sourceImage,
      crop: { ...metadata.sourceImage.crop },
      chartBounds: { ...metadata.sourceImage.chartBounds }
    };
  }
  return safe;
}

/** A structurally valid summary whose thumbnail matches `expectedRevision`. */
export function isValidProjectSummary(value: unknown, expectedRevision?: number): value is ProjectDocumentSummary {
  return isRecord(value)
    && hasValidProjectDimensions(value.width, value.height)
    && sanitizeProjectThumbnail(value.thumbnail, expectedRevision) !== undefined;
}

export function completeProjectSummary(metadata: ProjectMetadata): ProjectDocumentSummary | undefined {
  const width = metadata.width;
  const height = metadata.height;
  if (!hasValidProjectDimensions(width, height) || width === undefined || height === undefined) return undefined;
  const thumbnail = sanitizeProjectThumbnail(metadata.thumbnail, metadata.revision);
  if (thumbnail === undefined) return undefined;
  return { width, height, thumbnail };
}

export const projectSummaryFromMetadata = completeProjectSummary;

export function hasCompleteProjectSummary(metadata: ProjectMetadata): boolean {
  return completeProjectSummary(metadata) !== undefined;
}
