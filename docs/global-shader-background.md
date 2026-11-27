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
| The layer | `src/renderer/features/shaders/GlobalShaderBackground.tsx` — a `position: fixed; inset: 0; z-index: -1; pointer-events: none` sibling of the shell, `aria-hidden` |
| Glass bubbles | `src/renderer/features/shaders/ShaderBubbles.tsx` — six frosted spheres, rendered *inside* the wallpaper layer, pure CSS animation |
| Shader source | the playing track's cover, or `src/renderer/features/shaders/shaderSource.ts` (a generated accent gradient) when nothing is playing |
| The engine | the existing `KawarpBackground` mount — **no second shader engine, no new dependency** |
| Mount point | `src/renderer/App.tsx`, inside `.app-shell`, above every route; `data-shader-background="on"` on the shell gates all the CSS |
| Styles | `src/renderer/styles/global.css` — `.global-shader-bg`, `.glass-bubble` and the `[data-shader-background="on"]` rules, all scoped to the opt-in attribute |

The layer is a sibling of the routes, not part of one: navigating never mounts or unmounts it, so the
animation is continuous across pages, and it never takes input, so scrolling, text selection, focus
and the window controls are untouched.

## Layering — why `z-index: -1`, and the bug that shipped without it

The first version of this feature put the layer at `z-index: 0` inside the isolated shell and **every
piece of text in the content column disappeared**. The cause is stacking, not transparency:

- `.app-shell` is an isolated stacking context (`isolation: isolate`, needed so the layer cannot
  interleave with page-level stacking).
- Inside such a context, a *positioned* child with `z-index: 0` is painted in the positioned layer,
  which comes **after** (above) the in-flow, non-positioned content. Nearly every text box in a route —
  headings, row titles, labels — is non-positioned, so the wallpaper painted over them.
