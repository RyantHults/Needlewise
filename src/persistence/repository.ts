import { assertValidLayeredDocument, isRecord, type LayeredDocument } from '../domain';
import { isSha256Hex, isValidAssetMetadata, readAssetInputBytes } from './asset-input';
import { NeedlewiseDatabase } from './database';
import { PersistenceError, wrapStorage } from './errors';
import { isProjectId, parseProjectMetadata, type ParsedProjectMetadata } from './metadata';
import {
  isBoundedMetadataString,
  isValidAssetId,
  MAX_ASSET_BYTES,
  MAX_ASSET_TOTAL_BYTES,
  MAX_DOCUMENT_BYTES
} from './limits';
import { applyLegacyAidaCount, cloneLayeredDocument, decodeDocumentWithInfo, encodeDocument, type DecodedDocument } from './binary';
import { sha256 } from './hash';
import { inspectSourceImage } from './source-image';
import {
  completeProjectSummary,
  deriveProjectSummary,
  projectThumbnailsEqual,
  sanitizeProjectMetadata,
  withProjectSummary,
  type ProjectDocumentSummary
} from './project-thumbnail';
import type {
  CreateFolderInput,
  ProjectAsset,
  ProjectAssetInput,
  ProjectFolder,
  ProjectFolderAssignment,
  ProjectFolderIndex,
  ProjectHealth,
  ProjectMetadata,
  ProjectRecord,
  PreparedDocumentCapability,
  RepositoryOptions,
  SaveResult,
  SaveOptions,
  SessionHistoryEnvelope,
  SessionHistoryInput,
  StoredDocumentSnapshot,
  StoredDocumentHistory,
  StoredProjectHead,
  StoredProjectAsset
} from './types';
import { MAX_FOLDER_NAME_CHARS } from './types';
import { consumePreparedDocumentCapability } from './preparation-client';
import { prepareSessionHistory, prepareSessionHistoryForSave, sessionHistoryMatchesTrace, traceStateCanonical, traceStateFingerprint } from './session-history';

function invalidMetadata(message: string): never {
  throw new PersistenceError('invalid-metadata', message);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateFolderName(name: string): string {
  if (typeof name !== 'string') invalidMetadata('Folder name is malformed.');
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_FOLDER_NAME_CHARS) invalidMetadata(`Folder name must be between 1 and ${String(MAX_FOLDER_NAME_CHARS)} characters.`);
  if (hasControlCharacter(trimmed) || !isBoundedMetadataString(trimmed)) invalidMetadata('Folder name is malformed.');
  return trimmed;
}

/**
 * Parses metadata for writing. Any warning means our own code built bad
 * metadata, so it fails the save. A legacy `aidaCount` is never written: the
 * stitch count now lives in the document settings.
 */
function metadataForSave(projectId: string, input: ProjectMetadata, revision: number): ProjectMetadata {
  const { metadata, warnings } = parseProjectMetadata(input);
  if (metadata.id !== projectId) invalidMetadata('Project metadata ID does not match the project being saved.');
  if (warnings.length > 0) invalidMetadata(warnings[0]);
  if (metadata.revision !== revision) invalidMetadata('Project metadata and document revisions must match.');
  return metadata;
}

