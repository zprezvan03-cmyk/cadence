# Cadence — Premium UI Animation Pass

A release-ready motion pass over the whole player: one timing scale, a sliding navigation
indicator, view transitions that keep their page state, a settled player bar, animated overlays and
a fullscreen Now Playing that fades in instead of cutting. Everything is CSS (`transform` /
`opacity`, no per-frame JavaScript) and no animation dependency was added — the project has none
installed, and a library would have been a large dependency for what the platform already does.

The work was verified against the **production bundle running in headless Chromium**, not by
reading source: a new harness drives the real UI and asks the browser which animations it is
actually running, then holds those animations at 110 ms to capture true intermediate frames.
Results: **50/50 animation checks**, plus every existing suite green (details below).

---

## 1. The motion system

`src/renderer/styles/global.css` now defines one scale used everywhere:

| Token | Value | Used for |
| --- | --- | --- |
| `--dur-1` | `120ms` | hover / press feedback (nav items, icon buttons, rows, thumbs) |
| `--dur-2` | `180ms` | small surfaces: menus, toasts, toggles, panels, title changes |
| `--dur-3` | `240ms` | views, the queue panel, modal entry, the sidebar indicator, fullscreen entry |
| `--ease-out` | `cubic-bezier(0.22, 0.61, 0.36, 1)` | everything that enters or settles |
| `--ease-in-out` | `cubic-bezier(0.45, 0.05, 0.55, 0.95)` | available for symmetric moves |
| `--ease-spring` | `cubic-bezier(0.34, 1.3, 0.64, 1)` | press/pop feedback only (play button, thumbs, toggles) |

Keyframes: `view-in` (fade + 6 px rise), `modal-in` (fade + 8 px + 0.97 scale), `pop-in` (menus),
`toast-in`, `artwork-in`, `meta-in`, `icon-in`, `chrome-in`, `fs-in`, `form-in`.

Only `transform`, `opacity`, `visibility` (and a 3 px buffered-bar width) animate. No animation uses
`fill-mode: both` on a view, because a retained transform would turn the page into a containing
block for the fixed-position overlays drawn inside it.

---

## 2. What was implemented, by area

### Navigation

* **Sliding active indicator** (`Sidebar.tsx`, `.nav-pill`). One pill element moves between items
  (`translateY` + `height`) instead of each item fading its own background. It is measured from the
  DOM on navigation and on resize — never per frame — and `.active` remains the source of truth.
  The pill only takes over the background once a position is known (`data-pill="ready"`), so a
  failed measurement still leaves the plain `.active` background visible. Items not inside `.nav`
  (Settings) keep that plain background.
* **View transitions**: `.view` enters with a 240 ms fade + 6 px rise. The route content still
  remounts per view (that is what lets each screen replay its entrance), so:

### Page state survives navigation

* `useSessionState` (`src/renderer/app/useSessionState.ts`) keeps view state that belongs to the
  data, not to the mount: the library's **sort and filter** and the **selected Settings tab**.
  In-memory only — a restart starts clean.
* **Scroll offsets** are remembered per view in `App.tsx` and restored instantly on return (with
  `scroll-behavior: auto` for the restore only, then handed back to the smooth-scrolling rule).
* The search view's key no longer includes the query: typing in the global search is not a page
  change, and remounting the results on every keystroke made them flicker. Library tabs keep
  separate keys, so Songs → Albums still animates.

### Now Playing / player bar

* **Cover and title settle on track change**: `PlayerBar.tsx` restarts `artwork-in` / `meta-in` by
  toggling a class on the existing nodes (one forced reflow per track change, in a layout effect).
  Remounting the nodes instead made React stack **three covers side by side** in the player bar —
  that regression was caught by the harness and is now guarded by a dedicated check
  (`player-artwork-not-duplicated`).
* **Play/pause glyph** swaps through a keyed `.play-icon` wrapper that runs `icon-in` (fade +
  0.82→1 scale); the transport button has spring hover and quicker `:active` press feedback.
* **Seek bar**: the played fill is deliberately **not** transitioned — it is painted straight from
  the audio clock every ~100 ms, and a transition would put the bar behind the song on every seek
  (verified: computed `transition-duration` on the range input and its track is `0s`, and a seek to
  80 % moves `--progress` to 80.3 % within 120 ms). The buffered bar (which may lag) glides, and the
  thumb fades/scales in on hover and grows while dragging.
* **Lyrics**: the heading is keyed by track so the title block settles; the loading/empty/error
  cards fade in when they replace the lines. The lyric lines, karaoke highlight, translation and
  romanization animations stay **entirely upstream** (`@braccato/core`), which already transitions
  lines and honours `prefers-reduced-motion` on its own.
