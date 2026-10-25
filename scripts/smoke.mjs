#!/usr/bin/env node
/**
 * Headless smoke test for Cadence (Tauri v2 architecture).
 *
 * Exercises the runtime-agnostic service cores + Tauri bridge + library scanner + SQLite/JSON
 * stores + metadata reader + lyrics providers through the Vitest suite, builds the production Vite
 * frontend bundle (`dist/`), and validates the Tauri v2 configuration, capabilities, and Windows
 * icon/bundle setup.
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

// 2. Unit + integration tests (scanner, stores, metadata, queue, lyrics, Tauri bridge) ---------
const tests = run("npx", ["vitest", "run", "--silent"]);
check("tests", tests.status === 0, tests.status === 0 ? "all vitest suites passed" : "vitest reported failures");

// 3. Production frontend bundle (`dist/`) -----------------------------------------------------
const build = run("npx", ["vite", "build"]);
check("bundle-build", build.status === 0, build.status === 0 ? "vite emitted production frontend bundle to dist/" : "build failed");

check(
  "renderer-entry",
  existsSync(join(root, "dist/index.html")) && statSync(join(root, "dist/index.html")).size > 100,
  "dist/index.html"
);

const rendererAssets = existsSync(join(root, "dist/assets"))
  ? readdirSync(join(root, "dist/assets"))
  : [];
check(
  "renderer-assets",
  rendererAssets.some(file => file.endsWith(".js")) && rendererAssets.some(file => file.endsWith(".css")),
  `${rendererAssets.length} files`
);

const indexHtml = existsSync(join(root, "dist/index.html"))
  ? readFileSync(join(root, "dist/index.html"), "utf8")
  : "";
check(
  "csp-present",
  indexHtml.includes("Content-Security-Policy") && indexHtml.includes("cadence-media.localhost"),
  "renderer ships Tauri/WebView2 CSP"
);

// 4. Tauri v2 configuration, least-privilege capabilities, and Windows icons ------------------
const tauriConfPath = join(root, "src-tauri/tauri.conf.json");
const tauriWinConfPath = join(root, "src-tauri/tauri.windows.conf.json");
const tauriCapPath = join(root, "src-tauri/capabilities/default.json");
const tauriCargoPath = join(root, "src-tauri/Cargo.toml");
check("tauri-config-present", existsSync(tauriConfPath) && existsSync(tauriCargoPath), "src-tauri/{tauri.conf.json,Cargo.toml}");

if (existsSync(tauriConfPath)) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  const winCfg = conf?.app?.windows?.[0];
  const devScript = String(conf?.build?.beforeDevCommand ?? "").replace(/^npm run\s+/, "");
  const buildScript = String(conf?.build?.beforeBuildCommand ?? "").replace(/^npm run\s+/, "");
  check(
    "tauri-build-scripts",
    Boolean(pkg?.scripts?.[devScript] && pkg?.scripts?.[buildScript]),
    `${devScript}, ${buildScript}`
  );
  check(
    "tauri-identity-and-window",
    conf.productName === "Cadence" &&
      conf.identifier === "app.cadence.player" &&
      winCfg?.width === 1440 &&
      winCfg?.height === 920 &&
      winCfg?.minWidth === 1040 &&
      winCfg?.minHeight === 680 &&
      winCfg?.backgroundThrottling === "disabled",
    `${conf.productName} (${conf.identifier}) ${winCfg?.width}x${winCfg?.height}`
  );
  // The integrated title bar depends on the Windows overlay undecorating the window. Platform
  // configs replace `app.windows` wholesale, so the overlay must repeat every base field.
  if (existsSync(tauriWinConfPath)) {
    const winConf = JSON.parse(readFileSync(tauriWinConfPath, "utf8"));
    const winOverlay = winConf?.app?.windows?.[0] ?? {};
    const baseKeys = Object.keys(winCfg ?? {}).filter(key => key !== "decorations");
    check(
      "tauri-windows-title-bar",
      winOverlay.decorations === false &&
        baseKeys.every(key => winOverlay[key] === winCfg[key]) &&
        Object.keys(winOverlay).filter(key => key !== "decorations").length === baseKeys.length,
      "src-tauri/tauri.windows.conf.json undecorates the main window and mirrors the base config"
    );
  } else {
    fail("tauri-windows-title-bar", "src-tauri/tauri.windows.conf.json is missing");
  }
  check(
    "tauri-windows-icons",
    existsSync(join(root, "src-tauri/icons/icon.ico")) &&
      statSync(join(root, "src-tauri/icons/icon.ico")).size > 1024,
    "src-tauri/icons/icon.ico"
  );
}

if (existsSync(tauriCapPath)) {
  const cap = JSON.parse(readFileSync(tauriCapPath, "utf8"));
  const perms = Array.isArray(cap.permissions) ? cap.permissions : [];
  const hasUnrestrictedShellOrFs = perms.some(
    p => typeof p === "string" && (p.startsWith("shell:") || p.startsWith("fs:"))
  );
  check(
    "tauri-least-privilege",
    cap.local === true && !hasUnrestrictedShellOrFs,
    `${perms.length} scoped window/core permissions`
  );
  check(
    "tauri-title-bar-permissions",
    perms.includes("core:window:allow-start-dragging") &&
      perms.includes("core:window:allow-internal-toggle-maximize"),
    "drag region (drag to move, double-click to maximize) is allowed"
  );
}

// 5. Rust / Cargo native toolchain probe ------------------------------------------------------
const cargoProbe = spawnSync("cargo", ["--version"], { cwd: root, encoding: "utf8" });
if (cargoProbe.status === 0) {
  pass("rust-cargo", cargoProbe.stdout.trim());
} else {
  console.log("SKIP rust-cargo — Rust toolchain (cargo/rustc) is not installed in this environment; native Tauri binary/installer compilation requires a host with Rust + Windows MSVC/WebView2 SDK");
}

console.log(`\nsmoke: ${failures.length === 0 ? "ok" : `${failures.length} failure(s)`}`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
