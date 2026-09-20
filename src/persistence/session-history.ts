import { createEditorFromHistory, type DocumentEditorHistoryDto, type PatternDocument } from '../domain';
import { sha256 } from './hash';
import { isValidAssetId, MAX_ASSET_BYTES } from './limits';
import { validateSourceImageDescriptor } from './source-image';
import type {
  ProjectAsset,
  ProjectMetadata,
  SessionHistoryEnvelope,
  SourceImageDescriptor,
  StoredProjectAsset,
  TraceHistoryAsset,
  TraceHistoryAssetState,
  TraceHistoryEntry
} from './types';
import {
  MAX_SESSION_HISTORY_BYTES,
  MAX_SESSION_HISTORY_DECODE_BYTES,
  MAX_SESSION_HISTORY_ENTRIES,
  MAX_SESSION_HISTORY_LABEL_CHARS,
  SESSION_HISTORY_ENVELOPE_VERSION
} from './types';

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const MAX_HISTORY_OBJECTS = MAX_SESSION_HISTORY_ENTRIES * 32;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTypedArray(value: unknown): value is Uint8Array | Uint16Array | Uint32Array {
  if (!ArrayBuffer.isView(value)) return false;
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Uint8Array]' || tag === '[object Uint16Array]' || tag === '[object Uint32Array]';
}

function typedByteLength(value: unknown): number {
  return isTypedArray(value) ? value.byteLength : value instanceof ArrayBuffer ? value.byteLength : 0;
}

function boundedAdd(total: number, amount: number, ceiling: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || total > ceiling - amount) throw new Error('session history exceeds its decode budget.');
  return total + amount;
}

function rawPayloadBytes(value: unknown, seen: WeakSet<object> = new WeakSet(), objects = { count: 0 }): number {
  if (typeof value === 'string') return boundedAdd(16, value.length * 2, MAX_SESSION_HISTORY_DECODE_BYTES);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return 16;
  if (isTypedArray(value) || value instanceof ArrayBuffer) {
    if (seen.has(value)) throw new Error('session history contains a repeated reference.');
    seen.add(value);
    const total = boundedAdd(24, typedByteLength(value), MAX_SESSION_HISTORY_DECODE_BYTES);
    seen.delete(value);
    return total;
  }
  if (typeof value !== 'object') throw new Error('session history contains an unsupported value.');
  if (seen.has(value)) throw new Error('session history contains a cycle.');
  seen.add(value);
  objects.count += 1;
  if (objects.count > MAX_HISTORY_OBJECTS) throw new Error('session history contains too many objects.');
  if (Array.isArray(value)) {
    let total = boundedAdd(24, value.length * 8, MAX_SESSION_HISTORY_DECODE_BYTES);
    for (const child of value) total = boundedAdd(total, rawPayloadBytes(child, seen, objects), MAX_SESSION_HISTORY_DECODE_BYTES);
    seen.delete(value);
    return total;
  }
  let total = boundedAdd(64, Object.keys(value).length * 8, MAX_SESSION_HISTORY_DECODE_BYTES);
  for (const [key, child] of Object.entries(value)) {
    total = boundedAdd(total, key.length * 2, MAX_SESSION_HISTORY_DECODE_BYTES);
    total = boundedAdd(total, rawPayloadBytes(child, seen, objects), MAX_SESSION_HISTORY_DECODE_BYTES);
  }
  seen.delete(value);
  return total;
}

function exactKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`session history is missing ${key}.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`session history contains unsupported field ${key}.`);
}

function safeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid.`);
}

function stringValue(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`${label} is invalid.`);
}

function validateDocumentDtoShape(value: unknown): asserts value is DocumentEditorHistoryDto {
  if (!isRecord(value)) throw new Error('document history is not an object.');
  exactKeys(value, ['version', 'undo', 'redo']);
  if (value.version !== 1 || !Array.isArray(value.undo) || !Array.isArray(value.redo)) throw new Error('document history shape is invalid.');
  if (value.undo.length + value.redo.length > MAX_SESSION_HISTORY_ENTRIES) throw new Error('document history contains too many entries.');
}

