import type { RegisterSWOptions } from 'vite-plugin-pwa/types';

export type PwaUpdateCallback = (state: PwaUpdateState) => void;
export type RegisterServiceWorker = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

export interface PwaUpdateState {
  supported: boolean;
  registered: boolean;
  updateAvailable: boolean;
  offlineReady: boolean;
  error: Error | null;
}

export interface PwaUpdateAdapterOptions {
  /** Defaults to Vite's current mode. Tests can explicitly exercise the browser path with another mode. */
  mode?: string;
  /** Dependency-injection seam for tests; production uses virtual:pwa-register. */
  registerSW?: RegisterServiceWorker;
  onUpdateAvailable?: PwaUpdateCallback;
  onOfflineReady?: (state: PwaUpdateState) => void;
}

export interface PwaUpdateAdapter {
  readonly state: PwaUpdateState;
  readonly updateAvailable: boolean;
  register(): Promise<PwaUpdateState>;
  /** Explicitly activates the waiting worker and requests a page reload. */
  activateUpdate(): Promise<boolean>;
  /** Alias for callers that describe the action as applying an update. */
  applyUpdate(): Promise<boolean>;
  subscribe(listener: () => void): () => void;
}

const INITIAL_STATE: PwaUpdateState = {
  supported: false,
  registered: false,
  updateAvailable: false,
  offlineReady: false,
  error: null
};

function cloneState(state: PwaUpdateState): PwaUpdateState {
  return { ...state };
}

function browserSupportsServiceWorkers(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unable to register the application service worker.');
}

async function loadRegisterServiceWorker(): Promise<RegisterServiceWorker> {
  const module = await import('virtual:pwa-register');
  return module.registerSW;
}

class PwaUpdateAdapterImpl implements PwaUpdateAdapter {
  private currentState: PwaUpdateState = cloneState(INITIAL_STATE);
  private updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
  private registration: Promise<PwaUpdateState> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly options: PwaUpdateAdapterOptions;

  constructor(options: PwaUpdateAdapterOptions) {
    this.options = options;
  }

  get state(): PwaUpdateState {
    return cloneState(this.currentState);
  }

  get updateAvailable(): boolean {
    return this.currentState.updateAvailable;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  private setState(changes: Partial<PwaUpdateState>): void {
    this.currentState = { ...this.currentState, ...changes };
    for (const listener of [...this.listeners]) listener();
  }

  private reportUpdateAvailable(): void {
    this.setState({ updateAvailable: true });
    this.options.onUpdateAvailable?.(this.state);
  }

  private reportOfflineReady(): void {
    this.setState({ offlineReady: true });
    this.options.onOfflineReady?.(this.state);
  }

  async register(): Promise<PwaUpdateState> {
    if (this.registration) return this.registration;

    const mode = this.options.mode ?? import.meta.env.MODE;
    if (mode === 'test') {
      this.setState({ supported: false, registered: false });
      return this.state;
    }

    // An injected register function is a deliberate test seam. Real browser
    // registration still requires the platform service-worker API.
    if (!browserSupportsServiceWorkers() && !this.options.registerSW) {
      this.setState({ supported: false, registered: false });
      return this.state;
    }

    this.registration = (async () => {
      try {
        const registerSW = this.options.registerSW ?? await loadRegisterServiceWorker();
        this.updateSW = registerSW({
          immediate: false,
          onNeedRefresh: () => this.reportUpdateAvailable(),
          onOfflineReady: () => this.reportOfflineReady(),
          onRegisterError: (error: unknown) => this.setState({ error: normalizeError(error) })
        });
        this.setState({ supported: true, registered: true, error: null });
      } catch (error) {
        this.updateSW = null;
        this.setState({ supported: browserSupportsServiceWorkers(), registered: false, error: normalizeError(error) });
      }
      return this.state;
    })();
    return this.registration;
  }

  async activateUpdate(): Promise<boolean> {
    if (!this.currentState.updateAvailable || !this.updateSW) return false;
    try {
      // This is intentionally only called from the explicit UI action. The
      // adapter never activates, updates, or reloads in response to a notice.
      await this.updateSW(true);
      this.setState({ updateAvailable: false, error: null });
      return true;
    } catch (error) {
      this.setState({ error: normalizeError(error) });
      throw this.currentState.error;
    }
  }

  async applyUpdate(): Promise<boolean> {
    return this.activateUpdate();
  }
}

export function createPwaUpdateAdapter(options: PwaUpdateAdapterOptions = {}): PwaUpdateAdapter {
  return new PwaUpdateAdapterImpl(options);
}

/** Manual entry point for application startup; it never applies an update. */
export async function registerPwa(options: PwaUpdateAdapterOptions = {}): Promise<PwaUpdateAdapter> {
  const adapter = createPwaUpdateAdapter(options);
  await adapter.register();
  return adapter;
}

export function isServiceWorkerAvailable(): boolean {
  return browserSupportsServiceWorkers();
}
