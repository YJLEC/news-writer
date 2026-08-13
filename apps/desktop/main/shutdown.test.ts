import { describe, expect, it, vi } from 'vitest';

import { runWithWatchdog, type WatchdogTimerPort } from './shutdown.js';

class ManualTimer implements WatchdogTimerPort {
  callback: (() => void) | undefined;
  cleared = false;

  set(callback: () => void): unknown {
    this.callback = callback;
    return 1;
  }

  clear(): void {
    this.cleared = true;
  }

  fire(): void {
    this.callback?.();
  }
}

describe('runWithWatchdog', () => {
  it('clears the watchdog after an orderly shutdown', async () => {
    const timer = new ManualTimer();
    const onTimeout = vi.fn();
    await expect(runWithWatchdog(Promise.resolve(), 10_000, onTimeout, timer)).resolves.toBe(
      'completed',
    );
    expect(timer.cleared).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('returns finitely and invokes the timeout action for a nonresponsive shutdown', async () => {
    const timer = new ManualTimer();
    const onTimeout = vi.fn();
    const result = runWithWatchdog(new Promise(() => undefined), 10_000, onTimeout, timer);
    timer.fire();
    await expect(result).resolves.toBe('timedOut');
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(timer.cleared).toBe(false);
  });
});