* **Queue**: slides in over 240 ms; the current-row highlight glides when the queue advances.

### Library

* Song rows, row action buttons and media cards use the shared timings.
* Cover art fades in where it is looked at (album grid, detail header, fullscreen, player). Song-row
  thumbnails deliberately do **not** — a 500-row list must not start 500 animations.
* The "new playlist" form rises into place (`form-in`); settings `<details>` content fades in.

### Settings

* Tabs animate colour/border; each section panel fades in as a **single** element when a tab is
  picked — rows never animate individually.
* Toggles snap with the spring easing (thumb), sliders answer the pointer on the thumb only
  (hover 1.2×, drag 1.35×), selects and buttons use the shared hover timing.

### Dialogs and overlays

* Modal: backdrop `fade-in` + panel `modal-in` (fade, 8 px rise, 0.97 scale).
* Context menu / dock popovers: `pop-in` (130–180 ms).
* Toast: `toast-in` slides up from the player bar.
* Playlist picker and all of the above were checked for entry animation names, durations and
  mid-transition frames.

### Fullscreen / window

* Entering fullscreen swaps the view's animation to `fs-in` (fade + 0.994 scale) — a different
  animation name restarts on the class change, so no JS state machine is needed.
* Leaving fullscreen fades the shell back in: `.sidebar` and `.player-bar` animate `chrome-in` when
  they remount, and the lyrics view replays `view-in`.
* Fullscreen controls keep their existing behaviour (reveal on pointer-over-footer, conceal on
  leave) and animate **opacity + visibility only**. A translate was tried and removed: the footer is
  measured for the lyric scroll padding, so moving the controls shifted that measurement (caught by
  `controls-overlay-without-shift` and the five `fullscreen-layout-*` checks).

### Reduced motion

* The in-app **Settings → Appearance → Reduce motion** toggle already wrote
  `data-reduce-motion`; that rule now also covers pseudo-elements, delays and iteration counts.
* **`@media (prefers-reduced-motion: reduce)`** now mirrors it, so a reduced-motion OS never sees
  the app move even if the in-app toggle was never touched. Verified both ways: with the setting on
  and with the OS preference on (and the setting off) every duration collapses and a navigation
  leaves **zero** running animations.

---

## 3. Visual verification

New harness: `npm run test:animation` → `tests/browser/animation-audit.ts`, evidence in
`.artifacts/animation-audit/` (`summary.json` + screenshots).

It boots the production renderer over a real 24-track library with embedded covers and drives the
actual UI. It reads `getAnimations()` and computed styles, and captures intermediate frames by
pausing the running animation at 110 ms and comparing that frame with the settled one.

**50/50 checks**, including:

| Check | Evidence |
| --- | --- |
| `nav-pill-slides` | 16 distinct transforms across 27 frames (0 → 82 px over 240 ms) |
| `nav-pill-lands-on-active` / `-follows-resize` / `compact-sidebar-pill-aligns` | pill rect matches the active item within 1 px at 1440×900, 1120×820 and in compact sidebar |
| `view-enters-with-fade` | `view-in`, 240 ms, captured on the first frame after the click |
| `nav-mid-frame-differs` | 4 animations held at 110 ms, 3.35 % of pixels differ from the settled frame |
| `library-filter-sort-preserved` / `library-scroll-preserved` | filter "Fixture", sort "artist" and `scrollTop` 90 all survive Songs → Albums → Songs |
| `settings-tab-preserved` | returns to Playback, not Appearance |
| `play-icon-animates` | `icon-in` on both play → pause and pause → play |
| `artwork-fades-on-track-change` / `player-meta-fades-on-track-change` | `artwork-in` / `meta-in` after "Next track" |
| `player-artwork-not-duplicated` | exactly one cover and one title block, same nodes reused |
| `seek-fill-has-no-transition` / `seek-responds-immediately` | durations `0s`; seek to 80 % → `--progress` 80.3 % in 120 ms |
| `buffer-width-transitions` | `width` over 320 ms |
| `queue-panel-slides-in`, `context-menu-pops-in`, `modal-scales-in`, `modal-backdrop-fades`, `toast-slides-in` | `slide-in` 240 ms, `pop-in` 180 ms, `modal-in` 180 ms, `fade-in` 180 ms, `toast-in` 180 ms |
| `*-mid-frame-differs` (nav, player, queue, modal, fullscreen) | real intermediate frames captured and compared |
| `fullscreen-covers-window` | 1440×900 at (0, 0) after `fs-in` |
| `fs-controls-show-on-hover` / `-hide-on-leave` / `-fade-not-cut` / `-return` | reveal on the footer, concealed at 0 opacity/hidden afterwards, opacity transition present, back to 1 |
| `fullscreen-exits` / `shell-fades-back` | no fullscreen node; `chrome-in` on the player bar |
| `rapid-nav-single-view` / `-pill-not-stuck` / `-no-stuck-overlays` | 12 navigations at 45 ms: 1 view, 1 active item, pill aligned, 0 overlays |
| `layout-stable` | player 92 px, content 740 px, content top 68 px unchanged |
| `setting-collapses-motion` / `os-reduced-motion-honoured` / `motion-restored-after-preference` | durations collapse to one frame, zero running animations; restored when the preference clears |
| `toast-dismisses-on-its-own` | toast still leaves after its 2.6 s lifetime |

