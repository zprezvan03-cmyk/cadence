/**
 * Directories the media protocol may serve from. Kept free of Electron imports so the scanner,
 * the IPC layer and the automated tests can all use the same check. Written for Cadence.
 */

import { resolve } from "node:path";

/** Closed set of directories the protocol will serve from. */
export class MediaAllowlist {
  private roots = new Set<string>();

  setRoots(roots: string[]): void {
    this.roots = new Set(roots.map(root => resolve(root)));
  }

  addRoot(root: string): void {
    this.roots.add(resolve(root));
  }

  removeRoot(root: string): void {
    this.roots.delete(resolve(root));
  }

  getRoots(): string[] {
    return [...this.roots];
  }

  allows(path: string): boolean {
    const normalized = resolve(path);
    for (const root of this.roots) {
      if (normalized === root) return true;
      if (normalized.startsWith(root.endsWith("/") ? root : root + "/")) return true;
    }
    return false;
  }
}
