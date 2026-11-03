/**
 * Pure parsers from InnerTube (YouTube Music) JSON responses to Cadence's YTM domain model.
 *
 * Renderer shapes follow YouTube Music's web responses as modeled by the ArchiveTune reference
 * (rukamori/core @ fefeefa, GPL-3.0 — interface facts only; all code here is original). Parsers
 * are defensive: unknown or moved keys degrade to null/empty instead of throwing, and shelf
 * parsing walks renderer names so a layout tweak upstream cannot crash the catalog.
 */

import type {
  YtmAlbum,
  YtmAlbumPage,
  YtmArtist,
  YtmArtistPage,
  YtmArtistRef,
  YtmChartsPage,
  YtmExplorePage,
  YtmHomePage,
  YtmHomeChip,
  YtmItem,
  YtmMoodOrGenre,
  YtmPlaylist,
  YtmPlaylistPage,
  YtmPlayerResult,
  YtmQueueResult,
  YtmSearchFilter,
  YtmSearchResults,
  YtmShelf,
  YtmStreamFormat,
  YtmSuggestions,
  YtmTrack,
} from "../../shared/ytmusic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export function asRecord(value: unknown): Json | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Recursively collect every object that has the given renderer key, in document order. */
export function collectRenderers(value: unknown, name: string, out: Json[] = []): Json[] {
  const record = asRecord(value);
  if (record) {
    const inner = record[name];
    if (asRecord(inner)) out.push(inner);
    for (const key of Object.keys(record)) {
      if (key !== name) collectRenderers(record[key], name, out);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectRenderers(entry, name, out);
  }
  return out;
}

export function firstRenderer(value: unknown, ...names: string[]): Json | null {
  for (const name of names) {
    const found = collectRenderers(value, name);
    if (found.length) return found[0];
  }
  return null;
}

/* ------------------------------------------------------------ primitives */

function runsText(runs: unknown): string {
  return asArray(runs)
    .map(run => str(asRecord(run)?.text) ?? "")
    .join("");
}

function textOf(node: unknown): string | null {
  const record = asRecord(node);
  if (!record) return null;
  const text = str(record.text);
  if (text) return text;
  return runsText(record.runs) || null;
}

/** Split joined runs on the " • " (or similar) separator used between metadata fields. */
export function splitBySeparator(runs: unknown): string[] {
  const parts: string[] = [];
  let current = "";
  for (const run of asArray(runs)) {
    const piece = str(asRecord(run)?.text) ?? "";
    const segments = piece.split(/\s*[•·]\s*|\s+\/\s+/);
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (i > 0 && current) {
        parts.push(current);
        current = "";
      }
      current += segment;
    }
  }
  if (current) parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

/** "3:45" / "1:02:07" → seconds. */
export function parseTimeText(text: string | null): number | null {
  if (!text) return null;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function thumbnailOf(node: unknown): { url: string | null; width: number | null; height: number | null } {
  const record = asRecord(node);
  if (!record) return { url: null, width: null, height: null };
  const thumbnails = asArray(record.thumbnails);
  // Best = last (YouTube orders ascending); prefer the largest under 640px for list rows.
  let best: Json | null = null;
  let bestArea = -1;
  for (const thumb of thumbnails) {
    const t = asRecord(thumb);
    if (!t) continue;
    const url = str(t.url);
    if (!url) continue;
    const w = num(t.width) ?? 0;
    const h = num(t.height) ?? 0;
    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      best = t;
    }
  }
  if (!best) {
    // Some renderers nest one level deeper (thumbnail.musicThumbnailRenderer.thumbnail).
    return thumbnailOf(record.thumbnail ?? record.musicThumbnailRenderer);
  }
  let url = str(best.url);
  if (url) url = normalizeThumbUrl(url);
  return { url, width: num(best.width), height: num(best.height) };
}

/** googlevideo thumbnail URLs use =wNN-hNN cropping; strip to get a stable full image. */
export function normalizeThumbUrl(url: string): string {
  return url.replace(/=w\d+-h\d+(-[a-z]+)?/g, "=w512-h512");
}

function thumbnailFromRenderer(node: unknown): string | null {
  const record = asRecord(node);
  if (!record) return null;
  return (
    thumbnailOf(record.thumbnail ?? record.musicThumbnailRenderer ?? record).url ??
    thumbnailOf(record)?.url ??
    null
  );
}

/* ------------------------------------------------------------ endpoints */

interface ParsedEndpoint {
  watch: { videoId: string | null; playlistId: string | null; setVideoId: string | null; musicVideoType: string | null } | null;
  watchPlaylist: { playlistId: string | null } | null;
  browse: { browseId: string | null; params: string | null; pageType: string | null } | null;
}

function parseEndpoint(node: unknown): ParsedEndpoint {
  const record = asRecord(node);
  const result: ParsedEndpoint = { watch: null, watchPlaylist: null, browse: null };
  if (!record) return result;
  const watch = asRecord(record.watchEndpoint);
  if (watch) {
    const config = asRecord(
      asRecord(asRecord(watch.watchEndpointMusicSupportedConfigs)?.watchEndpointMusicConfig)?.musicVideoType
        ? watch.watchEndpointMusicSupportedConfigs
        : null
    );
    const musicConfig = asRecord(asRecord(watch.watchEndpointMusicSupportedConfigs)?.watchEndpointMusicConfig);
    result.watch = {
      videoId: str(watch.videoId),
      playlistId: str(watch.playlistId),
      setVideoId: str(watch.playlistSetVideoId),
      musicVideoType: str(musicConfig?.musicVideoType) ?? str(config?.musicVideoType),
    };
  }
  const watchPlaylist = asRecord(record.watchPlaylistEndpoint);
  if (watchPlaylist) result.watchPlaylist = { playlistId: str(watchPlaylist.playlistId) };
  const browse = asRecord(record.browseEndpoint);
  if (browse) {
    const context = asRecord(
      asRecord(browse.browseEndpointContextSupportedConfigs)?.browseEndpointContextMusicConfig
    );
    result.browse = {
      browseId: str(browse.browseId),
      params: str(browse.params),
      pageType: str(context?.pageType),
    };
  }
  return result;
}

function anyWatchEndpoint(record: Json | null): ParsedEndpoint["watch"] {
  if (!record) return null;
  return (
    parseEndpoint(record.navigationEndpoint).watch ??
    parseEndpoint(asRecord(record.playNavigationEndpoint)).watch ??
    parseEndpoint(asRecord(asRecord(record.overlay)?.musicItemThumbnailOverlayRenderer)?.content
      ? (asRecord(asRecord(asRecord(record.overlay)?.musicItemThumbnailOverlayRenderer)?.content)?.musicPlayButtonRenderer)
      : null).watch
  );
}

/* ------------------------------------------------------------ items */

function artistsFromRuns(runs: unknown): YtmArtistRef[] {
  const artists: YtmArtistRef[] = [];
  for (const run of asArray(runs)) {
    const record = asRecord(run);
    if (!record) continue;
    const name = str(record.text);
    if (!name) continue;
    const browse = parseEndpoint(record.navigationEndpoint).browse;
    // Only navigation runs are artists; separator (" • ") and duration runs have no endpoint.
    if (!browse?.browseId) continue;
    // Strict: only artist pages (or UC channel ids) count as artists; album/playlist runs are
    // handled separately so a song's album title never leaks into the artist list.
    if (browse.pageType !== "MUSIC_PAGE_TYPE_ARTIST" && !browse.browseId.startsWith("UC")) continue;
    artists.push({ name, browseId: browse.browseId });
  }
  return artists;
}

function albumRunFromRuns(runs: unknown): { text: string; browseId: string } | null {
  for (const run of asArray(runs)) {
    const record = asRecord(run);
    if (!record) continue;
    const browse = parseEndpoint(record.navigationEndpoint).browse;
    if (!browse?.browseId) continue;
    if (browse.pageType === "MUSIC_PAGE_TYPE_ALBUM" || browse.pageType === "MUSIC_PAGE_TYPE_AUDIOBOOK" || browse.browseId.startsWith("MPREb_")) {
      const text = str(record.text);
      if (text) return { text, browseId: browse.browseId };
    }
  }
  return null;
}

const TIME_TEXT = /^(?:\d+:)?\d{1,2}:\d{2}$/;

function runTexts(runs: unknown): string[] {
  return asArray(runs).map(run => str(asRecord(run)?.text) ?? "").filter(Boolean);
}

function isExplicit(badges: unknown): boolean {
  return asArray(badges).some(badge => {
    const icon = asRecord(asRecord(badge)?.musicInlineBadgeRenderer)?.icon;
    return str(asRecord(icon)?.iconType) === "MUSIC_EXPLICIT_BADGE";
  });
}

function menuPlaylistId(renderer: Json, iconType: string): string | null {
  const menu = asRecord(renderer.menu)?.menuRenderer;
  for (const item of asArray(menu?.items)) {
    const nav = asRecord(asRecord(item)?.menuNavigationItemRenderer);
    if (str(asRecord(nav?.icon)?.iconType) === iconType) {
      return parseEndpoint(nav?.navigationEndpoint).watchPlaylist?.playlistId ?? null;
    }
  }
  return null;
}

function flexColumnText(renderer: Json, index: number): unknown {
  const column = asArray(renderer.flexColumns)[index];
  return asRecord(asRecord(column)?.musicResponsiveListItemFlexColumnRenderer)?.text?.runs ?? null;
}

function flexColumnsAll(renderer: Json): unknown[] {
  return asArray(renderer.flexColumns).map(
    column => asRecord(asRecord(column)?.musicResponsiveListItemFlexColumnRenderer)?.text?.runs ?? []
  );
}

/**
 * Parse a `musicResponsiveListItemRenderer` into a YTM item. Classification mirrors the
 * reference: pageType decides artist/album/playlist; a watch endpoint means playable media,
 * with MUSIC_VIDEO_TYPE_ATV marking a proper music track (song) rather than a plain video.
 */
export function parseListItem(renderer: Json): YtmItem | null {
  const title = runsText(flexColumnText(renderer, 0));
  if (!title) return null;
  const endpoint = parseEndpoint(renderer.navigationEndpoint);
  const watch = endpoint.watch ?? anyWatchEndpoint(renderer);
  const playlistItemData = asRecord(renderer.playlistItemData);
  const videoId = str(playlistItemData?.videoId) ?? watch?.videoId;
  const thumbnail = thumbnailFromRenderer(renderer.thumbnail);
  const columns = flexColumnsAll(renderer);
  const metaGroups = columns.slice(1);

  const browse = endpoint.browse;
  const pageType = browse?.pageType ?? null;

  if (watch && videoId) {
    const musicVideoType = watch.musicVideoType;
    const isSong = musicVideoType === "MUSIC_VIDEO_TYPE_ATV" || musicVideoType === null;
    // Metadata columns: artists are the runs that navigate to artist pages, the album is the run
    // navigating to an album page, duration is the timecode run.
    const metaRuns = metaGroups.flat();
    const artists = artistsFromRuns(metaRuns);
    const albumRun = albumRunFromRuns(metaRuns);
    const allText = runTexts(metaRuns).join(" ");
    const durationText = runTexts(metaRuns).find(text => TIME_TEXT.test(text)) ?? null;
    const viewCountText = runTexts(metaRuns).find(text => !TIME_TEXT.test(text) && /views?/i.test(text)) ?? null;
    const track: YtmTrack = {
      kind: isSong ? "song" : "video",
      videoId,
      title,
      artists,
      album: albumRun ? { title: albumRun.text, browseId: albumRun.browseId } : null,
      durationSeconds: parseTimeText(durationText),
      durationText,
      artworkUrl: thumbnail,
      explicit: isExplicit(renderer.badges),
      viewCountText,
      playlistId: watch.playlistId ?? str(playlistItemData?.playlistId),
      setVideoId: str(playlistItemData?.setVideoId) ?? watch.setVideoId,
    };
    return { type: track.kind === "song" ? "song" : "video", track };
  }

  if (browse?.browseId) {
    if (pageType === "MUSIC_PAGE_TYPE_ARTIST" || browse.browseId.startsWith("UC")) {
      const artist: YtmArtist = {
        browseId: browse.browseId,
        name: title,
        artworkUrl: thumbnail,
        subscriberCountText:
          splitBySeparator(metaGroups[0] ?? []).find(part => /subscribers?/i.test(part)) ?? null,
        shufflePlaylistId: menuPlaylistId(renderer, "MUSIC_SHUFFLE"),
        radioPlaylistId: menuPlaylistId(renderer, "MIX"),
      };
      return { type: "artist", artist };
    }
    if (pageType === "MUSIC_PAGE_TYPE_ALBUM" || pageType === "MUSIC_PAGE_TYPE_AUDIOBOOK" || browse.browseId.startsWith("MPREb_")) {
      const parts = metaGroups.map(group => splitBySeparator(group)).flat();
      const album: YtmAlbum = {
        browseId: browse.browseId,
        playlistId:
          watch?.playlistId ??
          menuPlaylistId(renderer, "MUSIC_SHUFFLE") ??
          (browse.browseId.startsWith("MPREb_") ? `OLAK5uy_${browse.browseId.slice(6)}` : null),
        title,
        artists: metaGroups.map(group => artistsFromRuns(group)).find(list => list.length > 0) ?? [],
        year: parts.map(part => Number(part)).find(value => Number.isInteger(value) && value >= 1900 && value <= 2100) ?? null,
        artworkUrl: thumbnail,
        explicit: isExplicit(renderer.badges),
        trackCountText: parts.find(part => /\d+\s+(songs|tracks)/i.test(part)) ?? null,
        albumType: parts.find(part => /album|single|ep/i.test(part)) ?? null,
      };
      return { type: "album", album };
    }
    if (pageType === "MUSIC_PAGE_TYPE_PLAYLIST" || browse.browseId.startsWith("VL")) {
      const playlistId = browse.browseId.replace(/^VL/, "");
      const playlist: YtmPlaylist = {
        id: playlistId,
        title,
        author: (metaGroups.map(group => artistsFromRuns(group)).find(list => list.length > 0) ?? [])[0] ?? null,
        trackCountText: splitBySeparator(metaGroups[metaGroups.length - 1] ?? []).find(part => /\d+\s+(songs|videos|tracks)/i.test(part)) ?? null,
        viewCountText: splitBySeparator(metaGroups.flat() as unknown[]).find(part => /views?/i.test(part)) ?? null,
        artworkUrl: thumbnail,
        shufflePlaylistId: menuPlaylistId(renderer, "MUSIC_SHUFFLE"),
        radioPlaylistId: menuPlaylistId(renderer, "MIX"),
      };
      return { type: "playlist", playlist };
    }
  }
  return null;
}

/** Parse a `musicTwoRowItemRenderer` card (carousel items: albums, artists, playlists). */
export function parseTwoRowItem(renderer: Json): YtmItem | null {
  const title = runsText(asRecord(renderer.title)?.runs);
  if (!title) return null;
  const endpoint = parseEndpoint(renderer.navigationEndpoint);
  const thumbnail = thumbnailFromRenderer(renderer.thumbnailRenderer ?? renderer.thumbnail);
  const subtitleParts = splitBySeparator(asRecord(renderer.subtitle)?.runs);
  const browse = endpoint.browse;
  const pageType = browse?.pageType ?? null;

  if (pageType === "MUSIC_PAGE_TYPE_ARTIST" || browse?.browseId?.startsWith("UC")) {
    const browseId = browse?.browseId;
    if (!browseId) return null;
    return {
      type: "artist",
      artist: {
        browseId,
        name: title,
        artworkUrl: thumbnail,
        subscriberCountText: subtitleParts.find(part => /subscribers?/i.test(part)) ?? null,
        shufflePlaylistId: menuPlaylistId(renderer, "MUSIC_SHUFFLE"),
        radioPlaylistId: menuPlaylistId(renderer, "MIX"),
      },
    };
  }
  if (pageType === "MUSIC_PAGE_TYPE_ALBUM" || browse?.browseId?.startsWith("MPREb_")) {
    if (!browse?.browseId) return null;
    return {
      type: "album",
      album: {
        browseId: browse.browseId,
        playlistId:
          endpoint.watch?.playlistId ??
          menuPlaylistId(renderer, "MUSIC_SHUFFLE") ??
          `OLAK5uy_${browse.browseId.replace(/^MPREb_/, "")}`,
        title,
        artists: artistsFromRuns(asRecord(renderer.subtitle)?.runs).length
          ? artistsFromRuns(asRecord(renderer.subtitle)?.runs)
          : subtitleParts.map(name => ({ name, browseId: null })),
        year: subtitleParts.map(part => Number(part)).find(v => Number.isInteger(v) && v >= 1900 && v <= 2100) ?? null,
        artworkUrl: thumbnail,
        explicit: isExplicit(renderer.badges),
        trackCountText: null,
        albumType: subtitleParts.find(part => /album|single|ep/i.test(part)) ?? null,
      },
    };
  }
  if (pageType === "MUSIC_PAGE_TYPE_PLAYLIST" || browse?.browseId?.startsWith("VL")) {
    const id = (browse?.browseId ?? "").replace(/^VL/, "");
    if (!id) return null;
    return {
      type: "playlist",
      playlist: {
        id,
        title,
        author: artistsFromRuns(asRecord(renderer.subtitle)?.runs)[0] ?? null,
        trackCountText: subtitleParts.find(part => /\d+\s+(songs|videos|tracks)/i.test(part)) ?? null,
        viewCountText: subtitleParts.find(part => /views?/i.test(part)) ?? null,
        artworkUrl: thumbnail,
        shufflePlaylistId: menuPlaylistId(renderer, "MUSIC_SHUFFLE"),
        radioPlaylistId: menuPlaylistId(renderer, "MIX"),
      },
    };
  }
  // Two-row items that point at a watch endpoint are effectively songs/videos.
  const watch = endpoint.watch ?? anyWatchEndpoint(renderer);
  if (watch?.videoId) {
    const track: YtmTrack = {
      kind: watch.musicVideoType === "MUSIC_VIDEO_TYPE_ATV" || !watch.musicVideoType ? "song" : "video",
      videoId: watch.videoId,
      title,
      artists: artistsFromRuns(asRecord(renderer.subtitle)?.runs),
      album: null,
      durationSeconds: null,
      durationText: subtitleParts.find(part => parseTimeText(part)) ?? null,
      artworkUrl: thumbnail,
      explicit: isExplicit(renderer.badges),
      viewCountText: null,
      playlistId: watch.playlistId,
      setVideoId: null,
    };
    return { type: track.kind === "song" ? "song" : "video", track };
  }
  return null;
}

/** Parse a `musicCardShelfRenderer` (search "top result"). */
export function parseCardShelf(renderer: Json): YtmItem | null {
  const title = textOf(renderer.title);
  if (!title) return null;
  const endpoint = parseEndpoint(renderer.onTap ?? renderer.navigationEndpoint);
  const thumbnail = thumbnailFromRenderer(renderer.thumbnail);
  const subtitleParts = splitBySeparator(asRecord(renderer.subtitle)?.runs ?? asRecord(renderer.header)?.runs);
  if (endpoint.watch?.videoId) {
    const track: YtmTrack = {
      kind: endpoint.watch.musicVideoType === "MUSIC_VIDEO_TYPE_ATV" || !endpoint.watch.musicVideoType ? "song" : "video",
      videoId: endpoint.watch.videoId,
      title,
      artists: artistsFromRuns(asRecord(renderer.subtitle)?.runs),
      album: null,
      durationSeconds: null,
      durationText: null,
      artworkUrl: thumbnail,
      explicit: false,
      viewCountText: null,
      playlistId: endpoint.watch.playlistId,
      setVideoId: null,
    };
    return { type: track.kind === "song" ? "song" : "video", track };
  }
  const browse = endpoint.browse;
  if (browse?.browseId?.startsWith("UC") || browse?.pageType === "MUSIC_PAGE_TYPE_ARTIST") {
    const browseId = browse.browseId;
    if (!browseId) return null;
    return {
      type: "artist",
      artist: {
        browseId,
        name: title,
        artworkUrl: thumbnail,
        subscriberCountText: subtitleParts.find(part => /subscribers?/i.test(part)) ?? null,
        shufflePlaylistId: null,
        radioPlaylistId: null,
      },
    };
  }
  if (browse?.browseId) {
    const twoRow: Json = {
      title: { runs: [{ text: title }] },
      subtitle: asRecord(renderer.subtitle),
      navigationEndpoint: renderer.onTap ?? renderer.navigationEndpoint,
      thumbnailRenderer: renderer.thumbnail,
    };
    return parseTwoRowItem(twoRow);
  }
  return null;
}

/* ------------------------------------------------------------ continuations */

export function continuationToken(node: unknown): string | null {
  const list = Array.isArray(node) ? node : asArray(asRecord(node)?.continuations);
  for (const cont of list) {
    const token = str(
      asRecord(asRecord(cont)?.continuationItemRenderer)?.continuationEndpoint
        ? (asRecord(asRecord(asRecord(cont)?.continuationItemRenderer)?.continuationEndpoint) as Json)
            ?.continuationCommand
          ? str(
              asRecord(
                asRecord(asRecord(asRecord(cont)?.continuationItemRenderer)?.continuationEndpoint)?.continuationCommand
              )?.token
            )
          : null
        : null
    );
    if (token) return token;
  }
  return null;
}

/* ------------------------------------------------------------ pages */

function parseShelfContents(contents: unknown[]): { items: YtmItem[]; continuation: string | null } {
  const items: YtmItem[] = [];
  for (const entry of contents) {
    const record = asRecord(entry);
    if (!record) continue;
    const listItem = asRecord(record.musicResponsiveListItemRenderer);
    if (listItem) {
      const parsed = parseListItem(listItem);
      if (parsed) items.push(parsed);
      continue;
    }
    const twoRow = asRecord(record.musicTwoRowItemRenderer);
    if (twoRow) {
      const parsed = parseTwoRowItem(twoRow);
      if (parsed) items.push(parsed);
      continue;
    }
    const card = asRecord(record.musicCardShelfRenderer);
    if (card) {
      const parsed = parseCardShelf(card);
      if (parsed) items.push(parsed);
    }
  }
  return { items, continuation: continuationToken(contents) };
}

function carouselHeader(renderer: Json): { title: string | null; moreBrowseId: string | null; moreParams: string | null } {
  const header = asRecord(asRecord(renderer.header)?.musicCarouselShelfBasicHeaderRenderer);
  const more = asRecord(asRecord(header?.moreContentButton)?.buttonRenderer);
  const moreBrowse = more ? parseEndpoint(more.navigationEndpoint).browse : null;
  return {
    title: runsText(header?.title?.runs) || null,
    moreBrowseId: moreBrowse?.browseId ?? null,
    moreParams: moreBrowse?.params ?? null,
  };
}

function parseShelf(section: Json): YtmShelf | null {
  const shelf = asRecord(section.musicShelfRenderer);
  if (shelf) {
    const { items, continuation } = parseShelfContents(asArray(shelf.contents));
    return {
      title: runsText(asRecord(shelf.title)?.runs) || null,
      subtitle: null,
      items,
      continuation,
      moreBrowseId: null,
      moreParams: null,
    };
  }
  const carousel = asRecord(section.musicCarouselShelfRenderer);
  if (carousel) {
    const header = carouselHeader(carousel);
    const { items } = parseShelfContents(asArray(carousel.contents));
    return {
      title: header.title,
      subtitle: null,
      items,
      continuation: null,
      moreBrowseId: header.moreBrowseId,
      moreParams: header.moreParams,
    };
  }
  const cardShelf = asRecord(section.musicCardShelfRenderer);
  if (cardShelf) {
    const parsed = parseCardShelf(cardShelf);
    const header = asRecord(asRecord(cardShelf.header)?.musicCardShelfHeaderBasicRenderer);
    return {
      title: runsText(header?.title?.runs) || null,
      subtitle: null,
      items: parsed ? [parsed] : [],
      continuation: null,
      moreBrowseId: null,
      moreParams: null,
    };
  }
  const description = asRecord(section.musicDescriptionShelfRenderer);
  if (description) {
    return {
      title: runsText(asRecord(description.title)?.runs) || null,
      subtitle: runsText(asRecord(description.description)?.runs) || null,
      items: [],
      continuation: null,
      moreBrowseId: null,
      moreParams: null,
    };
  }
  return null;
}

function sectionListOf(response: unknown): { contents: unknown[]; continuation: string | null; chips: YtmHomeChip[] } {
  const sectionList = firstRenderer(response, "sectionListRenderer");
  const header = asRecord(sectionList?.header);
  const chips: YtmHomeChip[] = asArray(asRecord(header?.chipCloudRenderer)?.chips).map(chip => {
    const record = asRecord(chip)?.chipCloudChipRenderer ?? asRecord(chip);
    return {
      title: runsText(asRecord(record?.text)?.runs) || str(record?.text) || "",
      params: parseEndpoint(record?.navigationEndpoint).browse?.params ?? null,
      selected: Boolean(record?.isSelected),
    };
  });
  return {
    contents: asArray(sectionList?.contents),
    continuation: continuationToken(sectionList?.continuations),
    chips,
  };
}

function shelvesOf(contents: unknown[]): YtmShelf[] {
  return contents.map(entry => (asRecord(entry) ? parseShelf(asRecord(entry) as Json) : null)).filter(
    (shelf): shelf is YtmShelf => Boolean(shelf)
  );
}

/** Home feed (`browse` FEmusic_home), including continuation responses. */
export function parseHomePage(response: unknown, continuationResponse = false): YtmHomePage {
  if (continuationResponse) {
    const cont = asRecord(asRecord(response)?.continuationContents)?.sectionListContinuation;
    const contents = asArray(cont?.contents);
    const sections = shelvesOf(contents);
    return {
      chips: [],
      sections,
      continuation: sections.length ? continuationToken(cont?.continuations) : null,
    };
  }
  const { contents, continuation, chips } = sectionListOf(response);
  return { chips, sections: shelvesOf(contents), continuation };
}

/** Search results for one filter. */
export function parseSearchResponse(response: unknown, filter: YtmSearchFilter): YtmSearchResults {
  const tabbed = firstRenderer(response, "tabbedSearchResultsRenderer");
  const tabs = asArray(asRecord(tabbed)?.tabs);
  const selectedTab =
    tabs.map(tab => asRecord(asRecord(tab)?.tabRenderer)).find(tab => tab?.selected) ??
    asRecord(asRecord(tabs[0])?.tabRenderer);
  const sectionList = asRecord(asRecord(selectedTab?.content)?.sectionListRenderer);
  const contents = asArray(sectionList?.contents);

  let topResult: YtmItem | null = null;
  const items: YtmItem[] = [];
  let continuation: string | null = null;
  for (const entry of contents) {
    const record = asRecord(entry);
    if (!record) continue;
    const card = asRecord(record.musicCardShelfRenderer);
    if (card && !topResult) {
      topResult = parseCardShelf(card);
      continue;
    }
    const shelf = asRecord(record.musicShelfRenderer);
    if (shelf) {
      const parsed = parseShelfContents(asArray(shelf.contents));
      items.push(...parsed.items);
      continuation = continuation || parsed.continuation;
      continue;
    }
    const carousel = asRecord(record.musicCarouselShelfRenderer);
    if (carousel) {
      items.push(...parseShelfContents(asArray(carousel.contents)).items);
      continue;
    }
    const single = parseShelf(record);
    if (single) items.push(...single.items);
  }
  continuation = continuation || continuationToken(sectionList?.continuations);
  return { filter, topResult, items, continuation };
}

/** Search suggestions (`music/get_search_suggestions`). */
export function parseSuggestions(response: unknown): YtmSuggestions {
  const sections = collectRenderers(response, "searchSuggestionsSectionRenderer");
  const queries: string[] = [];
  const items: YtmItem[] = [];
  for (const section of sections) {
    for (const content of asArray(section.contents)) {
      const record = asRecord(content);
      if (!record) continue;
      const suggestion = asRecord(record.searchSuggestionRenderer);
      if (suggestion) {
        const text = runsText(asRecord(suggestion.suggestion)?.runs);
        if (text) queries.push(text);
        continue;
      }
      const listItem = asRecord(record.musicResponsiveListItemRenderer);
      if (listItem) {
        const parsed = parseListItem(listItem);
        if (parsed) items.push(parsed);
      }
    }
  }
  return { queries, items };
}

function headerOf(response: unknown): Json | null {
  return firstRenderer(
    response,
    "musicImmersiveHeaderRenderer",
    "musicVisualHeaderRenderer",
    "musicDetailHeaderRenderer",
    "musicEditablePlaylistDetailHeaderRenderer",
    "playlistHeaderRenderer"
  );
}

/** Artist page (`browse` UC…). */
export function parseArtistPage(response: unknown, browseId: string): YtmArtistPage {
  const header = headerOf(response);
  const name =
    runsText(asRecord(header?.title)?.runs) ||
    str(asRecord(header?.title)?.text) ||
    "Unknown artist";
  const artworkUrl = thumbnailFromRenderer(asRecord(header?.thumbnail)?.musicThumbnailRenderer ?? header?.thumbnail);
  const subtitleParts = splitBySeparator(asRecord(header?.subtitle)?.runs);
  const description =
    runsText(asRecord(header?.description)?.runs) ||
    (() => {
      const desc = firstRenderer(response, "musicDescriptionShelfRenderer");
      return desc ? runsText(asRecord(desc.description)?.runs) || null : null;
    })();

  // Shelves live in the first tab's section list; continuations may hang off the section list.
  const sectionList = firstRenderer(response, "sectionListRenderer");
  const contents = asArray(sectionList?.contents);
  const shelves = shelvesOf(contents);
  return {
    browseId,
    name,
    artworkUrl,
    description,
    subscriberCountText: subtitleParts.find(part => /subscribers?/i.test(part)) ?? null,
    shufflePlaylistId: null,
    radioPlaylistId: null,
    shelves,
    continuation: continuationToken(sectionList?.continuations),
  };
}

/** Artist shelf continuation (e.g. paging "Songs"). */
export function parseArtistContinuation(response: unknown): { shelves: YtmShelf[]; continuation: string | null } {
  const cont = asRecord(asRecord(response)?.continuationContents);
  const sectionCont = asRecord(cont?.sectionListContinuation);
  const musicShelfCont = asRecord(cont?.musicShelfContinuation) ?? asRecord(cont?.musicCarouselShelfContinuation);
  const contents = asArray(sectionCont?.contents ?? musicShelfCont?.contents);
  const shelves = shelvesOf(contents);
  if (shelves.length === 0 && musicShelfCont) {
    const { items, continuation } = parseShelfContents(asArray(musicShelfCont.contents));
    return {
      shelves: [{ title: null, subtitle: null, items, continuation, moreBrowseId: null, moreParams: null }],
      continuation: continuationToken(musicShelfCont.continuations),
    };
  }
  return { shelves, continuation: continuationToken(sectionCont?.continuations ?? musicShelfCont?.continuations) };
}

/** Album page (`browse` MPREb_…). */
export function parseAlbumPage(response: unknown, browseId: string): YtmAlbumPage {
  const header =
    firstRenderer(response, "musicResponsiveHeaderRenderer") ?? headerOf(response);
  const title = runsText(asRecord(header?.title)?.runs) || str(asRecord(header?.title)?.text) || "Unknown album";
  const subtitleParts = splitBySeparator(asRecord(header?.subtitle)?.runs);
  const artists = artistsFromRuns(asRecord(header?.subtitle)?.runs);
  const artworkUrl = thumbnailFromRenderer(header?.thumbnail);
  const description = (() => {
    const desc = firstRenderer(response, "musicDescriptionShelfRenderer");
    return desc ? runsText(asRecord(desc.description)?.runs) || null : null;
  })();

  const { contents, continuation } = sectionListOf(response);
  const tracks: YtmTrack[] = [];
  for (const shelf of shelvesOf(contents)) {
    for (const item of shelf.items) {
      if (item.type === "song" || item.type === "video") tracks.push(item.track);
    }
  }
  // Album header also carries a subtitle line like "Artist • Album • 2019" and a track count.
  return {
    browseId,
    title,
    artists,
    year: subtitleParts.map(p => Number(p)).find(v => Number.isInteger(v) && v >= 1900 && v <= 2100) ?? null,
    artworkUrl,
    description,
    trackCountText: subtitleParts.find(p => /\d+\s+(songs|tracks)/i.test(p)) ?? null,
    durationText: subtitleParts.find(p => /\d+\s+(min|minutes|hr|hours)/i.test(p)) ?? null,
    tracks,
    continuation,
  };
}

/** Playlist page (`browse` VL<id>). */
export function parsePlaylistPage(response: unknown, playlistId: string): YtmPlaylistPage {
  const header =
    firstRenderer(response, "musicEditablePlaylistDetailHeaderRenderer") ??
    firstRenderer(response, "playlistHeaderRenderer") ??
    headerOf(response);
  const title =
    runsText(asRecord(header?.title)?.runs) ??
    (() => {
      const t = asRecord(header?.title);
      return t ? str(t.text) ?? runsText(t.runs) : null;
    })() ??
    "Playlist";
  const subtitleRuns = asRecord(header?.subtitle)?.runs ?? asRecord(header?.secondSubtitle)?.runs;
  const subtitleParts = splitBySeparator(subtitleRuns);
  const author = artistsFromRuns(subtitleRuns)[0] ?? null;
  const artworkUrl = thumbnailFromRenderer(asRecord(header?.thumbnail) ?? header?.coverArt ?? header);
  const description = (() => {
    const desc = firstRenderer(response, "musicDescriptionShelfRenderer");
    return desc ? runsText(asRecord(desc.description)?.runs) || null : null;
  })();

  // Tracks: a musicPlaylistShelfRenderer or musicShelfRenderer of list items.
  const playlistShelf = firstRenderer(response, "musicPlaylistShelfRenderer");
  const shelfContents = asArray(playlistShelf?.contents);
  const { items, continuation: shelfContinuation } = parseShelfContents(shelfContents);
  const shelfOwnContinuation = continuationToken(playlistShelf);
  const tracks: YtmTrack[] = [];
  for (const item of items) {
    if (item.type === "song" || item.type === "video") tracks.push(item.track);
  }
  const { continuation: sectionContinuation } = sectionListOf(response);
  return {
    id: playlistId,
    title,
    author,
    description,
    trackCountText: subtitleParts.find(p => /\d+\s+(songs|videos|tracks)/i.test(p)) ?? null,
    viewCountText: subtitleParts.find(p => /views?/i.test(p)) ?? null,
    artworkUrl,
    tracks,
    continuation: shelfContinuation || shelfOwnContinuation || sectionContinuation,
  };
}

/** Charts (`browse` FEmusic_charts). */
export function parseChartsPage(response: unknown, continuationResponse = false): YtmChartsPage {
  if (continuationResponse) {
    const cont = asRecord(asRecord(response)?.continuationContents)?.sectionListContinuation;
    return {
      shelves: shelvesOf(asArray(cont?.contents)),
      continuation: continuationToken(cont?.continuations),
    };
  }
  const { contents, continuation } = sectionListOf(response);
  return { shelves: shelvesOf(contents), continuation };
}

/** Explore (`browse` FEmusic_explore). */
export function parseExplorePage(response: unknown): YtmExplorePage {
  const { contents } = sectionListOf(response);
  const newReleaseAlbums: YtmAlbum[] = [];
  const moodAndGenres: YtmMoodOrGenre[] = [];
  const shelves: YtmShelf[] = [];
  for (const entry of contents) {
    const record = asRecord(entry);
    if (!record) continue;
    const carousel = asRecord(record.musicCarouselShelfRenderer);
    if (carousel) {
      const header = carouselHeader(carousel);
      if (header.moreBrowseId === "FEmusic_new_releases_albums" || header.moreBrowseId === "FEmusic_new_releases") {
        for (const item of parseShelfContents(asArray(carousel.contents)).items) {
          if (item.type === "album") newReleaseAlbums.push(item.album);
        }
        shelves.push({ ...parseShelf(record)!, items: parseShelfContents(asArray(carousel.contents)).items });
        continue;
      }
      if (header.moreBrowseId === "FEmusic_moods_and_genres") {
        for (const content of asArray(carousel.contents)) {
          const button = asRecord(asRecord(content)?.musicNavigationButtonRenderer);
          if (!button) continue;
          const browse = parseEndpoint(button.navigationEndpoint).browse;
          const title = runsText(asRecord(button.buttonText)?.runs);
          if (title) moodAndGenres.push({ title, browseId: browse?.browseId ?? null, params: browse?.params ?? null });
        }
        continue;
      }
      const shelf = parseShelf(record);
      if (shelf) shelves.push(shelf);
      continue;
    }
    const shelf = parseShelf(record);
    if (shelf) shelves.push(shelf);
  }
  return { newReleaseAlbums, moodAndGenres, shelves };
}

/** Moods & genres grid (`browse` FEmusic_moods_and_genres). */
export function parseMoodsAndGenres(response: unknown): YtmMoodOrGenre[] {
  const buttons = collectRenderers(response, "musicNavigationButtonRenderer");
  const result: YtmMoodOrGenre[] = [];
  const seen = new Set<string>();
  for (const button of buttons) {
    const title = runsText(asRecord(button.buttonText)?.runs);
    const browse = parseEndpoint(button.navigationEndpoint).browse;
    if (!title || !browse?.browseId || seen.has(browse.browseId)) continue;
    seen.add(browse.browseId);
    result.push({ title, browseId: browse.browseId, params: browse.params });
  }
  return result;
}

/** A generic browse page → shelves (mood/genre category pages, new releases, etc.). */
export function parseBrowseShelves(response: unknown): YtmChartsPage {
  return parseChartsPage(response);
}

/* ------------------------------------------------------------ next / queue / lyrics */

/** `next` response: queue panel tracks plus the lyrics tab endpoint. */
export function parseNextResponse(response: unknown): YtmQueueResult {
  const watchNext = asRecord(asRecord(asRecord(response)?.contents)?.singleColumnMusicWatchNextResultsRenderer);
  const allTabs = asArray(asRecord(asRecord(watchNext?.tabbedRenderer)?.watchNextTabbedResultsRenderer)?.tabs);
  let lyricsBrowseId: string | null = null;
  let lyricsParams: string | null = null;
  for (const tab of allTabs) {
    const tabRenderer = asRecord(asRecord(tab)?.tabRenderer);
    const tabTitle = runsText(asRecord(tabRenderer?.title)?.runs) || str(tabRenderer?.title);
    const browse = parseEndpoint(tabRenderer?.endpoint).browse;
    if (browse && (tabTitle === "Lyrics" || browse.browseId === "LYRICS" || /lyrics/i.test(tabTitle ?? ""))) {
      lyricsBrowseId = browse.browseId;
      lyricsParams = browse.params;
    }
  }

  const panel = firstRenderer(response, "playlistPanelRenderer");
  const tracks: YtmTrack[] = [];
  let currentIndex: number | null = null;
  asArray(panel?.contents).forEach((content, index) => {
    const renderer = asRecord(asRecord(content)?.playlistPanelVideoRenderer);
    if (!renderer) return;
    const watch = parseEndpoint(renderer.navigationEndpoint).watch ?? anyWatchEndpoint(renderer);
    const videoId = str(asRecord(renderer.videoId) ? renderer.videoId : null) ?? watch?.videoId;
    if (!videoId) return;
    const title = runsText(asRecord(renderer.title)?.runs);
    const artists = artistsFromRuns(asRecord(asRecord(renderer.longBylineText)?.runs));
    const durationText =
      runsText(asRecord(renderer.lengthText)?.runs) || null;
    const track: YtmTrack = {
      kind: watch?.musicVideoType === "MUSIC_VIDEO_TYPE_OMV" || watch?.musicVideoType === "MUSIC_VIDEO_TYPE_UGC" ? "video" : "song",
      videoId,
      title: title || "Unknown title",
      artists,
      album: null,
      durationSeconds: parseTimeText(durationText),
      durationText,
      artworkUrl: thumbnailFromRenderer(renderer.thumbnail),
      explicit: isExplicit(renderer.badges),
      viewCountText: null,
      playlistId: watch?.playlistId ?? null,
      setVideoId: null,
    };
    if (renderer.selected) currentIndex = index;
    tracks.push(track);
  });
  const title = runsText(
    asRecord(asRecord(firstRenderer(response, "musicQueueHeaderRenderer"))?.subtitle)?.runs
  );
  return {
    title: title || null,
    tracks,
    currentIndex,
    continuation: continuationToken(panel?.continuations),
    lyricsBrowseId,
    lyricsParams,
  };
}

/** Lyrics text from a lyrics browse response (`musicDescriptionShelfRenderer`). */
export function parseLyricsResponse(response: unknown): string | null {
  const shelf = firstRenderer(response, "musicDescriptionShelfRenderer");
  if (!shelf) return null;
  const text = runsText(asRecord(shelf.description)?.runs);
  return text || null;
}

/* ------------------------------------------------------------ player */

function parseFormat(format: Json): YtmStreamFormat {
  const streamingData = format;
  return {
    itag: num(format.itag) ?? 0,
    url: str(format.url) ?? null,
    signatureCipher: str(format.signatureCipher) ?? null,
    mimeType: str(format.mimeType) ?? "",
    bitrate: num(format.bitrate) ?? 0,
    contentLength: num(format.contentLength),
    audioQuality: str(format.audioQuality),
    approxDurationMs: num(format.approxDurationMs),
  };
}

/**
 * Parse the `player` response into stream candidates. Only formats that carry a direct `url`
 * are usable: Cadence never deciphers `signatureCipher` and never attaches PO tokens, so those
 * formats are reported with `url: null` and drive `requiresDeciphering`.
 */
export function parsePlayerResponse(response: unknown, videoId: string): YtmPlayerResult {
  const record = asRecord(response);
  const playability = asRecord(record?.playabilityStatus);
  const status = str(playability?.status) ?? "UNKNOWN";
  const details = asRecord(record?.videoDetails);
  const streamingData = asRecord(record?.streamingData);
  const formats = [
    ...asArray(streamingData?.formats).map(asRecord).filter(Boolean),
    ...asArray(streamingData?.adaptiveFormats).map(asRecord).filter(Boolean),
  ] as Json[];
  const audioFormats = formats
    .filter(format => (str(format.mimeType) ?? "").startsWith("audio/"))
    .map(parseFormat)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const hasDirectStream = audioFormats.some(format => format.url !== null);
  return {
    videoId,
    status: status as YtmPlayerResult["status"],
    reason: str(playability?.reason) ?? (status === "OK" ? null : status),
    title: str(details?.title) ?? null,
    author: str(details?.author) ?? null,
    channelId: str(details?.channelId) ?? null,
    durationSeconds: (() => {
      const seconds = Number(str(details?.lengthSeconds));
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    })(),
    audioFormats,
    hasDirectStream,
    requiresDeciphering: audioFormats.length > 0 && !hasDirectStream,
  };
}
