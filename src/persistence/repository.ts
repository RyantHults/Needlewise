import { assertValidDocument, cloneDocument, normalizeAidaCount, normalizeDisplayUnits, normalizeMaterialAssumptions, type PatternDocument } from '../domain';
import { exportArchive, importArchive } from './archive';
import { NeedlewiseDatabase } from './database';
import { PersistenceError } from './errors';
import {
  isArchiveSafeAssetId,
  isBoundedMetadataString,
  isValidAssetId,
  MAX_ASSET_BYTES,
  MAX_ASSET_TOTAL_BYTES,
  MAX_DOCUMENT_BYTES
} from './limits';
import { decodeDocument, encodeDocument } from './binary';
import { sha256 } from './hash';
import { MAX_DAILY_PROGRESS_ENTRIES, normalizeProgressActivity, type ProgressActivity } from './activity';
import { inspectSourceImage, validateSourceImageDescriptor } from './source-image';
import {
  completeProjectSummary,
  deriveProjectSummary,
  sanitizeProjectMetadata,
  withProjectSummary,
  type ProjectDocumentSummary
} from './project-thumbnail';
import type {
  ArchiveImportOptions,
  ProjectAsset,
  ProjectAssetInput,
  ProjectHealth,
  ProjectMetadata,
  ProjectRecord,
  PreparedDocumentCapability,
  RepositoryOptions,
  SaveResult,
  SaveOptions,
  SaveCommitMode,
  StoredDocumentSnapshot,
  StoredProjectHead,
  StoredProjectAsset,
  StoredDailyProgressAggregate
} from './types';
import { consumePreparedDocumentCapability } from './preparation-client';
import type { MaterialSettingsV2 } from '../domain';

function invalidMetadata(message: string): never {
  throw new PersistenceError('invalid-metadata', message);
}

function validateProjectMetadata(projectId: string, metadata: ProjectMetadata, documentOrRevision: PatternDocument | number): ProjectMetadata {
  if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 256 || !isBoundedMetadataString(projectId) || metadata.id !== projectId) invalidMetadata('Project metadata ID does not match the project being saved.');
  if (typeof metadata.title !== 'string' || typeof metadata.notes !== 'string' || !isBoundedMetadataString(metadata.title) || !isBoundedMetadataString(metadata.notes) || !Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0 || !Number.isSafeInteger(metadata.updatedAt) || metadata.updatedAt < 0 || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0) invalidMetadata('Project metadata is malformed.');
  const documentRevision = typeof documentOrRevision === 'number' ? documentOrRevision : documentOrRevision.revision;
  if (metadata.revision !== documentRevision) invalidMetadata('Project metadata and document revisions must match.');
  let aidaCount: ProjectMetadata['aidaCount'];
  if (metadata.aidaCount !== undefined) {
    try {
      aidaCount = normalizeAidaCount(metadata.aidaCount);
    } catch (error) {
      invalidMetadata(`Project Aida count is malformed: ${errorText(error)}`);
    }
  }
  let materialSettings: ProjectMetadata['materialSettings'];
  if (metadata.materialSettings !== undefined) {
    try {
      materialSettings = normalizeMaterialAssumptions(metadata.materialSettings as MaterialSettingsV2);
    } catch (error) {
      invalidMetadata(`Project material settings are malformed: ${errorText(error)}`);
    }
  }
  let units: ProjectMetadata['units'];
  if (metadata.units !== undefined) {
    try {
      units = normalizeDisplayUnits(metadata.units);
    } catch (error) {
      invalidMetadata(`Project display units are malformed: ${errorText(error)}`);
    }
  }
  let sourceImage: ProjectMetadata['sourceImage'];
  if (metadata.sourceImage !== undefined) {
    try {
      sourceImage = validateSourceImageDescriptor(metadata.sourceImage);
    } catch (error) {
      invalidMetadata(`Project source image settings are malformed: ${errorText(error)}`);
    }
  }
  return { ...metadata, ...(aidaCount === undefined ? {} : { aidaCount }), ...(units === undefined ? {} : { units }), ...(materialSettings === undefined ? {} : { materialSettings }), ...(sourceImage === undefined ? {} : { sourceImage }) };
}

function isMetadataRecord(projectId: string, metadata: ProjectMetadata | undefined): metadata is ProjectMetadata {
  return metadata !== undefined
    && typeof metadata.id === 'string'
    && metadata.id === projectId
    && metadata.id.length > 0
    && metadata.id.length <= 256
    && isBoundedMetadataString(metadata.id)
    && typeof metadata.title === 'string'
    && typeof metadata.notes === 'string'
    && isBoundedMetadataString(metadata.title)
    && isBoundedMetadataString(metadata.notes)
    && Number.isSafeInteger(metadata.createdAt)
    && metadata.createdAt >= 0
    && Number.isSafeInteger(metadata.updatedAt)
    && metadata.updatedAt >= 0
    && Number.isSafeInteger(metadata.revision)
    && metadata.revision >= 0
    && (metadata.aidaCount === undefined || (() => {
      try {
        normalizeAidaCount(metadata.aidaCount);
        return true;
      } catch {
        return false;
      }
    })())
    && (metadata.materialSettings === undefined || (() => {
      try {
        normalizeMaterialAssumptions(metadata.materialSettings as MaterialSettingsV2);
        return true;
      } catch {
        return false;
      }
    })())
    && (metadata.units === undefined || (() => {
      try {
        normalizeDisplayUnits(metadata.units);
        return true;
      } catch {
        return false;
      }
    })());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The local record is malformed.';
}

function sanitizeSourceImageMetadata(metadata: ProjectMetadata): { metadata: ProjectMetadata; warning?: string } {
  if (metadata.sourceImage === undefined) return { metadata };
  try {
    const sourceImage = validateSourceImageDescriptor(metadata.sourceImage);
    return { metadata: { ...metadata, sourceImage } };
  } catch (error) {
    const safe = { ...metadata };
    delete safe.sourceImage;
    return { metadata: safe, warning: `Optional source image settings were ignored: ${errorText(error)}.` };
  }
}

function storedBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

async function bytesForAsset(input: ProjectAssetInput, legacyIds: ReadonlySet<string>): Promise<Uint8Array> {
  if ((!isArchiveSafeAssetId(input.id) && !legacyIds.has(input.id)) || typeof input.name !== 'string' || input.name.length > 512 || typeof input.mimeType !== 'string' || input.mimeType.length > 256) throw new PersistenceError('invalid-asset', 'Asset metadata is malformed.');
  let bytes: Uint8Array;
  if (typeof Blob !== 'undefined' && input.data instanceof Blob) {
    if (input.data.size > MAX_ASSET_BYTES) throw new PersistenceError('invalid-asset', `Asset ${input.id} exceeds the size limit.`);
    bytes = new Uint8Array(await input.data.arrayBuffer());
  } else if (input.data instanceof Uint8Array) {
    bytes = input.data.slice();
  } else if (input.data instanceof ArrayBuffer) {
    bytes = new Uint8Array(input.data).slice();
  } else {
    throw new PersistenceError('invalid-asset', `Asset ${input.id} has unsupported data.`);
  }
  if (bytes.length > MAX_ASSET_BYTES) throw new PersistenceError('invalid-asset', `Asset ${input.id} exceeds the size limit.`);
  return bytes;
}

