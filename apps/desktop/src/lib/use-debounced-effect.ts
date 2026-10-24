import { useEffect } from "react";

export function useDebouncedEffect(
  callback: () => void | Promise<void>,
  delay: number,
  dependencies: readonly unknown[],
): void {
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void callback();
    }, delay);
    return () => window.clearTimeout(timeout);
    // The dependency list is intentionally supplied by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
}
