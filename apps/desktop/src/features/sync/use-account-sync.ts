import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { syncApi, type SyncStatus } from "@/lib/tauri-api";

const SIGNED_OUT: SyncStatus = { signedIn: false, email: null, serverUrl: null, lastSyncedAt: null, pending: false, allowHttp: false };

/** Fetch while editing remains available, then flush the latest draft and apply
 * under a short UI lock. Native SQLite also compares the captured workspace. */
export function useAccountSync(callbacks: { flush: () => Promise<void>; reload: () => Promise<void> }) {
  const [status, setStatus] = useState<SyncStatus>(SIGNED_OUT);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState(0);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const statusRef = useRef(status);
  statusRef.current = status;
  const running = useRef(false);
  const actionRef = useRef<() => Promise<void>>(async () => {});
  const commitRef = useRef(false);
  const pointers = useRef(new Set<number>());
  const finishGesture = useRef<(() => void) | null>(null);
  useEffect(() => {
    const down = (event: PointerEvent) => { pointers.current.add(event.pointerId); };
    const up = (event: PointerEvent) => {
      pointers.current.delete(event.pointerId);
      if (!pointers.current.size) { finishGesture.current?.(); finishGesture.current = null; }
    };
    const blur = () => { pointers.current.clear(); finishGesture.current?.(); finishGesture.current = null; };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", up, true); window.removeEventListener("blur", blur); blur(); };
  }, []);

  async function runSync() {
    if (running.current || !statusRef.current.signedIn || document.visibilityState === "hidden") return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await callbacksRef.current.flush();
      await syncApi.prepare();
      // Let a stroke, drag, or pinch finish before remounting a changed page.
      if (pointers.current.size) await new Promise<void>(resolve => { finishGesture.current = resolve; });
      // Changing inert immediately also blocks DOM input before an IPC await.
      commitRef.current = true;
      flushSync(() => setCommitting(true));
      await callbacksRef.current.flush();
      const result = await syncApi.finish();
      setStatus(result.status);
      if (result.changed) await callbacksRef.current.reload();
      if (result.conflicts.length) setConflicts(n => n + result.conflicts.length);
      setMessage(result.applied ? (result.conflicts.length ? "Synced. Conflicting page versions are saved in History." : "All changes synced.") : "New edits are saved locally. Sync will retry shortly.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      await syncApi.status().then(setStatus).catch(() => {});
    } finally {
      commitRef.current = false;
      setCommitting(false);
      setBusy(false);
      running.current = false;
    }
  }
  actionRef.current = runSync;
  useEffect(() => {
    let active = true;
    void syncApi.status().then(value => {
      if (!active || !value) return;
      statusRef.current = value;
      setStatus(value);
      if (value.signedIn) void actionRef.current();
    }).catch(() => {});
    const onReconnect = () => { void actionRef.current(); };
    const onVisible = () => { if (document.visibilityState === "visible") onReconnect(); };
    const timer = window.setInterval(onReconnect, 15_000);
    window.addEventListener("online", onReconnect);
    window.addEventListener("focus", onReconnect);
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; clearInterval(timer); window.removeEventListener("online", onReconnect); window.removeEventListener("focus", onReconnect); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  async function login(server: string, email: string, password: string, signup: boolean, allowHttp: boolean, provider: "supabase" | "selfHosted", publicKey: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    let succeeded = false;
    try {
      const next = await syncApi.login(server, email, password, signup, allowHttp, provider, publicKey);
      statusRef.current = next;
      setStatus(next);
      setMessage("Signed in. Syncing your notes…");
      succeeded = true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { running.current = false; setBusy(false); }
    if (succeeded) await actionRef.current();
    return succeeded;
  }
  async function logout() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await callbacksRef.current.flush();
      const next = await syncApi.logout();
      statusRef.current = next;
      setStatus(next);
      setMessage("Signed out on this device. Your notes remain available offline.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { running.current = false; setBusy(false); }
  }
  return { status, busy, committing, commitRef, message, error, conflicts, login, logout, syncNow: runSync };
}
