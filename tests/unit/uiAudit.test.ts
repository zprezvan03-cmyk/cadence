import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

describe("UI audit invariants", () => {
  it("keeps lyrics dock popovers outside scroll clipping and prevents button wrapping", () => {
    const dockTsx = read("src/renderer/features/lyrics/LyricsDock.tsx");
    const lyricsCss = read("src/renderer/styles/lyrics.css");

    // Unified popover state instead of independent overlapping booleans.
    expect(dockTsx).toContain("openPopover");
    expect(dockTsx).not.toContain("languageOpen");
    expect(dockTsx).not.toContain("saveOpen");
    expect(dockTsx).not.toContain("regenerateOpen");
    expect(dockTsx).toContain("Escape");
    expect(dockTsx).toContain("pointerdown");
    expect(dockTsx).toContain("lyrics-dock-scroll");
    expect(dockTsx).toContain('className="dock-label"');

    // Popovers stay outside the scrollable pill strip so overflow-x never clips them.
    expect(lyricsCss).toMatch(/\.lyrics-dock\s*\{[^}]*position:\s*relative/);
    expect(lyricsCss).toMatch(/html\[data-mobile="true"\] \.lyrics-dock\s*\{[^}]*overflow:\s*visible/);
    expect(lyricsCss).toContain(".lyrics-dock-scroll {");
    expect(lyricsCss).toContain(".dock-button {\n");
    expect(lyricsCss).toMatch(/\.dock-button\s*\{[^}]*white-space:\s*nowrap/);
    expect(lyricsCss).toMatch(/\.dock-status\s*\{[^}]*white-space:\s*nowrap/);
    expect(lyricsCss).toMatch(/\.np-customize-button\s*\{[^}]*white-space:\s*nowrap/);
    expect(lyricsCss).toMatch(/html\[data-mobile="true"\] \.dock-button \.dock-label\s*\{[^}]*display:\s*none/);
  });

  it("removes duplicate mobile Queue button and duplicate smart playlist edit button", () => {
    const lyricsView = read("src/renderer/features/lyrics/LyricsView.tsx");
    const detailViews = read("src/renderer/features/library/DetailViews.tsx");

    expect(lyricsView).not.toContain("toggleQueue");
    expect(lyricsView).toContain("showLyricsToggle={fullscreen}");
    expect(lyricsView).toContain('className="btn-label"');

    const editRuleMatches = detailViews.match(/data-testid="edit-smart-rule"/g) ?? [];
    expect(editRuleMatches).toHaveLength(1);
  });

  it("keeps shared buttons compact with nowrap and guards context menus and modal Escape", () => {
    const globalCss = read("src/renderer/styles/global.css");
    const viewsCss = read("src/renderer/styles/views.css");
    const trackList = read("src/renderer/components/TrackList.tsx");
    const libraryView = read("src/renderer/features/library/LibraryView.tsx");
    const decodeView = read("src/renderer/features/decode-tester/DecodeTesterView.tsx");
    const picker = read("src/renderer/app/PlaylistPicker.tsx");
    const settings = read("src/renderer/features/settings/SettingsView.tsx");
    const fetchSettings = read("src/renderer/features/lyrics-fetch/FetchAllSettings.tsx");

    expect(globalCss).toMatch(/\.primary,\s*\n\.heading-actions button/);
    expect(globalCss).toMatch(/white-space:\s*nowrap;\s*\n\s*flex-shrink:\s*0;/);

    // Ensure dead stale mobile CSS class names are gone and real selectors are used.
    expect(viewsCss).not.toContain(".track-table-head");
    expect(viewsCss).not.toContain(".track-album");
    expect(viewsCss).not.toContain(".track-duration");
    expect(viewsCss).not.toContain(".detail-actions");
    expect(viewsCss).not.toContain(".media-grid");
    expect(viewsCss).not.toContain(".cards-row");
    expect(viewsCss).not.toContain(".eq-bands");

    expect(viewsCss).toContain(".stats-rank-row:has(.source-badge)");
    expect(viewsCss).toContain("html[data-mobile=\"true\"] .track-row .col-actions");
    expect(viewsCss).toContain("html[data-mobile=\"true\"] .equalizer-bands");
    expect(viewsCss).toContain("html[data-mobile=\"true\"] .detail-hero > .back-button");

    expect(trackList).toContain("window.innerWidth");
    expect(trackList).toContain("window.innerHeight");
    expect(libraryView).toContain("{!hasAndroid ?");
    expect(decodeView).toContain("{!isAndroidNativeAudio() ?");
    expect(picker).toContain('event.key === "Escape"');
    expect(settings).toContain("{!isMobile ?");
    expect(fetchSettings).not.toContain("✨");
  });
});
