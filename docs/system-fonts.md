# System font selector

**Status:** implemented in `src-tauri/src/fonts.rs` (host), `src/shared/fonts.ts` (ids + stacks),
`src/renderer/state/fontsStore.ts` (cache), `src/renderer/app/fonts.ts` (application) and the
pickers in `SettingsView.tsx` / `CustomizationStudio.tsx`.

The font list is never hard-coded: the Tauri host enumerates the fonts the operating system has
installed and the renderer turns that into the picker. A font installed after the build is
selectable without a code change.

## How a font is identified

A font id is one of:

| id | meaning |
| --- | --- |
| `system` | **System default.** The app shell uses the platform's UI face (`system-ui` → Segoe UI / SF / the desktop's sans); the lyrics renderer uses Better Lyrics' default stack (Satoshi Variable, bundled → Noto Sans → platform). |
| `monospace` | The generic monospace preset. |
| anything else | The exact family name of an installed font, e.g. `Georgia` or `Noto Sans CJK JP`. |

`normalizeFontId` (shared) trims, refuses non-strings, control characters and names longer than
120 characters, and migrates the ids written by builds that shipped a fixed list (`segoe-ui` →
`Segoe UI`, `georgia` → `Georgia`, `noto-sans` → `Noto Sans`, …; see `LEGACY_FONT_PRESETS`).

Every stack `fontStack(id)` produces ends in a generic family, so a saved font that is no longer
installed still renders — the browser walks the stack and lands on `sans-serif`. The setting is
**not** silently changed when the font is missing: the picker keeps the id selected, shows it
labelled "(not installed)" with a hint, and the user can pick another font or reinstall it.

## Enumeration per platform (`src-tauri/src/fonts.rs`)

| Platform | Source |
| --- | --- |
| Windows | `%WINDIR%\Fonts` (per-machine installs) and `%LOCALAPPDATA%\Microsoft\Windows\Fonts` (per-user installs, Windows 10 1809+). |
| macOS | `/System/Library/Fonts`, `/System/Library/Fonts/Supplemental`, `/Library/Fonts`, `~/Library/Fonts`. |
| Linux / other | `fc-list --format=%{file}` (fontconfig's own database — honours every `<dir>` in `fonts.conf`) plus a directory scan of `~/.local/share/fonts`, `~/.fonts`, `/usr/share/fonts*`, `/usr/local/share/fonts` and `XDG_DATA_DIRS` when `fc-list` is missing. |

Files are filtered by extension (`ttf`, `otf`, `ttc`, `otc`) and the family is read from the font
itself — the sfnt `name` table, including every face in a collection — never from the file name.
The typographic family/subfamily (name IDs 16/17) is preferred over the legacy pair (1/2), which
keeps "Arial" + "Bold" apart instead of "Arial Bold". A font that carries localized names yields
its Windows en-US record, so Japanese/Chinese faces appear under the name every font picker uses.
Families are merged case-insensitively and returned sorted, with the styles found for each.

The scan reads only the table directory and the `name` table of each file (never the whole file),
bounds file size (128 MiB), table size (1 MiB), directory depth (10) and the family length, and
runs on the blocking pool (`spawn_blocking`) so the webview never stalls.

## Persistence

The id lives in `settings.appearance.fontFamily` through the regular settings store, so it is
saved on every change and read back on the next launch (`normalizeSettings` runs the same
`normalizeFontId`). Profiles can override the font per Now Playing layout (`fontId`,
`translationFontId`, `romanizationFontId`; empty = inherit the app font).

## Applying it

`useBootstrap` subscribes to the settings store and calls `applyFontFamily` on every change: it
writes `--font` (shell) and `--blyrics-font-family` (lyrics renderer) on `<html>`, so every surface
in the app — settings, library, Now Playing, mini player — follows the one setting. A Now Playing
profile font is set on the lyrics container, which is a descendant and therefore wins there.

## Refreshing

`useSystemFonts.load()` caches the list for the session. The Settings view refreshes on first
open, on **Refresh**, and when the window regains focus (at most once every 30 s — a scan reads
hundreds of files). The Customization Studio loads the list when a font row mounts.

## Graceful degradation

* No Tauri host (browser harness, web build) or the command fails → the store falls back to
  `FALLBACK_FONT_FAMILIES` (well-known families) and shows the error in the picker; the two
  presets always work.
* Empty result (no fonts found / unusual platform) → only `system` and `monospace` are listed.
* Corrupt ids in the settings file → normalized to `system`.

## Verification

* `tests/unit/fonts.test.ts` — id normalization and legacy migration, stacks, payload merging,
  settings persistence across a restart, corrupt ids.
* `tests/unit/nowPlayingProfiles.test.ts` — profile font ids accept real family names.
* `tests/unit/ipcContract.test.ts` — the command is registered and its argument contract holds.
* `tests/browser/audit-ui.mjs` (`expanded-appearance-controls-completes`, `font-applies-globally`)
  and `provider-identity.ts` — every option persists, the preview renders the chosen stack, reset
  restores the default.
* `src-tauri/src/fonts.rs` has unit tests for the `name`-table parser (typographic/legacy, English
  vs. localized names, collections, junk files). **They have not been compiled in the sandbox used
  to write this feature — no Rust toolchain was available; run `cargo test` on a machine with one.**

## Known limitations

* Fonts registered outside the standard directories (a Windows registry entry pointing at a
  custom folder, macOS "downloadable" fonts in `/System/Library/AssetsV2`) are not enumerated.
* Styles are reported for information only; the picker selects a family and the browser picks the
  weight/synthesizes it.
* WOFF/WOFF2 is not an installed-font format on any supported platform and is skipped.
