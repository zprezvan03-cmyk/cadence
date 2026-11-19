# Desktop UI restructuring

## Browsing and playback

- Library expands to Recently Added, Artists, Albums and Songs. Playlists expands to the collection, named playlists and New playlist. Liked songs stays a direct destination. Search and scan/lyrics-fetch status live in the sidebar. Back and Forward live in the integrated Windows title bar; when the OS draws the frame, they fall back to the sidebar. Add folder lives in the Library heading. The native window strip stays separate on Windows.
- Home uses single-row artwork shelves for Explore, Your top tracks and On repeat. Album browsing and playback are separate actions. Top Tracks plays its ranked queue; On Repeat uses the last 14 days and plays the selected track without replacing the queue.
- Now Playing opens from the full-width player bar. It is a presentation of the current playback, not an entry in the browsing history. Escape closes the queue first, then Now Playing. F11 and the native View menu use OS fullscreen; normal entry does not resize the window. Mini artwork opens Now Playing, while Restore leaves the current browse route in place.
- Lyrics On keeps the timed renderer and lyrics tools. Lyrics Off offers artwork, track details and transport, with no lyrics dock. Switching modes keeps the same audio element and Braccato host. Empty, loading and failed lookups leave the mode controls and Exit available.

## Profiles and motion

**Settings → Appearance → Now Playing → Customize** opens the editor with a scaled preview of the real layout. Lyrics On and Off have independent content, appearance and profile selection. Built-in presets are protected; duplicate one to edit it. The draft is separate from saved settings until Save & apply. The desktop bridge serializes settings writes and reports a failed write rather than applying the draft.

The saved profile format stays additive at v1. Its `fullscreen` configuration is Lyrics On. Old profiles get an independent `lyricsOff` configuration based on their normalized fullscreen values, and older settings inherit the former effective fullscreen profile for Lyrics Off. The windowed layout and context choices remain available for existing `#/lyrics` links and saved profiles.

Timed lyric animations use the pinned Braccato defaults for follow, fades, scale, word effects and instrumental motion. The renderer adds no alternate timing clock. Artwork, metadata and transport still hand off between live slots rather than animating duplicate players.

## Settings

**Settings → Lyrics** groups fetching, timing, fonts and themes, AI Translation, AI Romanization, and provider order. Appearance keeps app-wide visual options, shaders and the Now Playing editor. Settings remembers the selected category and its own scroll position while you browse. The offline lyrics recovery link opens Lyrics at the online-fetch switch, even if you previously scrolled much farther down the panel.

Existing preferences keep the same keys and values. In particular, AI configurations are independent and disabled providers still keep their position in the saved order. **Reset all** is at the bottom of **About**. Cancel leaves current and saved settings alone; confirm restores the defaults, including playback preferences and Now Playing profiles. Clearing the lyrics cache is a separate action.

## Verification

Type checking and the production renderer build passed. Browser checks use real local audio and the production UI with a simulated Tauri bridge.

| Check | Result |
| --- | ---: |
| Offline unit tests | 621/621 |
| Extended renderer audit | 285 passed, 0 failed, 4 blocked, 3 not tested |
| Now Playing and Customization Studio | 150/150 |
| Braccato and playback motion | 116/116 |
| Lyrics decorations | 43/43 |
| History, Stats and library persistence | 27/27 |
| Lyrics cache and settings reset | 15/15 |
| Audio engine | 11/11 |

The extended audit covers sidebar destinations, playlist actions, playback settings, queue behavior, offline recovery, provider priority during playback, and the separate AI Translation and Romanization controls. The cache suite confirmed **Reset all** writes the default preferences while leaving a populated `lyrics-cache.json` byte-for-byte unchanged. **Clear lyrics cache** still removes the entries and reports a failed write without changing the on-disk cache.

Visual checks at **1440×900** and **1040×680** covered the sidebar disclosures, one-row Home shelves, Lyrics and About settings, both Now Playing modes, and both editor previews. They also checked that closing Now Playing reveals the same browse route and scroll position, and that Settings actions fit on one line at the minimum window size.

During the Settings split, the audit reproduced two earlier provider-order failures. The Fetch All fixture lacked the `promote` bridge method called by Autofetch during playback, which aborted the first settings write. The fixture now supplies the method and the audit fails on unhandled renderer errors. Provider moves, removal and re-addition are also tested with a real settings file.

See the [test commands in the README](../README.md#tests). After `npm run test:ui` builds the bundle and library fixtures, run `node tests/browser/audit-ui.mjs` for the extended interaction audit. Run `npm run test:cache:clear` for the disk-backed cache checks. The offline unit suite excludes `_matasaburo_full.test.ts`, which needs a private local fixture and live AI access.

### Native verification still needed

`npm run build:desktop -- --no-bundle` stopped before compilation because `cargo` was not installed in the verification environment. On Windows, verify F11 and the OS fullscreen exit, Mini window resizing and restore, a profile save followed by a fresh launch, the native filesystem dialogs, and SMTC and physical media-key delivery from an installed build. Chromium's simulated bridge and software WebGL do not verify those behaviors, live lyrics/AI provider connections, the installer and its shortcut registration, or hardware GPU/RAM and long-running performance.