- Elements that escaped it were the ones with their own stacking context (album covers with
  `position: relative`, the player bar's rows), which is exactly the tell-tale pattern: images visible,
  words gone. A DOM hit-test still reported the text as the top element because the layer is
  `pointer-events: none`, so DOM probes alone could not see the defect — only pixels could.

The fix is `z-index: -1`. As a negative-z-index child of an isolated context, the layer paints above
that context's own background but below *all* of its in-flow content and below every positioned
descendant. Text, icons, rows and covers need no z-index of their own, and none were added: the
foreground UI is untouched. This is a root-cause fix, not a stacking patch — and the rule is written
into the stylesheet comment so it is not "corrected" back later.

## The grey screen — a hook that only ran when music was playing

This one shipped and blanked the window in a real build, and it is worth writing down because no
automated check caught it and the cause was a single character.

`GlobalShaderBackground` picked its artwork like this:

```tsx
const artworkUrl = item?.artworkUrl ?? useMemo(() => generatedShaderSource(accent), [accent]);
```

`useMemo` here is a **conditionally called hook**. On the first render after a track starts,
`item` is non-null, `??` short-circuits, and the `useMemo` is skipped. React compares the hook
sequence against the previous render, sees a different count, and throws ("Rendered more hooks than
during the previous render" — React error #300). Nothing in the tree caught the throw, so React
unmounted the root: `#root` was left with **zero children**, the body had no text, and what
remained on screen was the window's own background — the grey/blank screen. The Settings toggle
that would have turned the shader back off lives inside the UI that had just disappeared, so the
user could not recover from inside the app.

Two changes, at both levels:

1. **The bug itself.** The fallback gradient is now computed unconditionally and the two candidates
   are chosen afterwards:

   ```tsx
   const generated = useMemo(() => generatedShaderSource(accent), [accent]);
   const artworkUrl = item?.artworkUrl ?? generated;
   ```

2. **The containment**, because a wallpaper must never be able to take the application down.
   `ShaderBoundary` (`src/renderer/app/ShaderBoundary.tsx`) wraps the shader subtree in `App.tsx`.
   A render error unmounts only the wallpaper, logs once, and leaves the rest of the app running on
   the plain canvas — so Settings is reachable and the user can switch the shader off. This is a
   class component because that is still the only way to catch render errors in React 19.

Why the harness missed it: `visual-inspect.mjs` and `run-app.mjs` both walked pages and toggled the
shader, but the row they played first in an earlier probe (`broken.flac`) is the deliberate
undecodable fixture — playback fails, no media item ever exists, `item` stays `null`, and the hook
count never changes. The guard now plays a track that really decodes.

**Regression guard:** `run-app.mjs` → `global-shader-playback-never-blanks-the-app`. With the
wallpaper on it plays "Fixture FLAC", then asserts `#root` still has children and more than 1 KB of
markup, the body still has text, the heading and player title are present, the layer is still a live
canvas at `z-index: -1`, the text is not hit-tested to the layer, and **no page error** was raised.
Verified in this environment to fail (empty root, React #300) on the pre-fix code and pass after.

## If the app is already stuck blank

The setting lives in the app's data directory, outside the window, so it can be edited by hand:

- Windows: `%APPDATA%\app.cadence.player\settings.json`
- macOS: `~/Library/Application Support/app.cadence.player/settings.json`
- Linux: `~/.local/share/app.cadence.player/settings.json`

Quit Cadence, then set `shaders.globalBackground` (and `shaders.enabled`) to `false` in that file and
start it again. The app opens on its normal opaque background. This is only needed for builds made
before the fix above; from then on a shader failure cannot blank the window at all.

## The glass bubbles

Six large frosted spheres inside the wallpaper layer, each a translucent disc with a backdrop blur,
an inset rim light, a specular highlight (`::before`), a caustic at the lower edge (`::after`) and a
soft cast shadow, so they read as glass objects with depth rather than flat circles.

- They drift on a slow CSS `transform` (26–47 s per bubble, offset phases) while their
  `border-radius` morphs, giving organic, non-repeating motion with no JavaScript per frame.
- The composition keeps them out of the reading column: corners, the gutter between the sidebar and
  content, and the bottom edge — never over row text.
- They are `aria-hidden`, `pointer-events: none`, and live inside the layer, so they are below every UI
  element by the same rule as the shader.
- Reduced motion freezes both the drift and the morph; the glass stays, nothing moves.

## Contrast

Under the UI, the wallpaper's own scrim is lighter than the Now Playing stage's (which is judged over
lyrics alone). The content column gets a second, wide gradient shade
(`.content-scroll::before`, `z-index: -1` inside the shell) that softens the mid-tones towards the
window edges, so body copy keeps the contrast it has over the flat canvas while the shader stays
visible. Measured visually in `.artifacts/visual/`.

## Performance and lifecycle

- **Off costs nothing.** The layer is not rendered at all when either switch is off, so no canvas, no
  GL context, no resize observer, no render loop and no bubble animation exist. `globalShaderEnabled()`
  is the single predicate used by both the shell and the stage.
- **On**, `KawarpBackground` keeps its upstream lifecycle: one context per mount, `dispose()` on
  unmount, a resize observer that only resizes the drawing buffer, and no work while `document.hidden`.
  The canvas is sized from the window times the performance-mode DPR, so it follows window resizes and
  DPI changes.
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

Measured in the running application, not inferred from source:

- `node tests/browser/visual-inspect.mjs` — the visual pass. Boots the built app against the harness,
  turns the wallpaper on, walks **Home, Songs, Albums, Artists, Liked songs, Playlists, Stats, History,
  Settings, windowed lyrics, fullscreen Now Playing and the queue**, screenshots each one, and asserts
  per page that every visible text node has a non-zero alpha and that the wallpaper never wins the
  hit-test over UI. It also resizes to 1024×700 and 1680×1000, toggles the feature off and on in
  Settings, and reloads to prove persistence. **29/29 checks**, zero console errors. Screenshots in
  `.artifacts/visual/`.
- `npm run typecheck` — clean.
- `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` — **633/633**, including five settings
  cases: ships off, migrates old files to off, never enabled by a malformed value, persists across a
  restart, leaves the other shader settings untouched.
- `tests/browser/run-app.mjs` — **168/168**, including `global-shader-never-covers-text` (page heading
  and track titles are not under the layer and are not transparent — the regression guard),
  `global-shader-is-one-surface` (exactly one layer, one canvas, six bubbles),
  `global-shader-layer-behind-the-ui` (fixed, `z-index: -1`, covers the window, no input, isolated
  shell, near-opaque rail, transparent content), `global-shader-off-by-default` (no layer, no canvas,
  shell still opaque and un-isolated), `global-shader-enables-live`,
  `global-shader-does-not-capture-input`, `global-shader-covers-the-immersive-stage`,
  `global-shader-survives-reload`, `global-shader-disables-live`,
  `global-shader-falls-back-when-engine-fails`, `global-shader-failure-keeps-app-usable`, and four
  onboarding checks.
- `tests/browser/audit-ui.mjs` — 295 passed, 1 failed: the pre-existing `instrumental-setting-completes`
  flake, which fails on the base commit too and passes when run alone.
- `tests/browser/now-playing-layout.ts` — 37 checks, then the pre-existing `openProfileSwitcher` probe
  failure (also on base).
- `tests/browser/animation-audit.ts` — 117 checks with four failures that reproduce on base
  (`lyric-follow-…`, `mini-expansion-…`, `mini-handoff-…`, `layout-stable`).

## What was visually inspected, and what was found

Inspected: Home, Songs, Albums, Artists, Liked songs, Playlists, Stats, History, Settings (General and
Appearance → Shader background), windowed lyrics, fullscreen Now Playing, the queue panel, two window
sizes, the toggle in both states, and the app after a reload.

Defects found and fixed:

1. **All content text was invisible with the shader on** — the `z-index: 0` layering bug described
   above. Only artwork (own stacking context) survived. Fixed with the negative z-index; text verified
   back on every page.
2. **The shader was a near-black field** — with nothing playing there was no artwork to warp. Fixed by
   warping a generated accent gradient when there is no cover.
3. **Bubbles sat on top of the reading column** — the first composition put a sphere over the featured
   album's title. Recomposed to corners, gutter and bottom edge only.
4. **Settings text lost contrast** over the bright mid-tones — added the content-column shade and
   lightened the wallpaper scrim.

Also checked and found *not* to be a defect: the brown album-art placeholder in Now Playing is
identical with the shader on and off (sampled `rgb(62, 52, 48)` both ways); it is pre-existing styling.

## Not verified

- The **Tauri desktop window** was not launched: this environment has no Rust toolchain, so the native
  shell cannot be built here. Everything above runs the real renderer (the built `dist` bundle) in
  Chromium with the same bridge contract, which covers layout, stacking, CSS animation and WebGL, but
  not WebView2-specific compositing or a real GPU driver. GPU work here is ANGLE/SwiftShader.
- Smoothness was judged from screenshots and hand-driven inspection, not from a frame-time profile on
  real hardware.
