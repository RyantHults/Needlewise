import { isRecord, normalizeAidaCount, normalizeDisplayUnits, normalizeMaterialAssumptions, type MaterialSettingsV2 } from '../domain';
import { PersistenceError } from './errors';
import { isBoundedMetadataString } from './limits';
import { sanitizeProjectMetadata } from './project-thumbnail';
import { validateSourceImageDescriptor } from './source-image';
import type { ProjectMetadata } from './types';

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && isBoundedMetadataString(value);
}

export interface ParsedProjectMetadata {
  metadata: ProjectMetadata;
  /** A legacy metadata stitch count, which belongs to a v1/v2 document and is never part of `metadata`. */
  legacyAidaCount?: number;
  /** One entry per optional field that was dropped because it is malformed. */
  warnings: string[];
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && isBoundedMetadataString(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The value is malformed.';
}

/**
 * Parses project metadata on every path that reads or writes it. A malformed
 * required field throws; a malformed optional field is dropped with a warning.
 * Only known fields are copied, and summary fields go through
 * `sanitizeProjectMetadata`.
 */
export function parseProjectMetadata(value: unknown): ParsedProjectMetadata {
  if (
    !isRecord(value)
    || !isProjectId(value.id)
    || !isBoundedString(value.title)
    || !isBoundedString(value.notes)
    || !isNonNegativeSafeInteger(value.createdAt)
    || !isNonNegativeSafeInteger(value.updatedAt)
    || !isNonNegativeSafeInteger(value.revision)
  ) throw new PersistenceError('invalid-metadata', 'Project metadata is malformed.');
  const metadata: ProjectMetadata = {
    id: value.id,
    title: value.title,
    notes: value.notes,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision: value.revision
  };
  const warnings: string[] = [];
  let legacyAidaCount: number | undefined;
  if (value.aidaCount !== undefined) {
    try {
      legacyAidaCount = normalizeAidaCount(value.aidaCount);
    } catch (error) {
      warnings.push(`The legacy project Aida count was ignored: ${errorText(error)}`);
    }
  }
  if (value.units !== undefined) {
    try {
      metadata.units = normalizeDisplayUnits(value.units);
    } catch (error) {
      warnings.push(`The project display units were ignored: ${errorText(error)}`);
    }
  }
  if (value.materialSettings !== undefined) {
    try {
      metadata.materialSettings = normalizeMaterialAssumptions(value.materialSettings as MaterialSettingsV2);
    } catch (error) {
      warnings.push(`The project material settings were ignored: ${errorText(error)}`);
    }
  }
  if (value.sourceImage !== undefined) {
    try {
      metadata.sourceImage = validateSourceImageDescriptor(value.sourceImage);
    } catch (error) {
      warnings.push(`Optional source image settings were ignored: ${errorText(error)}`);
    }
  }
  // The summary is a cache of the document: sanitizing drops a bad one silently.
  const { width, height, thumbnail } = value as Pick<ProjectMetadata, 'width' | 'height' | 'thumbnail'>;
  if (width !== undefined) metadata.width = width;
  if (height !== undefined) metadata.height = height;
  if (thumbnail !== undefined) metadata.thumbnail = thumbnail;
  return { metadata: sanitizeProjectMetadata(metadata), ...(legacyAidaCount === undefined ? {} : { legacyAidaCount }), warnings };
}