Screenshots reviewed: `00-boot` (pill on Home), `01-nav-albums-mid/-settled`,
`02-player-track-change-mid/-settled` (single cover, full title), `03-queue-mid/-settled`,
`04-modal-mid/-settled`, `05-fullscreen-mid/-settled/-exit-settled`, `06-settings-playback`,
`06-toast`, `07-after-rapid-nav`, `08-albums-grid`, `09-compact-sidebar`.

---

## 4. Regression matrix

| Suite | Result |
| --- | --- |
| `npm test` (vitest) | 311/311 |
| `npm run test:renderer` | 25/25 |
| `npm run test:lyrics-ui` | 40/40 |
| `npm run test:providers` | 41/41 |
| `npm run test:cache` | 43/43 |
| `npm run test:cache:clear` | 13/13 |
| `npm run test:alac` | 13/13 — SUMMARY `{flacMs:191, mp3Ms:102, singleMs:1010, doubleMs:986, nextMs:108, rapidMs:1836}` (harness timing over a stubbed 900 ms decode; unchanged in shape from the v1.0.0 run) |
| `npm run test:now-playing` | 17/17 |
| `npm run test:animation` | 50/50 (new) |
| `npm run test:ui` | 149/150 twice, with a **different** single failure each run: `controls-show-shader-through-glass` once, `fullscreen-layout-800x600` once — both frame-timing-sensitive checks in the area already recorded as failing in this environment (the 800×600 fullscreen lyric scroll position). Six other `fullscreen-layout-*` and `hover-fade-is-opacity-only` failures that an intermediate build did cause were fixed, not accepted. |
| `npm run typecheck` | clean |

Playback, seeking, lyric sync, audio processing and caching are untouched: no change to
`audio/`, `player/`, the lyrics parser, the cache or the bridge. The only timing-adjacent edit is
the buffered-bar width transition, which is a separate element from the played fill.

---

## 5. Deliberate decisions and remaining limitations

1. **Closing overlays is instant, opening is animated.** The app's own contracts require the queue,
   context menu and modals to be *gone from the DOM* within 80–120 ms of closing (`shortcut-q-close`,
   `context-menu-escape`, `playlist-picker-close-button`, …), and desktop menus are expected to
   vanish under the pointer. A delayed unmount would either break those checks or delay the
   dismissal; entry animations are short enough (130–240 ms) that the asymmetry is not noticeable.
2. **No exit animation for fullscreen** either — the class toggle cannot animate the return to page
   layout. Instead the returning chrome fades in and the lyrics view replays its entrance, which
   covers the swap.
3. **Tooltips use the native `title` attribute.** The app has no tooltip layer; adding one would be
   a new feature (and a new focus/aria surface), so the OS tooltip delay and fade are what you get.
4. **Search results do not stagger** — they are replaced per keystroke, and any per-result animation
   there would flicker; the view itself still animates when you navigate to it.
5. **The upstream lyrics renderer keeps its own motion.** Line scale, karaoke sweep, translation and
   romanization appearance are the published `@braccato/core` animations; they were left untouched
   (they already respect `prefers-reduced-motion`). Only app-level containers around it animate.
6. **Reduced motion is a hard stop, not a softer animation.** Durations collapse to one frame; there
   is no "gentler" variant.
7. **The player's cover/title fade uses one synchronous reflow per track change** to restart the CSS
   animation. It is a single layout read, not a per-frame cost.
8. `test:ui` remains flaky in the fullscreen area in this environment (one of 150 checks, different
   one each run, all in the pre-existing fullscreen/glass measurement group).

---

## 6. Re-running

```bash
npm ci
python3 tests/fixtures/generate-audio.py     # needs numpy, soundfile, av, mutagen
npm run test:animation                        # build + 50-check motion audit (+ screenshots)
npm run test:ui && npm run test:now-playing && npm run test:alac
```
