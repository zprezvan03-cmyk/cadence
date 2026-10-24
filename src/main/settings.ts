/**
 * Cadence settings persistence (Node filesystem adapter over `SettingsCore`).
 * Written for Cadence; shader defaults come from the ported upstream `DEFAULT_GRADIENT_SETTINGS`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings, DeepPartial } from "../shared/types";
import { DEFAULT_SETTINGS, SettingsCore } from "./settingsCore";

export { DEFAULT_SETTINGS };

export class SettingsStore {
  private readonly core: SettingsCore;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    let initialJson: string | null = null;
    if (existsSync(filePath)) {
      try {
        initialJson = readFileSync(filePath, "utf8");
      } catch (error) {
        console.warn("[Cadence] Settings file is unreadable, using defaults:", error);
      }
    }
    this.core = new SettingsCore({
      initialJson,
      persist: json => {
        const temporary = `${this.filePath}.tmp`;
        writeFileSync(temporary, json);
        renameSync(temporary, this.filePath);
      },
    });
  }

  get(): AppSettings {
    return this.core.get();
  }

  patch(patch: DeepPartial<AppSettings>): AppSettings {
    return this.core.patch(patch);
  }

  reset(): AppSettings {
    return this.core.reset();
  }

  save(): void {
    this.core.save();
  }
}
