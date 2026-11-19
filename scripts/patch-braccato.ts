import { readFileSync } from "node:fs";
import { applyPatch, parsePatch } from "diff";
import type { Plugin } from "vite";

/** Apply the pinned paint-only patch in dev and production without modifying node_modules. */
export function patchBraccato(): Plugin {
  const source = new URL("../vendor/braccato-core/1.16.11-paint.patch", import.meta.url);
  const patches = new Map(parsePatch(readFileSync(source, "utf8")).map(patch => [patch.newFileName, patch]));
  return {
    name: "cadence:braccato-paint",
    enforce: "pre",
    // Prebundling would hide the two modules from the dev transform hook.
    config: () => ({ optimizeDeps: { exclude: ["@braccato/core"] } }),
    transform(code, id) {
      const file = id.split("?", 1)[0].match(/\/node_modules\/@braccato\/core\/(dist\/(?:engine|text)\.js)$/)?.[1];
      if (!file) return;
      const patch = patches.get(`b/${file}`);
      const patched = patch && applyPatch(code, patch);
      if (typeof patched !== "string") {
        this.error(`Braccato paint patch did not apply to ${file}. Recheck 1.16.11-paint.patch before updating Braccato.`);
      }
      return { code: patched, map: null };
    },
  };
}
