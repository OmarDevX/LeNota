import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { notesApi } from "@/lib/tauri-api";
import { createManagedImagePool } from "./managed-image-source";

type Props = ComponentPropsWithoutRef<"img"> & { attachmentId: string };
const imageSources = createManagedImagePool(id => notesApi.readAttachmentBytes(id));

export const ManagedImage = forwardRef<HTMLImageElement, Props>(function ManagedImage(
  { attachmentId, src, alt, onError, ...props }, ref,
) {
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setLoaded(null);
    setFailure(null);
    if (!attachmentId) return;
    let disposed = false;
    const resource = imageSources.acquire(attachmentId);
    void resource.source.then(url => {
      if (!disposed && url) setLoaded({ id: attachmentId, url });
    }).catch(error => {
      if (!disposed) setFailure({ id: attachmentId, message: error instanceof Error ? error.message : String(error) });
    });
    return () => { disposed = true; resource.dispose(); };
  }, [attachmentId, retry]);

  const imageSrc = attachmentId ? (loaded?.id === attachmentId ? loaded.url : undefined) : src;
  const error = failure?.id === attachmentId ? failure.message : null;
  return <>
    <img decoding="async" {...props} ref={ref} src={imageSrc} alt={imageSrc ? alt : ""} onError={event => {
      if (attachmentId) setFailure({ id: attachmentId, message: "The saved image could not be decoded." });
      onError?.(event);
    }}/>
    {attachmentId && !imageSrc && !error ? <span role="status" className="block p-3 text-xs text-neutral-400">Loading image…</span> : null}
    {error ? <div role="alert" className="p-3 text-xs text-red-300">
      <span>Image unavailable: {error}</span>
      <button type="button" className="ml-2 rounded border border-current px-2 py-1" onClick={() => setRetry(value => value + 1)}>Retry</button>
    </div> : null}
  </>;
});
