export interface WatchdogTimerPort {
  set(callback: () => void, timeoutMs: number): unknown;
  clear(handle: unknown): void;
}

const nativeTimer: WatchdogTimerPort = {
  set: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const runWithWatchdog = async (
  operation: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>,
  timer: WatchdogTimerPort = nativeTimer,
): Promise<'completed' | 'timedOut'> => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Watchdog timeout must be a positive integer');
  }
  let handle: unknown;
  const timeout = new Promise<'timedOut'>((resolve) => {
    handle = timer.set(() => {
      void Promise.resolve(onTimeout())
        .catch(() => undefined)
        .then(() => resolve('timedOut'));
    }, timeoutMs);
  });
  const completed = operation.then(
    () => 'completed' as const,
    () => 'completed' as const,
  );
  const result = await Promise.race([completed, timeout]);
  if (result === 'completed' && handle !== undefined) timer.clear(handle);
  return result;
};
