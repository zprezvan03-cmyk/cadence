# Now Playing: Better Lyrics fullscreen parity

Scope: the fullscreen Now Playing surface — layout, controls, dock, idle behaviour, loader and empty
states. The windowed Now Playing view and the Customization Studio preview keep their existing
structure; they consume the same profile settings as before.

Reference: Better Lyrics `18be320` (v3.0.1.1), `src/modules/ui/{dom,playerControls,lyricsDock}.ts`
and `public/css/blyrics/components.css`. Cadence reimplements the behaviour; no upstream code is
copied, and the CSS class names here are Cadence's own. Where the reference drives YouTube Music's
DOM, Cadence drives its own player store.

## Layout

| Reference | Cadence | Notes |
| --- | --- | --- |
| `#blyrics-fs-column` — artwork, 2rem gap, song-info row, 1.5rem gap, progress + transport; the column is exactly as wide as the artwork | `.fs-col` inside `.fs-side` (`FullscreenColumnControls`, `FullscreenInfoActions`) | Same order, same gaps (`clamp(14px, 2.2cqh, 32px)` and `1.5rem`). |
| Artwork column centred vertically in the main panel | `.fs-side` keeps its `translateY()` centring | Unchanged from Cadence's layout. |
| Lyrics column scrolled independently | `.lyrics-body` in grid column 2 | Unchanged. |
| Player bar stays visible in fullscreen (YouTube Music's bar) | `.fs-controls` stays visible, edge-to-edge, matte `#1b1b1d`, white progress | The bar keeps Cadence's three zones (identity / transport+seek / tools) and gains the reference's full-width footprint. |
| `#blyrics-song-info`: title 700 weight, artist at 0.5 opacity, `artist · album` | `.fs-col .lyrics-heading` | Sizes derive from the profile's `--np-title-size`, so profile scaling still applies. |

Profiles still decide what exists: `metadataSlot`/`metadataVisible` move the heading between the
column and the header, `artworkVisible` drops the cover, and `controlsVisible: false` falls back to
the pre-parity presentation (controls only in the bottom bar). `artwork-right` mirrors the column.

## Controls

- Round discs `.fs-disc` (52px, 56% glyph) with the reference's hover (`rgb(255 255 255 / 24%)`,
  `scale(1.06)`, 140ms), 28px song-info actions with 18px glyphs, and the solid white 68px play
  button (`46%` glyph).
- Click feedback matches the reference's three motions: a 280ms pop, a 300ms ±22% icon nudge on the
  skip buttons, and a 480ms ripple (`scale(2.6)`) that spawns at the pointer.
- Favourite runs the 640ms pop, the 900ms iris reveal of the filled heart, and a 460/480ms ray and
  dot burst.
- Shuffle/repeat take the reference's like/dislike positions: Cadence's transport owns those
  settings, and an active one gets the reference's 3px underline dot.
- Progress bar (`features/player/ProgressBar.tsx`): 4px track at `rgb(255 255 255 / 22%)`, 10px
  knob, `transform`-driven fill with a 260ms glide on seeks, scrub previews, click-to-seek, keyboard
  steps (5s, 30s with Shift, Home/End). The right-hand time flips between total and remaining
  (`-0:04`) when clicked and animates its new box in over 420ms with
  `cubic-bezier(.22,1,.36,1)`.
- Volume (`FullscreenVolume`): the mute button's 4px slider slides out to `clamp(72px, 7vw, 104px)`
  while hovered or focused, closes 350ms after the pointer leaves, and the wheel adjusts in 4%
  notches (arrows 5%, Home/End the extremes, Escape closes). Glyph parts switch between muted, low
  and high.
- The bottom bar's transport keeps Cadence's icon language but uses the same pop/nudge/ripple.

Store contracts used: `toggle`, `next`, `previous`, `seek`, `seekBy`, `setVolume`, `setMuted`,
`toggleShuffle`, `cycleRepeat`, `position`, `duration`, `buffered`. `playback.showRemainingTime`
is a new persisted setting (default `false`) written through the settings store, so the choice
survives a restart and applies to both the fullscreen column and the windowed/bottom bar.