function validateSourceShape(value: unknown): void {
  if (value !== null && !isRecord(value)) throw new Error('trace source descriptor is invalid.');
}

function validateTraceAssetShape(value: unknown): void {
  if (value === null) return;
  if (!isRecord(value)) throw new Error('trace asset is invalid.');
  exactKeys(value, ['id', 'name', 'mimeType', 'data', 'checksum']);
  stringValue(value.id, 'trace asset ID', 256);
  if (!isValidAssetId(value.id)) throw new Error('trace asset ID is invalid.');
  stringValue(value.name, 'trace asset name', 512);
  stringValue(value.mimeType, 'trace asset MIME type', 256);
  if (!isTypedArray(value.data) || Object.prototype.toString.call(value.data) !== '[object Uint8Array]') throw new Error('trace asset bytes are invalid.');
  if (value.data.byteLength > MAX_ASSET_BYTES) throw new Error('trace asset exceeds its size limit.');
  stringValue(value.checksum, 'trace asset checksum', 64);
  if (!HEX_SHA256.test(value.checksum)) throw new Error('trace asset checksum is invalid.');
}

function validateTraceAssetState(value: unknown): asserts value is TraceHistoryAssetState {
  if (!isRecord(value)) throw new Error('trace asset state is invalid.');
  if (value.kind === 'unchanged' || value.kind === 'absent') {
    exactKeys(value, ['kind']);
    return;
  }
  if (value.kind === 'captured') {
    exactKeys(value, ['kind', 'asset']);
    validateTraceAssetShape(value.asset);
    return;
  }
  throw new Error('trace asset state discriminator is invalid.');
}

function validateTraceEntryShape(value: unknown): asserts value is TraceHistoryEntry {
  if (!isRecord(value)) throw new Error('trace history entry is invalid.');
  exactKeys(value, ['label', 'sourceBefore', 'sourceAfter', 'assetBefore', 'assetAfter']);
  stringValue(value.label, 'trace history label', MAX_SESSION_HISTORY_LABEL_CHARS);
  validateSourceShape(value.sourceBefore);
  validateSourceShape(value.sourceAfter);
  validateTraceAssetState(value.assetBefore);
  validateTraceAssetState(value.assetAfter);
  if ((value.assetBefore as UnknownRecord).kind === 'unchanged' !== ((value.assetAfter as UnknownRecord).kind === 'unchanged')) throw new Error('trace asset unchanged state must apply to both sides.');
}

function validateMarkers(value: unknown, documentLength: number, traceLength: number): void {
  if (!Array.isArray(value)) throw new Error('history markers are invalid.');
  if (value.length > documentLength + traceLength) throw new Error('history markers contain too many entries.');
  if (value.length === 0 && documentLength + traceLength > 0) throw new Error('history markers are missing entries.');
  if (value.length !== documentLength + traceLength) throw new Error('history markers do not cover the unified history stack.');
  const seen = new Set<string>();
  let nextDocument = 0;
  let nextTrace = 0;
  for (const marker of value) {
    if (!isRecord(marker)) throw new Error('history marker is invalid.');
    exactKeys(marker, ['kind', 'index']);
    if (marker.kind !== 'document' && marker.kind !== 'trace') throw new Error('history marker kind is invalid.');
    safeInteger(marker.index, 'history marker index');
    const markerKey = `${marker.kind}:${String(marker.index)}`;
    if (seen.has(markerKey)) throw new Error('history markers contain a duplicate entry.');
    seen.add(markerKey);
    if (marker.kind === 'document') {
      if (marker.index !== nextDocument) throw new Error('document history markers are not chronological.');
      nextDocument += 1;
    } else {
      if (marker.index !== nextTrace) throw new Error('trace history markers are not chronological.');
      nextTrace += 1;
    }
    if (marker.kind === 'document' && marker.index >= documentLength) throw new Error('document history marker is out of bounds.');
    if (marker.kind === 'trace' && marker.index >= traceLength) throw new Error('trace history marker is out of bounds.');
  }
}