async function normalizeAssets(inputs: readonly ProjectAssetInput[], legacyIds: ReadonlySet<string> = new Set(), allowLegacyAssetIds = false): Promise<ProjectAsset[]> {
  const assets: ProjectAsset[] = [];
  const ids = new Set<string>();
  const permittedLegacyIds = allowLegacyAssetIds
    ? new Set(inputs.map((candidate) => candidate.id).filter(isValidAssetId))
    : legacyIds;
  let total = 0;
  for (const input of inputs) {
    if (ids.has(input.id)) throw new PersistenceError('invalid-asset', `Asset ${input.id} is duplicated.`);
    const data = await bytesForAsset(input, permittedLegacyIds);
    total += data.length;
    if (total > MAX_ASSET_TOTAL_BYTES) throw new PersistenceError('invalid-asset', 'Assets exceed the size limit.');
    ids.add(input.id);
    assets.push({ id: input.id, name: input.name, mimeType: input.mimeType, data, checksum: await sha256(data) });
  }
  return assets;
}

async function verifySnapshot(snapshot: StoredDocumentSnapshot): Promise<PatternDocument> {
  const bytes = storedBytes(snapshot.bytes);
  if (typeof snapshot.projectId !== 'string' || snapshot.projectId.length < 1 || snapshot.projectId.length > 256 || !bytes || typeof snapshot.checksum !== 'string' || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new PersistenceError('invalid-document', 'Stored snapshot metadata is malformed.');
  }
  const checksum = await sha256(bytes);
  if (checksum !== snapshot.checksum) throw new PersistenceError('checksum-mismatch', `Snapshot revision ${String(snapshot.revision)} failed its checksum.`);
  const document = decodeDocument(bytes);
  if (document.revision !== snapshot.revision) throw new PersistenceError('invalid-document', 'Snapshot revision does not match its document.');
  return document;
}

function toStoredSnapshot(projectId: string, document: PatternDocument, bytes: Uint8Array, checksum: string, savedAt: number): StoredDocumentSnapshot {
  return { projectId, revision: document.revision, bytes: bytes.slice(), checksum, savedAt };
}

function toStoredPreparedSnapshot(projectId: string, revision: number, bytes: Uint8Array, checksum: string, savedAt: number): StoredDocumentSnapshot {
  // The preparation result is already persistence-owned. IndexedDB performs
  // its own structured clone when this record is committed; do not make a
  // second main-thread byte copy here.
  return { projectId, revision, bytes, checksum, savedAt };
}

function toStoredHead(projectId: string, revision: number, checksum: string): StoredProjectHead {
  return { projectId, revision, checksum };
}

function headFromSnapshot(projectId: string, snapshot: StoredDocumentSnapshot | undefined): StoredProjectHead | undefined {
  if (
    !snapshot
    || snapshot.projectId !== projectId
    || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 0
    || typeof snapshot.checksum !== 'string'
    || !/^[0-9a-f]{64}$/.test(snapshot.checksum)
  ) return undefined;
  return toStoredHead(projectId, snapshot.revision, snapshot.checksum);
}

function isStoredHead(projectId: string, head: StoredProjectHead | undefined): head is StoredProjectHead {
  return head !== undefined
    && head.projectId === projectId
    && Number.isSafeInteger(head.revision)
    && head.revision >= 0
    && typeof head.checksum === 'string'
    && /^[0-9a-f]{64}$/.test(head.checksum);
}

function headSignature(projectId: string, head: StoredProjectHead | undefined): string {
  if (isStoredHead(projectId, head)) return `valid:${String(head.revision)}:${head.checksum}`;
  return head === undefined ? 'missing' : 'invalid';
}

function toStoredActivity(projectId: string, activity: ProgressActivity): StoredDailyProgressAggregate[] {
  return activity.daily.map((entry) => ({ projectId, date: entry.date, marked: entry.marked, unmarked: entry.unmarked }));
}

interface LoadedActivity {
  activity: ProgressActivity;
  warning?: string;
}

function activityFromStored(projectId: string, rows: readonly StoredDailyProgressAggregate[]): LoadedActivity {
  try {
    if (!Array.isArray(rows) || rows.length > MAX_DAILY_PROGRESS_ENTRIES || rows.some((row) => row.projectId !== projectId)) throw new TypeError('Stored project activity is malformed.');
    return { activity: normalizeProgressActivity({ daily: rows.map((row) => ({ date: row.date, marked: row.marked, unmarked: row.unmarked })) }) };
  } catch (error) {
    return { activity: { daily: [] }, warning: `Stored project activity was ignored: ${errorText(error)}` };
  }
}

async function inspectSnapshot(snapshot: StoredDocumentSnapshot | undefined, projectId: string): Promise<ProjectHealth['current']> {
  if (!snapshot) return { status: 'missing', revision: null };
  try {
    if (snapshot.projectId !== projectId) throw new PersistenceError('storage-failure', 'Snapshot project ID does not match its key.');
    await verifySnapshot(snapshot);
    return { status: 'valid', revision: snapshot.revision };
  } catch (error) {
    return { status: 'corrupt', revision: Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : null, warning: errorText(error) };
  }
}

function assetHealth(
  count: number,
  validCount: number,
  warnings: readonly string[],
  verified: boolean
): ProjectHealth['assets'] {
  const status = warnings.length > 0 ? 'corrupt' : verified ? 'valid' : 'unchecked';
  return {
    status,
    count,
    validCount,
    corruptCount: count - validCount,
    ...(warnings.length > 0 ? { warning: warnings[0], warnings: [...warnings] } : {})
  };
}

function storedAssetIssue(projectId: string, asset: StoredProjectAsset, bytes: Uint8Array | undefined): string | undefined {
  if (
    asset.projectId !== projectId
    || !isValidAssetId(asset.id)
    || typeof asset.name !== 'string'
    || asset.name.length > 512
    || typeof asset.mimeType !== 'string'
    || asset.mimeType.length > 256
    || !bytes
    || bytes.length > MAX_ASSET_BYTES
    || typeof asset.checksum !== 'string'
    || !/^[0-9a-f]{64}$/.test(asset.checksum)
  ) return `Asset ${String(asset.id)} has malformed stored metadata.`;
  return undefined;
}

function inspectStoredAssets(projectId: string, storedAssets: readonly StoredProjectAsset[]): ProjectHealth['assets'] {
  let validCount = 0;
  let total = 0n;
  const ids = new Set<string>();
  const warnings: string[] = [];
  for (const asset of storedAssets) {
    const bytes = storedBytes(asset.data);
    let issue = storedAssetIssue(projectId, asset, bytes);
    if (!issue && ids.has(asset.id)) issue = `Asset ${asset.id} is duplicated.`;
    if (!issue && bytes) {
      const nextTotal = total + BigInt(bytes.length);
      if (nextTotal > BigInt(MAX_ASSET_TOTAL_BYTES)) issue = 'Stored assets exceed the size limit.';
      else {
        total = nextTotal;
        ids.add(asset.id);
      }
    }
    if (issue) warnings.push(issue);
    else validCount += 1;
  }
  // Health listing intentionally does not hash or decode assets. A full load
  // performs checksum verification before making bytes available to callers.
  return assetHealth(storedAssets.length, validCount, warnings, false);
}

