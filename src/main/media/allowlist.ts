/**
 * Directories the media protocol may serve from, plus cross-platform path containment helpers.
 * Kept free of Electron imports so the scanner, the IPC layer and the automated tests can all use
 * the same check. Written for Cadence.
 */

import { posix, win32, type PlatformPath } from "node:path";

export type PathPlatform = "win32" | "posix";

const WINDOWS_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\\\\\?\\)/;
const WINDOWS_DRIVE_RELATIVE_PATTERN = /^[a-zA-Z]:(?![\\/])/;

export function stripWindowsDevicePrefix(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\") || value.startsWith("\\\\?\\unc\\")) {
    return "\\\\" + value.slice(8);
  }
  if (value.startsWith("\\\\?\\")) {
    return value.slice(4);
  }
  return value;
}

export function resolvePathApi(platform?: PathPlatform, samplePath?: string): PlatformPath {
  if (platform === "win32") return win32;
  if (platform === "posix") return posix;
  if (process.platform === "win32") return win32;
  if (samplePath && WINDOWS_PATH_PATTERN.test(samplePath)) return win32;
  return posix;
}

function isInvalidPathInput(value: string): boolean {
  return !value || value.includes("\0");
}

function isRelativeContained(rel: string, pathApi: PlatformPath): boolean {
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

/**
 * Returns true when `candidatePath` resolves to `rootDir` itself or a descendant inside `rootDir`,
 * using the appropriate `node:path` implementation (`win32` or `posix`) and `path.relative()`.
 */
export function isPathInside(rootDir: string, candidatePath: string, platform?: PathPlatform): boolean {
  if (isInvalidPathInput(rootDir) || isInvalidPathInput(candidatePath)) return false;

  const pathApi = resolvePathApi(platform, rootDir);
  if (pathApi === win32) {
    if (WINDOWS_DRIVE_RELATIVE_PATTERN.test(rootDir) || WINDOWS_DRIVE_RELATIVE_PATTERN.test(candidatePath)) {
      return false;
    }
    const resolvedRoot = win32.resolve(stripWindowsDevicePrefix(rootDir));
    const resolvedCandidate = win32.resolve(stripWindowsDevicePrefix(candidatePath));
    return isRelativeContained(win32.relative(resolvedRoot, resolvedCandidate), win32);
  }

  const resolvedRoot = posix.resolve(rootDir);
  const resolvedCandidate = posix.resolve(candidatePath);
  return isRelativeContained(posix.relative(resolvedRoot, resolvedCandidate), posix);
}

/**
 * Resolves `targetPath` against `rootDir` and returns the normalized path only if it stays within
 * `rootDir`; returns `null` on traversal, sibling-prefix, cross-drive, or malformed inputs.
 */
export function resolveContainedPath(
  rootDir: string,
  targetPath: string,
  platform?: PathPlatform
): string | null {
  if (isInvalidPathInput(rootDir) || isInvalidPathInput(targetPath)) return null;

  const pathApi = resolvePathApi(platform, rootDir);
  if (pathApi === win32) {
    if (WINDOWS_DRIVE_RELATIVE_PATTERN.test(rootDir) || WINDOWS_DRIVE_RELATIVE_PATTERN.test(targetPath)) {
      return null;
    }
    const resolvedRoot = win32.resolve(stripWindowsDevicePrefix(rootDir));
    const resolvedTarget = win32.resolve(resolvedRoot, stripWindowsDevicePrefix(targetPath));
    return isRelativeContained(win32.relative(resolvedRoot, resolvedTarget), win32) ? resolvedTarget : null;
  }

  const resolvedRoot = posix.resolve(rootDir);
  const resolvedTarget = posix.resolve(resolvedRoot, targetPath);
  return isRelativeContained(posix.relative(resolvedRoot, resolvedTarget), posix) ? resolvedTarget : null;
}

/** Closed set of directories the protocol will serve from. */
export class MediaAllowlist {
  private roots = new Map<string, string>();

  constructor(private readonly platform?: PathPlatform) {}

  private normalizeRoot(root: string): { key: string; resolved: string } | null {
    if (isInvalidPathInput(root)) return null;
    const pathApi = resolvePathApi(this.platform, root);
    if (pathApi === win32) {
      if (WINDOWS_DRIVE_RELATIVE_PATTERN.test(root)) return null;
      const resolved = win32.resolve(stripWindowsDevicePrefix(root));
      return { key: `win32:${resolved.toLowerCase()}`, resolved };
    }
    const resolved = posix.resolve(root);
    return { key: `posix:${resolved}`, resolved };
  }

  setRoots(roots: string[]): void {
    this.roots.clear();
    for (const root of roots) this.addRoot(root);
  }

  addRoot(root: string): void {
    const entry = this.normalizeRoot(root);
    if (entry) this.roots.set(entry.key, entry.resolved);
  }

  removeRoot(root: string): void {
    const entry = this.normalizeRoot(root);
    if (entry) this.roots.delete(entry.key);
  }

  getRoots(): string[] {
    return [...this.roots.values()];
  }

  resolveAllowedPath(candidatePath: string): string | null {
    if (isInvalidPathInput(candidatePath)) return null;
    for (const root of this.roots.values()) {
      const pathApi = resolvePathApi(this.platform, root);
      const effectivePlatform: PathPlatform = pathApi === win32 ? "win32" : "posix";
      if (!isPathInside(root, candidatePath, effectivePlatform)) continue;
      return pathApi === win32
        ? win32.resolve(stripWindowsDevicePrefix(candidatePath))
        : posix.resolve(candidatePath);
    }
    return null;
  }

  allows(path: string): boolean {
    return this.resolveAllowedPath(path) !== null;
  }
}