function preflightEnvelope(value: unknown): asserts value is SessionHistoryEnvelope {
  if (!isRecord(value)) throw new Error('session history envelope is not an object.');
  exactKeys(value, ['version', 'document', 'trace', 'undoOrder', 'redoOrder']);
  if (value.version !== SESSION_HISTORY_ENVELOPE_VERSION) throw new Error('session history envelope version is unsupported.');
  validateDocumentDtoShape(value.document);
  if (!isRecord(value.trace)) throw new Error('trace history is invalid.');
  exactKeys(value.trace, ['undo', 'redo']);
  if (!Array.isArray(value.trace.undo) || !Array.isArray(value.trace.redo)) throw new Error('trace history stacks are invalid.');
  if (value.trace.undo.length + value.trace.redo.length + value.document.undo.length + value.document.redo.length > MAX_SESSION_HISTORY_ENTRIES) throw new Error('session history contains too many entries.');
  for (const entry of [...value.trace.undo, ...value.trace.redo]) validateTraceEntryShape(entry);
  validateMarkers(value.undoOrder, value.document.undo.length, value.trace.undo.length);
  validateMarkers(value.redoOrder, value.document.redo.length, value.trace.redo.length);
}

function cloneTypedArray(value: Uint8Array | Uint16Array | Uint32Array): Uint8Array | Uint16Array | Uint32Array {
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Uint8Array]') return Uint8Array.from(value);
  if (tag === '[object Uint16Array]') return Uint16Array.from(value);
  return Uint32Array.from(value);
}

function cloneValue(value: unknown): unknown {
  if (isTypedArray(value)) return cloneTypedArray(value);
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  return value;
}

function documentOnlyEnvelope(value: DocumentEditorHistoryDto): SessionHistoryEnvelope {
  return {
    version: SESSION_HISTORY_ENVELOPE_VERSION,
    document: value,
    trace: { undo: [], redo: [] },
    undoOrder: value.undo.map((_, index) => ({ kind: 'document', index })),
    redoOrder: value.redo.map((_, index) => ({ kind: 'document', index }))
  };
}

function isEnvelopeInput(value: unknown): value is SessionHistoryEnvelope {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'document');
}

function estimateValueBytes(value: unknown, seen: WeakSet<object> = new WeakSet()): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return 16;
  if (isTypedArray(value) || value instanceof ArrayBuffer) return 24 + typedByteLength(value);
  if (typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    const total = 24 + value.reduce((sum, child) => sum + estimateValueBytes(child, seen), 0);
    seen.delete(value);
    return total;
  }
  const total = 64 + Object.entries(value).reduce((sum, [key, child]) => sum + key.length * 2 + estimateValueBytes(child, seen), 0);
  seen.delete(value);
  return total;
}

interface TraceState {
  source: SourceImageDescriptor | null;
  asset: TraceHistoryAsset | null;
}

function traceAssetSnapshot(asset: ProjectAsset | StoredProjectAsset | TraceHistoryAsset): TraceHistoryAsset {
  return { id: asset.id, name: asset.name, mimeType: asset.mimeType, data: asset.data instanceof Uint8Array ? asset.data : Uint8Array.from(asset.data as unknown as ArrayLike<number>), checksum: asset.checksum };
}

function traceStateEqual(left: TraceState, right: TraceState): boolean {
  if (JSON.stringify(left.source) !== JSON.stringify(right.source)) return false;
  if (left.asset === null || right.asset === null) return left.asset === right.asset;
  if (left.asset.id !== right.asset.id || left.asset.name !== right.asset.name || left.asset.mimeType !== right.asset.mimeType || left.asset.checksum !== right.asset.checksum || left.asset.data.byteLength !== right.asset.data.byteLength) return false;
  return left.asset.data.every((byte, index) => byte === right.asset!.data[index]);
}

