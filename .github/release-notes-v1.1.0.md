> **Beta / pre-release.** This build is for testing — v1.0.0 remains the latest stable release. This beta ships the portable ZIP and standalone executable only; NSIS/MSI installers are not included.

## What's new in 1.1.0

- **Playback and library:** dual-deck playback engine, equalizer and ReplayGain, listening statistics and discovery shelves, metadata/artwork editing, smart playlists and duplicate tools, history persistence.
- **Desktop integration:** system tray, mini-player, keyboard shortcuts, and Last.fm scrobbling.
- **Lyrics and customization:** Now Playing profiles, customization studio, animation/karaoke/background options, configurable AI translation and romanization, language analysis, provider/model settings, caching and Thinking Modes.
- **Translation and export:** an explicit Local translation source that never calls or falls back to AI, plus TTML export. Romanization is line-level only; word/syllable lyric timing is retained.
- **Quality and delivery:** Windows build workflow and extensive unit/browser-harness coverage. All version metadata and client User-Agent strings now report 1.1.0.

The YouTube catalog/IFrame experiment and the graphite UI redesign were reverted or removed and are **not** part of this release.

## Downloads (Windows x64, requires Edge WebView2 Runtime)

| Asset | Description |
| --- | --- |
| `Cadence-1.1.0-win-x64-portable.zip` | Portable build: `Cadence.exe` + `LICENSE`, `UPSTREAM.md`, `README.md`. Unzip and run — no installer or admin rights needed. |
| `Cadence-1.1.0-win-x64.exe` | Standalone executable, for users who only need the binary. |
| `SHA256SUMS.txt` | SHA-256 checksums for both files. |

The build is unsigned, so Windows SmartScreen may show "Unknown publisher" (*More info → Run anyway*).

## Verification

- `npm run typecheck` clean; `npm test`: 37 test files, **470/470 tests passing**.
- Binaries compiled by the [Windows build workflow](https://github.com/zprezvan03-cmyk/cadence/actions/runs/42383136006) from the v1.1.0 sources; the embedded User-Agent reports `Cadence Player v1.1.0`.
- Source tag points at `main` after merging PR #21 (version bump).

**Full Changelog**: https://github.com/zprezvan03-cmyk/cadence/compare/v1.0.0...v1.1.0
