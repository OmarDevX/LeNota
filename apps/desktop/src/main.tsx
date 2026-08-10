import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import App from "./app";
import { LENOTA_VERSION } from "./build-info";
import { discardPersistedFocusMode, resetInterfaceAndReload } from "@/features/layout/ui-preferences";
import "./styles.css";
import "katex/dist/katex.min.css";

interface AppErrorBoundaryState { error: Error | null }

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("LeNota failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "32px", background: "#f4f1ea", color: "#25231f", fontFamily: "system-ui, sans-serif" }}>
      <section style={{ width: "min(560px, 100%)", border: "1px solid rgba(54,48,42,.14)", borderRadius: "18px", padding: "28px", background: "#fbfaf7", boxShadow: "0 24px 70px rgba(69,58,45,.14)" }}>
        <h1 style={{ margin: 0, fontSize: "24px" }}>LeNota could not restore the interface</h1>
        <p style={{ margin: "12px 0 20px", lineHeight: 1.6, color: "#67645e" }}>Your notes are safe. Reset only the saved interface layout, then reload the app.</p>
        <button type="button" onClick={resetInterfaceAndReload} style={{ minHeight: "42px", border: 0, borderRadius: "10px", padding: "0 16px", background: "#6d55d9", color: "white", fontWeight: 650, cursor: "pointer" }}>Reset interface and reload</button>
        <details style={{ marginTop: "18px", color: "#7e7972", fontSize: "12px" }}><summary>Technical details</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{this.state.error.message}</pre></details>
      </section>
    </main>;
  }
}

// LeNota is a desktop canvas application, not a browser page. Keep the
// WebKit document at 100% and reserve zoom gestures for the note canvas.
void getCurrentWebview().setZoom(1).catch((error) => {
  console.warn("Unable to reset WebView zoom to 100%", error);
});

// Browser-only interactions conflict with canvas navigation. Linux primary-
// selection middle-click paste is especially disruptive while panning.
const stopContextMenu = (event: Event) => event.preventDefault();
const stopMiddleDefault = (event: MouseEvent | PointerEvent) => {
  if (event.button === 1) event.preventDefault();
};
const stopDocumentZoomWheel = (event: WheelEvent) => {
  // WebKitGTK exposes trackpad pinch as Ctrl+wheel. Prevent WebKit's page zoom;
  // the event still bubbles to PageEditor, which converts it into canvas zoom.
  if (event.ctrlKey || event.metaKey) event.preventDefault();
};
const stopDocumentZoomKeys = (event: KeyboardEvent) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (["+", "=", "-", "_", "0"].includes(event.key)) event.preventDefault();
};
const resetInterfaceShortcut = (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "0") {
    event.preventDefault();
    resetInterfaceAndReload();
  }
};

// Some WebKit builds emit Safari-style gesture events instead of Ctrl+wheel.
// Convert those to a synthetic Ctrl+wheel event so the same canvas zoom path
// is used, while still preventing the web document itself from scaling.
let lastGestureScale = 1;
const gestureScale = (event: Event) => {
  const value = Number((event as Event & { scale?: number }).scale ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
};
const stopGestureStart = (event: Event) => {
  event.preventDefault();
  lastGestureScale = gestureScale(event);
};
const stopGestureChange = (event: Event) => {
  event.preventDefault();
  const next = gestureScale(event);
  const ratio = Math.max(.5, Math.min(2, next / Math.max(.001, lastGestureScale)));
  lastGestureScale = next;
  const target = event.target instanceof Element ? event.target : null;
  const canvas = target?.closest(".note-canvas");
  if (!canvas || Math.abs(ratio - 1) < .002) return;
  const pointer = event as Event & { clientX?: number; clientY?: number };
  canvas.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    clientX: Number(pointer.clientX ?? 0),
    clientY: Number(pointer.clientY ?? 0),
    deltaY: -Math.log(ratio) * 360,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
  }));
};

for (const type of ["pointerdown", "mousedown", "mouseup", "auxclick"] as const) {
  document.addEventListener(type, stopMiddleDefault as EventListener, true);
}
document.addEventListener("contextmenu", stopContextMenu, true);
window.addEventListener("wheel", stopDocumentZoomWheel, { capture: true, passive: false });
window.addEventListener("keydown", stopDocumentZoomKeys, true);
window.addEventListener("keydown", resetInterfaceShortcut, true);
document.addEventListener("gesturestart", stopGestureStart, { capture: true, passive: false } as AddEventListenerOptions);
document.addEventListener("gesturechange", stopGestureChange, { capture: true, passive: false } as AddEventListenerOptions);

document.documentElement.dataset.desktopZoomLocked = "true";
discardPersistedFocusMode(window.localStorage);
document.documentElement.dataset.focusMode = "false";
document.documentElement.dataset.lenotaVersion = LENOTA_VERSION;
document.title = `LeNota ${LENOTA_VERSION}`;

// The app shell is sized from html/body/#root in CSS. Avoid caching a pixel
// height from window.innerHeight here: WebView zoom/maximize transitions can
// change the CSS-pixel viewport without delivering a matching resize event,
// which leaves bottom-anchored canvas controls outside the visible window.

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
);