function resolvedTraceAsset(state: TraceHistoryAssetState, fallback: TraceHistoryAsset | null): TraceHistoryAsset | null {
  if (state.kind === 'unchanged') return fallback;
  if (state.kind === 'absent') return null;
  return traceAssetSnapshot(state.asset);
}

function resolvedTraceState(entry: TraceHistoryEntry, side: 'before' | 'after', fallback: TraceHistoryAsset | null): TraceState {
  const source = side === 'before' ? entry.sourceBefore : entry.sourceAfter;
  const assetState = side === 'before' ? entry.assetBefore : entry.assetAfter;
  const asset = resolvedTraceAsset(assetState, fallback);
  const resolved = { source: source === null ? null : validateSourceImageDescriptor(source), asset };
  if ((resolved.source === null) !== (resolved.asset === null) || (resolved.source !== null && resolved.source.assetId !== resolved.asset!.id)) {
    throw new Error('trace source and resolved asset IDs do not match.');
  }
  return resolved;
}

/** Validates trace adjacency and requires the active endpoint to be current. */
export function sessionHistoryMatchesTrace(
  envelope: SessionHistoryEnvelope,
  metadata: ProjectMetadata,
  assets: readonly (ProjectAsset | StoredProjectAsset)[]
): boolean {
  try {
    const undo = envelope.trace.undo;
    const redo = envelope.trace.redo;
    if (undo.length === 0 && redo.length === 0) return true;
    const source = metadata.sourceImage === undefined ? null : validateSourceImageDescriptor(metadata.sourceImage);
    const currentAsset = source === null ? undefined : assets.find((asset) => asset.id === source.assetId);
    if (source !== null && currentAsset === undefined) return false;
    const currentState: TraceState = { source, asset: currentAsset === undefined ? null : traceAssetSnapshot(currentAsset) };
    if ((currentState.source === null) !== (currentState.asset === null) || (currentState.source !== null && currentState.source.assetId !== currentState.asset!.id)) return false;
    const validateStack = (entries: readonly TraceHistoryEntry[], redoOrder: boolean): boolean => {
      let state = currentState;
      const start = redoOrder ? entries.length - 1 : entries.length - 1;
      for (let index = start; index >= 0; index -= 1) {
        const entry = entries[index];
        const before = resolvedTraceState(entry, 'before', state.asset);
        const after = resolvedTraceState(entry, 'after', state.asset);
        if (redoOrder) {
          if (!traceStateEqual(before, state)) return false;
          state = after;
        } else {
          if (!traceStateEqual(after, state)) return false;
          state = before;
        }
      }
      return true;
    };
    return validateStack(undo, false) && validateStack(redo, true);
  } catch {
    return false;
  }
}

async function validateTraceAssetChecksums(value: unknown): Promise<void> {
  if (!isRecord(value) || value.kind !== 'captured' || !isRecord(value.asset) || !isTypedArray(value.asset.data)) return;
  const bytes = value.asset.data instanceof Uint8Array ? value.asset.data : Uint8Array.from(value.asset.data as unknown as ArrayLike<number>);
  if (await sha256(bytes) !== value.asset.checksum) throw new Error('trace asset checksum does not match its bytes.');
}

