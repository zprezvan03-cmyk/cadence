/**
 * Directories the media protocol may serve from, plus cross-platform path containment helpers.
 * Kept free of Node- or desktop-runtime-specific imports so the scanner, the Tauri bridge, the
 * protocol handler and the automated tests all share the exact same check. Written for Cadence.
 */

export type PathPlatform = "win32" | "posix";

export interface SimplePlatformPath {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  join(...paths: string[]): string;
}

function getNodeProcess(): { cwd?: () => string; platform?: string } | undefined {
  return (globalThis as { process?: { cwd?: () => string; platform?: string } }).process;
}

const WINDOWS_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\\\\\?\\)/;
const WINDOWS_DRIVE_RELATIVE_PATTERN = /^[a-zA-Z]:(?![\\/])/;
const WINDOWS_DRIVE_ABS_PATTERN = /^([a-zA-Z]):(?:[\\/](.*))?$/;
const WINDOWS_UNC_PATTERN = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/;

export function stripWindowsDevicePrefix(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\") || value.startsWith("\\\\?\\unc\\")) {
    return "\\\\" + value.slice(8);
  }
  if (value.startsWith("\\\\?\\")) {
    return value.slice(4);
  }
  return value;
}

function normalizeSegments(rawSegments: string[]): string[] {
  const stack: string[] = [];
  for (const segment of rawSegments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack;
}

function parseWin32Root(input: string): { root: string; rest: string } | null {
  const unc = WINDOWS_UNC_PATTERN.exec(input);
  if (unc) {
    return {
      root: `\\\\${unc[1]}\\${unc[2]}\\`,
      rest: unc[3] ?? "",
    };
  }
  const drive = WINDOWS_DRIVE_ABS_PATTERN.exec(input);
  if (drive) {
    return {
      root: `${drive[1]}:\\`,
      rest: drive[2] ?? "",
    };
  }
  return null;
}

export const win32Path: SimplePlatformPath = {
  sep: "\\",

  isAbsolute(path: string): boolean {
    if (!path) return false;
    const stripped = stripWindowsDevicePrefix(path);
    return (
      WINDOWS_UNC_PATTERN.test(stripped) ||
      /^[a-zA-Z]:[\\/]/.test(stripped) ||
      /^[\\/]/.test(stripped)
    );
  },

  resolve(...paths: string[]): string {
    let resolvedRoot = "";
    let resolvedTail = "";

    for (let i = paths.length - 1; i >= 0; i--) {
      const raw = paths[i];
      if (!raw) continue;
      const part = stripWindowsDevicePrefix(raw);
      const parsed = parseWin32Root(part);

      if (parsed) {
        if (!resolvedRoot) {
          resolvedRoot = parsed.root;
          resolvedTail = `${parsed.rest}\\${resolvedTail}`;
          break;
        }
        if (parsed.root.toLowerCase() === resolvedRoot.toLowerCase()) {
          resolvedTail = `${parsed.rest}\\${resolvedTail}`;
          break;
        }
        continue;
      }

      if (/^[\\/]/.test(part)) {
        // Rooted on current drive (e.g. `\Windows\win.ini`): keep scanning left only for a drive root.
        resolvedTail = `${part.replace(/^[\\/]+/, "")}\\${resolvedTail}`;
        for (let j = i - 1; j >= 0; j--) {
          const earlier = stripWindowsDevicePrefix(paths[j] || "");
          const earlierRoot = parseWin32Root(earlier);
          if (earlierRoot) {
            resolvedRoot = earlierRoot.root;
            break;
          }
        }
        break;
      }

      resolvedTail = resolvedTail ? `${part}\\${resolvedTail}` : part;
    }

    if (!resolvedRoot) {
      const proc = getNodeProcess();
      const cwd = typeof proc?.cwd === "function" ? proc.cwd() : "C:\\";
      const cwdParsed = parseWin32Root(stripWindowsDevicePrefix(cwd));
      resolvedRoot = cwdParsed ? cwdParsed.root : "C:\\";
      if (cwdParsed) {
        resolvedTail = `${cwdParsed.rest}\\${resolvedTail}`;
      }
    }

    const parts = normalizeSegments(resolvedTail.split(/[\\/]+/));
    if (parts.length === 0) {
      // UNC roots normally omit trailing backslash unless at share root; drive roots keep `C:\`.
      return WINDOWS_UNC_PATTERN.test(resolvedRoot.replace(/\\$/, ""))
        ? resolvedRoot.replace(/\\$/, "")
        : resolvedRoot;
    }
    const prefix = resolvedRoot.endsWith("\\") ? resolvedRoot : `${resolvedRoot}\\`;
    return `${prefix}${parts.join("\\")}`;
  },

  relative(from: string, to: string): string {
    const resolvedFrom = win32Path.resolve(from);
    const resolvedTo = win32Path.resolve(to);
    if (resolvedFrom.toLowerCase() === resolvedTo.toLowerCase()) return "";

    const parsedFrom = parseWin32Root(resolvedFrom);
    const parsedTo = parseWin32Root(resolvedTo);
    if (!parsedFrom || !parsedTo || parsedFrom.root.toLowerCase() !== parsedTo.root.toLowerCase()) {
      return resolvedTo;
    }

    const fromParts = parsedFrom.rest ? parsedFrom.rest.split("\\").filter(Boolean) : [];
    const toParts = parsedTo.rest ? parsedTo.rest.split("\\").filter(Boolean) : [];

    let common = 0;
    const limit = Math.min(fromParts.length, toParts.length);
    while (common < limit && fromParts[common].toLowerCase() === toParts[common].toLowerCase()) {
      common++;
    }

    const up = new Array<string>(fromParts.length - common).fill("..");
    return [...up, ...toParts.slice(common)].join("\\");
  },

  join(...paths: string[]): string {
    const nonEmpty = paths.filter(Boolean);
    if (nonEmpty.length === 0) return ".";
    const joined = nonEmpty.join("\\");
    const parsed = parseWin32Root(stripWindowsDevicePrefix(joined));
    if (parsed) return win32Path.resolve(joined);
    const leadingSlash = /^[\\/]/.test(joined);
    const parts = normalizeSegments(joined.split(/[\\/]+/));
    const body = parts.join("\\");
    if (leadingSlash) return `\\${body}`;
    return body || ".";
  },
};

export const posixPath: SimplePlatformPath = {
  sep: "/",

  isAbsolute(path: string): boolean {
    return path.startsWith("/");
  },

  resolve(...paths: string[]): string {
    let resolved = "";
    let absolute = false;

    for (let i = paths.length - 1; i >= 0 && !absolute; i--) {
      const part = paths[i];
      if (!part) continue;
      resolved = resolved ? `${part}/${resolved}` : part;
      absolute = part.startsWith("/");
    }

    if (!absolute) {
      const proc = getNodeProcess();
      const cwd = typeof proc?.cwd === "function" ? proc.cwd() : "/";
      resolved = resolved ? `${cwd}/${resolved}` : cwd;
    }

    const parts = normalizeSegments(resolved.split(/\/+/));
    return `/${parts.join("/")}`;
  },

  relative(from: string, to: string): string {
    const resolvedFrom = posixPath.resolve(from);
    const resolvedTo = posixPath.resolve(to);
    if (resolvedFrom === resolvedTo) return "";

    const fromParts = resolvedFrom.split("/").filter(Boolean);
    const toParts = resolvedTo.split("/").filter(Boolean);

    let common = 0;
    const limit = Math.min(fromParts.length, toParts.length);
    while (common < limit && fromParts[common] === toParts[common]) {
      common++;
    }

    const up = new Array<string>(fromParts.length - common).fill("..");
    return [...up, ...toParts.slice(common)].join("/");
  },

  join(...paths: string[]): string {
    const nonEmpty = paths.filter(Boolean);
    if (nonEmpty.length === 0) return ".";
    const joined = nonEmpty.join("/");
    if (joined.startsWith("/")) return posixPath.resolve(joined);
    const parts = normalizeSegments(joined.split(/\/+/));
    return parts.join("/") || ".";
  },
};

export function detectRuntimePlatform(): PathPlatform {
  const proc = getNodeProcess();
  if (typeof proc?.platform === "string") {
    return proc.platform === "win32" ? "win32" : "posix";
  }
  if (typeof navigator !== "undefined" && /win/i.test(navigator.userAgent)) {
    return "win32";
  }
  return "posix";
}

export function resolvePathApi(platform?: PathPlatform, samplePath?: string): SimplePlatformPath {
  if (platform === "win32") return win32Path;
  if (platform === "posix") return posixPath;
  if (detectRuntimePlatform() === "win32") return win32Path;
  if (samplePath && WINDOWS_PATH_PATTERN.test(samplePath)) return win32Path;
  return posixPath;
}

function isInvalidPathInput(value: string): boolean {
  return !value || value.includes("\0");
}

function isRelativeContained(rel: string, pathApi: SimplePlatformPath): boolean {
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

/**
 * Returns true when `candidatePath` resolves to `rootDir` itself or a descendant inside `rootDir`,
 * using the appropriate `win32` or `posix` path semantics.
 */
export function isPathInside(rootDir: string, candidatePath: string, platform?: PathPlatform): boolean {
  if (isInvalidPathInput(rootDir) || isInvalidPathInput(candidatePath)) return false;

  const pathApi = resolvePathApi(platform, rootDir);
  if (pathApi === win32Path) {
    if (WINDOWS_DRIVE_RELATIVE_PATTERN.test(rootDir) || WINDOWS_DRIVE_RELATIVE_PATTERN.test(candidatePath)) {
      return false;
    }
    const resolvedRoot = win32Path.resolve(stripWindowsDevicePrefix(rootDir));
    const resolvedCandidate = win32Path.resolve(stripWindowsDevicePrefix(candidatePath));
    return isRelativeContained(win32Path.relative(resolvedRoot, resolvedCandidate), win32Path);
  }

  const resolvedRoot = posixPath.resolve(rootDir);
  const resolvedCandidate = posixPath.resolve(candidatePath);
  return isRelativeContained(posixPath.relative(resolvedRoot, resolvedCandidate), posixPath);
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
  if (pathApi === win32Path) {
    if (WINDOWS_DRIVE_RELATIVE_PATTERN.test(rootDir) || WINDOWS_DRIVE_RELATIVE_PATTERN.test(targetPath)) {
      return null;
    }
    const resolvedRoot = win32Path.resolve(stripWindowsDevicePrefix(rootDir));
    const resolvedTarget = win32Path.resolve(resolvedRoot, stripWindowsDevicePrefix(targetPath));
    return isRelativeContained(win32Path.relative(resolvedRoot, resolvedTarget), win32Path) ? resolvedTarget : null;
  }

  const resolvedRoot = posixPath.resolve(rootDir);
  const resolvedTarget = posixPath.resolve(resolvedRoot, targetPath);
  return isRelativeContained(posixPath.relative(resolvedRoot, resolvedTarget), posixPath) ? resolvedTarget : null;
}

/** Closed set of directories the protocol will serve from. */
export class MediaAllowlist {
  private roots = new Map<string, string>();

  constructor(private readonly platform?: PathPlatform) {}

  private normalizeRoot(root: string): { key: string; resolved: string } | null {
    if (isInvalidPathInput(root)) return null;
    const pathApi = resolvePathApi(this.platform, root);
    if (pathApi === win32Path) {
      if (WINDOWS_DRIVE_RELATIVE_PATTERN.test(root)) return null;
      const resolved = win32Path.resolve(stripWindowsDevicePrefix(root));
      return { key: `win32:${resolved.toLowerCase()}`, resolved };
    }
    const resolved = posixPath.resolve(root);
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
      const effectivePlatform: PathPlatform = pathApi === win32Path ? "win32" : "posix";
      if (!isPathInside(root, candidatePath, effectivePlatform)) continue;
      return pathApi === win32Path
        ? win32Path.resolve(stripWindowsDevicePrefix(candidatePath))
        : posixPath.resolve(candidatePath);
    }
    return null;
  }

  allows(path: string): boolean {
    return this.resolveAllowedPath(path) !== null;
  }
}
