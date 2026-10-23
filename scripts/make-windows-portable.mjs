#!/usr/bin/env node
/**
 * Build a portable Windows package from an existing electron-builder output.
 *
 * `electron-builder --win` already produces `release/win-unpacked/` before it packages the
 * installer, so this script wraps that directory in a ZIP that runs without installation. It is
 * deliberately separate from electron-builder so a portable build can be produced even when the
 * NSIS step is unavailable, and it never downloads anything itself.
 *
 * Usage: npm run package:win:portable
 */
import { createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const releaseDir = join(root, "release");
const unpacked = join(releaseDir, "win-unpacked");
const pkg = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(join(root, "package.json"), "utf8")));

if (!existsSync(unpacked)) {
  console.error(
    [
      `No Windows build at ${unpacked}.`,
      "",
      "electron-builder must produce it first, and it needs the Electron Windows zip:",
      "  1. On a machine with network access:  npm run package:win",
      "  2. Set ELECTRON_MIRROR if npm/Corepack is behind a proxy.",
      "",
      "A portable package cannot be produced without that Electron binary — this script does not",
      "download or fabricate one.",
    ].join("\n")
  );
  process.exit(1);
}

const required = ["Cadence.exe", "resources/app.asar"];
for (const file of required) {
  if (!existsSync(join(unpacked, file))) {
    console.error(`win-unpacked is incomplete: ${file} is missing. Re-run npm run package:win.`);
    process.exit(1);
  }
}

/** Minimal deterministic ZIP writer (deflate), so packaging needs no extra dependency. */
const { deflateRawSync } = await import("node:zlib");
const { createHash } = await import("node:crypto");

const files = [];
const walk = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push(full);
  }
};
walk(unpacked);
files.sort();

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

const { readFile } = await import("node:fs/promises");
const chunks = [];
const central = [];
let offset = 0;
const dosTime = 0;
const dosDate = (() => {
  const now = new Date();
  return ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
})();

for (const file of files) {
  const data = await readFile(file);
  const name = file.slice(unpacked.length + 1).split("\\").join("/");
  const nameBytes = Buffer.from(name, "utf8");
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
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
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
await pipeline((await import("node:fs")).createReadStream(target), sha);
console.log(`portable package: ${target}`);
console.log(`  files:  ${files.length}`);
console.log(`  size:   ${(size / 1024 / 1024).toFixed(1)} MiB`);
console.log(`  sha256: ${sha.digest("hex")}`);
console.log("  run:    unzip and launch Cadence.exe (no installer, no admin rights)");