async function validateTraceEntries(entries: readonly unknown[]): Promise<void> {
  for (const entry of entries) {
    if (!isRecord(entry)) throw new Error('trace history entry is invalid.');
    validateTraceEntryShape(entry);
    const traceEntry = entry as TraceHistoryEntry;
    await validateTraceAssetChecksums(entry.assetBefore);
    await validateTraceAssetChecksums(entry.assetAfter);
    if (traceEntry.sourceBefore !== null) validateSourceImageDescriptor(traceEntry.sourceBefore);
    if (traceEntry.sourceAfter !== null) validateSourceImageDescriptor(traceEntry.sourceAfter);
    if (traceEntry.sourceBefore === null && traceEntry.assetBefore.kind !== 'absent') throw new Error('trace before source and asset states do not match.');
    if (traceEntry.sourceAfter === null && traceEntry.assetAfter.kind !== 'absent') throw new Error('trace after source and asset states do not match.');
    if (traceEntry.sourceBefore !== null && traceEntry.assetBefore.kind === 'absent') throw new Error('trace before source and asset states do not match.');
    if (traceEntry.sourceAfter !== null && traceEntry.assetAfter.kind === 'absent') throw new Error('trace after source and asset states do not match.');
    if (traceEntry.sourceBefore !== null && traceEntry.assetBefore.kind === 'captured' && traceEntry.sourceBefore.assetId !== traceEntry.assetBefore.asset.id) throw new Error('trace before source and asset IDs do not match.');
    if (traceEntry.sourceAfter !== null && traceEntry.assetAfter.kind === 'captured' && traceEntry.sourceAfter.assetId !== traceEntry.assetAfter.asset.id) throw new Error('trace after source and asset IDs do not match.');
  }
}

/**
 * Validates the untrusted shape and budget before making any local deep copy,
 * then returns a detached structured-clone-safe envelope. A supplied document
 * is additionally used to validate the domain history chain.
 */
export async function prepareSessionHistory(
  document: PatternDocument | undefined,
  input: unknown,
  traceCurrent?: { metadata: ProjectMetadata; assets: readonly (ProjectAsset | StoredProjectAsset)[] }
): Promise<SessionHistoryEnvelope | undefined> {
  try {
    rawPayloadBytes(input);
    const raw = isEnvelopeInput(input) ? input : documentOnlyEnvelope(input as DocumentEditorHistoryDto);
    preflightEnvelope(raw);
    if (estimateValueBytes(raw) > MAX_SESSION_HISTORY_BYTES) return undefined;
    await validateTraceEntries([...raw.trace.undo, ...raw.trace.redo]);
    const envelope = cloneValue(raw) as SessionHistoryEnvelope;
    if (document !== undefined) {
      const editor = createEditorFromHistory(document, envelope.document);
      if (editor.historyBytes > MAX_SESSION_HISTORY_BYTES) return undefined;
    }
    if (traceCurrent !== undefined && !sessionHistoryMatchesTrace(envelope, traceCurrent.metadata, traceCurrent.assets)) return undefined;
    return envelope;
  } catch {
    return undefined;
  }
}

export function traceStateCanonical(metadata: ProjectMetadata, assets: readonly (ProjectAsset | StoredProjectAsset)[]): string {
  const sourceImage = metadata.sourceImage === undefined ? null : validateSourceImageDescriptor(metadata.sourceImage);
  const assetState = assets
    .map((asset) => ({ id: asset.id, name: asset.name, mimeType: asset.mimeType, byteLength: asset.data.byteLength, checksum: asset.checksum }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.checksum.localeCompare(right.checksum));
  const canonical = JSON.stringify({ sourceImage, assets: assetState });
  return canonical;
}

export async function traceStateFingerprint(metadata: ProjectMetadata, assets: readonly (ProjectAsset | StoredProjectAsset)[]): Promise<string> {
  return sha256(new TextEncoder().encode(traceStateCanonical(metadata, assets)));
}

export function cloneSessionHistory(value: SessionHistoryEnvelope): SessionHistoryEnvelope {
  return cloneValue(value) as SessionHistoryEnvelope;
}

export function isSessionHistoryEnvelope(value: unknown): value is SessionHistoryEnvelope {
  try {
    rawPayloadBytes(value);
    preflightEnvelope(value);
    return true;
  } catch {
    return false;
  }
}
