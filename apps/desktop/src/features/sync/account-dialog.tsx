import { useEffect, useRef, useState, type FormEvent } from "react";
import { Cloud, CloudOff, RefreshCw, X } from "lucide-react";
import type { useAccountSync } from "./use-account-sync";

export function AccountDialog({ sync, onClose }: { sync: ReturnType<typeof useAccountSync>; onClose: () => void }) {
  const [signup, setSignup] = useState(false);
  const [provider, setProvider] = useState<"supabase" | "selfHosted">(sync.status.provider ?? "supabase");
  const [publicKey, setPublicKey] = useState(sync.status.publicKey ?? "");
  const [server, setServer] = useState(sync.status.serverUrl ?? "");
  const [email, setEmail] = useState(sync.status.email ?? "");
  const [password, setPassword] = useState("");
  const [allowHttp, setAllowHttp] = useState(sync.status.allowHttp);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    section.current?.querySelector<HTMLElement>("input,button")?.focus();
    return () => previous?.focus();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await sync.login(server, email, password, signup, allowHttp, provider, publicKey)) setPassword("");
  }
  return <div className="sync-dialog-backdrop no-print" onPointerDown={event => { if (event.target === event.currentTarget && !sync.busy) onClose(); }}>
    <section ref={section} className="sync-dialog" role="dialog" aria-modal="true" aria-label="Account and sync" onKeyDown={event => {
      if (event.key === "Escape" && !sync.busy) { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const items = Array.from(section.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]") ?? []);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div className="sync-dialog-heading"><Cloud size={22}/><div><h2>Account & sync</h2><p>Your notes, on every device</p></div></div><button type="button" className="sync-icon-button" aria-label="Close account and sync" disabled={sync.busy} onClick={onClose}><X size={20}/></button></header>
      <div className="sync-dialog-body">
        {sync.status.signedIn ? <>
          <div className="sync-account-card"><Cloud size={26}/><div><strong>{sync.status.email}</strong><span>{sync.status.serverUrl}</span></div></div>
          <div className="sync-status-line" role="status"><span className={sync.error ? "sync-dot is-error" : "sync-dot"}/>{sync.busy ? "Syncing…" : sync.error ? "Sync needs attention" : "Automatic sync is on"}</div>
          <p className="sync-help">Sync runs every 15 seconds while LeNota is open, and when you reconnect. You can keep editing offline.</p>
          {sync.status.lastSyncedAt ? <p className="sync-help">Last synced: {new Date(Number(sync.status.lastSyncedAt)).toLocaleString()}</p> : null}
          {sync.conflicts > 0 ? <p className="sync-notice">Some edits were made on both devices. Open the affected page’s History to review the saved versions. Edited items are kept when they conflict with a deletion.</p> : null}
          <div className="sync-actions"><button className="sync-primary" disabled={sync.busy} onClick={() => void sync.syncNow()}><RefreshCw size={16} className={sync.busy ? "sync-spin" : ""}/>{sync.busy ? "Syncing…" : "Sync now"}</button><button className="sync-secondary" disabled={sync.busy} onClick={() => void sync.logout()}>Sign out</button></div>
        </> : <>
          <p className="sync-help">Use the same account and server address on your PC and phone. Your existing notes will be merged into your account on the first sync.</p>
          {sync.status.email ? <p className="sync-notice">This workspace is linked to {sync.status.email}. Sign in to continue syncing it.</p> : <div className="sync-tabs"><button className={!signup ? "is-active" : ""} onClick={() => setSignup(false)}>Sign in</button><button className={signup ? "is-active" : ""} onClick={() => setSignup(true)}>Create account</button></div>}
          <form onSubmit={event => void submit(event)}>
            {!sync.status.email ? <label>Sync service<select aria-label="Sync service" value={provider} disabled={sync.busy} onChange={event => setProvider(event.target.value as "supabase" | "selfHosted")}><option value="supabase">Supabase — free cloud sync</option><option value="selfHosted">Self-hosted server</option></select></label> : null}
            {provider === "supabase" ? <p className="sync-help">Create a Free Supabase project, run the included setup SQL, and copy its project URL and publishable key. You can use a confirmed user created in its dashboard.</p> : null}
            <label>{provider === "supabase" ? "Supabase project URL" : "Server address"}<input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" required placeholder={provider === "supabase" ? "https://your-project.supabase.co" : "https://notes.example.com"} value={server} disabled={sync.busy} onChange={event => setServer(event.target.value)}/></label>
            {provider === "supabase" ? <label>Publishable key<input aria-label="Publishable key" type="text" autoCapitalize="none" autoCorrect="off" required placeholder="sb_publishable_…" value={publicKey} disabled={sync.busy} onChange={event => setPublicKey(event.target.value)}/><small className="sync-help">Use the public publishable key. Keep secret/service-role keys out of the app.</small></label> : null}
            <label>Email<input type="email" inputMode="email" autoComplete="username" autoCapitalize="none" required value={email} disabled={sync.busy} onChange={event => setEmail(event.target.value)}/></label>
            <label>Password<input type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={12} maxLength={1024} required placeholder="At least 12 characters" value={password} disabled={sync.busy} onChange={event => setPassword(event.target.value)}/></label>
            {provider === "selfHosted" ? <label className="sync-checkbox"><input type="checkbox" checked={allowHttp} disabled={sync.busy} onChange={event => setAllowHttp(event.target.checked)}/><span>Allow HTTP on a trusted local network</span></label> : null}
            {allowHttp && provider === "selfHosted" ? <p className="sync-help">HTTP sends your password and notes without encryption. Use HTTPS for internet access.</p> : null}
            <button className="sync-primary" type="submit" disabled={sync.busy}>{sync.busy ? "Connecting…" : signup ? "Create account & sync" : "Sign in & sync"}</button>
          </form>
        </>}
        {sync.error ? <div className="sync-error" role="alert"><CloudOff size={18}/><span>{sync.error}</span></div> : sync.message ? <p className="sync-help" role="status">{sync.message}</p> : null}
      </div>
      <footer>Notes are saved on this device even when sync is unavailable.</footer>
    </section>
  </div>;
}
