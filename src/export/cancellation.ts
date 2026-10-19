export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportCancelledError();
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}