## Chrome visibility and the cursor

`useFullscreenChrome` replaces `useControlsHover`, which revealed the controls only while the pointer
was over the footer.

- The chrome (player bar, song-info actions, column controls, mode tabs, exit button, floating dock)
  is shown by any pointer move, pointer press, keyboard use or focus arrival, and hides after
  **3000ms** without them — Better Lyrics' `PLAYER_BAR_HIDE_DELAY` behaviour, driven by YouTube
  Music's `show-fullscreen-controls` attribute.
- The chrome stays up while the pointer rests on it, while a popover or the queue is open
  (`chromePinned`), while a pointer press is in flight, and while focus is inside it from the
  keyboard. A mouse click does not pin it: the reference hides the chrome after any pointer idle.
- A hidden chrome hides the cursor too (`.lyrics-view[data-chrome="hidden"] { cursor: none }`), as
  `cursor-hidden` does on YouTube Music's layout.
- Visibility fades over `--dur-3` (240ms) with `visibility` trailing it so hidden chrome leaves the
  hit-testing and focus order. The floating dock additionally scales to 0.85 and blurs to 8px, the
  reference's `.blyrics-dock--hidden` transform.

## Dock

The inline top-right tools row is gone. The dock now floats over the bottom-right of the lyrics
column as the reference's `.blyrics-dock__inner` does: 8px padding, 4px gaps, 14px radius,
`hsla(0, 0%, 100%, 0.06)`, `blur(12px)`, hairline inset light and a soft drop shadow, with 28px
minimum-height controls and hairline group dividers. Its popovers rise above the pill. Position is
Cadence's own choice: the reference docks against YouTube Music's side panel, which has no
equivalent here.

## Loader and empty states

- Loader (`#blyrics-loader`): a 3.5rem mark spinning once per 1.5s beside 2.2rem bold status text
  whose gradient shimmers across it (3s), 1.5rem apart. The card entrance is the reference's
  slide-up: the mark and text travel in with `cubic-bezier(.22,1,.36,1)`.
- "Lyrics not found" is the reference's quiet inline message, not a bordered card: `p` only, with
  the existing recovery actions (choose a file, try again, enable online lyrics) beneath it. The
  error state adds a `-`-free muted detail line.
- Lyrics Off with no lyrics keeps the artwork card's progress bar and transport.

## Verification

- `npm run typecheck` — clean.
- `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` — **628/628**.
- `npm run build:web` — clean.
- `tests/browser/run-app.mjs` — **153/153**, including new checks for pointer-wake, the 3s idle
  hide, the hidden cursor, the pinned popover, the matte full-width bar, and the column's
  volume/favourite/transport.
- `tests/browser/audit-ui.mjs` — **296 passed, 0 failed** (4 blocked, 3 not tested, as on the base).
- `tests/browser/animation-audit.ts` — 61 checks pass, then the pre-existing `InvalidStateError`
  while finishing an infinite shimmer animation, which also occurs on the base commit.
- `tests/browser/now-playing-layout.ts` — 37 checks pass; its `openProfileSwitcher` probe fails on
  the base commit as well (the switcher button is not reachable in that harness), and its two
  assertions updated here (Lyrics Off visibility, the quiet empty panel, the loader geometry) pass.

## Known limitations

- The transport is duplicated by design: the reference shows both its own column and YouTube Music's
  bar, and Cadence keeps its full-width player bar while the column carries the same transport.
- Better Lyrics' like/dislike voting writes to its own backend; Cadence has no voting model, so the
  heart is the library favourite and shuffle/repeat occupy the outermost slots.
- The artist and album are not links (Cadence's `MarqueeText` heading), unlike the reference's
  `blyrics-song-link` anchors.
- Karaoke, word-sync and translations come from Braccato and are unchanged by this pass.
