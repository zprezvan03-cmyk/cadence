/**
 * User-supplied YouTube Data API v3 catalog settings.
 *
 * Cadence ships no shared Google API key and has no YouTube/Google account sign-in. The key
 * entered here stays in Cadence's local settings and is only used by the desktop bridge for
 * documented public catalog requests. Search quota belongs to the user's Google Cloud project.
 */

import { useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import type { YouTubeCatalogSettings as YouTubeCatalogSettingsValues } from "../../../shared/types";
import {
  clearYouTubeCatalogCache,
  getYouTubeCatalogStatus,
  getYouTubeTrending,
} from "../youtube/catalogApi";

interface Props {
  settings: YouTubeCatalogSettingsValues;
  patchSettings: (patch: {
    youtubeCatalog: Partial<YouTubeCatalogSettingsValues>;
  }) => Promise<void>;
  showToast: (message: string) => void;
}

async function openExternal(url: string): Promise<void> {
  if (window.cadence?.app?.openExternal) {
    await window.cadence.app.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function YouTubeCatalogSettings({ settings, patchSettings, showToast }: Props) {
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [region, setRegion] = useState(settings.region);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "clear" | "remove" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cacheEntries, setCacheEntries] = useState<number | null>(null);
  const [resolvedRegion, setResolvedRegion] = useState(settings.region || "");

  useEffect(() => setApiKey(settings.apiKey), [settings.apiKey]);
  useEffect(() => setRegion(settings.region), [settings.region]);

  useEffect(() => {
    let cancelled = false;
    void getYouTubeCatalogStatus().then(status => {
      if (cancelled || !status) return;
      setCacheEntries(status.cacheEntries);
      setResolvedRegion(status.region);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.enabled, settings.apiKey, settings.region]);

  const normalizedKey = apiKey.replace(/\s+/g, "");
  const normalizedRegion = region.trim().toUpperCase();
  const changed = normalizedKey !== settings.apiKey || normalizedRegion !== settings.region;
  const configured = settings.enabled && Boolean(settings.apiKey);

  const validateRegion = (): boolean => {
    if (!normalizedRegion || /^[A-Z]{2}$/.test(normalizedRegion)) return true;
    setError("Region must be a two-letter country code such as ID, US or JP, or blank for Auto.");
    return false;
  };

  const save = async (enable?: boolean): Promise<boolean> => {
    if (!validateRegion()) return false;
    await patchSettings({
      youtubeCatalog: {
        apiKey: normalizedKey,
        region: normalizedRegion,
        ...(enable !== undefined ? { enabled: enable } : {}),
      },
    });
    const status = await getYouTubeCatalogStatus();
    if (status) {
      setCacheEntries(status.cacheEntries);
      setResolvedRegion(status.region);
    }
    return true;
  };

  const onSave = async () => {
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      if (await save()) setMessage("YouTube catalog settings saved on this computer.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save those settings.");
    } finally {
      setBusy(null);
    }
  };

  const onTest = async () => {
    if (!normalizedKey) {
      setError("Paste a YouTube Data API v3 key first.");
      return;
    }
    setBusy("test");
    setError(null);
    setMessage(null);
    try {
      if (!(await save(true))) return;
      const result = await getYouTubeTrending({ maxResults: 1 });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const status = await getYouTubeCatalogStatus();
      if (status) {
        setCacheEntries(status.cacheEntries);
        setResolvedRegion(status.region);
      }
      setMessage(
        result.data.items[0]
          ? `Catalog connected. Trending test returned “${result.data.items[0].title}”.`
          : "Catalog connected. YouTube returned no trending music videos for this region."
      );
      showToast("YouTube catalog connected");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "The catalog test failed.");
    } finally {
      setBusy(null);
    }
  };

  const onClearCache = async () => {
    setBusy("clear");
    setError(null);
    try {
      const cleared = await clearYouTubeCatalogCache();
      setCacheEntries(0);
      setMessage(`Cleared ${cleared} in-memory YouTube catalog entr${cleared === 1 ? "y" : "ies"}.`);
    } finally {
      setBusy(null);
    }
  };

  const onRemoveKey = async () => {
    setBusy("remove");
    setError(null);
    setMessage(null);
    try {
      await patchSettings({ youtubeCatalog: { apiKey: "", enabled: false } });
      await clearYouTubeCatalogCache();
      setApiKey("");
      setCacheEntries(0);
      setMessage("API key removed from Cadence settings. Revoke it in Google Cloud if it should no longer exist.");
      showToast("YouTube API key removed");
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove the API key.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-subsection youtube-catalog-settings" data-testid="settings-youtube-catalog">
      <h3>YouTube catalog</h3>
      <label className="setting-row">
        <span>
          <strong>Enable public YouTube catalog</strong>
          <em>
            Adds account-free YouTube music videos, channels and public playlists to Search and
            Home. Playback uses YouTube’s official visible player; Cadence never asks for a
            Google login, cookie or password.
          </em>
        </span>
        <input
          type="checkbox"
          checked={settings.enabled}
          data-testid="youtube-catalog-enabled"
          onChange={event =>
            void patchSettings({ youtubeCatalog: { enabled: event.target.checked } })
          }
        />
      </label>

      <label className="setting-row youtube-catalog-field">
        <span>
          <strong>YouTube Data API v3 key</strong>
          <em>
            Create your own key in Google Cloud, enable YouTube Data API v3, and add an API
            restriction for that API only. Do not add a website/referer application restriction:
            Cadence is a desktop app. The key is stored locally in Cadence settings—never send
            it to Cadence support or paste it into chat.
          </em>
        </span>
        <span className="youtube-key-input">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder="Your YouTube Data API v3 key"
            data-testid="youtube-catalog-api-key"
            onChange={event => setApiKey(event.target.value)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={showKey ? "Hide API key" : "Show API key"}
            onClick={() => setShowKey(value => !value)}
          >
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </span>
      </label>

      <label className="setting-row youtube-catalog-field">
        <span>
          <strong>Catalog region</strong>
          <em>
            Two-letter country code used for charts and regional search. Leave blank to use the
            system region{resolvedRegion ? ` (currently ${resolvedRegion})` : ""}.
          </em>
        </span>
        <input
          type="text"
          value={region}
          maxLength={2}
          autoComplete="off"
          spellCheck={false}
          placeholder="Auto"
          data-testid="youtube-catalog-region"
          onChange={event => setRegion(event.target.value.toUpperCase())}
        />
      </label>

      <div className="setting-row youtube-catalog-actions">
        <span>
          <strong>{configured ? "Catalog configured" : "Catalog not configured"}</strong>
          <em>
            {configured
              ? `Region ${resolvedRegion || settings.region || "Auto"} · ${cacheEntries ?? "…"} in-memory cache entries.`
              : "Local library, local search and local playback do not need a key."}
          </em>
        </span>
        <span className="youtube-catalog-buttons">
          <button
            type="button"
            onClick={() =>
              void openExternal("https://console.cloud.google.com/apis/credentials")
            }
          >
            <ExternalLink size={14} /> Google Cloud keys
          </button>
          {changed ? (
            <button type="button" onClick={() => void onSave()} disabled={busy !== null}>
              Save
            </button>
          ) : null}
          <button
            type="button"
            className="primary"
            data-testid="youtube-catalog-test"
            onClick={() => void onTest()}
            disabled={busy !== null || !normalizedKey}
          >
            <KeyRound size={14} /> {busy === "test" ? "Testing…" : "Save & test"}
          </button>
          <button type="button" onClick={() => void onClearCache()} disabled={busy !== null}>
            <RefreshCw size={14} /> Clear cache
          </button>
          {settings.apiKey || normalizedKey ? (
            <button type="button" onClick={() => void onRemoveKey()} disabled={busy !== null}>
              <Trash2 size={14} /> Remove key
            </button>
          ) : null}
        </span>
      </div>

      <p className="muted youtube-catalog-quota-note">
        Google’s default project quota currently allows only 100 <code>search.list</code> calls
        per day. Cadence debounces typing, loads one search tab at a time and caches results in
        memory to reduce use. It does not download YouTube audio or video.
      </p>

      {message ? (
        <p className="youtube-catalog-message" role="status" data-testid="youtube-catalog-message">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="youtube-catalog-message error" role="alert" data-testid="youtube-catalog-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
