/** Parse a directly entered size without imposing an arbitrary upper preset. */
export function parseCustomSize(value: unknown, minimum = 0.1): number | null {
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : null;
}

export function customSizeOr(value: unknown, fallback: number, minimum = 0.1): number {
  return parseCustomSize(value, minimum) ?? fallback;
}
