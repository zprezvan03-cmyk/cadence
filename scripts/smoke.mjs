#!/usr/bin/env node
/**
 * Headless smoke test for Cadence.
 *
 * Exercises the real main-process modules (library scanner, SQLite + JSON stores, metadata reader,
 * lyrics providers) through the vitest suite, rebuilds the app, and validates the emitted bundle.
 * It needs no Electron binary, so it also runs in sandboxes and CI where that download is blocked.
 * Launching the GUI is covered separately by `npm run test:ui`.
 *
 * Usage: npm run smoke
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const fixtures = join(root, ".artifacts/fixtures/formats");
const failures = [];

const pass = (name, detail = "") => console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, detail) => {
  failures.push(`${name}: ${detail}`);
  console.log(`FAIL ${name} — ${detail}`);
};
const check = (name, ok, detail = "") => (ok ? pass(name, detail) : fail(name, detail));
const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...options });

// 1. Fixtures ---------------------------------------------------------------------------------
if (!existsSync(join(fixtures, "fixture.flac"))) {
  console.log("Audio fixtures missing, generating them…");
  const generated = run("python3", [join(root, "tests/fixtures/generate-audio.py")]);
  if (generated.status !== 0) {
    console.error("Could not generate fixtures (needs python3 + av + soundfile + mutagen). See README.");
    process.exit(1);
  }
}
const fixturesPresent = readdirSync(fixtures).filter(name => /\.(flac|mp3|m4a|wav|ogg|opus)$/.test(name));
check("fixtures", fixturesPresent.length === 8, `${fixturesPresent.length} encoded audio files`);

// 2. Unit + integration tests (scanner, stores, metadata, queue, lyrics, LRC parsing) ----------
const tests = run("npx", ["vitest", "run", "--silent"]);
check("tests", tests.status === 0, tests.status === 0 ? "all vitest suites passed" : "vitest reported failures");

// 3. Production bundle ------------------------------------------------------------------------
const build = run("npx", ["electron-vite", "build"]);
check("bundle-build", build.status === 0, build.status === 0 ? "electron-vite emitted main, preload and renderer" : "build failed");

for (const [name, file] of [
  ["main-bundle", "out/main/index.js"],
  ["preload-bundle", "out/preload/index.mjs"],
  ["renderer-entry", "out/renderer/index.html"],
]) {
  check(name, existsSync(join(root, file)) && statSync(join(root, file)).size > 100, file);
}

const rendererAssets = existsSync(join(root, "out/renderer/assets"))
  ? readdirSync(join(root, "out/renderer/assets"))
  : [];
check("renderer-assets", rendererAssets.some(file => file.endsWith(".js")) && rendererAssets.some(file => file.endsWith(".css")), `${rendererAssets.length} files`);

const indexHtml = existsSync(join(root, "out/renderer/index.html")) ? readFileSync(join(root, "out/renderer/index.html"), "utf8") : "";
check("csp-present", indexHtml.includes("Content-Security-Policy"), "renderer ships a CSP");

// 4. Electron binary --------------------------------------------------------------------------
const electronBinary = process.platform === "win32"
  ? join(root, "node_modules/electron/dist/electron.exe")
  : join(root, "node_modules/electron/dist/electron");
if (existsSync(electronBinary)) {
  pass("electron-binary", electronBinary);
} else {
  // Not a failure of the source tree: this sandbox cannot download the Electron binary.
  console.log("SKIP electron-binary — not installed here; GUI launch must be verified on a machine with Electron");
}
if (!existsSync(electronBinary)) {
  console.log("SKIP package — electron-builder needs that binary");
}

console.log(`\nsmoke: ${failures.length === 0 ? "ok" : `${failures.length} failure(s)`}`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
