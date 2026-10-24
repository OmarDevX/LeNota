import { detectVisualImageMimeType } from "./visual-selection.ts";

export function normalizeImageBytes(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer;
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]).buffer;
  throw new Error("LeNota received invalid image attachment bytes.");
}

/** Runtime image URLs belong to the view, never to the saved note document. */
export function createManagedImageSource(
  attachmentId: string,
  readBytes: (id: string) => Promise<unknown>,
): { source: Promise<string | null>; dispose: () => void } {
  let disposed = false;
  let objectUrl: string | null = null;
  const source = Promise.resolve().then(() => readBytes(attachmentId)).then(raw => {
    if (disposed) return null;
    const buffer = normalizeImageBytes(raw);
    if (!buffer.byteLength) throw new Error("The saved image attachment is empty.");
    const mimeType = detectVisualImageMimeType(new Uint8Array(buffer));
    objectUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
    return objectUrl;
  });
  return {
    source,
    dispose: () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
  };
}

/** Share immutable managed attachments between views and limit simultaneous
 * IPC reads. A retry after failure gets a fresh read; the final viewer releases
 * its blob. Queued reads with no remaining viewers are skipped. */
export function createManagedImagePool(readBytes: (id: string) => Promise<unknown>, concurrency = 3) {
  type Entry = {
    id: string; users: number; started: boolean; url: string | null;
    source: Promise<string | null>; resolve: (url: string | null) => void; reject: (error: unknown) => void;
  };
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  let active = 0;
  const forget = (entry: Entry) => { if (entries.get(entry.id) === entry) entries.delete(entry.id); };
  const drain = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift()!;
      if (!entry.users) continue;
      entry.started = true;
      active += 1;
      void Promise.resolve().then(()=>readBytes(entry.id)).then(raw => {
        if (!entry.users) { entry.resolve(null); return; }
        const buffer = normalizeImageBytes(raw);
        if (!buffer.byteLength) throw new Error("The saved image attachment is empty.");
        entry.url = URL.createObjectURL(new Blob([buffer], { type: detectVisualImageMimeType(new Uint8Array(buffer)) }));
        entry.resolve(entry.url);
      }).catch(error => { forget(entry); entry.reject(error); }).finally(() => { active -= 1; drain(); });
    }
  };
  return {
    acquire(id: string): { source: Promise<string | null>; dispose: () => void } {
      let entry = entries.get(id);
      if (!entry) {
        let resolve!: Entry["resolve"], reject!: Entry["reject"];
        const source = new Promise<string | null>((done, fail) => { resolve = done; reject = fail; });
        entry = { id, users: 0, started: false, url: null, source, resolve, reject };
        entries.set(id, entry);
        queue.push(entry);
      }
      const current = entry;
      current.users += 1;
      drain();
      let disposed = false;
      return {
        source: current.source,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          current.users -= 1;
          if (current.users) return;
          forget(current);
          if (current.url) { URL.revokeObjectURL(current.url); current.url = null; }
          if (!current.started) current.resolve(null);
        },
      };
    },
  };
}
