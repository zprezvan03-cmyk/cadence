# Global shader background

Cadence's shader (the ported Better Lyrics Kawarp engine) used to exist only inside the Now Playing
stage. It can now run **behind the whole application** — library, settings and Now Playing alike —
as one opt-in wallpaper. Written for Cadence.

## What the user sees

- **Off by default.** A new install, and every existing settings file that predates the switch, renders
  the plain `--bg` canvas exactly as before.
- **Two places to turn it on**, both writing the same persisted field:
  - *Onboarding → Preferences*: an explicit `Off | On` pair (`[data-testid="onboarding-shader-background"]`),
    defaulting to Off. It is optional — Next never depends on it, and finishing with it untouched
    stores `false`.
  - *Settings → Appearance → Shader background across the whole app*: a persistent toggle that applies
    immediately, without a restart.
- **On**, the app's canvas becomes transparent, the rails (player bar, title bar) go translucent over a
  blurred backdrop, and the sidebar keeps a near-opaque fill so navigation stays readable. Route
  content sits on the wallpaper itself, and the immersive Now Playing stage becomes transparent so the
  app-wide shader is what the lyrics sit on.

## How it is wired

| Piece | File |
| --- | --- |
| Persisted field | `shaders.globalBackground: boolean` (`src/shared/types.ts`), default `false` in `DEFAULT_SETTINGS`, normalized on every load and patch (`src/main/settingsCore.ts`) so a missing, null or malformed value can never turn it on |
| The layer | `src/renderer/features/shaders/GlobalShaderBackground.tsx` — a `position: fixed; inset: 0; z-index: 0; pointer-events: none` sibling of the shell, `aria-hidden` |
| The engine | the existing `KawarpBackground` mount — **no second shader engine, no new dependency** |
| Mount point | `src/renderer/App.tsx`, inside `.app-shell`, above every route; `data-shader-background="on"` on the shell gates all the CSS |
| Styles | `src/renderer/styles/global.css` — `.global-shader-bg` plus the `[data-shader-background="on"]` rules, all scoped to the opt-in attribute |

The layer is a sibling of the routes, not part of one: navigating never mounts or unmounts it, and it
never takes input, so scrolling, text selection, focus and the window controls are untouched.

## Performance and lifecycle

- **Off costs nothing.** The layer is not rendered at all when either switch is off, so no canvas, no
  GL context, no resize observer and no render loop exist. `globalShaderEnabled()` is the single
  predicate used by both the shell and the stage.
- **On**, `KawarpBackground` keeps its upstream lifecycle: one context per mount, `dispose()` on
  unmount, a resize observer that only resizes the drawing buffer, and no work while `document.hidden`.
- The wallpaper keeps drifting while playback is stopped (a frozen backdrop reads as broken) unless
  the user asked for reduced motion, in which case it holds a single still frame
  (`animateWhenPaused` / `still` props on `KawarpBackground`; the player page keeps upstream's
  pause-with-playback behaviour).
- The Now Playing stage does not mount its own background while the wallpaper is on — one GL context
  for the window, not two for the same pixels. An enabled music video still gets its layer.
- **Failures fall back.** If the engine cannot start, `KawarpBackground` logs, swaps in its blurred
  artwork layer, and the wallpaper keeps its own opaque backing fill; the UI above it stays translucent
  over a real surface, never over a hole.

## Verification

- `npm run typecheck` — clean.
- `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` — **633/633**, including five new
  `settings` cases: ships off, migrates old files to off, never enabled by a malformed value, persists
  across a restart, and leaves the other shader settings untouched.
- `tests/browser/run-app.mjs` — **166/166**, including `global-shader-off-by-default` (no layer, no
  canvas, shell still opaque and un-isolated), `global-shader-enables-live`,
  `global-shader-layer-behind-the-ui` (fixed, `z-index: 0`, covers the window, no input, translucent
  shell/rail/content), `global-shader-does-not-capture-input`,
  `global-shader-covers-the-immersive-stage` (transparent stage, exactly one canvas),
  `global-shader-survives-reload`, `global-shader-disables-live`,
  `global-shader-falls-back-when-engine-fails`, `global-shader-failure-keeps-app-usable`, and the four
  onboarding checks (`defaults-off`, `applies-immediately`, `can-be-cleared`,
  `completes-with-the-choice-untouched`).
- `tests/browser/audit-ui.mjs` — 295 passed, 1 failed: the pre-existing `instrumental-setting-completes`
  flake, which fails on the base commit too and passes when run alone.
- `tests/browser/now-playing-layout.ts` — 37 checks, then the pre-existing `openProfileSwitcher` probe
  failure (also on base).
- `tests/browser/animation-audit.ts` — 117 checks with four failures that reproduce on base
  (`lyric-follow-…`, `mini-expansion-…`, `mini-handoff-…`, `layout-stable`).

Screenshots: `.artifacts/screens/07b-global-shader.png` (library), `07c-global-shader-settings.png`,
`07d-global-shader-fullscreen.png`.
