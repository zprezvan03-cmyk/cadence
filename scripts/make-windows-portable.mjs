#!/usr/bin/env node
/**
 * Build a portable Windows ZIP package from an existing Tauri release build.
 *
 * `npm run package:win` (`tauri build`) produces the native Windows executable (`cadence.exe`,
 * with the production `dist/` frontend assets embedded directly inside the binary) under
 * `src-tauri/target/x86_64-pc-windows-msvc/release/` or `src-tauri/target/release/`.
 * This script packages that standalone executable (plus `LICENSE` and `UPSTREAM.md`) into a
 * ready-to-run portable ZIP that requires no installer or administrator rights.
 *
 * Usage: npm run package:win:portable
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const releaseDir = join(root, "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const candidateBins = [
  join(root, "src-tauri/target/x86_64-pc-windows-msvc/release/cadence.exe"),
  join(root, "src-tauri/target/x86_64-pc-windows-msvc/release/Cadence.exe"),
  join(root, "src-tauri/target/release/cadence.exe"),
  join(root, "src-tauri/target/release/Cadence.exe"),
];

const exePath = candidateBins.find(candidate => existsSync(candidate));
if (!exePath) {
  console.error(
    [
      "No compiled Tauri Windows executable found in src-tauri/target/.",
      "",
      "Build the native Windows target first on a machine with Rust + MSVC + WebView2:",
      "  1. npm install",
      "  2. npm run package:win",
      "",
      "A portable package cannot be produced without compiling the Rust host binary — this script",
      "never fabricates or downloads prebuilt binaries.",
    ].join("\n")
  );
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
const exeDir = resolve(exePath, "..");

const entriesToPack = [
  { zipName: "Cadence.exe", diskPath: exePath },
];
const webviewLoader = join(exeDir, "WebView2Loader.dll");
if (existsSync(webviewLoader)) {
  entriesToPack.push({ zipName: "WebView2Loader.dll", diskPath: webviewLoader });
}
for (const doc of ["LICENSE", "UPSTREAM.md", "README.md"]) {
  const full = join(root, doc);
  if (existsSync(full)) entriesToPack.push({ zipName: doc, diskPath: full });
}

let crcTable = null;
const crc32 = buffer => {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
};

const chunks = [];
const central = [];
let offset = 0;
const dosTime = 0;
const dosDate = (() => {
  const now = new Date();
  return ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
})();

for (const item of entriesToPack) {
  const data = await readFile(item.diskPath);
  const nameBytes = Buffer.from(item.zipName, "utf8");
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBytes, compressed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(dosTime, 12);
  entry.writeUInt16LE(dosDate, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(compressed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([entry, nameBytes]));

  offset += local.length + nameBytes.length + compressed.length;
}

const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entriesToPack.length, 8);
end.writeUInt16LE(entriesToPack.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);

const target = join(releaseDir, `Cadence-${pkg.version}-win-x64-portable.zip`);
await pipeline(
  (async function* () {
    yield Buffer.concat(chunks);
    yield centralBuffer;
    yield end;
  })(),
  createWriteStream(target)
);

const size = statSync(target).size;
const sha = createHash("sha256");
await pipeline(createReadStream(target), sha);
console.log(`portable package: ${target}`);
console.log(`  files:  ${entriesToPack.length}`);
console.log(`  size:   ${(size / 1024 / 1024).toFixed(2)} MiB`);
console.log(`  sha256: ${sha.digest("hex")}`);
console.log("  run:    unzip and launch Cadence.exe (uses Windows WebView2 runtime)");
