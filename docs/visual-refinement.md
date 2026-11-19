# Cadence visual and motion refinement

Baseline: the completed desktop redesign at `a165b0d`. The reference was the last accepted Listen Now capture; the same 24-track sample library was then run against an archived production build of that commit and the refined renderer. This pass keeps the dark palette, sidebar, routes, and existing controls. It does not change audio, queue commands, native window commands, lyric data, or synchronization.

## Problems seen and changes made

| Before | Refinement | Files |
| --- | --- | --- |
| The warm artwork wash recolored the whole 92 px player. The large glowing Play button, two bright slider fills, and utility divider read as separate groups. Long track titles could move the favorite control and the tiny avatar competed with the cover. | An 80 px, neutral full-width rail anchors the existing 56 px cover and a fixed-width metadata/favorite area. The Play button is 38 px without a glow; transport and seek share a center line, the seek is shorter, and volume uses a quieter neutral fill. The tool buttons share one alignment without a divider. Artist text, source label, and every control remain; only the small repeated portrait was removed. The optional artwork wash is monochrome and limited to 144 px behind the cover. | `src/renderer/features/player/PlayerBar.tsx`, `src/renderer/styles/global.css` |
| The oversized Listen Now and spotlight titles competed, and the padded feature card and six-row list didn't share a visual baseline. | A smaller page title leaves room for two equal-rank section headings. The featured sleeve starts at the left gutter beside its copy, without a shadow or enclosing card. Recently played uses three rows of two with matching top/bottom alignment, readable labels and a hover/focus play glyph over the existing thumbnail instead of a reserved extra column. | `src/renderer/features/library/HomeView.tsx`, `src/renderer/styles/views.css` |
| Album artwork was pushed to the very bottom at 1040×680; even at 1440×900 the first row's subtitles ran behind the player. | A shared heading rhythm, tighter shelf/card spacing and responsive square columns bring cover and caption together. A short-window rule leaves room below the captions. In the fixture, the shelf starts at y=600→523 px at 1440×900 and y=565→436 px at 1040×680. The narrow caption box ends at y=596, above the player at y=600. Long labels still ellipsize rather than growing the row. | `src/renderer/styles/views.css` |
| On a track change the new title started after most of the old title had faded, and the big artwork wash changed before the cover had finished appearing. Successful thumbnail loads also caused extra React commits. | Decoded playback art still dissolves over the held cover in 320 ms, with a more legible ease-out blend. The 240 ms metadata envelope overlaps earlier (24 ms head start for the outgoing text), with 3 px travel and outgoing content still inert. A lazy library image now reveals itself on load, not through React state; cached images reveal on mount and failed images still fall back. | `src/renderer/styles/playback-motion.css`, `src/renderer/components/Artwork.tsx` |
| The live Mini controls moved most of the distance early and took the rest of the 300 ms to settle. | The same cover, title and transport use a more even 300 ms shared move. Only the small compact title strip settles with the collapse; expansion doesn't animate the big lyrics surfaces or the filtered background. There are no copied controls, overlays, or extra views. The OS restore-before-expansion and shrink-after-collapse ordering is unchanged. | `src/renderer/features/player/PlayerLayoutMotion.tsx`, `src/renderer/styles/playback-motion.css` |
| The route entered from blank and transformed a long scrolling list, triggering layout repeatedly. Shelves also started fully transparent and retained animation fill. | Routes reveal from 60% opacity over 240 ms without moving the scroll geometry. The sidebar indicator still moves; scroll restoration and navigation are unchanged. Card staggering stays capped, is less dark at entry and doesn't leave fill behind. | `src/renderer/styles/global.css`, `src/renderer/styles/views.css` |
| Moving lyric text carried a wide static shadow, and the old active highlight lingered into the next line. | A smaller static shadow, a gentler follow easing over the same 240 ms, and matched 180 ms highlight fades make the handoff easier to read. The selected glow and artwork background remain. The existing clock, active-line selection, scroll target, karaoke timing, and authored Custom-theme motion are unchanged. | `src/renderer/styles/lyrics.css`, `src/renderer/upstream/better-lyrics/themes.ts` |
| A removed queue row and its moving neighbors could overlap, and an interrupted entry could snap to full opacity. The now-transparent detached row stayed until the neighbors landed. | The old row starts leaving before its neighbors close the gap. Repeated edits use the displayed position and opacity, including the actual scroll position, and remove an inert exit as soon as its 120 ms fade finishes. Entry is 180 ms after a short beat; neighbor motion stays within 240 ms. The existing viewport cap and occurrence identities are retained. | `src/renderer/features/player/QueueMotionList.tsx`, `src/renderer/styles/global.css` |

## What the probes showed