/** Parses a stored metadata row for its key; a missing row or one with a malformed required field yields undefined. */
function readStoredMetadata(projectId: string, row: unknown): ParsedProjectMetadata | undefined {
  if (row === undefined) return undefined;
  try {
    const parsed = parseProjectMetadata(row);
    return parsed.metadata.id === projectId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The row to write back for parsed metadata, keeping a legacy stitch count with its v1/v2 document. */
function storedMetadataRow(metadata: ProjectMetadata, legacyAidaCount: number | undefined): ProjectMetadata {
  return legacyAidaCount === undefined ? metadata : { ...metadata, aidaCount: legacyAidaCount };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The local record is malformed.';
}

function storedBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

async function normalizeAssets(inputs: readonly ProjectAssetInput[]): Promise<ProjectAsset[]> {
  const assets: ProjectAsset[] = [];
  const ids = new Set<string>();
  let total = 0;
  for (const input of inputs) {
    if (ids.has(input.id)) throw new PersistenceError('invalid-asset', `Asset ${input.id} is duplicated.`);
    const data = await readAssetInputBytes(input);
    total += data.length;
    if (total > MAX_ASSET_TOTAL_BYTES) throw new PersistenceError('invalid-asset', 'Assets exceed the size limit.');
    ids.add(input.id);
    assets.push({ id: input.id, name: input.name, mimeType: input.mimeType, data, checksum: await sha256(data) });
  }
  return assets;
}

async function decodeSnapshot(snapshot: StoredDocumentSnapshot): Promise<DecodedDocument> {
  const bytes = storedBytes(snapshot.bytes);
  if (!isProjectId(snapshot.projectId) || !bytes || typeof snapshot.checksum !== 'string' || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new PersistenceError('invalid-document', 'Stored snapshot metadata is malformed.');
  }
  const checksum = await sha256(bytes);
  if (checksum !== snapshot.checksum) throw new PersistenceError('checksum-mismatch', `Snapshot revision ${String(snapshot.revision)} failed its checksum.`);
  const decoded = decodeDocumentWithInfo(bytes);
  if (decoded.document.revision !== snapshot.revision) throw new PersistenceError('invalid-document', 'Snapshot revision does not match its document.');
  return decoded;
}

async function verifySnapshot(snapshot: StoredDocumentSnapshot): Promise<LayeredDocument> {
  return (await decodeSnapshot(snapshot)).document;
}

/** Decodes a snapshot for use, copying a legacy metadata stitch count into v1/v2 documents. */
async function loadSnapshotDocument(snapshot: StoredDocumentSnapshot, legacyAidaCount: number | undefined): Promise<LayeredDocument> {
  const decoded = await decodeSnapshot(snapshot);
  applyLegacyAidaCount(decoded, legacyAidaCount);
  return decoded.document;
}

function toStoredPreparedSnapshot(projectId: string, revision: number, bytes: Uint8Array, checksum: string, savedAt: number): StoredDocumentSnapshot {
  // The preparation result is already persistence-owned. IndexedDB performs
  // its own structured clone when this record is committed; do not make a
  // second main-thread byte copy here.
  return { projectId, revision, bytes, checksum, savedAt };
}

function toStoredHead(projectId: string, revision: number, checksum: string, historyGeneration?: number): StoredProjectHead {
  return { projectId, revision, checksum, ...(historyGeneration === undefined ? {} : { historyGeneration }) };
}

function toStoredHistory(projectId: string, head: StoredProjectHead, history: SessionHistoryEnvelope, generation: number, traceFingerprint: string, savedAt: number): StoredDocumentHistory {
  return { projectId, revision: head.revision, checksum: head.checksum, generation, traceFingerprint, history, savedAt };
}

function isStoredHistory(projectId: string, value: StoredDocumentHistory | undefined): value is StoredDocumentHistory {
  return value !== undefined
    && value.projectId === projectId
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && isSha256Hex(value.checksum)
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && isSha256Hex(value.traceFingerprint)
    && Number.isSafeInteger(value.savedAt)
    && value.savedAt >= 0
    && isRecord(value.history);
}

function headFromSnapshot(projectId: string, snapshot: StoredDocumentSnapshot | undefined): StoredProjectHead | undefined {
  if (
    !snapshot
    || snapshot.projectId !== projectId
    || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 0
    || !isSha256Hex(snapshot.checksum)
  ) return undefined;
  return toStoredHead(projectId, snapshot.revision, snapshot.checksum);
}

function isStoredHead(projectId: string, head: StoredProjectHead | undefined): head is StoredProjectHead {
  return head !== undefined
    && head.projectId === projectId
    && Number.isSafeInteger(head.revision)
    && head.revision >= 0
    && isSha256Hex(head.checksum)
    && (head.historyGeneration === undefined || (Number.isSafeInteger(head.historyGeneration) && head.historyGeneration >= 0));
}

function headSignature(projectId: string, head: StoredProjectHead | undefined): string {
  if (isStoredHead(projectId, head)) return `valid:${String(head.revision)}:${head.checksum}:${String(head.historyGeneration ?? 0)}`;
  return head === undefined ? 'missing' : 'invalid';
}

function nextHistoryGeneration(head: StoredProjectHead | undefined, stored: StoredDocumentHistory | undefined): number {
  const currentHeadGeneration = head?.historyGeneration ?? 0;
  const currentRowGeneration = stored?.generation ?? 0;
  const current = Math.max(currentHeadGeneration, currentRowGeneration);
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) throw new Error('session history generation overflowed.');
  return current + 1;
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
    || !isValidAssetMetadata(asset)
    || !bytes
    || bytes.length > MAX_ASSET_BYTES
    || !isSha256Hex(asset.checksum)
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
  if (!metadata) warnings.push('Project metadata is missing or malformed.');
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
    metadata: metadata ? { ...metadata } : null,
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

/** A session history checked against the trace state it is saved with. */
interface PreparedHistory {
  history: SessionHistoryEnvelope;
  traceCanonical: string;
  traceFingerprint: string;
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
  private verifiedCurrentCache: StoredDocumentSnapshot | undefined;

  constructor(db: NeedlewiseDatabase | undefined = undefined, options: RepositoryOptions = {}) {
    this.db = db ?? new NeedlewiseDatabase(options.databaseName);
    this.now = options.now ?? (() => Date.now());
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
        && projectThumbnailsEqual(existing.thumbnail, summary.thumbnail)
      ) return;
      await this.db.transaction('rw', [this.db.projects, this.db.projectHeads], async () => {
        const [row, storedHead] = await Promise.all([
          this.db.projects.get(projectId),
          this.db.projectHeads.get(projectId)
        ]);
        const stored = readStoredMetadata(projectId, row);
        if (
          !stored
          || stored.metadata.revision !== loadedMetadata.revision
          || !isStoredHead(projectId, storedHead)
          || storedHead.revision !== head.revision
          || storedHead.checksum !== head.checksum
        ) return;
        const freshSummary = completeProjectSummary(stored.metadata);
        if (
          freshSummary?.width === summary.width
          && freshSummary.height === summary.height
          && projectThumbnailsEqual(freshSummary.thumbnail, summary.thumbnail)
        ) return;
        // Merge with the row read inside the CAS transaction so unrelated
        // metadata edits made after load are not overwritten by this cache
        // repair.
        await this.db.projects.put(withProjectSummary(storedMetadataRow(stored.metadata, stored.legacyAidaCount), summary));
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
    head: StoredProjectHead,
    assets: readonly ProjectAsset[] | undefined,
    history: SessionHistoryEnvelope | null | undefined,
    traceFingerprint?: string,
    onHistoryWrite?: () => void
  ): Promise<void> {
    await this.db.projects.put(metadata);
    await this.db.currentSnapshots.put(snapshot);
    await this.db.projectHeads.put(head);
    if (assets !== undefined) {
      await this.db.assets.where('projectId').equals(projectId).delete();
      const storedAssets: StoredProjectAsset[] = assets.map((asset) => ({ ...asset, projectId, data: asset.data.slice() }));
      if (storedAssets.length > 0) await this.db.assets.bulkPut(storedAssets);
    }
    if (history !== undefined) {
      onHistoryWrite?.();
      await this.db.documentHistories.delete(projectId);
      if (history !== null) {
        if (head.historyGeneration === undefined || traceFingerprint === undefined) throw new Error('session history anchor is incomplete.');
        await this.db.documentHistories.put(toStoredHistory(projectId, head, history, head.historyGeneration, traceFingerprint, snapshot.savedAt));
      }
    }
  }

  private async bestEffortDeleteHistory(projectId: string, expected?: unknown): Promise<void> {
    try {
      await this.db.transaction('rw', this.db.documentHistories, async () => {
        if (expected !== undefined) {
          const current = await this.db.documentHistories.get(projectId);
          if (
            !current
            || typeof expected !== 'object'
            || expected === null
            || current.projectId !== (expected as { projectId?: unknown }).projectId
            || current.revision !== (expected as { revision?: unknown }).revision
            || current.checksum !== (expected as { checksum?: unknown }).checksum
            || current.generation !== (expected as { generation?: unknown }).generation
            || current.traceFingerprint !== (expected as { traceFingerprint?: unknown }).traceFingerprint
            || current.savedAt !== (expected as { savedAt?: unknown }).savedAt
          ) return;
        }
        await this.db.documentHistories.delete(projectId);
      });
    } catch {
      // History is an optional cache. Cleanup failures must not make the
      // canonical document operation fail.
    }
  }

  private async bestEffortClearHistoryUnlessHead(projectId: string, head: StoredProjectHead): Promise<void> {
    try {
      await this.db.transaction('rw', this.db.documentHistories, async () => {
        const current = await this.db.documentHistories.get(projectId);
        if (isStoredHistory(projectId, current) && current.revision === head.revision && current.checksum === head.checksum && current.generation === head.historyGeneration) return;
        await this.db.documentHistories.delete(projectId);
      });
    } catch {
      // History cleanup is deliberately non-fatal after a canonical commit.
    }
  }

  async save(projectId: string, metadata: ProjectMetadata, document: LayeredDocument, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    return this.enqueue(projectId, () => options.mode === 'retain'
      ? this.saveRetained(projectId, metadata, assets, options)
      : this.saveReplaced(projectId, metadata, document, assets, options));
  }

  async savePrepared(projectId: string, metadata: ProjectMetadata, prepared: PreparedDocumentCapability, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    return this.enqueue(projectId, () => this.savePreparedSerialized(projectId, metadata, prepared, assets, options));
  }

  /** Runs the saves of one project one at a time, in call order, whatever the outcome of the one before. */
  private enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => operation());
    const settle = (): void => {
      if (this.queues.get(projectId) === tracked) this.queues.delete(projectId);
    };
    const tracked = result.then(settle, settle);
    this.queues.set(projectId, tracked);
    return result;
  }

  private async savePreparedSerialized(projectId: string, metadataInput: ProjectMetadata, prepared: PreparedDocumentCapability, assetsInput?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    if (options.mode === 'retain') invalidMetadata('Prepared document commits must use replace mode.');
    if (typeof options.preparedRequestId !== 'string' || options.preparedRequestId.length < 1 || options.preparedRequestId.length > 256) throw new PersistenceError('invalid-document', 'Prepared document request identity is malformed.');
    const metadata = metadataForSave(projectId, metadataInput, metadataInput.revision);
    return consumePreparedDocumentCapability(
      prepared,
      { projectId, revision: metadata.revision, requestId: options.preparedRequestId },
      async (bytes, checksum, summary) => this.commitReplaced(projectId, metadata, summary, metadata.revision, bytes, checksum, assetsInput, options, false)
    );
  }

  private async saveReplaced(projectId: string, metadataInput: ProjectMetadata, sourceDocument: LayeredDocument, assetsInput?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    assertValidLayeredDocument(sourceDocument);
    const document = cloneLayeredDocument(sourceDocument);
    const metadata = metadataForSave(projectId, metadataInput, document.revision);
    const summary = deriveProjectSummary(document);
    const bytes = encodeDocument(document);
    const checksum = await sha256(bytes);
    return this.commitReplaced(projectId, metadata, summary, document.revision, bytes, checksum, assetsInput, options, true);
  }

  /**
   * Prepares the rows a save writes beside the document. `history` is
   * undefined when the save leaves stored history alone, and null when the
   * save clears it.
   */
  private async prepareAuxiliaryRows(
    projectId: string,
    metadata: ProjectMetadata,
    assetsInput: readonly ProjectAssetInput[] | undefined,
    historyInput: SessionHistoryInput | undefined
  ): Promise<{ assets: ProjectAsset[] | undefined; history: PreparedHistory | null | undefined }> {
    const envelope = historyInput === undefined ? undefined : await prepareSessionHistoryForSave(historyInput) ?? null;
    const assets = assetsInput === undefined ? undefined : await normalizeAssets(assetsInput);
    const history = envelope === undefined || envelope === null ? envelope : await this.prepareHistoryTrace(projectId, metadata, assets, envelope);
    return { assets, history };
  }

  /** Anchors a history to the trace state it is saved with. A history that does not match it, or whose trace cannot be read, is cleared. */
  private async prepareHistoryTrace(projectId: string, metadata: ProjectMetadata, assets: readonly ProjectAsset[] | undefined, history: SessionHistoryEnvelope): Promise<PreparedHistory | null> {
    try {
      const traceAssets = assets ?? await this.db.assets.where('projectId').equals(projectId).toArray();
      if (!sessionHistoryMatchesTrace(history, metadata, traceAssets)) return null;
      return { history, traceCanonical: traceStateCanonical(metadata, traceAssets), traceFingerprint: await traceStateFingerprint(metadata, traceAssets) };
    } catch {
      return null;
    }
  }

  /**
   * Re-checks a prepared history inside the commit transaction. Returns
   * 'trace-changed' when the trace state moved after preparation, and null
   * when the history no longer matches it.
   */
  private async checkHistoryAnchor(projectId: string, metadata: ProjectMetadata, assets: readonly ProjectAsset[] | undefined, prepared: PreparedHistory): Promise<SessionHistoryEnvelope | null | 'trace-changed'> {
    const fingerprintAssets = assets ?? await this.db.assets.where('projectId').equals(projectId).toArray();
    if (traceStateCanonical(metadata, fingerprintAssets) !== prepared.traceCanonical) return 'trace-changed';
    return sessionHistoryMatchesTrace(prepared.history, metadata, fingerprintAssets) ? prepared.history : null;
  }

  private tablesFor(includeHistory: boolean) {
    const { projects, currentSnapshots, recoverySnapshots, projectHeads, documentHistories, assets } = this.db;
    return includeHistory
      ? [projects, currentSnapshots, recoverySnapshots, projectHeads, documentHistories, assets]
      : [projects, currentSnapshots, recoverySnapshots, projectHeads, assets];
  }

  /**
   * Runs a save's commit transaction, and when a history write fails, runs it
   * once more without the history table: a history clone or quota failure must
   * not roll back the canonical commit. Stored history is cleared only after
   * that fallback commits, because its anchor no longer matches the new head.
   */
  private async commitWithOptionalHistory<R>(
    projectId: string,
    includeHistory: boolean,
    commit: (includeHistory: boolean, markHistoryWrite: () => void) => Promise<R>,
    committedHead: (result: R) => StoredProjectHead | undefined
  ): Promise<R> {
    let historyWriteStarted = false;
    const markHistoryWrite = (): void => { historyWriteStarted = true; };
    try {
      return await commit(includeHistory, markHistoryWrite);
    } catch (historyError) {
      if (!historyWriteStarted) throw historyError;
      const result = await commit(false, markHistoryWrite).catch(() => { throw historyError; });
      const head = committedHead(result);
      if (head !== undefined) await this.bestEffortClearHistoryUnlessHead(projectId, head);
      return result;
    }
  }

  private async tryWarmReplacement(
    projectId: string,
    revision: number,
    metadata: ProjectMetadata,
    nextSnapshot: StoredDocumentSnapshot,
    assets: readonly ProjectAsset[] | undefined,
    history: PreparedHistory | null,
    options: SaveOptions
  ): Promise<WarmCommitDecision | undefined> {
    const cached = this.verifiedCurrentCache;
    if (!cached || cached.projectId !== projectId) return undefined;
    return wrapStorage('Unable to commit the project locally.', async () => {
      let warmPreflightHead: StoredProjectHead | undefined;
      const decision = await this.commitWithOptionalHistory(projectId, true, async (includeHistory, markHistoryWrite) => this.db.transaction('rw', this.tablesFor(includeHistory), async (): Promise<WarmCommitDecision> => {
        const head = await this.db.projectHeads.get(projectId);
        if (!isStoredHead(projectId, head)) return { kind: 'fallback', invalidateCache: true };
        if (includeHistory) warmPreflightHead = head;
        if (!includeHistory && headSignature(projectId, head) !== headSignature(projectId, warmPreflightHead)) {
          return { kind: 'stale', invalidateCache: true, result: { committed: false, stale: true, revision: head.revision } };
        }
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

        const storedHistory = includeHistory ? await this.db.documentHistories.get(projectId) : undefined;
        const generation = nextHistoryGeneration(head, isStoredHistory(projectId, storedHistory) ? storedHistory : undefined);
        const nextHead = toStoredHead(projectId, revision, nextSnapshot.checksum, generation);
        let effectiveHistory = history?.history ?? null;
        if (includeHistory && history !== null) {
          const anchored = await this.checkHistoryAnchor(projectId, metadata, assets, history);
          if (anchored === 'trace-changed') return { kind: 'fallback', invalidateCache: true };
          effectiveHistory = anchored;
        }

        // The cache is a fully verified exact current record. Dexie clones it
        // as part of the transaction, so no main-thread byte copy is needed.
        await this.db.recoverySnapshots.put(cached);
        await this.writeReplacementRows(projectId, metadata, nextSnapshot, nextHead, assets, includeHistory ? effectiveHistory : undefined, history?.traceFingerprint, markHistoryWrite);
        return { kind: 'committed', result: { committed: true, stale: false, revision, head: nextHead } };
      }), (decision) => decision.kind === 'committed' ? decision.result.head : undefined);
      if (decision.kind === 'committed') this.cacheVerifiedCurrentSnapshot(nextSnapshot);
      return decision;
    });
  }

  private async commitReplaced(projectId: string, metadataInput: ProjectMetadata, summary: ProjectDocumentSummary, revision: number, bytes: Uint8Array, checksum: string, assetsInput: readonly ProjectAssetInput[] | undefined, options: SaveOptions, clonePreparedBytes: boolean): Promise<SaveResult> {
    const metadata = withProjectSummary(metadataInput, summary);
    const auxiliary = await this.prepareAuxiliaryRows(projectId, metadata, assetsInput, options.history);
    const { assets } = auxiliary;
    // A replace commit always rewrites stored history, since the new head
    // orphans whatever history was anchored to the old one.
    const history = auxiliary.history ?? null;
    const savedAt = this.now();
    const nextSnapshot = toStoredPreparedSnapshot(projectId, revision, clonePreparedBytes ? bytes.slice() : bytes, checksum, savedAt);
    const warmDecision = await this.tryWarmReplacement(projectId, revision, metadata, nextSnapshot, assets, history, options);
    if (warmDecision?.kind === 'committed') return warmDecision.result;
    if (warmDecision?.kind === 'stale') {
      if (warmDecision.invalidateCache) this.clearVerifiedCurrentCache(projectId);
      return warmDecision.result;
    }
    if (warmDecision?.kind === 'fallback' && warmDecision.invalidateCache) this.clearVerifiedCurrentCache(projectId);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { previouslyValid, preflightHead } = await wrapStorage('Unable to inspect the current local snapshot.', async () => {
        const [candidate, head] = await Promise.all([
          this.db.currentSnapshots.get(projectId),
          this.db.projectHeads.get(projectId)
        ]);
        let verified: StoredDocumentSnapshot | undefined;
        if (candidate && candidate.revision < revision) {
          try {
            await verifySnapshot(candidate);
            verified = candidate;
          } catch (error) {
            // A corrupt current snapshot must never become recovery data. The
            // new validated revision can still replace it atomically.
            if (!(error instanceof PersistenceError)) throw error;
          }
        }
        return { previouslyValid: verified, preflightHead: head };
      });
      const result = await wrapStorage('Unable to commit the project locally.', async () => this.commitWithOptionalHistory(projectId, true, async (includeHistory, markHistoryWrite) => this.db.transaction('rw', this.tablesFor(includeHistory), async (): Promise<SaveResult> => {
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
        const storedHistory = includeHistory ? await this.db.documentHistories.get(projectId) : undefined;
        const generation = nextHistoryGeneration(existingHead, isStoredHistory(projectId, storedHistory) ? storedHistory : undefined);
        const nextHead = toStoredHead(projectId, revision, checksum, generation);
        let effectiveHistory = history?.history ?? null;
        if (includeHistory && history !== null) {
          const anchored = await this.checkHistoryAnchor(projectId, metadata, assets, history);
          if (anchored === 'trace-changed') return { committed: false, stale: true, revision };
          effectiveHistory = anchored;
        }
        await this.writeReplacementRows(projectId, metadata, nextSnapshot, nextHead, assets, includeHistory ? effectiveHistory : undefined, history?.traceFingerprint, markHistoryWrite);
        return { committed: true, stale: false, revision, head: nextHead };
      }), (committed) => committed.committed ? committed.head : undefined));
      if (result.committed) {
        this.cacheVerifiedCurrentSnapshot(nextSnapshot);
      } else if (result.stale) {
        this.clearVerifiedCurrentCache(projectId);
        if (attempt === 0) continue;
      }
      return result;
    }
    throw new PersistenceError('storage-failure', 'Unable to commit the project locally.');
  }

  private async saveRetained(projectId: string, metadataInput: ProjectMetadata, assetsInput?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    const requestedHead = options.expectedHead;
    if (requestedHead?.projectId !== undefined && requestedHead.projectId !== projectId) invalidMetadata('Expected project head does not match the project being saved.');
    if (requestedHead !== undefined && options.expectedRevision !== undefined && options.expectedRevision !== requestedHead.revision) invalidMetadata('Expected project revisions do not match.');
    const expectedRevision = requestedHead?.revision ?? options.expectedRevision ?? metadataInput.revision;
    const expectedChecksum = requestedHead?.checksum;
    const expectedGeneration = requestedHead?.historyGeneration;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalidMetadata('Expected project revision is invalid.');
    if (expectedChecksum !== undefined && typeof expectedChecksum !== 'string') invalidMetadata('Expected project head is malformed.');
    if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)) invalidMetadata('Expected history generation is invalid.');

    // Retain mode deliberately validates only the metadata and auxiliary
    // rows. It never touches the document value, so no document clone,
    // assertion, encoding, checksum, or snapshot readback is performed.
    const incomingMetadata = metadataForSave(projectId, metadataInput, expectedRevision);
    const incomingSummary = completeProjectSummary(incomingMetadata);
    // The head check inside the commit transaction anchors this history to
    // the current snapshot; no snapshot decode or chain replay happens here.
    const { assets, history } = await this.prepareAuxiliaryRows(projectId, incomingMetadata, assetsInput, options.history);

    const result = await wrapStorage('Unable to commit the project locally.', async () => this.commitWithOptionalHistory(projectId, history !== undefined, async (includeHistory, markHistoryWrite) => this.db.transaction('rw', this.tablesFor(includeHistory), async (): Promise<SaveResult> => {
      const [storedRow, storedHead] = await Promise.all([
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
        if (head !== undefined && expectedGeneration !== undefined) head = { ...head, historyGeneration: expectedGeneration };
        needsBackfill = head !== undefined;
      }
      if (
        !head
        || head.revision !== expectedRevision
        || (expectedChecksum !== undefined && head.checksum !== expectedChecksum)
        || (expectedGeneration !== undefined && head.historyGeneration !== expectedGeneration)
      ) {
        return { committed: false, stale: true, revision: head?.revision ?? legacyCurrent?.revision ?? expectedRevision };
      }

      // Retain changes metadata and auxiliary rows only. A complete summary
      // already stored for the head wins as one unit; otherwise a complete
      // incoming summary fills all three fields. Partial summaries are
      // never assembled field-by-field.
      const parsedStored = readStoredMetadata(projectId, storedRow);
      const stored = parsedStored?.metadata.revision === expectedRevision ? parsedStored : undefined;
      const retainedSummary = (stored === undefined ? undefined : completeProjectSummary(stored.metadata)) ?? incomingSummary;
      const retainedMetadata: ProjectMetadata = { ...incomingMetadata };
      delete retainedMetadata.width;
      delete retainedMetadata.height;
      delete retainedMetadata.thumbnail;
      // Retain never rewrites the snapshot, so a stored legacy stitch count
      // stays with its v1/v2 document until the next replace commit.
      if (stored?.legacyAidaCount !== undefined) retainedMetadata.aidaCount = stored.legacyAidaCount;
      if (retainedSummary !== undefined) {
        retainedMetadata.width = retainedSummary.width;
        retainedMetadata.height = retainedSummary.height;
        retainedMetadata.thumbnail = retainedSummary.thumbnail;
      }

      // This transaction intentionally excludes all snapshot writes. The
      // expected-head check and every auxiliary-row update are atomic.
      const storedHistory = includeHistory ? await this.db.documentHistories.get(projectId) : undefined;
      const generation = history !== undefined
        ? nextHistoryGeneration(head, isStoredHistory(projectId, storedHistory) ? storedHistory : undefined)
        : head.historyGeneration;
      const nextHead = toStoredHead(projectId, head.revision, head.checksum, generation);
      if (needsBackfill || nextHead.historyGeneration !== head.historyGeneration) await this.db.projectHeads.put(nextHead);
      await this.db.projects.put(retainedMetadata);
      let effectiveHistory = history === undefined || history === null ? history : history.history;
      if (includeHistory && history !== undefined && history !== null) {
        const anchored = await this.checkHistoryAnchor(projectId, retainedMetadata, assets, history);
        if (anchored === 'trace-changed') return { committed: false, stale: true, revision: expectedRevision };
        effectiveHistory = anchored;
      }
      if (assets !== undefined) {
        await this.db.assets.where('projectId').equals(projectId).delete();
        const storedAssets: StoredProjectAsset[] = assets.map((asset) => ({ ...asset, projectId, data: asset.data.slice() }));
        if (storedAssets.length > 0) await this.db.assets.bulkPut(storedAssets);
      }
      if (includeHistory && effectiveHistory !== undefined) {
        markHistoryWrite();
        await this.db.documentHistories.delete(projectId);
        if (effectiveHistory !== null) {
          if (nextHead.historyGeneration === undefined || history?.traceFingerprint === undefined) throw new Error('session history anchor is incomplete.');
          await this.db.documentHistories.put(toStoredHistory(projectId, nextHead, effectiveHistory, nextHead.historyGeneration, history.traceFingerprint, this.now()));
        }
      }
      return { committed: true, stale: false, revision: expectedRevision, head: nextHead };
    }), (committed) => committed.committed ? committed.head : undefined));
    if (!result.committed && result.stale) this.clearVerifiedCurrentCache(projectId);
    return result;
  }

  /** The head a load trusts: the stored head when it names the current snapshot, else one derived from the snapshot and written back. */
  private async reconcileHead(projectId: string, current: StoredDocumentSnapshot | undefined, storedHead: StoredProjectHead | undefined): Promise<StoredProjectHead | undefined> {
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
    return head;
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    if (!isProjectId(projectId)) invalidMetadata('Project ID is invalid.');
    this.clearVerifiedCurrentCache(projectId);
    try {
      return await wrapStorage('Unable to load the project locally.', async () => {
        const { row, current, recovery, storedAssets, storedHistory, head } = await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.documentHistories, this.db.assets], async () => {
          const [row, current, recovery, storedAssets, storedHead, storedHistory] = await Promise.all([
            this.db.projects.get(projectId),
            this.db.currentSnapshots.get(projectId),
            this.db.recoverySnapshots.get(projectId),
            this.db.assets.where('projectId').equals(projectId).toArray(),
            this.db.projectHeads.get(projectId),
            this.db.documentHistories.get(projectId)
          ]);
          return { row, current, recovery, storedAssets, storedHistory, head: await this.reconcileHead(projectId, current, storedHead) };
        });
        if (!row && !current && !recovery && storedAssets.length === 0) return undefined;
        const currentHealth = await inspectSnapshot(current, projectId);
        const recoveryHealth = await inspectSnapshot(recovery, projectId);
        const parsed = readStoredMetadata(projectId, row);
        if (!parsed) throw new PersistenceError('storage-failure', 'Project metadata is missing or malformed.');
        const { metadata, legacyAidaCount, warnings } = parsed;
        if (currentHealth.status !== 'valid' || !current) throw new PersistenceError('storage-failure', 'Current project snapshot is corrupt or missing.');
        const document = await loadSnapshotDocument(current, legacyAidaCount);
        if (metadata.revision !== document.revision) throw new PersistenceError('storage-failure', 'Project metadata and current snapshot are inconsistent.');
        let recoveryRecord: ProjectRecord['recovery'] = null;
        if (recovery && recoveryHealth.status === 'valid') {
          const recoveryDocument = await loadSnapshotDocument(recovery, legacyAidaCount);
          recoveryRecord = { revision: recovery.revision, document: recoveryDocument };
        }
        const loadedAssets = await loadAssets(projectId, storedAssets);
        const sourceImage = inspectSourceImage(metadata.sourceImage, loadedAssets.assets);
        const summary = deriveProjectSummary(document);
        const canonicalMetadata = withProjectSummary(metadata, summary);
        let loadedHistory: SessionHistoryEnvelope | undefined;
        if (
          isStoredHistory(projectId, storedHistory)
          && head !== undefined
          && storedHistory.revision === head.revision
          && storedHistory.checksum === head.checksum
          && storedHistory.generation === head.historyGeneration
        ) {
          try {
            const fingerprint = await traceStateFingerprint(metadata, loadedAssets.assets);
            if (fingerprint === storedHistory.traceFingerprint) loadedHistory = await prepareSessionHistory(document, storedHistory.history, { metadata, assets: loadedAssets.assets });
          } catch {
            loadedHistory = undefined;
          }
        }
        if (storedHistory !== undefined && loadedHistory === undefined) await this.bestEffortDeleteHistory(projectId, storedHistory);
        const health = makeProjectHealth(projectId, canonicalMetadata, currentHealth, recoveryHealth, loadedAssets.health, warnings, sourceImage);
        this.cacheVerifiedCurrentSnapshot(current);
        await this.bestEffortBackfillSummary(projectId, metadata, head, summary);
        return { metadata: sanitizeProjectMetadata(canonicalMetadata), document, head, history: loadedHistory, recovery: recoveryRecord, assets: loadedAssets.assets, health };
      });
    } catch (error) {
      this.clearVerifiedCurrentCache(projectId);
      throw error;
    }
  }

  async getAsset(projectId: string, assetId: string): Promise<ProjectAsset | undefined> {
    if (!isProjectId(projectId) || !isValidAssetId(assetId)) invalidMetadata('Project or asset ID is invalid.');
    return wrapStorage('Unable to retrieve the project asset.', async () => {
      const stored = await this.db.assets.get([projectId, assetId]);
      if (!stored) return undefined;
      const bytes = storedBytes(stored.data);
      const issue = storedAssetIssue(projectId, stored, bytes);
      if (issue || !bytes || await sha256(bytes) !== stored.checksum) return undefined;
      return { id: stored.id, name: stored.name, mimeType: stored.mimeType, data: bytes.slice(), checksum: stored.checksum };
    });
  }

  /**
   * Lists metadata without requiring the project to be fully readable. A
   * corrupt current snapshot or a malformed optional field leaves the project
   * listed; use inspectProjectHealth for diagnostics.
   */
  async listProjects(): Promise<ProjectMetadata[]> {
    return wrapStorage('Unable to list local projects.', async () => {
      const rows = await this.db.projects.toArray();
      const visible = rows.flatMap((row) => {
        const parsed = readStoredMetadata(row.id, row);
        return parsed === undefined ? [] : [parsed.metadata];
      });
      return visible.sort((left, right) => right.updatedAt - left.updatedAt || right.revision - left.revision || left.id.localeCompare(right.id));
    });
  }

  async listProjectMetadata(): Promise<ProjectMetadata[]> {
    return this.listProjects();
  }

  async inspectProjectHealth(projectId: string): Promise<ProjectHealth | undefined> {
    if (!isProjectId(projectId)) invalidMetadata('Project ID is invalid.');
    return wrapStorage('Unable to inspect the local project.', async () => {
      const [row, current, recovery, storedAssets] = await this.db.transaction('r', this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.assets, async () => Promise.all([
        this.db.projects.get(projectId),
        this.db.currentSnapshots.get(projectId),
        this.db.recoverySnapshots.get(projectId),
        this.db.assets.where('projectId').equals(projectId).toArray()
      ]));
      if (!row && !current && !recovery && storedAssets.length === 0) return undefined;
      const currentHealth = await inspectSnapshot(current, projectId);
      const recoveryHealth = await inspectSnapshot(recovery, projectId);
      if (currentHealth.status === 'corrupt') this.clearVerifiedCurrentCache(projectId);
      const parsed = readStoredMetadata(projectId, row);
      return makeProjectHealth(projectId, parsed?.metadata, currentHealth, recoveryHealth, inspectStoredAssets(projectId, storedAssets), parsed?.warnings);
    });
  }

  /**
   * Explicitly opens the durable recovery revision. This never falls back
   * from load() implicitly, which keeps callers aware that the current head
   * was not used.
   */
  async loadRecoveryRevision(projectId: string, revision?: number): Promise<ProjectRecord | undefined> {
    if (!isProjectId(projectId)) invalidMetadata('Project ID is invalid.');
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) invalidMetadata('Recovery revision is invalid.');
    try {
      return await wrapStorage('Unable to load the project recovery revision.', async () => {
        const { row, current, recovery, storedAssets, head } = await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.assets], async () => {
          const [row, current, recovery, storedAssets, storedHead] = await Promise.all([
            this.db.projects.get(projectId),
            this.db.currentSnapshots.get(projectId),
            this.db.recoverySnapshots.get(projectId),
            this.db.assets.where('projectId').equals(projectId).toArray(),
            this.db.projectHeads.get(projectId)
          ]);
          return { row, current, recovery, storedAssets, head: await this.reconcileHead(projectId, current, storedHead) };
        });
        if (!row && !current && !recovery && storedAssets.length === 0) return undefined;
        const parsed = readStoredMetadata(projectId, row);
        if (!parsed || !recovery) throw new PersistenceError('storage-failure', 'Project recovery data is incomplete.');
        const { metadata, legacyAidaCount, warnings } = parsed;
        const recoveryHealth = await inspectSnapshot(recovery, projectId);
        if (recoveryHealth.status !== 'valid') throw new PersistenceError('storage-failure', 'Project recovery snapshot is corrupt.');
        if (revision !== undefined && recovery.revision !== revision) throw new PersistenceError('storage-failure', `Recovery revision ${String(revision)} is not available.`);
        const document = await loadSnapshotDocument(recovery, legacyAidaCount);
        const loadedAssets = await loadAssets(projectId, storedAssets);
        const sourceImage = inspectSourceImage(metadata.sourceImage, loadedAssets.assets);
        const summary = deriveProjectSummary(document);
        const canonicalMetadata = withProjectSummary({ ...metadata, revision: document.revision }, summary);
        const currentHealth = await inspectSnapshot(current, projectId);
        if (currentHealth.status === 'corrupt') this.clearVerifiedCurrentCache(projectId);
        const health = makeProjectHealth(projectId, canonicalMetadata, currentHealth, recoveryHealth, loadedAssets.health, warnings, sourceImage);
        return {
          metadata: sanitizeProjectMetadata(canonicalMetadata),
          document,
          head,
          recovery: null,
          assets: loadedAssets.assets,
          health
        };
      });
    } catch (error) {
      this.clearVerifiedCurrentCache(projectId);
      throw error;
    }
  }

  /** Deletes the project and every row keyed to it, in one transaction. */
  async deleteProject(projectId: string): Promise<void> {
    this.clearVerifiedCurrentCache(projectId);
    await this.db.transaction('rw', [this.db.projects, this.db.currentSnapshots, this.db.recoverySnapshots, this.db.projectHeads, this.db.documentHistories, this.db.assets, this.db.dailyActivity, this.db.projectFolders], async () => {
      await this.db.projects.delete(projectId);
      await this.db.currentSnapshots.delete(projectId);
      await this.db.recoverySnapshots.delete(projectId);
      await this.db.projectHeads.delete(projectId);
      await this.db.documentHistories.delete(projectId);
      await this.db.assets.where('projectId').equals(projectId).delete();
      await this.db.dailyActivity.where('projectId').equals(projectId).delete();
      await this.db.projectFolders.delete(projectId);
    });
  }

  async listFolderIndex(): Promise<ProjectFolderIndex> {
    return wrapStorage('Unable to list local folders.', async () => {
      return await this.db.transaction('r', [this.db.folders, this.db.projectFolders, this.db.projects], async () => {
        const [folderRows, assignmentRows, projectRows] = await Promise.all([
          this.db.folders.toArray(),
          this.db.projectFolders.toArray(),
          this.db.projects.toArray()
        ]);
        const folders = folderRows
          .slice()
          .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id));
        const folderIds = new Set(folders.map((folder) => folder.id));
        const projectIds = new Set(projectRows.map((project) => project.id));
        const assignments = assignmentRows.filter((assignment) => folderIds.has(assignment.folderId) && projectIds.has(assignment.projectId));
        return { folders, assignments };
      });
    });
  }

  async createFolder(input: CreateFolderInput): Promise<ProjectFolder> {
    const name = validateFolderName(input.name);
    const parentId = input.parentId ?? null;
    if (parentId !== null && (typeof parentId !== 'string' || parentId.length < 1 || parentId.length > 256 || !isBoundedMetadataString(parentId))) invalidMetadata('Folder parent ID is malformed.');
    if (typeof input.id !== 'string' || input.id.length < 1 || input.id.length > 256 || !isBoundedMetadataString(input.id)) invalidMetadata('Folder ID is malformed.');
    const { id } = input;
    return wrapStorage('Unable to create the local folder.', async () => {
      return await this.db.transaction('rw', [this.db.folders, this.db.projects, this.db.projectFolders], async () => {
        if (parentId !== null) {
          const parent = await this.db.folders.get(parentId);
          if (!parent || parent.parentId !== null) invalidMetadata('Folder parent must be an existing top-level folder.');
        }
        const now = this.now();
        const folder: ProjectFolder = { id, name, parentId, createdAt: now, updatedAt: now };
        await this.db.folders.put(folder);
        for (const projectId of input.projectIds ?? []) {
          if (!(await this.db.projects.get(projectId))) invalidMetadata('Project does not exist.');
          await this.db.projectFolders.put({ projectId, folderId: id, assignedAt: now });
        }
        return folder;
      });
    });
  }

  async renameFolder(folderId: string, name: string): Promise<ProjectFolder> {
    const trimmed = validateFolderName(name);
    return wrapStorage('Unable to rename the local folder.', async () => {
      return await this.db.transaction('rw', [this.db.folders], async () => {
        const existing = await this.db.folders.get(folderId);
        if (!existing) invalidMetadata('Folder does not exist.');
        const renamed: ProjectFolder = { ...existing, name: trimmed, updatedAt: this.now() };
        await this.db.folders.put(renamed);
        return renamed;
      });
    });
  }

  async deleteFolder(folderId: string): Promise<void> {
    return wrapStorage('Unable to delete the local folder.', async () => {
      await this.db.transaction('rw', [this.db.folders, this.db.projectFolders], async () => {
        const deleted = await this.db.folders.get(folderId);
        if (!deleted) return;
        const reparentedId = deleted.parentId;
        const children = await this.db.folders.where('parentId').equals(folderId).toArray();
        await Promise.all(children.map((child) => this.db.folders.update(child.id, { parentId: reparentedId, updatedAt: this.now() })));
        const assignments = await this.db.projectFolders.where('folderId').equals(folderId).toArray();
        if (reparentedId === null) {
          await Promise.all(assignments.map((assignment) => this.db.projectFolders.delete(assignment.projectId)));
        } else {
          await Promise.all(assignments.map((assignment) => this.db.projectFolders.put({ ...assignment, folderId: reparentedId })));
        }
        await this.db.folders.delete(folderId);
      });
    });
  }

  async moveProjectToFolder(projectId: string, folderId: string | null): Promise<void> {
    return wrapStorage('Unable to move the project to the folder.', async () => {
      await this.db.transaction('rw', [this.db.projects, this.db.folders, this.db.projectFolders], async () => {
        const project = await this.db.projects.get(projectId);
        if (!project) invalidMetadata('Project does not exist.');
        if (folderId === null) {
          await this.db.projectFolders.delete(projectId);
          return;
        }
        const folder = await this.db.folders.get(folderId);
        if (!folder) invalidMetadata('Folder does not exist.');
        const assignment: ProjectFolderAssignment = { projectId, folderId, assignedAt: this.now() };
        await this.db.projectFolders.put(assignment);
      });
    });
  }

  async moveFolder(folderId: string, parentId: string | null): Promise<void> {
    return wrapStorage('Unable to move the local folder.', async () => {
      await this.db.transaction('rw', [this.db.folders], async () => {
        const folder = await this.db.folders.get(folderId);
        if (!folder) invalidMetadata('Folder does not exist.');
        if (parentId === null) {
          await this.db.folders.update(folderId, { parentId: null, updatedAt: this.now() });
          return;
        }
        if (parentId === folderId) invalidMetadata('A folder cannot be moved into itself.');
        const parent = await this.db.folders.get(parentId);
        if (!parent || parent.parentId !== null) invalidMetadata('Folder parent must be an existing top-level folder.');
        const children = await this.db.folders.where('parentId').equals(folderId).toArray();
        if (children.length > 0) invalidMetadata('A folder with subfolders cannot be moved into another folder.');
        await this.db.folders.update(folderId, { parentId, updatedAt: this.now() });
      });
    });
  }

  async close(): Promise<void> {
    this.clearVerifiedCurrentCache();
    this.db.close();
  }
}