function makeProjectHealth(
  projectId: string,
  metadata: ProjectMetadata | undefined,
  current: ProjectHealth['current'],
  recovery: ProjectHealth['recovery'],
  assets: ProjectHealth['assets'],
  extraWarnings: readonly string[] = [],
  sourceImage?: ProjectHealth['sourceImage']
): ProjectHealth {
  const warnings: string[] = [];
  if (!metadata) warnings.push('Project metadata is missing.');
  if (current.status !== 'valid') warnings.push(current.warning ?? 'Current snapshot is not readable.');
  if (current.status === 'valid' && metadata && metadata.revision !== current.revision) warnings.push('Project metadata and current snapshot revisions do not match.');
  if (recovery.status === 'corrupt') warnings.push(recovery.warning ?? 'Recovery snapshot is not readable.');
  if (assets.status === 'corrupt') warnings.push(...(assets.warnings ?? [assets.warning ?? 'Project assets are malformed.']));
  if (sourceImage && sourceImage.status !== 'valid') warnings.push(sourceImage.warning ?? 'Optional source image reference is unavailable.');
  warnings.push(...extraWarnings);
  const currentMatchesMetadata = current.status === 'valid' && metadata?.revision === current.revision;
  const recoveryAvailable = recovery.status === 'valid';
  return {
    projectId,
    metadata: metadata && isMetadataRecord(projectId, metadata) ? { ...metadata } : null,
    current,
    recovery,
    assets,
    ...(sourceImage === undefined ? {} : { sourceImage }),
    usableRevision: currentMatchesMetadata ? current.revision : recoveryAvailable ? recovery.revision : null,
    recoveryAvailable,
    warnings
  };
}

interface LoadedAssets {
  assets: ProjectAsset[];
  health: ProjectHealth['assets'];
}

type WarmCommitDecision =
  | { kind: 'committed'; result: SaveResult }
  | { kind: 'stale'; result: SaveResult; invalidateCache: boolean }
  | { kind: 'fallback'; invalidateCache: boolean };

async function loadAssets(projectId: string, storedAssets: readonly StoredProjectAsset[]): Promise<LoadedAssets> {
  const assets: ProjectAsset[] = [];
  const ids = new Set<string>();
  const warnings: string[] = [];
  let totalAssetBytes = 0n;
  for (const asset of storedAssets) {
    const data = storedBytes(asset.data);
    let issue = storedAssetIssue(projectId, asset, data);
    if (!issue && ids.has(asset.id)) issue = `Asset ${asset.id} is duplicated.`;
    if (!issue && data) {
      const nextTotal = totalAssetBytes + BigInt(data.length);
      if (nextTotal > BigInt(MAX_ASSET_TOTAL_BYTES)) issue = 'Stored assets exceed the size limit.';
      else {
        try {
          if (await sha256(data) !== asset.checksum) issue = `Asset ${asset.id} failed its checksum.`;
        } catch (error) {
          issue = `Asset ${asset.id} could not be verified: ${errorText(error)}`;
        }
        if (!issue) {
          totalAssetBytes = nextTotal;
          ids.add(asset.id);
          assets.push({ id: asset.id, name: asset.name, mimeType: asset.mimeType, data: data.slice(), checksum: asset.checksum });
        }
      }
    }
    if (issue) warnings.push(issue);
  }
  return { assets, health: assetHealth(storedAssets.length, assets.length, warnings, true) };
}

export class ProjectRepository {
  readonly db: NeedlewiseDatabase;
  private readonly now: () => number;
  private readonly queues = new Map<string, Promise<unknown>>();
  private exportWarningState: string[] = [];
  private verifiedCurrentCache: StoredDocumentSnapshot | undefined;

  constructor(db: NeedlewiseDatabase | undefined = undefined, options: RepositoryOptions = {}) {
    this.db = db ?? new NeedlewiseDatabase(options.databaseName);
    this.now = options.now ?? (() => Date.now());
  }

  get exportWarnings(): readonly string[] {
    return [...this.exportWarningState];
  }

  get lastExportWarnings(): readonly string[] {
    return this.exportWarnings;
  }

  private clearVerifiedCurrentCache(projectId?: string): void {
    if (projectId === undefined || this.verifiedCurrentCache?.projectId === projectId) this.verifiedCurrentCache = undefined;
  }