- **Layout vs. React:** On the old renderer, four Home → Songs probes caused 12–16 layouts with the old route motion, 13–17 when the route started 6 px above rather than below its final position, and exactly two each when only opacity was animated. The finished renderer also used two layouts in this probe. A React commit probe on the sample library found 50 → 26 sampled artwork renders and four → three commits per Songs opening. In a 1.65 s steady playback slice, only the seek row rendered, around 20 times in each build; the shell, lyrics, and queue did not re-render per audio tick in that slice.
- **Filters and decode:** The footer did not use `backdrop-filter`, nor did the tested lyrics/queue surfaces. The old footer applied `blur(26px) saturate(1.2)` to a 1504×155 CSS box at 1440×900. The new box is 144×79 with `grayscale(1) blur(10px)`, about 95% less CSS box area, not a claim about GPU memory or render time. The playback cover decode was around 1 ms for a new fixture cover in the first trace sample and absent in the steady render probe. Slow-decode and corrupt-file tests confirm the held cover, fallback, and pending-request sharing remain. Actual decode latency depends on the art and machine.
- **Concurrent work:** In an intermediate trial, a full lyric-pane fade coincided with worse Mini expansion samples, including a 50 ms callback gap with GC and a large paint in the same trace. That fade was removed. The final stills use the original selected backdrop and lyric styling during flight, not a second animated surface. Queue geometry is read in a batch before animations start, and its temporary exits, resize/scroll/visibility handlers and animations are released after the edit or on interruption.

## Checking the result

Live renderer states were checked at **1440×900** and **1040×680**, and in **460×160** Mini. The before/final captures in `.artifacts/refinement/{before,final}/` include Home and Albums plus held and settled frames of playback artwork, lyric follow, queue removal, and both Mini directions. The queue remains docked at the larger width or overlays the workspace at the smaller width; both terminate above the player. The walkthrough plays actual fixture audio, crosses a lyric line on the media clock, and uses the existing controls to skip, remove a queued song, switch views, collapse and restore.

The renderer builds and typechecks. The offline unit suite passed **610/610** (`npm test -- --exclude tests/unit/_matasaburo_full.test.ts`); the excluded test requires a private Windows media fixture and a live lyrics-AI credential.

| Production renderer checks | Passed |
| --- | ---: |
| Animation and shell (`npm run test:animation`) | 112/112 |
| Now Playing, fullscreen, and Studio (`npm run test:now-playing`) | 120/120 |
| Lyrics display and decorations (`npm run test:lyrics-ui`) | 40/40 |
| Audio engine (`npm run test:audio`) | 11/11 |
| History and restart (`npm run test:history`) | 22/22 |
| Targeted recents, navigation, search, library, playlist, and dialog checks | 64, no failures |

The animation checks cover the opacity-only route reveal, blur preference, cover loading and fallback, queue interruption and early exit cleanup, in-flight Mini hit-testing, and reduced motion. The larger fixture library reached track 144 with 20 mounted rows, 58 px row heights, and no drift at the end of the scroll. Native OS controls and live provider checks were not part of these browser runs.

## Measured motion cost

Two alternating runs per build, three sweeps each, using the same production fixture actions in headless Chromium 153 with SwiftShader at 1440×900. Layout and main-thread task time are medians across six roughly 520 ms windows per action. Callback gaps are totals across those windows, not presented-frame measurements.

| Action | Layouts, before → after | Main-thread task time, ms | rAF gaps >25 ms |
| --- | ---: | ---: | ---: |
| Open Home | 4 → 3 | 43.7 → 34.3 | 1 → 2 |
| Open Songs | 18 → 4 | 61.7 → 48.4 | 1 → 0 |
| Cover and title change | 12.5 → 12.5 | 68.0 → 69.6 | 1 → 0 |
| Lyric follow | 14 → 14 | 117.5 → 94.5 | 0 → 0 |
| Mini collapse | 6 → 6 | 22.3 → 22.5 | 0 → 0 |
| Mini → Now Playing | 14 → 14 | 48.7 → 78.9 | 1 → 3 |
| Open queue drawer | 3 → 3.5 | 44.2 → 48.2 | 0 → 0 |
| Insert queue row | 1 → 1 | 15.5 → 15.0 | 0 → 0 |
| Remove queue row | 3 → 4 | 23.6 → 24.1 | 0 → 0 |

The route change reduced repeated layout and the lyric-follow window used less main-thread time. It was not an across-the-board speedup: p95 callback spacing stayed around 16.7–16.8 ms, Home still had an isolated 50 ms interval, and Mini expansion cost more in this repeat. Mini layout count stayed constant; the slower runs had longer React scheduler tasks around the resized mount and, in two samples, 5–7 ms of major garbage collection. Removing the extra pane fade leaves the live handoff intact but does not eliminate that mount cost.

Generate the audio fixtures (`python3 tests/fixtures/generate-audio.py`), build the renderer, and run the same workload against an archived `a165b0d` build and the working renderer:

```sh
CADENCE_MOTION_RUN=refinement-before-verified CADENCE_PROFILE_DIST="$PWD/.artifacts/refinement/baseline-dist" npx vite-node tests/browser/animation-audit.ts
CADENCE_MOTION_RUN=refinement-final-verified npx vite-node tests/browser/animation-audit.ts
```

The repeated summaries are in `.artifacts/refinement/comparison-verified.json`; the `profile.json` and compressed traces are in `.artifacts/motion-quality/refinement-*-verified*/`. Inspection stills are taken **after** profiling. These files and the sample media are workspace artifacts, not bundled with the app.

Native Tauri window behavior and presented-frame pacing on Intel UHD are unverified. This environment has neither a physical graphics device nor the native Tauri build prerequisites. The callback and trace counters above are not a native FPS benchmark.
