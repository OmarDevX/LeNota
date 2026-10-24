import type { CloudAskResponse } from "../../lib/tauri-api.ts";
import { cloudBlocksToTiptap } from "./cloud-ai-content.ts";

let transportBusy = false;

/** The native worker may still be finishing a cancelled request. Do not queue
 * more jobs behind it or allow a late answer to overwrite the user's notes. */
export async function askSafely(cloud: () => Promise<CloudAskResponse>, signal: AbortSignal, timeoutMs = 185_000): Promise<CloudAskResponse> {
  if (signal.aborted) throw new DOMException("Ask cancelled", "AbortError");
  if (transportBusy) throw new Error("The previous AI request is still finishing. Your notes remain editable; retry shortly.");
  transportBusy = true;
  const transport = Promise.resolve().then(cloud).finally(() => { transportBusy = false; });
  const response = await new Promise<CloudAskResponse>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new DOMException("Ask cancelled", "AbortError")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`AI response timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Your notes were kept. The native request may still be finishing; check your AI backups.`)); }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    transport.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  if (signal.aborted) throw new DOMException("Ask cancelled", "AbortError");
  if (!response || !Array.isArray(response.blocks) || !response.blocks.length || !cloudBlocksToTiptap(response.blocks).length) {
    throw new Error("AI returned invalid note content. Your /ask command was kept.");
  }
  return response;
}

