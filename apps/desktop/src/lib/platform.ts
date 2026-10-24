/** Native platform comes from Rust, never from a phone-shaped desktop window. */
export type NativePlatform = "desktop" | "android" | "ios";

export function currentPlatform(): NativePlatform {
  return (window as Window & { __LENOTA_PLATFORM__?: NativePlatform }).__LENOTA_PLATFORM__ ?? "desktop";
}

export function isNativeMobile(): boolean {
  return currentPlatform() !== "desktop";
}

/** Follow the visible viewport when the keyboard opens, including iOS WebKit. */
export function installMobileViewport(): void {
  const mobile = isNativeMobile();
  document.documentElement.dataset.nativeMobile = String(mobile);
  if (!mobile && !window.matchMedia("(pointer: coarse)").matches) return;
  const update = () => {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    // Android resizes the whole WebView for IME insets, so visualViewport and
    // innerHeight can be equal even while the keyboard is open.
    const nativeKeyboard = (window as Window & { __LENOTA_KEYBOARD_OPEN__?: boolean }).__LENOTA_KEYBOARD_OPEN__;
    document.documentElement.style.setProperty("--ln-visible-height", `${height}px`);
    document.documentElement.dataset.keyboardOpen = String(nativeKeyboard ?? (window.innerHeight - height > 150));
  };
  window.visualViewport?.addEventListener("resize", update);
  window.addEventListener("resize", update);
  window.addEventListener("lenota:keyboard", update);
  update();
}
