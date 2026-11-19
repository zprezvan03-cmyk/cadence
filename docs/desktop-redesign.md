# Cadence desktop redesign

The desktop renderer takes its cues from Apple Music’s library views: grouped navigation, a quiet dark canvas, square album sleeves and a clear hierarchy between browsing, track actions and playback. The library and its artwork still come from the listener’s own files.

- **Listen Now and Library:** a local-album spotlight beside recent plays, artwork-led album and playlist grids, circular artist portraits, collection breadcrumbs and consistent song tables. Search reports loading, no matches and failures separately; leaving search clears the field, and Back restores the search route.
- **Playback:** the transport spans the window. The queue sits beside the page at 1240px and wider; on smaller windows and in Now Playing it overlays content without covering the windowed transport. The Mini Player fits the existing 460×160 native window. The live artwork, metadata and transport handoff still uses the real controls rather than duplicates.
- **Now Playing:** metadata sits beside the lyrics in wider panes and above them in narrower ones. The full-screen layout, playback clock, lyric timing, profile data and Studio controls are preserved. Settings, History, playlists and the other library tools share the same surfaces and spacing.

## Verifying the renderer

Use the existing audio fixture generator and run `npm run test:animation`, `npm run test:now-playing`, `npm run test:history`, `npm run test:lyrics-ui` and `npm run test:audio`. The animation audit covers both queue placements, menu focus and dismissal, the full-width transport, live Mini handoff and reduced-motion behavior. The visual pass used scanned fixture audio at 1440×900, the 1040×680 minimum and the 460×160 Mini size. Sample artwork and media are not bundled with the application.

These browser checks run the production renderer with a test IPC bridge. To validate the real title bar, system dialogs, fullscreen and always-on-top window behavior, run `npm run dev` on a machine with the Tauri prerequisites. No native window, audio-engine or library-storage changes are required by this redesign.
