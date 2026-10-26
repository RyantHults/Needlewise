import {
  PATTERN_IMPORT_PROTOCOL,
  SNIFF_BYTES,
  isPatternImportRequest,
  readBlobBytes,
  serializeImportError,
  transferableAnalysis,
  type PatternImportRequest,
  type PatternImportResponse
} from '../import/import-protocol';
import { findImporter } from '../import/registry';
import { bootWorker, runAbortable, type WorkerScope } from './runtime';
import { ImportError, type ImportProgress, type ImportSession } from '../import/types';

type Post = (message: PatternImportResponse, transfer?: Transferable[]) => void;

/** The open session, plus the controllers of requests in flight. */
export interface PatternImportWorkerState {
  session: ImportSession | null;
  readonly active: Map<string, AbortController>;
}

export function createPatternImportWorkerState(): PatternImportWorkerState {
  return { session: null, active: new Map() };
}

async function run(request: Exclude<PatternImportRequest, { type: 'cancel' }>, post: Post, state: PatternImportWorkerState, signal: AbortSignal): Promise<void> {
  const { requestId } = request;
  const options = {
    signal,
    onProgress: (progress: ImportProgress) => {
      if (!signal.aborted) post({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'progress', requestId, progress });
    }
  };
  let session: ImportSession;
  if (request.type === 'open') {
    const bytes = await readBlobBytes(request.file);
    const importer = findImporter(bytes.subarray(0, SNIFF_BYTES));
    if (!importer) throw new ImportError('unsupported-format', 'This file type is not supported.');
    session = await importer.open(bytes, { ...options, fileName: request.fileName });
    if (signal.aborted) {
      await session.close();
      throw new ImportError('cancelled', 'The import was cancelled.');
    }
    state.session = session;
  } else {
    if (!state.session) throw new ImportError('unsupported-format', 'No file is open.');
    session = state.session;
  }
  const analysis = await session.analyze(request.type === 'reanalyze' ? request.overrides : undefined, options);
  if (signal.aborted) throw new ImportError('cancelled', 'The import was cancelled.');
  const prepared = transferableAnalysis(analysis);
  post({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'result', requestId, analysis: prepared.analysis }, prepared.transfer);
}

/** Handle one request without depending on a concrete WorkerGlobalScope. */
export function handlePatternImportWorkerMessage(
  value: unknown,
  post: Post,
  state: PatternImportWorkerState = createPatternImportWorkerState()
): void {
  if (!isPatternImportRequest(value)) return;
  const { requestId } = value;
  if (value.type === 'cancel') {
    state.active.get(requestId)?.abort();
    return;
  }
  if (state.active.has(requestId)) {
    post({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'error', requestId, error: { message: 'The import request is already running.' } });
    return;
  }
  runAbortable(state.active, requestId, (signal) => run(value, post, state, signal), {
    cancelled: () => { post({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'cancelled', requestId }); },
    failed: (error) => {
      if (error instanceof ImportError && error.code === 'cancelled') post({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'cancelled', requestId });
      else post({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'error', requestId, error: serializeImportError(error) });
    }
  });
}

function installPatternImportWorker(scope: WorkerScope<PatternImportResponse>): void {
  const state = createPatternImportWorkerState();
  scope.addEventListener('message', (event) => {
    handlePatternImportWorkerMessage(event.data, (message, transfer) => { scope.postMessage(message, transfer); }, state);
  });
}

bootWorker(installPatternImportWorker);
