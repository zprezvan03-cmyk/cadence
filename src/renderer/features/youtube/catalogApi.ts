/**
 * Renderer-side adapter for the desktop bridge's official YouTube catalog.
 *
 * Components should use these helpers rather than calling the bridge directly: successful
 * results are remembered in the bounded in-memory registry, and a missing/older bridge in a
 * browser harness degrades to an explicit unavailable state without breaking local surfaces.
 */

import { bridge } from "../../state/bridge";
import { useRemoteMedia } from "../../state/remoteMediaStore";
import type {
  CatalogPage,
  MediaItem,
  YouTubeCatalogPageRequest,
  YouTubeCatalogResult,
  YouTubeCatalogSearchRequest,
  YouTubeCatalogStatus,
  YouTubeChannelDetail,
  YouTubeChannelItem,
  YouTubePlaylistDetail,
  YouTubePlaylistSummary,
} from "../../../shared/types";

type CatalogApi = typeof bridge.youtubeCatalog;

function unavailable<T>(): YouTubeCatalogResult<T> {
  return {
    ok: false,
    error: {
      kind: "unavailable",
      message: "The YouTube catalog bridge is unavailable in this Cadence runtime.",
    },
  };
}

async function callCatalog<T>(
  operation: (api: CatalogApi) => Promise<YouTubeCatalogResult<T>>
): Promise<YouTubeCatalogResult<T>> {
  try {
    const api = (bridge as Partial<typeof bridge>).youtubeCatalog;
    if (!api) return unavailable<T>();
    const result = await operation(api);
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
      return unavailable<T>();
    }
    return result;
  } catch {
    return unavailable<T>();
  }
}

export async function getYouTubeCatalogStatus(): Promise<YouTubeCatalogStatus | null> {
  try {
    const api = (bridge as Partial<typeof bridge>).youtubeCatalog;
    return api ? await api.status() : null;
  } catch {
    return null;
  }
}

export async function clearYouTubeCatalogCache(): Promise<number> {
  try {
    const api = (bridge as Partial<typeof bridge>).youtubeCatalog;
    if (!api) return 0;
    const result = await api.clearCache();
    useRemoteMedia.getState().clear();
    return result.cleared;
  } catch {
    return 0;
  }
}

export async function searchYouTubeMusicVideos(
  request: YouTubeCatalogSearchRequest
): Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>> {
  const result = await callCatalog(api => api.searchMusicVideos(request));
  if (result.ok) useRemoteMedia.getState().rememberVideos(result.data.items);
  return result;
}

export async function searchYouTubeChannels(
  request: YouTubeCatalogSearchRequest
): Promise<YouTubeCatalogResult<CatalogPage<YouTubeChannelItem>>> {
  const result = await callCatalog(api => api.searchChannels(request));
  if (result.ok) useRemoteMedia.getState().rememberChannels(result.data.items);
  return result;
}

export async function searchYouTubePlaylists(
  request: YouTubeCatalogSearchRequest
): Promise<YouTubeCatalogResult<CatalogPage<YouTubePlaylistSummary>>> {
  const result = await callCatalog(api => api.searchPlaylists(request));
  if (result.ok) useRemoteMedia.getState().rememberPlaylists(result.data.items);
  return result;
}

export async function getYouTubeTrending(
  request: YouTubeCatalogPageRequest = {}
): Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>> {
  const result = await callCatalog(api => api.trending(request));
  if (result.ok) useRemoteMedia.getState().rememberVideos(result.data.items);
  return result;
}

export async function getYouTubeChannel(
  channelId: string
): Promise<YouTubeCatalogResult<YouTubeChannelDetail>> {
  const result = await callCatalog(api => api.getChannel({ channelId }));
  if (result.ok) {
    const registry = useRemoteMedia.getState();
    registry.rememberChannels([result.data.channel]);
    registry.rememberPlaylists(result.data.playlists);
    registry.rememberVideos(result.data.uploads.items);
  }
  return result;
}

export async function getYouTubePlaylist(
  playlistId: string
): Promise<YouTubeCatalogResult<YouTubePlaylistDetail>> {
  const result = await callCatalog(api => api.getPlaylist({ playlistId }));
  if (result.ok) useRemoteMedia.getState().rememberPlaylists([result.data.playlist]);
  return result;
}

export async function getYouTubePlaylistItems(
  playlistId: string,
  pageToken?: string | null,
  maxResults?: number
): Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>> {
  const result = await callCatalog(api =>
    api.getPlaylistItems({ playlistId, pageToken, maxResults })
  );
  if (result.ok) useRemoteMedia.getState().rememberVideos(result.data.items);
  return result;
}
