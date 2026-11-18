# Desktop UI restructuring

## Browsing and playback

- Library expands to Recently Added, Artists, Albums and Songs. Playlists expands to the collection, named playlists and New playlist. Liked songs stays a direct destination. Back, Forward, search, Add music and scan/lyrics-fetch status live in the sidebar, not in a second toolbar. The native window strip stays separate on Windows.
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

The production renderer passed the following checks with real local audio and a simulated Tauri bridge:

| Check | Result |
| --- | ---: |
| Offline unit tests | 621/621 |
| Now Playing and Customization Studio | 150/150 |
| Production UI | 150/150 |
| Braccato and playback motion | 113/113 |

The Now Playing suite covers mode changes without a playback restart, browse history and focus, simulated native exits and pending F11 requests, independent drafts, a rejected save and retry, and legacy layouts. Eight visual checks covered the two modes and their editor previews at 1440×900 and 1040×680, with no layout issues observed. Type checking and the production web build also passed.

During the Settings split, the extended audit reproduced two earlier provider-order failures. Its Fetch All fixture was missing the `promote` bridge method called by Autofetch during playback, which aborted the first settings write. The fixture now supplies the method and the audit fails on unhandled renderer errors. Provider moves, removal and re-addition are also tested with a real settings file.

See the [test commands in the README](../README.md#tests). After `npm run test:ui` builds the bundle and library fixtures, run `node tests/browser/audit-ui.mjs` for the extended interaction audit. The offline suite excludes `_matasaburo_full.test.ts`, which needs a private local fixture and live AI access.

The audit harness stubs the native bridge. On a desktop host, verify F11 and the OS fullscreen exit, Mini window resizing and restore, and a profile save followed by a fresh launch. Actual window chrome, dialogs, physical media keys and GPU performance are not covered by the Chromium runs.
