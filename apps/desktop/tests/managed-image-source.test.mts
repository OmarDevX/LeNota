import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createManagedImagePool, createManagedImageSource, normalizeImageBytes } from "../src/features/editor/managed-image-source.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("managed image source reads by attachment id and exposes unchanged PNG bytes", async () => {
  const seen: string[] = [];
  const resource = createManagedImageSource("page-image-id", async id => { seen.push(id); return png.buffer; });
  const url = await resource.source;
  assert.ok(url?.startsWith("blob:"));
  const response = await fetch(url!);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.deepEqual(seen, ["page-image-id"]);
  resource.dispose();
  await assert.rejects(fetch(url!));
  resource.dispose();
});

test("IPC image normalization respects typed-array byte offsets", () => {
  const padded = Uint8Array.from([99, ...png, 88]);
  assert.deepEqual(new Uint8Array(normalizeImageBytes(padded.subarray(1, -1))), png);
  assert.deepEqual(new Uint8Array(normalizeImageBytes([...png])), png);
  assert.throws(() => normalizeImageBytes("not binary"), /invalid image/);
});

test("unmount before the attachment read finishes creates no abandoned image URL", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const resource = createManagedImageSource("late-page", async () => pending);
  resource.dispose();
  finish(png.buffer);
  assert.equal(await resource.source, null);
});

test("read failures and empty files remain errors instead of broken asset URLs", async () => {
  const missing = createManagedImageSource("missing", async () => { throw new Error("Attachment missing"); });
  await assert.rejects(missing.source, /Attachment missing/);
  missing.dispose();
  const empty = createManagedImageSource("empty", async () => new ArrayBuffer(0));
  await assert.rejects(empty.source, /empty/);
  empty.dispose();
});

test("JPEG attachments keep their image type and each view owns its resource", async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const first = createManagedImageSource("same-id", async () => jpeg);
  const second = createManagedImageSource("same-id", async () => jpeg);
  const [a, b] = await Promise.all([first.source, second.source]);
  assert.notEqual(a, b);
  first.dispose();
  assert.equal((await fetch(b!)).headers.get("content-type"), "image/jpeg");
  second.dispose();
});

test("the native CSP permits managed image blobs while retaining the narrow disk scope", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const imagePolicy = config.app.security.csp.split(";").find((item: string) => item.trim().startsWith("img-src "));
  assert.ok(imagePolicy.split(/\s+/).includes("blob:"));
  assert.deepEqual(config.app.security.assetProtocol.scope, ["$APPDATA/attachments/**/*"]);
});

test("duplicate PDF image views share one read and release only after the last viewer", async () => {
  let reads = 0;
  const pool = createManagedImagePool(async () => { reads++; return png; });
  const a = pool.acquire("pdf-page"), b = pool.acquire("pdf-page");
  const [first, second] = await Promise.all([a.source, b.source]);
  assert.equal(reads, 1);
  assert.equal(first, second);
  a.dispose(); a.dispose();
  assert.deepEqual(new Uint8Array(await (await fetch(second!)).arrayBuffer()), png);
  b.dispose();
  await assert.rejects(fetch(first!));
  const next = pool.acquire("pdf-page");
  assert.notEqual(await next.source, first);
  assert.equal(reads, 2);
  next.dispose();
});

test("many PDF pages respect the IPC read limit and skip removed queued pages", async () => {
  const pending: Array<() => void> = [];
  const reads: string[] = [];
  let active = 0, maximum = 0;
  const pool = createManagedImagePool(async id => {
    reads.push(id); active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => pending.push(resolve));
    active--; return png;
  }, 2);
  const pages = Array.from({ length: 8 }, (_, i) => pool.acquire(`page-${i}`));
  await Promise.resolve();
  assert.equal(reads.length, 2);
  pages[4].dispose();
  assert.equal(await pages[4].source, null);
  for (let i = 0; i < 12; i++) {
    pending.splice(0).forEach(finish => finish());
    await new Promise(resolve => setImmediate(resolve));
  }
  await Promise.all(pages.map(page => page.source));
  assert.equal(maximum, 2);
  assert.equal(reads.length, 7);
  assert.ok(!reads.includes("page-4"));
  pages.forEach(page => page.dispose());
});

test("failed shared image reads can retry without invalidating the new resource", async () => {
  let reads = 0;
  const pool = createManagedImagePool(async () => { if (++reads === 1) throw new Error("temporary failure"); return png; });
  const failed = pool.acquire("retry-page");
  await assert.rejects(failed.source, /temporary failure/);
  const retry = pool.acquire("retry-page");
  failed.dispose();
  const url = await retry.source;
  assert.equal((await fetch(url!)).status, 200);
  retry.dispose();
});

test("removing all viewers during a read creates no leaked blob", async () => {
  let finish!: (raw: unknown) => void;
  const pool = createManagedImagePool(async () => new Promise(resolve => { finish = resolve; }));
  const page = pool.acquire("late-page");
  await Promise.resolve();
  page.dispose();
  finish(png);
  assert.equal(await page.source, null);
});
