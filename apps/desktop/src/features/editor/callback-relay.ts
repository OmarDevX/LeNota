/** Stable event identities for memoized children, with the latest parent
 * state and handlers. No captured selection or document can go stale. */
export function createCallbackRelay<T extends { [K in keyof T]: (...args: any[]) => any }>(initial: T) {
  let latest = initial;
  const callbacks = Object.fromEntries(Object.keys(initial).map(key => [
    key, (...args: unknown[]) => latest[key as keyof T](...args),
  ])) as T;
  return { callbacks, update: (next: T) => { latest = next; } };
}
