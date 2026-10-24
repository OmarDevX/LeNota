import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = fileURLToPath(new URL("../", import.meta.url));
const [platform, action, ...args] = process.argv.slice(2);
if (!["android", "ios"].includes(platform) || !["init", "dev", "build"].includes(action)) {
  console.error("Usage: node scripts/mobile.mjs android|ios init|dev|build [Tauri options]"); process.exit(1);
}
if (platform === "ios" && process.platform !== "darwin") {
  console.error("iOS builds require macOS and Xcode. Android can be built on Linux, macOS, or Windows."); process.exit(1);
}
const cli = path.join(app, "node_modules/@tauri-apps/cli/tauri.js");
const run = options => {
  // Native IDE build tasks must invoke the general Tauri command, rather than
  // recursively invoking this platform wrapper with extra Android/iOS args.
  const result = spawnSync(process.execPath, [cli, platform, ...options], { cwd: app, stdio: "inherit", env: { ...process.env, npm_lifecycle_event: "tauri" } });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (action !== "init" && !existsSync(path.join(app, "src-tauri/gen", platform === "ios" ? "apple" : "android"))) run(["init", "--ci"]);
// Some phones have a 64-bit CPU but run 32-bit Android. Include both ARM
// userspaces by default; an explicit target still selects a smaller build.
if (platform === "android" && action === "build" && !args.some(arg => arg === "--target" || arg.startsWith("--target=") || arg.startsWith("-t"))) {
  args.push("--target", "aarch64", "armv7");
}
run([action, ...args]);
