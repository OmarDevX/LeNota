/**
 * Return the pages in their persisted sibling order while keeping subpages
 * directly after their parent. Invalid parent links are treated as roots and
 * cycles are appended once, so the focus strip is always deterministic.
 */
export function orderFocusPages<T extends { id: string; parentPageId: string | null }>(pages: readonly T[]): T[] {
  const knownIds = new Set(pages.map((page) => page.id));
  const byParent = new Map<string | null, T[]>();

  for (const page of pages) {
    const parentId = page.parentPageId && knownIds.has(page.parentPageId) ? page.parentPageId : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(page);
    byParent.set(parentId, siblings);
  }

  const ordered: T[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null) => {
    for (const page of byParent.get(parentId) ?? []) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      ordered.push(page);
      visit(page.id);
    }
  };

  visit(null);
  for (const page of pages) {
    if (!seen.has(page.id)) {
      seen.add(page.id);
      ordered.push(page);
      visit(page.id);
    }
  }

  return ordered;
}