  private cacheVerifiedCurrentSnapshot(snapshot: StoredDocumentSnapshot): void {
    const bytes = storedBytes(snapshot.bytes);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES) {
      this.clearVerifiedCurrentCache(snapshot.projectId);
      return;
    }
    const exactBytes = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    this.verifiedCurrentCache = { ...snapshot, bytes: exactBytes };
  }

  /** Backfill derived metadata only after a verified, unchanged current load. */
  private async bestEffortBackfillSummary(
    projectId: string,
    loadedMetadata: ProjectMetadata,
    head: StoredProjectHead | undefined,
    summary: ProjectDocumentSummary
  ): Promise<void> {
    try {
      if (!isStoredHead(projectId, head)) return;
      const existing = completeProjectSummary(loadedMetadata);
      if (
        existing?.width === summary.width
        && existing.height === summary.height
        && JSON.stringify(existing.thumbnail) === JSON.stringify(summary.thumbnail)
      ) return;
      await this.db.transaction('rw', [this.db.projects, this.db.projectHeads], async () => {
        const [metadata, storedHead] = await Promise.all([
          this.db.projects.get(projectId),
          this.db.projectHeads.get(projectId)
        ]);
        if (
          !metadata
          || !isMetadataRecord(projectId, metadata)
          || metadata.revision !== loadedMetadata.revision
          || !isStoredHead(projectId, storedHead)
          || storedHead.revision !== head.revision
          || storedHead.checksum !== head.checksum
        ) return;
        const freshSummary = completeProjectSummary(metadata);
        if (
          freshSummary?.width === summary.width
          && freshSummary.height === summary.height
          && JSON.stringify(freshSummary.thumbnail) === JSON.stringify(summary.thumbnail)
        ) return;
        // Merge with the row read inside the CAS transaction so unrelated
        // metadata edits made after load are not overwritten by this cache
        // repair.
        await this.db.projects.put(withProjectSummary(metadata, summary));
      });
    } catch {
      // Metadata is a cache of verified document data. A quota or transaction
      // failure must never turn a successful document load into an error.
    }
  }

  private async writeReplacementRows(
    projectId: string,
    metadata: ProjectMetadata,
    snapshot: StoredDocumentSnapshot,
    assets: readonly ProjectAsset[] | undefined,
    activity: ProgressActivity | undefined
  ): Promise<void> {
    await this.db.projects.put(metadata);
    await this.db.currentSnapshots.put(snapshot);
    await this.db.projectHeads.put(toStoredHead(projectId, snapshot.revision, snapshot.checksum));
    if (assets !== undefined) {
      await this.db.assets.where('projectId').equals(projectId).delete();
      const storedAssets: StoredProjectAsset[] = assets.map((asset) => ({ ...asset, projectId, data: asset.data.slice() }));
      if (storedAssets.length > 0) await this.db.assets.bulkPut(storedAssets);
    }
    if (activity !== undefined) {
      await this.db.dailyActivity.where('projectId').equals(projectId).delete();
      const storedActivity = toStoredActivity(projectId, activity);
      if (storedActivity.length > 0) await this.db.dailyActivity.bulkPut(storedActivity);
    }
  }

  async save(projectId: string, metadata: ProjectMetadata, document: PatternDocument, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.saveSerialized(projectId, metadata, document, assets, options));
    const tracked = operation.then(() => {
      if (this.queues.get(projectId) === tracked) this.queues.delete(projectId);
    }, () => {
      if (this.queues.get(projectId) === tracked) this.queues.delete(projectId);
    });
    this.queues.set(projectId, tracked);
    return operation;
  }

  async savePrepared(projectId: string, metadata: ProjectMetadata, prepared: PreparedDocumentCapability, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.savePreparedSerialized(projectId, metadata, prepared, assets, options));
    const tracked = operation.then(() => {
      if (this.queues.get(projectId) === tracked) this.queues.delete(projectId);
    }, () => {
      if (this.queues.get(projectId) === tracked) this.queues.delete(projectId);
    });
    this.queues.set(projectId, tracked);
    return operation;
  }

  private async saveSerialized(projectId: string, metadataInput: ProjectMetadata, sourceDocument: PatternDocument, assetsInput?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    const mode = this.resolveSaveMode(options);
    if (mode === 'retain') return this.saveRetained(projectId, metadataInput, assetsInput, options);
    return this.saveReplaced(projectId, metadataInput, sourceDocument, assetsInput, options);
  }

  private resolveSaveMode(options: SaveOptions): SaveCommitMode {
    const requestedModes = [options.mode, options.commit, options.commitMode].filter((mode): mode is SaveCommitMode => mode !== undefined);
    if (requestedModes.some((mode) => mode !== 'replace' && mode !== 'retain')) invalidMetadata('Project save mode is invalid.');
    if (new Set(requestedModes).size > 1) invalidMetadata('Project save mode was specified more than once.');
    const explicitMode = requestedModes[0];
    if (explicitMode !== undefined) return explicitMode;
    // `allowSameRevision` is the pre-Phase-1 compatibility spelling. It
    // remains a replace commit, including its historical equal-revision
    // behavior. Only an explicit retain mode may skip document preparation.
    return 'replace';
  }

  private async savePreparedSerialized(projectId: string, metadataInput: ProjectMetadata, prepared: PreparedDocumentCapability, assetsInput?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    if (this.resolveSaveMode(options) === 'retain') invalidMetadata('Prepared document commits must use replace mode.');
    if (typeof options.preparedRequestId !== 'string' || options.preparedRequestId.length < 1 || options.preparedRequestId.length > 256) throw new PersistenceError('invalid-document', 'Prepared document request identity is malformed.');
    const metadata = validateProjectMetadata(projectId, metadataInput, metadataInput.revision);
    return consumePreparedDocumentCapability(
      prepared,
      { projectId, revision: metadata.revision, requestId: options.preparedRequestId },
      (bytes, checksum, summary) => this.commitReplaced(projectId, metadata, summary, metadata.revision, bytes, checksum, assetsInput, options, false)
    );
  }

  private async saveReplaced(projectId: string, metadataInput: ProjectMetadata, sourceDocument: PatternDocument, assetsInput?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    assertValidDocument(sourceDocument);
    const document = cloneDocument(sourceDocument);
    const metadata = validateProjectMetadata(projectId, metadataInput, document);
    const summary = deriveProjectSummary(document);
    const bytes = encodeDocument(document);
    const checksum = await sha256(bytes);
    return this.commitReplaced(projectId, metadata, summary, document.revision, bytes, checksum, assetsInput, options, true);
  }

  private async tryWarmReplacement(
    projectId: string,
    revision: number,
    metadata: ProjectMetadata,
    nextSnapshot: StoredDocumentSnapshot,
    assets: readonly ProjectAsset[] | undefined,
    activity: ProgressActivity | undefined,
    options: SaveOptions
  ): Promise<WarmCommitDecision | undefined> {
    const cached = this.verifiedCurrentCache;
    if (!cached || cached.projectId !== projectId) return undefined;
    try {
      const decision = await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.assets, this.db.dailyActivity], async (): Promise<WarmCommitDecision> => {
        const head = await this.db.projectHeads.get(projectId);
        if (!isStoredHead(projectId, head)) return { kind: 'fallback', invalidateCache: true };
        const cacheMatchesHead = cached.revision === head.revision && cached.checksum === head.checksum;
        if (!cacheMatchesHead) {
          if (head.revision > revision || (head.revision === revision && !options.allowSameRevision)) {
            return { kind: 'stale', invalidateCache: true, result: { committed: false, stale: true, revision: head.revision } };
          }
          return { kind: 'fallback', invalidateCache: true };
        }
        if (head.revision > revision) return { kind: 'stale', invalidateCache: true, result: { committed: false, stale: true, revision: head.revision } };
        if (head.revision === revision) {
          if (!options.allowSameRevision) return { kind: 'stale', invalidateCache: false, result: { committed: false, stale: true, revision: head.revision } };
          return { kind: 'fallback', invalidateCache: false };
        }

        // The cache is a fully verified exact current record. Dexie clones it
        // as part of the transaction, so no main-thread byte copy is needed.
        await this.db.recoverySnapshots.put(cached);
        await this.writeReplacementRows(projectId, metadata, nextSnapshot, assets, activity);
        return { kind: 'committed', result: { committed: true, stale: false, revision, head: toStoredHead(projectId, revision, nextSnapshot.checksum) } };
      });
      if (decision.kind === 'committed') this.cacheVerifiedCurrentSnapshot(nextSnapshot);
      return decision;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to commit the project locally.', error);
    }
  }

  private async commitReplaced(projectId: string, metadataInput: ProjectMetadata, summary: ProjectDocumentSummary, revision: number, bytes: Uint8Array, checksum: string, assetsInput: readonly ProjectAssetInput[] | undefined, options: SaveOptions, clonePreparedBytes: boolean): Promise<SaveResult> {
    const metadata = withProjectSummary(metadataInput, summary);
    let legacyAssetIds = new Set<string>();
    if (assetsInput !== undefined) {
      try {
        const existingAssets = await this.db.assets.where('projectId').equals(projectId).toArray();
        legacyAssetIds = new Set(existingAssets
          .map((asset) => asset.id)
          .filter((assetId): assetId is string => isValidAssetId(assetId) && !isArchiveSafeAssetId(assetId)));
      } catch (error) {
        throw new PersistenceError('storage-failure', 'Unable to inspect existing project assets.', error);
      }
    }
    const assets = assetsInput === undefined ? undefined : await normalizeAssets(assetsInput, legacyAssetIds, options.allowLegacyAssetIds === true);
    let activity: ProgressActivity | undefined;
    if (options.activity !== undefined) {
      try {
        activity = normalizeProgressActivity(options.activity);
      } catch (error) {
        throw new PersistenceError('invalid-activity', 'Project activity is malformed.', error);
      }
    }
    const savedAt = this.now();
    const nextSnapshot = clonePreparedBytes
      ? toStoredPreparedSnapshot(projectId, revision, bytes.slice(), checksum, savedAt)
      : toStoredPreparedSnapshot(projectId, revision, bytes, checksum, savedAt);
    const warmDecision = await this.tryWarmReplacement(projectId, revision, metadata, nextSnapshot, assets, activity, options);
    if (warmDecision?.kind === 'committed') return warmDecision.result;
    if (warmDecision?.kind === 'stale') {
      if (warmDecision.invalidateCache) this.clearVerifiedCurrentCache(projectId);
      return warmDecision.result;
    }
    if (warmDecision?.kind === 'fallback' && warmDecision.invalidateCache) this.clearVerifiedCurrentCache(projectId);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let previouslyValid: StoredDocumentSnapshot | undefined;
      let preflightHead: StoredProjectHead | undefined;
      try {
        const [candidate, head] = await Promise.all([
          this.db.currentSnapshots.get(projectId),
          this.db.projectHeads.get(projectId)
        ]);
        preflightHead = head;
        if (candidate && candidate.revision < revision) {
          try {
            await verifySnapshot(candidate);
            previouslyValid = candidate;
          } catch (error) {
            // A corrupt current snapshot must never become recovery data. The
            // new validated revision can still replace it atomically.
            if (!(error instanceof PersistenceError)) throw error;
          }
        }
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError('storage-failure', 'Unable to inspect the current local snapshot.', error);
      }
      try {
        const result = await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.assets, this.db.dailyActivity], async () => {
          const existing = await this.db.currentSnapshots.get(projectId);
          const existingHead = await this.db.projectHeads.get(projectId);
          if (headSignature(projectId, existingHead) !== headSignature(projectId, preflightHead)) {
            const headRevision = isStoredHead(projectId, existingHead) ? existingHead.revision : existing?.revision ?? revision;
            return { committed: false, stale: true, revision: headRevision };
          }
          if (existing && (existing.revision > revision || (existing.revision === revision && !options.allowSameRevision))) return { committed: false, stale: true, revision: existing.revision };
          if (existing && previouslyValid && existing.revision === previouslyValid.revision && existing.checksum === previouslyValid.checksum) {
            // The old current record is copied before the new current record is
            // installed, in this same transaction, so a partial save cannot
            // expose recovery data.
            await this.db.recoverySnapshots.put({ ...existing, bytes: existing.bytes.slice() });
          }
          await this.writeReplacementRows(projectId, metadata, nextSnapshot, assets, activity);
          return { committed: true, stale: false, revision, head: toStoredHead(projectId, revision, checksum) };
        });
        if (!result.committed && result.stale) {
          this.clearVerifiedCurrentCache(projectId);
          if (attempt === 0) continue;
        } else if (result.committed) {
          this.cacheVerifiedCurrentSnapshot(nextSnapshot);
        }
        return result;
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError('storage-failure', 'Unable to commit the project locally.', error);
      }
    }
    throw new PersistenceError('storage-failure', 'Unable to commit the project locally.');
  }

  private async saveRetained(projectId: string, metadataInput: ProjectMetadata, assetsInput?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    const requestedHead = options.expectedHead;
    const requestedRevision = options.expectedRevision;
    let expectedRevision: number | undefined = requestedRevision;
    let expectedChecksum: string | undefined;
    if (requestedHead !== undefined) {
      if (typeof requestedHead === 'number') {
        if (expectedRevision !== undefined && expectedRevision !== requestedHead) invalidMetadata('Expected project revisions do not match.');
        expectedRevision = requestedHead;
      } else if (typeof requestedHead === 'object' && requestedHead !== null) {
        if (requestedHead.projectId !== undefined && requestedHead.projectId !== projectId) invalidMetadata('Expected project head does not match the project being saved.');
        if (expectedRevision !== undefined && expectedRevision !== requestedHead.revision) invalidMetadata('Expected project revisions do not match.');
        expectedRevision = requestedHead.revision;
        expectedChecksum = requestedHead.checksum;
      } else {
        invalidMetadata('Expected project head is malformed.');
      }
    }
    if (expectedRevision === undefined) expectedRevision = metadataInput.revision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalidMetadata('Expected project revision is invalid.');
    if (expectedChecksum !== undefined && typeof expectedChecksum !== 'string') invalidMetadata('Expected project head is malformed.');

    // Retain mode deliberately validates only the metadata and auxiliary
    // rows. It never touches the document value, so no document clone,
    // assertion, encoding, checksum, or snapshot readback is performed.
    const validatedMetadata = validateProjectMetadata(projectId, metadataInput, expectedRevision);
    const incomingMetadata = sanitizeProjectMetadata(validatedMetadata);
    const incomingSummary = completeProjectSummary(incomingMetadata);
    let legacyAssetIds = new Set<string>();
    if (assetsInput !== undefined) {
      try {
        const existingAssets = await this.db.assets.where('projectId').equals(projectId).toArray();
        legacyAssetIds = new Set(existingAssets
          .map((asset) => asset.id)
          .filter((assetId): assetId is string => isValidAssetId(assetId) && !isArchiveSafeAssetId(assetId)));
      } catch (error) {
        throw new PersistenceError('storage-failure', 'Unable to inspect existing project assets.', error);
      }
    }
    const assets = assetsInput === undefined ? undefined : await normalizeAssets(assetsInput, legacyAssetIds, options.allowLegacyAssetIds === true);
    let activity: ProgressActivity | undefined;
    if (options.activity !== undefined) {
      try {
        activity = normalizeProgressActivity(options.activity);
      } catch (error) {
        throw new PersistenceError('invalid-activity', 'Project activity is malformed.', error);
      }
    }

    try {
      const result = await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.assets, this.db.dailyActivity], async () => {
        const [storedMetadata, storedHead] = await Promise.all([
          this.db.projects.get(projectId),
          this.db.projectHeads.get(projectId)
        ]);
        let head = storedHead;
        let legacyCurrent: StoredDocumentSnapshot | undefined;
        let needsBackfill = false;
        if (!isStoredHead(projectId, head)) {
          // Databases created before the compact head table are allowed one
          // compatibility read. Every normal retain path reads only this
          // small record and never structured-clones snapshot bytes.
          legacyCurrent = await this.db.currentSnapshots.get(projectId);
          head = headFromSnapshot(projectId, legacyCurrent);
          needsBackfill = head !== undefined;
        }
        if (
          !head
          || head.revision !== expectedRevision
          || (expectedChecksum !== undefined && head.checksum !== expectedChecksum)
        ) {
          return { committed: false, stale: true, revision: head?.revision ?? legacyCurrent?.revision ?? expectedRevision };
        }

        // Retain changes metadata and auxiliary rows only. A complete summary
        // already stored for the head wins as one unit; otherwise a complete
        // incoming summary fills all three fields. Partial summaries are
        // never assembled field-by-field.
        const safeStoredMetadata = storedMetadata !== undefined
          && storedMetadata.revision === expectedRevision
          && isMetadataRecord(projectId, storedMetadata)
          ? sanitizeProjectMetadata(storedMetadata)
          : undefined;
        const retainedSummary = (safeStoredMetadata === undefined ? undefined : completeProjectSummary(safeStoredMetadata)) ?? incomingSummary;
        const retainedMetadata: ProjectMetadata = { ...incomingMetadata };
        delete retainedMetadata.width;
        delete retainedMetadata.height;
        delete retainedMetadata.thumbnail;
        if (retainedSummary !== undefined) {
          retainedMetadata.width = retainedSummary.width;
          retainedMetadata.height = retainedSummary.height;
          retainedMetadata.thumbnail = retainedSummary.thumbnail;
        }

        // This transaction intentionally excludes all snapshot writes. The
        // expected-head check and every auxiliary-row update are atomic.
        if (needsBackfill) await this.db.projectHeads.put(head);
        await this.db.projects.put(retainedMetadata);
        if (assets !== undefined) {
          await this.db.assets.where('projectId').equals(projectId).delete();
          const storedAssets: StoredProjectAsset[] = assets.map((asset) => ({ ...asset, projectId, data: asset.data.slice() }));
          if (storedAssets.length > 0) await this.db.assets.bulkPut(storedAssets);
        }
        if (activity !== undefined) {
          await this.db.dailyActivity.where('projectId').equals(projectId).delete();
          const storedActivity = toStoredActivity(projectId, activity);
          if (storedActivity.length > 0) await this.db.dailyActivity.bulkPut(storedActivity);
        }
        return { committed: true, stale: false, revision: expectedRevision, head: { ...head } };
      });
      if (!result.committed && result.stale) this.clearVerifiedCurrentCache(projectId);
      return result;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to commit the project locally.', error);
    }
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 256) invalidMetadata('Project ID is invalid.');
    this.clearVerifiedCurrentCache(projectId);
    try {
      const { metadata, current, recovery, storedAssets, storedActivity, head } = await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.assets, this.db.dailyActivity], async () => {
        const [metadata, current, recovery, storedAssets, storedActivity, storedHead] = await Promise.all([
          this.db.projects.get(projectId),
          this.db.currentSnapshots.get(projectId),
          this.db.recoverySnapshots.get(projectId),
          this.db.assets.where('projectId').equals(projectId).toArray(),
          this.db.dailyActivity.where('projectId').equals(projectId).toArray(),
          this.db.projectHeads.get(projectId)
        ]);
        const snapshotHead = headFromSnapshot(projectId, current);
        const head = snapshotHead === undefined
          ? (isStoredHead(projectId, storedHead) ? storedHead : undefined)
          : isStoredHead(projectId, storedHead)
            && storedHead.revision === snapshotHead.revision
            && storedHead.checksum === snapshotHead.checksum
            ? storedHead
            : snapshotHead;
        if (head !== undefined && (!isStoredHead(projectId, storedHead) || storedHead.revision !== head.revision || storedHead.checksum !== head.checksum)) {
          await this.db.projectHeads.put(head);
        }
        return { metadata, current, recovery, storedAssets, storedActivity, head };
      });
      if (!metadata && !current && !recovery && storedAssets.length === 0 && storedActivity.length === 0) return undefined;
      const currentHealth = await inspectSnapshot(current, projectId);
      const recoveryHealth = await inspectSnapshot(recovery, projectId);
      if (!metadata || !isMetadataRecord(projectId, metadata)) throw new PersistenceError('storage-failure', 'Project metadata is missing or malformed.');
      if (currentHealth.status !== 'valid' || !current) throw new PersistenceError('storage-failure', 'Current project snapshot is corrupt or missing.');
      const document = await verifySnapshot(current);
      if (metadata.revision !== document.revision) throw new PersistenceError('storage-failure', 'Project metadata and current snapshot are inconsistent.');
      let recoveryRecord: ProjectRecord['recovery'] = null;
      if (recovery && recoveryHealth.status === 'valid') {
        const recoveryDocument = await verifySnapshot(recovery);
        recoveryRecord = { revision: recovery.revision, document: recoveryDocument };
      }
      const loadedAssets = await loadAssets(projectId, storedAssets);
      const loadedActivity = activityFromStored(projectId, storedActivity);
      const sourceImage = inspectSourceImage(metadata.sourceImage, loadedAssets.assets);
      const safeMetadata = sanitizeSourceImageMetadata(metadata);
      const summary = deriveProjectSummary(document);
      const canonicalMetadata = withProjectSummary(safeMetadata.metadata, summary);
      const extraWarnings = [
        ...(loadedActivity.warning === undefined ? [] : [loadedActivity.warning]),
        ...(safeMetadata.warning === undefined ? [] : [safeMetadata.warning])
      ];
      const health = makeProjectHealth(projectId, canonicalMetadata, currentHealth, recoveryHealth, loadedAssets.health, extraWarnings, sourceImage);
      this.cacheVerifiedCurrentSnapshot(current);
      await this.bestEffortBackfillSummary(projectId, metadata, head, summary);
      return { metadata: sanitizeProjectMetadata(canonicalMetadata), document, head, recovery: recoveryRecord, assets: loadedAssets.assets, activity: loadedActivity.activity, health };
    } catch (error) {
      this.clearVerifiedCurrentCache(projectId);
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to load the project locally.', error);
    }
  }

  async getAsset(projectId: string, assetId: string): Promise<ProjectAsset | undefined> {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 256 || typeof assetId !== 'string' || assetId.length < 1 || assetId.length > 256) invalidMetadata('Project or asset ID is invalid.');
    try {
      const stored = await this.db.assets.get([projectId, assetId]);
      if (!stored) return undefined;
      const bytes = storedBytes(stored.data);
      const issue = storedAssetIssue(projectId, stored, bytes);
      if (issue || !bytes || await sha256(bytes) !== stored.checksum) return undefined;
      return { id: stored.id, name: stored.name, mimeType: stored.mimeType, data: bytes.slice(), checksum: stored.checksum };
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to retrieve the project asset.', error);
    }
  }

  async getProjectAsset(projectId: string, assetId: string): Promise<ProjectAsset | undefined> {
    return this.getAsset(projectId, assetId);
  }

  /**
   * Lists metadata without requiring the project to be fully readable. This
   * preserves the old return shape while ensuring a corrupt current snapshot
   * remains visible to callers; use listProjectHealth for diagnostics.
   */
  async listProjects(): Promise<ProjectMetadata[]> {
    try {
      const candidates = await this.db.projects.toArray();
      const visible = candidates
        .filter((candidate) => isMetadataRecord(candidate.id, candidate))
        .map((candidate) => sanitizeProjectMetadata(candidate));
      return visible.sort((left, right) => right.updatedAt - left.updatedAt || right.revision - left.revision || left.id.localeCompare(right.id));
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to list local projects.', error);
    }
  }

  async listProjectMetadata(): Promise<ProjectMetadata[]> {
    return this.listProjects();
  }

  async inspectProjectHealth(projectId: string): Promise<ProjectHealth | undefined> {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 256) invalidMetadata('Project ID is invalid.');
    try {
      const [metadata, current, recovery, storedAssets, storedActivity] = await this.db.transaction('r', this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.assets, this.db.dailyActivity, async () => Promise.all([
        this.db.projects.get(projectId),
        this.db.currentSnapshots.get(projectId),
        this.db.recoverySnapshots.get(projectId),
        this.db.assets.where('projectId').equals(projectId).toArray(),
        this.db.dailyActivity.where('projectId').equals(projectId).toArray()
      ]));
      if (!metadata && !current && !recovery && storedAssets.length === 0 && storedActivity.length === 0) return undefined;
      const activity = activityFromStored(projectId, storedActivity);
      const currentHealth = await inspectSnapshot(current, projectId);
      const recoveryHealth = await inspectSnapshot(recovery, projectId);
      if (currentHealth.status === 'corrupt') this.clearVerifiedCurrentCache(projectId);
      return makeProjectHealth(projectId, metadata, currentHealth, recoveryHealth, inspectStoredAssets(projectId, storedAssets), activity.warning === undefined ? [] : [activity.warning]);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to inspect the local project.', error);
    }
  }

  async listProjectHealth(): Promise<ProjectHealth[]> {
    try {
      const [metadataRows, currentRows, recoveryRows, assetRows, activityRows] = await this.db.transaction('r', this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.assets, this.db.dailyActivity, async () => Promise.all([
        this.db.projects.toArray(),
        this.db.currentSnapshots.toArray(),
        this.db.recoverySnapshots.toArray(),
        this.db.assets.toArray(),
        this.db.dailyActivity.toArray()
      ]));
      const metadataById = new Map(metadataRows.map((metadata) => [metadata.id, metadata]));
      const currentById = new Map(currentRows.map((snapshot) => [snapshot.projectId, snapshot]));
      const recoveryById = new Map(recoveryRows.map((snapshot) => [snapshot.projectId, snapshot]));
      const assetsById = new Map<string, StoredProjectAsset[]>();
      for (const asset of assetRows) {
        const existing = assetsById.get(asset.projectId) ?? [];
        existing.push(asset);
        assetsById.set(asset.projectId, existing);
      }
      const activityById = new Map<string, StoredDailyProgressAggregate[]>();
      for (const row of activityRows) {
        const existing = activityById.get(row.projectId) ?? [];
        existing.push(row);
        activityById.set(row.projectId, existing);
      }
      const projectIds = new Set<string>([
        ...metadataRows.map((metadata) => metadata.id),
        ...currentRows.map((snapshot) => snapshot.projectId),
        ...recoveryRows.map((snapshot) => snapshot.projectId),
        ...assetRows.map((asset) => asset.projectId),
        ...activityRows.map((row) => row.projectId)
      ]);
      const health: ProjectHealth[] = [];
      for (const projectId of projectIds) {
        if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 256) continue;
        const activity = activityFromStored(projectId, activityById.get(projectId) ?? []);
        const currentHealth = await inspectSnapshot(currentById.get(projectId), projectId);
        const recoveryHealth = await inspectSnapshot(recoveryById.get(projectId), projectId);
        if (currentHealth.status === 'corrupt') this.clearVerifiedCurrentCache(projectId);
        health.push(makeProjectHealth(
          projectId,
          metadataById.get(projectId),
          currentHealth,
          recoveryHealth,
          inspectStoredAssets(projectId, assetsById.get(projectId) ?? []),
          activity.warning === undefined ? [] : [activity.warning]
        ));
      }
      return health.sort((left, right) => {
        const leftUpdated = left.metadata?.updatedAt ?? 0;
        const rightUpdated = right.metadata?.updatedAt ?? 0;
        return rightUpdated - leftUpdated || (right.usableRevision ?? -1) - (left.usableRevision ?? -1) || left.projectId.localeCompare(right.projectId);
      });
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to inspect local project health.', error);
    }
  }

  async inspectProjects(): Promise<ProjectHealth[]> {
    return this.listProjectHealth();
  }

  /**
   * Explicitly opens the durable recovery revision. This never falls back
   * from load() implicitly, which keeps callers aware that the current head
   * was not used.
   */
  async loadRecoveryRevision(projectId: string, revision?: number): Promise<ProjectRecord | undefined> {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 256) invalidMetadata('Project ID is invalid.');
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) invalidMetadata('Recovery revision is invalid.');
    try {
      const { metadata, current, recovery, storedAssets, storedActivity, head } = await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.assets, this.db.dailyActivity], async () => {
        const [metadata, current, recovery, storedAssets, storedActivity, storedHead] = await Promise.all([
          this.db.projects.get(projectId),
          this.db.currentSnapshots.get(projectId),
          this.db.recoverySnapshots.get(projectId),
          this.db.assets.where('projectId').equals(projectId).toArray(),
          this.db.dailyActivity.where('projectId').equals(projectId).toArray(),
          this.db.projectHeads.get(projectId)
        ]);
        const snapshotHead = headFromSnapshot(projectId, current);
        const head = snapshotHead === undefined
          ? (isStoredHead(projectId, storedHead) ? storedHead : undefined)
          : isStoredHead(projectId, storedHead)
            && storedHead.revision === snapshotHead.revision
            && storedHead.checksum === snapshotHead.checksum
            ? storedHead
            : snapshotHead;
        if (head !== undefined && (!isStoredHead(projectId, storedHead) || storedHead.revision !== head.revision || storedHead.checksum !== head.checksum)) {
          await this.db.projectHeads.put(head);
        }
        return { metadata, current, recovery, storedAssets, storedActivity, head };
      });
      if (!metadata && !current && !recovery && storedAssets.length === 0 && storedActivity.length === 0) return undefined;
      if (!metadata || !isMetadataRecord(projectId, metadata) || !recovery) throw new PersistenceError('storage-failure', 'Project recovery data is incomplete.');
      const recoveryHealth = await inspectSnapshot(recovery, projectId);
      if (recoveryHealth.status !== 'valid') throw new PersistenceError('storage-failure', 'Project recovery snapshot is corrupt.');
      if (revision !== undefined && recovery.revision !== revision) throw new PersistenceError('storage-failure', `Recovery revision ${String(revision)} is not available.`);
      const document = await verifySnapshot(recovery);
      const loadedAssets = await loadAssets(projectId, storedAssets);
      const loadedActivity = activityFromStored(projectId, storedActivity);
      const sourceImage = inspectSourceImage(metadata.sourceImage, loadedAssets.assets);
      const safeMetadata = sanitizeSourceImageMetadata(metadata);
      const summary = deriveProjectSummary(document);
      const canonicalMetadata = withProjectSummary({ ...safeMetadata.metadata, revision: document.revision }, summary);
      const extraWarnings = [
        ...(loadedActivity.warning === undefined ? [] : [loadedActivity.warning]),
        ...(safeMetadata.warning === undefined ? [] : [safeMetadata.warning])
      ];
      const currentHealth = await inspectSnapshot(current, projectId);
      if (currentHealth.status === 'corrupt') this.clearVerifiedCurrentCache(projectId);
      const health = makeProjectHealth(projectId, canonicalMetadata, currentHealth, recoveryHealth, loadedAssets.health, extraWarnings, sourceImage);
      return {
        metadata: sanitizeProjectMetadata(canonicalMetadata),
        document,
        head,
        recovery: null,
        assets: loadedAssets.assets,
        activity: loadedActivity.activity,
        health
      };
    } catch (error) {
      this.clearVerifiedCurrentCache(projectId);
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to load the project recovery revision.', error);
    }
  }

  async loadRecovery(projectId: string, revision?: number): Promise<ProjectRecord | undefined> {
    return this.loadRecoveryRevision(projectId, revision);
  }

  /**
   * Explicitly promotes the validated recovery snapshot to current. The
   * operation is copy-on-write and never treats a recovery record as current
   * merely because the current record is unreadable.
   */
  async promoteRecoveryRevision(projectId: string, revision?: number): Promise<ProjectRecord> {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 256) invalidMetadata('Project ID is invalid.');
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) invalidMetadata('Recovery revision is invalid.');
    this.clearVerifiedCurrentCache(projectId);
    try {
      const [metadata, current, recovery] = await this.db.transaction('r', this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, async () => Promise.all([
        this.db.projects.get(projectId),
        this.db.currentSnapshots.get(projectId),
        this.db.recoverySnapshots.get(projectId)
      ]));
      if (!metadata || !isMetadataRecord(projectId, metadata) || !recovery) throw new PersistenceError('storage-failure', 'Project recovery data is incomplete.');
      if (recovery.projectId !== projectId) throw new PersistenceError('storage-failure', 'Project recovery snapshot does not match its key.');
      if (revision !== undefined && recovery.revision !== revision) throw new PersistenceError('storage-failure', `Recovery revision ${String(revision)} is not available.`);
      const recoveryDocument = await verifySnapshot(recovery);
      const recoveryBytes = storedBytes(recovery.bytes);
      if (!recoveryBytes) throw new PersistenceError('invalid-document', 'Recovery snapshot bytes are malformed.');
      const preflightMetadataRevision = metadata.revision;
      const preflightCurrentChecksum = current?.checksum ?? null;
      const preflightCurrentRevision = current?.revision ?? null;
      const preflightRecoveryChecksum = recovery.checksum;
      const preflightRecoveryRevision = recovery.revision;
      let validCurrent: StoredDocumentSnapshot | undefined;
      if (current && current.projectId === projectId && metadata.revision === current.revision) {
        try {
          await verifySnapshot(current);
          validCurrent = current;
        } catch {
          // A corrupt current record is deliberately not copied into recovery.
        }
      }
      const promotedChecksum = await sha256(recoveryBytes);
      const promotedSummary = deriveProjectSummary(recoveryDocument);
      const savedAt = this.now();
      await this.db.transaction('rw', this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, async () => {
        const [latestMetadata, latestCurrent, latestRecovery] = await Promise.all([
          this.db.projects.get(projectId),
          this.db.currentSnapshots.get(projectId),
          this.db.recoverySnapshots.get(projectId)
        ]);
        const latestCurrentChecksum = latestCurrent?.checksum ?? null;
        const latestCurrentRevision = latestCurrent?.revision ?? null;
        if (
          !latestRecovery
          || latestRecovery.checksum !== preflightRecoveryChecksum
          || latestRecovery.revision !== preflightRecoveryRevision
          || !latestMetadata
          || latestMetadata.id !== projectId
          || latestMetadata.revision !== preflightMetadataRevision
          || latestCurrentChecksum !== preflightCurrentChecksum
          || latestCurrentRevision !== preflightCurrentRevision
        ) throw new PersistenceError('stale-save', 'Project state changed before recovery could be promoted.');
        if (validCurrent && latestCurrent?.checksum === validCurrent.checksum && latestCurrent.checksum !== latestRecovery.checksum) {
          await this.db.recoverySnapshots.put({ ...latestCurrent, bytes: storedBytes(latestCurrent.bytes)?.slice() ?? latestCurrent.bytes });
        } else {
          await this.db.recoverySnapshots.delete(projectId);
        }
        await this.db.projects.put(withProjectSummary({ ...latestMetadata, revision: recoveryDocument.revision }, promotedSummary));
        await this.db.currentSnapshots.put(toStoredSnapshot(projectId, recoveryDocument, recoveryBytes, promotedChecksum, savedAt));
        await this.db.projectHeads.put(toStoredHead(projectId, recoveryDocument.revision, promotedChecksum));
      });
      const promoted = await this.load(projectId);
      if (!promoted) throw new PersistenceError('storage-failure', 'Promoted recovery could not be read back.');
      return promoted;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to promote the project recovery revision.', error);
    }
  }

  async promoteRecovery(projectId: string, revision?: number): Promise<ProjectRecord> {
    return this.promoteRecoveryRevision(projectId, revision);
  }

  async exportProject(projectId: string): Promise<Uint8Array> {
    const project = await this.load(projectId);
    if (!project) throw new PersistenceError('storage-failure', `Project ${projectId} does not exist.`);
    const warnings = project.health?.warnings.filter((warning) => warning.includes('Optional source image')) ?? [];
    const archive = await exportArchive(
      { metadata: project.metadata, document: project.document, assets: project.assets, activity: project.activity },
      { onWarning: (warning) => warnings.push(warning) }
    );
    this.exportWarningState = warnings;
    return archive;
  }

  async importProject(input: Uint8Array | ArrayBuffer | Blob, options: ArchiveImportOptions = {}): Promise<ProjectRecord> {
    // Parsing, migration, checksums, asset limits, and domain validation all
    // complete before the write transaction begins.
    const bundle = await importArchive(input, options);
    this.clearVerifiedCurrentCache(bundle.metadata.id);
    const importedMetadata = withProjectSummary(bundle.metadata, deriveProjectSummary(bundle.document));
    const bytes = encodeDocument(bundle.document);
    const checksum = await sha256(bytes);
    const savedAt = this.now();
    try {
      const [preflightMetadata, preflightCurrent, preflightRecovery] = await this.db.transaction('r', this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, async () => Promise.all([
        this.db.projects.get(bundle.metadata.id),
        this.db.currentSnapshots.get(bundle.metadata.id),
        this.db.recoverySnapshots.get(bundle.metadata.id)
      ]));
      let replacementRecovery: StoredDocumentSnapshot | undefined;
      let replacementSourceChecksum: string | undefined;
      if (preflightCurrent && preflightCurrent.projectId === bundle.metadata.id && preflightMetadata && isMetadataRecord(bundle.metadata.id, preflightMetadata) && preflightMetadata.revision === preflightCurrent.revision) {
        try {
          await verifySnapshot(preflightCurrent);
          replacementRecovery = { ...preflightCurrent, bytes: storedBytes(preflightCurrent.bytes)?.slice() ?? preflightCurrent.bytes };
          replacementSourceChecksum = preflightCurrent.checksum;
        } catch {
          // Do not make an unverified current snapshot into recovery data.
        }
      }
      if (!replacementRecovery && preflightRecovery) {
        try {
          await verifySnapshot(preflightRecovery);
          replacementRecovery = { ...preflightRecovery, bytes: storedBytes(preflightRecovery.bytes)?.slice() ?? preflightRecovery.bytes };
          replacementSourceChecksum = preflightRecovery.checksum;
        } catch {
          // A corrupt prior recovery is discarded during explicit replacement.
        }
      }
      await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.assets, this.db.dailyActivity], async () => {
        const [existingMetadata, existing, existingRecovery, existingAssets, existingActivity] = await Promise.all([
          this.db.projects.get(bundle.metadata.id),
          this.db.currentSnapshots.get(bundle.metadata.id),
          this.db.recoverySnapshots.get(bundle.metadata.id),
          this.db.assets.where('projectId').equals(bundle.metadata.id).toArray(),
          this.db.dailyActivity.where('projectId').equals(bundle.metadata.id).toArray()
        ]);
        const knownProject = existingMetadata !== undefined || existing !== undefined || existingRecovery !== undefined || existingAssets.length > 0 || existingActivity.length > 0;
        if ((options.collision ?? 'reject') === 'reject' && knownProject) throw new PersistenceError('import-collision', `Project ${bundle.metadata.id} already exists.`);

        // Replacement is the only operation allowed to touch an existing ID.
        // Prefer a verified current snapshot as recovery, but never copy an
        // unverified current record. If the head is bad, preserve a verified
        // prior recovery revision instead of poisoning it with that head.
        if ((options.collision ?? 'reject') === 'replace') {
          await this.db.recoverySnapshots.delete(bundle.metadata.id);
          if (replacementRecovery && replacementSourceChecksum !== undefined) {
            const sourceStillMatches = existing?.checksum === replacementSourceChecksum || existingRecovery?.checksum === replacementSourceChecksum;
            if (sourceStillMatches) await this.db.recoverySnapshots.put(replacementRecovery);
          }
        }
        await this.db.projects.put(importedMetadata);
        await this.db.currentSnapshots.put(toStoredSnapshot(bundle.metadata.id, bundle.document, bytes, checksum, savedAt));
        await this.db.projectHeads.put(toStoredHead(bundle.metadata.id, bundle.document.revision, checksum));
        await this.db.assets.where('projectId').equals(bundle.metadata.id).delete();
        const storedAssets: StoredProjectAsset[] = bundle.assets.map((asset) => ({ ...asset, projectId: bundle.metadata.id, data: asset.data.slice() }));
        if (storedAssets.length > 0) await this.db.assets.bulkPut(storedAssets);
        await this.db.dailyActivity.where('projectId').equals(bundle.metadata.id).delete();
        if (bundle.activity !== undefined) {
          const activity = normalizeProgressActivity(bundle.activity);
          const storedActivity = toStoredActivity(bundle.metadata.id, activity);
          if (storedActivity.length > 0) await this.db.dailyActivity.bulkPut(storedActivity);
        }
      });
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('storage-failure', 'Unable to import the project locally.', error);
    }
    const project = await this.load(bundle.metadata.id);
    if (!project) throw new PersistenceError('storage-failure', 'Imported project could not be read back.');
    if (bundle.warnings && bundle.warnings.length > 0 && project.health) {
      project.health = { ...project.health, warnings: [...project.health.warnings, ...bundle.warnings] };
    }
    return project;
  }

  async deleteProject(projectId: string): Promise<void> {
    this.clearVerifiedCurrentCache(projectId);
    await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.assets, this.db.dailyActivity], async () => {
      await this.db.projects.delete(projectId);
      await this.db.currentSnapshots.delete(projectId);
      await this.db.recoverySnapshots.delete(projectId);
      await this.db.projectHeads.delete(projectId);
      await this.db.assets.where('projectId').equals(projectId).delete();
      await this.db.dailyActivity.where('projectId').equals(projectId).delete();
    });
  }

  async close(): Promise<void> {
    this.clearVerifiedCurrentCache();
    this.db.close();
  }
}

export const ProjectStore = ProjectRepository;
export const LocalProjectRepository = ProjectRepository;
export const SaveCoordinator = ProjectRepository;

export function createRepository(db?: NeedlewiseDatabase, options?: RepositoryOptions): ProjectRepository {
  return new ProjectRepository(db, options);
}
