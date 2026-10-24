export const INTERFACE_PREFERENCE_KEYS = [
  "lenota:appearance:focus-mode",
  "lenota:appearance:theme",
  "lenota:layout:page-list-width",
  "lenota:layout:page-list-collapsed",
  "lenota:layout:inspector-open",
  "lenota:layout:v026:page-list-width",
  "lenota:layout:v026:page-list-collapsed",
  "lenota:layout:v026:inspector-open",
  "lenota:layout:v027:page-list-width",
  "lenota:layout:v027:page-list-collapsed",
  "lenota:layout:v027:inspector-open",
  "lenota:layout:v028:page-list-width",
  "lenota:layout:v028:page-list-collapsed",
  "lenota:layout:v028:inspector-open",
  "lenota:layout:v029:page-list-width",
  "lenota:layout:v029:page-list-collapsed",
  "lenota:layout:v029:inspector-open",
  "lenota:toolbar-mode",
  "lenota:draw-toolbar-panel",
] as const;

type PreferenceReader = Pick<Storage, "removeItem">;

/**
 * Focus Mode is intentionally session-only. Older builds persisted it and a
 * broken focus layout could therefore trap the next launch in a blank window.
 */
export function discardPersistedFocusMode(storage: PreferenceReader): false {
  try { storage.removeItem("lenota:appearance:focus-mode"); } catch { /* storage is optional */ }
  return false;
}

/** Clears interface preferences only. Notes, attachments, drafts, and backups
 * are stored elsewhere and are deliberately left untouched. */
export function clearInterfacePreferences(storage: PreferenceReader): void {
  for (const key of INTERFACE_PREFERENCE_KEYS) {
    try { storage.removeItem(key); } catch { /* continue clearing other keys */ }
  }
}

export function resetInterfaceAndReload(): void {
  clearInterfacePreferences(window.localStorage);
  window.location.reload();
}
