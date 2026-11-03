/**
 * Tauri IPC argument contract between `src/tauri/bridge.ts` and `src-tauri/src/commands.rs`.
 *
 * Tauri v2 resolves every command parameter by name from the invoke payload
 * (`CommandArg::from_command` deserializes the value at the parameter's camelCase key, and
 * errors if that key is absent). A call site whose object keys do not match the Rust
 * parameter names therefore fails on EVERY call while looking perfectly plausible in
 * review — exactly how `cmd_history_add` shipped broken: the Rust side took a single
 * struct parameter named `args`, the bridge sent the fields flat, every history write
 * rejected, and listening history never reached SQLite (it "disappeared" on restart
 * because only the in-memory optimistic rows ever existed).
 *
 * This test pins the contract statically for every command: Rust parameter names (with
 * struct-typed parameters expanded to their fields) must match the invoke payload keys.
 * It also pins that every command is registered in the Tauri invoke handler, since an
 * unregistered command fails identically.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const commandsRs = readFileSync(resolve(root, "src-tauri/src/commands.rs"), "utf8");
const libRs = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");
const bridgeTs = readFileSync(resolve(root, "src/tauri/bridge.ts"), "utf8");

const toCamel = (snake: string) => snake.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());

/** Types Tauri injects itself; they never come from the invoke payload. */
const INJECTED_TYPE = /^(State|AppHandle|WebviewWindow|Window|Webview|tauri::ipc::Request)/;

/** Struct params whose fields arrive nested under the parameter name, e.g. `{ args: { ... } }`. */
interface RustCommand {
  name: string;
  /** Flat payload keys expected at the top level of the invoke object. */
  flatKeys: string[];
  /** paramKey -> expected keys inside the nested object (struct-typed parameters). */
  nestedKeys: Record<string, string[]>;
}

/** Fields of a struct defined in commands.rs, or null when the type is not a local struct. */
function parseStructFields(structName: string): string[] | null {
  const pattern = new RegExp(`(?:pub )?struct ${structName} \\{([\\s\\S]*?)\\n\\}`);
  const match = pattern.exec(commandsRs);
  if (!match) return null;
  return [...match[1].matchAll(/(?:pub )?(\w+):/g)].map(m => toCamel(m[1]));
}

function parseRustCommands(): RustCommand[] {
  const commands: RustCommand[] = [];
  const fnPattern = /pub (?:async )?fn (cmd_\w+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
  for (const match of commandsRs.matchAll(fnPattern)) {
    const [, name, rawParams] = match;
    const flatKeys: string[] = [];
    const nestedKeys: Record<string, string[]> = {};
    // Split params on top-level commas (generics like State<'_, AppState> contain commas).
    const params: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of rawParams) {
      if (ch === "<" || ch === "(") depth += 1;
      if (ch === ">" || ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        params.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) params.push(current);

    for (const param of params) {
      const trimmed = param.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(":");
      if (colon === -1) continue; // e.g. a bare `window: WebviewWindow` is handled by type check below
      const paramName = trimmed.slice(0, colon).trim().replace(/^mut\s+/, "");
      const paramType = trimmed.slice(colon + 1).trim();
      if (INJECTED_TYPE.test(paramType)) continue;
      const key = toCamel(paramName);
      const structMatch = /^([A-Z]\w+)$/.exec(paramType);
      const fields = structMatch ? parseStructFields(structMatch[1]) : null;
      if (fields) {
        nestedKeys[key] = fields;
      } else {
        flatKeys.push(key);
      }
    }
    commands.push({ name, flatKeys, nestedKeys });
  }
  return commands;
}

/** Scan past a JS value starting at `start`; returns the index just past it. String-aware
 *  and nesting-aware (braces/brackets/parens). Stops at a top-level comma or closing brace. */
function skipValue(source: string, start: number): number {
  let i = start;
  let depth = 0;
  let inString: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return i;
    }
    i += 1;
  }
  return i;
}

