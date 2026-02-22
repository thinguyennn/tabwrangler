export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
  options?: { maxWait?: number },
): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;

  return ((...args: unknown[]) => {
    if (timer != null) clearTimeout(timer);

    if (options?.maxWait && maxWaitTimer == null) {
      maxWaitTimer = setTimeout(() => {
        if (timer != null) clearTimeout(timer);
        maxWaitTimer = undefined;
        fn(...args);
      }, options.maxWait);
    }

    timer = setTimeout(() => {
      if (maxWaitTimer != null) {
        clearTimeout(maxWaitTimer);
        maxWaitTimer = undefined;
      }
      fn(...args);
    }, ms);
  }) as T;
}
