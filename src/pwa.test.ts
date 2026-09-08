import { describe, expect, it, vi } from 'vitest';
import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import { createPwaUpdateAdapter } from './pwa';

describe('PWA update adapter', () => {
  it('does not register in test mode and is safe without service workers', async () => {
    const registerSW = vi.fn();
    const adapter = createPwaUpdateAdapter({ mode: 'test', registerSW });

    await expect(adapter.register()).resolves.toMatchObject({
      supported: false,
      registered: false,
      updateAvailable: false
    });
    expect(registerSW).not.toHaveBeenCalled();
    await expect(adapter.activateUpdate()).resolves.toBe(false);
  });

  it('reports an unavailable browser without importing the virtual registration module', async () => {
    const adapter = createPwaUpdateAdapter({ mode: 'production' });

    await expect(adapter.register()).resolves.toMatchObject({
      supported: false,
      registered: false,
      error: null
    });
    await expect(adapter.applyUpdate()).resolves.toBe(false);
  });

  it('waits for explicit activation after an update-needed callback', async () => {
    let registerOptions: RegisterSWOptions | undefined;
    const activate = vi.fn(async () => undefined);
    const onUpdateAvailable = vi.fn();
    const adapter = createPwaUpdateAdapter({
      mode: 'production',
      registerSW: vi.fn((options) => {
        registerOptions = options;
        return activate;
      }),
      onUpdateAvailable
    });

    await adapter.register();
    expect(adapter.state).toMatchObject({ supported: true, registered: true, updateAvailable: false });
    expect(activate).not.toHaveBeenCalled();

    registerOptions?.onNeedRefresh?.();
    expect(adapter.updateAvailable).toBe(true);
    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();

    await expect(adapter.activateUpdate()).resolves.toBe(true);
    expect(activate).toHaveBeenCalledWith(true);
    expect(adapter.updateAvailable).toBe(false);
  });

  it('notifies subscribers without forcing an update', async () => {
    let onNeedRefresh: (() => void) | undefined;
    const activate = vi.fn(async () => undefined);
    const adapter = createPwaUpdateAdapter({
      mode: 'production',
      registerSW: vi.fn((options) => {
        onNeedRefresh = options.onNeedRefresh;
        return activate;
      })
    });
    const listener = vi.fn();
    adapter.subscribe(listener);

    await adapter.register();
    onNeedRefresh?.();
    expect(listener).toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