/** Extract the top-level keys of the object literal starting at `start` (index of `{`). */
function objectKeys(source: string, start: number): { keys: string[]; nested: Record<string, string[]> } {
  const keys: string[] = [];
  const nested: Record<string, string[]> = {};
  let i = start + 1;
  while (i < source.length) {
    // Skip whitespace and separators between properties.
    while (i < source.length && /[\s,]/.test(source[i])) i += 1;
    if (i >= source.length || source[i] === "}") break;
    // Read the key token up to `:` (keyed) or `,`/`}` (shorthand).
    let token = "";
    let inString: string | null = null;
    while (i < source.length) {
      const ch = source[i];
      if (inString) {
        if (ch === "\\") i += 1;
        else if (ch === inString) inString = null;
        token += ch;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        token += ch;
        i += 1;
        continue;
      }
      if (ch === ":" || ch === "," || ch === "}") break;
      token += ch;
      i += 1;
    }
    const key = token.trim().replace(/["']/g, "");
    if (key) keys.push(key);
    if (source[i] === ":") {
      i += 1;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (source[i] === "{" && key) nested[key] = objectKeys(source, i).keys;
      i = skipValue(source, i);
    }
  }
  return { keys, nested };
}

interface InvokeCall {
  command: string;
  keys: string[];
  nested: Record<string, string[]>;
  /** True when the invoke passes a raw (non-object) body, like cmd_save_artwork. */
  rawBody: boolean;
}

function parseInvokeCalls(): InvokeCall[] {
  const calls: InvokeCall[] = [];
  const invokePattern = /invoke(?:<[^>]*>)?\(\s*"((?:cmd_|plugin:)[^"]+)"/g;
  for (const match of bridgeTs.matchAll(invokePattern)) {
    const command = match[1];
    let i = match.index + match[0].length;
    while (i < bridgeTs.length && /[\s,]/.test(bridgeTs[i])) i += 1;
    if (bridgeTs[i] === "{") {
      const { keys, nested } = objectKeys(bridgeTs, i);
      calls.push({ command, keys, nested, rawBody: false });
    } else if (bridgeTs[i] === ")") {
      calls.push({ command, keys: [], nested: {}, rawBody: false });
    } else {
      calls.push({ command, keys: [], nested: {}, rawBody: true });
    }
  }
  return calls;
}

const rustCommands = parseRustCommands();
const invokeCalls = parseInvokeCalls();
const rustByName = new Map(rustCommands.map(c => [c.name, c]));

/** Raw-body invocation (Tauri `Request` param): payload keys do not apply. */
const RAW_BODY_COMMANDS = new Set(["cmd_save_artwork"]);

describe("tauri IPC argument contract", () => {
  it("finds the command surface on both sides", () => {
    expect(rustCommands.length).toBeGreaterThan(20);
    expect(invokeCalls.length).toBeGreaterThan(20);
  });

  it("registers every Rust command in the invoke handler", () => {
    for (const command of rustCommands) {
      expect(libRs, `${command.name} must appear in lib.rs generate_handler!`).toContain(
        `commands::${command.name}`,
      );
    }
  });

  it("every invoked app command exists in Rust with matching argument keys", () => {
    for (const call of invokeCalls) {
      if (call.command.startsWith("plugin:")) continue;
      const rust = rustByName.get(call.command);
      expect(rust, `${call.command} invoked from bridge.ts but not defined in commands.rs`).toBeDefined();
      if (!rust) continue;
      if (RAW_BODY_COMMANDS.has(call.command)) {
        expect(call.rawBody, `${call.command} should use the raw-body invoke form`).toBe(true);
        continue;
      }
      const expectedTop = [...rust.flatKeys, ...Object.keys(rust.nestedKeys)].sort();
      expect(
        [...call.keys].sort(),
        `${call.command}: invoke keys [${call.keys}] must equal Rust parameter keys [${expectedTop}] ` +
          `(Tauri resolves each parameter by name; a mismatch rejects every call)`,
      ).toEqual(expectedTop);
      for (const [paramKey, fields] of Object.entries(rust.nestedKeys)) {
        expect(
          [...(call.nested[paramKey] ?? [])].sort(),
          `${call.command}: nested "${paramKey}" fields must equal the Rust struct fields [${fields}]`,
        ).toEqual([...fields].sort());
      }
    }
  });

  it("pins the history write contract that regressed (flat keys, no wrapper)", () => {
    const rust = rustByName.get("cmd_history_add");
    expect(rust).toBeDefined();
    expect(rust?.flatKeys.sort()).toEqual([
      "canonicalUrl",
      "payload",
      "playedAt",
      "remoteId",
      "sourceKind",
      "trackId",
    ]);
    expect(rust?.nestedKeys).toEqual({});
    const call = invokeCalls.find(c => c.command === "cmd_history_add");
    expect(call?.keys.sort()).toEqual([
      "canonicalUrl",
      "payload",
      "playedAt",
      "remoteId",
      "sourceKind",
      "trackId",
    ]);
  });
});
