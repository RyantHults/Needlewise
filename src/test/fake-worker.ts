/** Stands in for a `Worker`: records posts and lets a test deliver messages or transport errors. */
export class FakeWorker {
  readonly posted: unknown[] = [];
  readonly terminated = { count: 0 };
  private readonly listeners = new Map<string, (event: unknown) => void>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.set(type, listener as unknown as (event: unknown) => void);
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emit(message: unknown): void {
    this.listeners.get('message')?.({ data: message });
  }

  emitTransport(type: 'error' | 'messageerror', event: unknown): void {
    this.listeners.get(type)?.(event);
  }

  terminate(): void {
    this.terminated.count += 1;
  }
}
