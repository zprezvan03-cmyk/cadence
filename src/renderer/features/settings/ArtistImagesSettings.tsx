/**
 * Settings → Cache → Artist pictures.
 *
 * Deliberately compact: one switch, one refresh window, the provider priority list and each
 * source's verified capability, plus a cache size/clear control. Adding a provider later only adds
 * a row here — the panel derives everything from the reports the main process returns.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, RefreshCw, Trash2 } from "lucide-react";
import type { ArtistImageProviderReport, ArtistImageStats } from "../../../shared/types";
import { normalizeArtistImageProviderOrder } from "../../../shared/artistImageProviders";
import { useArtistImages } from "../../state/artistImageStore";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = typeof error === "string" ? error : JSON.stringify(error);
  return text && text !== "{}" ? text : "unknown error";
}

function moveProvider(order: readonly string[], provider: string, direction: -1 | 1): string[] {
  const next = [...order];
  const index = next.indexOf(provider);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

const REFRESH_OPTIONS = [
  { days: 0, label: "Never (only with a manual refresh)" },
  { days: 7, label: "After a week" },
  { days: 30, label: "After a month" },
  { days: 90, label: "After three months" },
];

function artistImageApi() {
  if (typeof window === "undefined") return undefined;
  return window.cadence?.artistImages;
}

export function ArtistImagesSettings() {
  const settings = useSettings(state => state.settings);
  const patch = useSettings(state => state.patch);
  const showToast = useUi(state => state.showToast);
  const resetArtistImages = useArtistImages(state => state.resetAll);
  const clearArtistImages = useArtistImages(state => state.clearCache);
  const [providers, setProviders] = useState<ArtistImageProviderReport[] | null>(null);
  const [stats, setStats] = useState<ArtistImageStats | null>(null);
  const [busy, setBusy] = useState<"clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = artistImageApi();
    if (!api) {
      setProviders([]);
      return;
    }
    try {
      const [nextProviders, nextStats] = await Promise.all([api.providers(), api.stats()]);
      setProviders(nextProviders);
      setStats(nextStats);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) return null;
  const config = settings.artistImages;
  const order = normalizeArtistImageProviderOrder(config.providerOrder);
  const available = new Map((providers ?? []).map(report => [report.provider, report]));

  const patchArtistImages = (patchValue: Partial<typeof config>) =>
    void patch({ artistImages: { ...config, ...patchValue } });

  const clearCache = async () => {
    setBusy("clear");
    try {
      const result = await clearArtistImages();
      showToast(
        result.removedImages > 0
          ? `Cleared ${result.removedImages} cached artist picture${result.removedImages === 1 ? "" : "s"}`
          : "No cached artist pictures to clear"
      );
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section artist-images-section" data-testid="settings-artist-images">
      <h2>Artist pictures</h2>
      <p className="muted">
        Cadence looks up artist photos from public music catalogues, stores each one once per artist, and always
        keeps the credit its licence requires. Pictures are only fetched for artists you actually see.
      </p>

      <label className="setting-row">
        <span>
          <strong>Fetch artist pictures</strong>
          <em>Turn off to use only pictures already cached on this device</em>
        </span>
        <input
          type="checkbox"
          data-testid="artist-images-enabled"
          checked={config.enabled}
          onChange={event => {
            patchArtistImages({ enabled: event.target.checked });
            // Entries resolved as "disabled" must be allowed to resolve again.
            resetArtistImages();
          }}
        />
      </label>

      <label className="setting-row">
        <span>
          <strong>Refresh cached pictures</strong>
          <em>Re-check sources quietly in the background once a picture ages past this window</em>
        </span>
        <select
          value={String(config.refreshAfterDays)}
          onChange={event => patchArtistImages({ refreshAfterDays: Number(event.target.value) })}
          data-testid="artist-images-refresh-days"
        >
          {REFRESH_OPTIONS.map(option => (
            <option key={option.days} value={option.days}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="provider-order-head">
        <span className="muted">Source priority</span>
        <button
          type="button"
          className="provider-restore"
          onClick={() => patchArtistImages({ providerOrder: normalizeArtistImageProviderOrder(undefined) })}
        >
          Restore defaults
        </button>
      </div>
      <ol className="provider-order artist-provider-order" data-testid="artist-provider-order">
        {order.map((provider, index) => {
          const report = available.get(provider);
          return (
            <li key={provider}>
              <span className="provider-index">{index + 1}</span>
              <span className="provider-name">
                <strong>{report?.name ?? provider}</strong>
                <span className="provider-badges">
                  {report && !report.available ? (
                    <span className="provider-badge unavailable" title={report.statusReason}>
                      needs setup
                    </span>
                  ) : null}
                  {report?.attributionRequired ? <span className="provider-badge">credit shown</span> : null}
                  {report?.license ? <span className="provider-badge offline">{report.license}</span> : null}
                </span>
              </span>
              <span className="provider-buttons">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => patchArtistImages({ providerOrder: moveProvider(order, provider, -1) })}
                  aria-label={`Move ${report?.name ?? provider} up`}
                  disabled={index === 0}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => patchArtistImages({ providerOrder: moveProvider(order, provider, 1) })}
                  aria-label={`Move ${report?.name ?? provider} down`}
                  disabled={index === order.length - 1}
                >
                  <ArrowDown size={13} />
                </button>
              </span>
            </li>
          );
        })}
      </ol>

      {providers && providers.length > 0 ? (
        <ul className="artist-provider-capabilities" data-testid="artist-provider-capabilities">
          {providers.map(report => (
            <li key={report.provider} data-feasible={report.feasible}>
              <strong>{report.name}</strong>
              <span className="muted">
                {report.implemented && report.feasible
                  ? report.available
                    ? "Supported"
                    : "Supported · not configured"
                  : report.statusReason}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Provider diagnostics are available in the desktop app.</p>
      )}

      {error ? <p className="error-text">{error}</p> : null}

      <div className="setting-row">
        <span>
          <strong>Picture cache</strong>
          <em>
            {stats
              ? `${stats.artists} picture${stats.artists === 1 ? "" : "s"} · ${formatBytes(stats.bytes)}${
                  stats.misses > 0 ? ` · ${stats.misses} artist${stats.misses === 1 ? "" : "s"} without a picture` : ""
                }`
              : "Loading…"}
          </em>
        </span>
        <span className="artist-image-actions">
          <button type="button" onClick={() => void load()} aria-label="Refresh cache statistics">
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            onClick={() => void clearCache()}
            disabled={busy === "clear"}
            data-testid="clear-artist-images"
          >
            <Trash2 size={15} /> {busy === "clear" ? "Clearing…" : "Clear"}
          </button>
        </span>
      </div>
    </section>
  );
}
