/**
 * Settings → Cache → Artist images.
 *
 * One dedicated section covering the whole feature: the master switch, automatic fetching, the
 * per-provider switches and priority order, and the cache itself. All four controls read and write
 * `settings.artistImages`, so they persist through the existing settings store — no second settings
 * system, and every change applies immediately because the bridge rebuilds its resolver when the
 * relevant values change.
 *
 * Adding a provider later only adds a row here: the list, the badges and the capability lines are
 * all derived from what the main process reports.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Power, RefreshCw, Trash2 } from "lucide-react";
import type { ArtistImageProviderReport, ArtistImageStats } from "../../../shared/types";
import {
  DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER,
  activeArtistImageProviders,
  artistImageProviderIdOf,
  isDisabledArtistImageProviderEntry,
  normalizeArtistImageProviderOrder,
} from "../../../shared/artistImageProviders";
import { addProviderToOrder, moveProviderInOrder, removeProviderFromOrder } from "../../../shared/providerOrder";
import { artistImageKey } from "../../../shared/artistImageCache";
import { MarqueeText } from "../../components/MarqueeText";
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
  const refreshArtistImage = useArtistImages(state => state.refresh);
  const [providers, setProviders] = useState<ArtistImageProviderReport[] | null>(null);
  const [stats, setStats] = useState<ArtistImageStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const [refreshJob, setRefreshJob] = useState<{ total: number; done: number; running: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);  /** Outcome of the last "Refresh": the difference between "no picture exists" and "we could not ask". */
  const [lastRefresh, setLastRefresh] = useState<{ total: number; ready: number; reason: string | null } | null>(
    null
  );
  const cancelRefresh = useRef(false);

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

  // Leaving Settings must not leave a long refresh running in the background of another page.
  useEffect(
    () => () => {
      cancelRefresh.current = true;
    },
    []
  );

  if (!settings) return null;
  const config = settings.artistImages;
  const order = normalizeArtistImageProviderOrder(config.providerOrder);
  const activeCount = activeArtistImageProviders(order).length;
  const reportByProvider = new Map((providers ?? []).map(report => [report.provider, report]));

  /**
   * Every artist-image change goes through the same patch helper. Clearing the renderer's resolved
   * entries afterwards makes mounted avatars pick the new behaviour up immediately instead of
   * waiting for a remount or an app restart.
   */
  const patchArtistImages = (patchValue: Partial<typeof config>) => {
    void patch({ artistImages: { ...config, ...patchValue } });
    resetArtistImages();
  };

  const clearCache = async () => {
    if (
      !confirm(
        "Clear every cached artist picture? Pictures will be looked up again the next time an artist is shown. " +
          "Your music files, library, cache of lyrics and settings are not touched."
      )
    ) {
      return;
    }
    setClearing(true);
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
      setClearing(false);
    }
  };

  const refreshAll = async () => {
    const api = artistImageApi();
    if (!api) return;
    try {
      const index = await api.indexed();
      const names = [...index.withImage, ...index.withoutImage];
      if (names.length === 0) {
        showToast("No artists in the picture cache yet");
        return;
      }
      cancelRefresh.current = false;
      setRefreshJob({ total: names.length, done: 0, running: true });
      // Sequential on purpose: refresh goes straight to the providers, and the main process already
      // rate-limits each source. One at a time keeps a big library from bursting every API at once.
      for (const name of names) {
        if (cancelRefresh.current) break;
        await refreshArtistImage(name);
        setRefreshJob(job => (job ? { ...job, done: job.done + 1 } : job));
      }
      setRefreshJob(job => (job ? { ...job, running: false } : job));
      await load();
      if (!cancelRefresh.current) {
        // "Refreshed 24 artists" is misleading when nothing was actually found, so report the
        // outcome and, when every artist missed, the reason the pipeline recorded (an unreachable
        // API looks very different from artists that genuinely have no portrait).
        const entries = useArtistImages.getState().entries;
        const ready = names.filter(name => entries[artistImageKey(name)]?.status === "ready").length;
        const reasons = names
          .map(name => entries[artistImageKey(name)]?.reason)
          .filter((reason): reason is string => Boolean(reason));
        const reason = ready === 0 && reasons.length > 0 ? (reasons[0] as string) : null;
        setLastRefresh({ total: names.length, ready, reason });
        showToast(
          ready > 0
            ? `Found pictures for ${ready} of ${names.length} artist${names.length === 1 ? "" : "s"}`
            : `No picture found for ${names.length} artist${names.length === 1 ? "" : "s"}${reason ? ` (${reason})` : ""}`
        );
      }
    } catch (cause) {
      setError(describeError(cause));
      setRefreshJob(job => (job ? { ...job, running: false } : job));
    }
  };

  return (
    <section className="settings-section artist-images-section" data-testid="settings-artist-images">
      <h2>Artist images</h2>
      <p className="muted">
        Cadence looks up artist photos from public music catalogues, stores one picture per artist on this device,
        and always keeps the credit its licence requires. Pictures are only fetched for artists you actually see.
      </p>

      <div className="settings-subsection">
        <h3>Display</h3>
        <label className="setting-row">
          <span>
            <strong>Show artist pictures</strong>
            <em>Turn off to hide every artist picture and stop all lookups</em>
          </span>
          <input
            type="checkbox"
            data-testid="artist-images-enabled"
            checked={config.enabled}
            onChange={event => patchArtistImages({ enabled: event.target.checked })}
          />
        </label>

        <label className={`setting-row${config.enabled ? "" : " is-disabled"}`}>
          <span>
            <strong>Fetch missing pictures automatically</strong>
            <em>
              When off, only pictures already cached on this device are shown. Nothing already cached is
              deleted, and lookups resume as soon as this is switched back on.
            </em>
          </span>
          <input
            type="checkbox"
            data-testid="artist-images-auto-fetch"
            checked={config.autoFetch}
            disabled={!config.enabled}
            onChange={event => patchArtistImages({ autoFetch: event.target.checked })}
          />
        </label>

        <label className={`setting-row${config.enabled ? "" : " is-disabled"}`}>
          <span>
            <strong>Refresh cached pictures</strong>
            <em>Quietly re-check sources once a picture ages past this window</em>
          </span>
          <select
            value={String(config.refreshAfterDays)}
            disabled={!config.enabled}
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
      </div>

      <div className="settings-subsection">
        <h3>Image providers</h3>
        <p className="muted">
          Sources are tried in this order until one returns a valid picture. Missing MusicBrainz IDs, API keys or
          catalogue entries are reported next to each source.
        </p>
        <div className="provider-order-head">
          <span className="muted">
            {activeCount} of {order.length} active
          </span>
          <button
            type="button"
            className="provider-restore"
            onClick={() => patchArtistImages({ providerOrder: [...DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER] })}
          >
            Restore defaults
          </button>
        </div>
        <ol className="provider-order artist-provider-order" data-testid="artist-provider-order">
          {order.map((entry, index) => {
            const providerId = artistImageProviderIdOf(entry);
            const disabled = isDisabledArtistImageProviderEntry(entry);
            const report = reportByProvider.get(providerId);
            const name = report?.name ?? providerId;
            return (
              <li key={providerId} className={disabled ? "is-disabled" : undefined} data-provider={providerId}>
                <span className="provider-index">{index + 1}</span>
                <span className="provider-name">
                  <strong>{name}</strong>
                  <span className="provider-badges">
                    {disabled ? <span className="provider-badge">off</span> : null}
                    {!disabled && report && !report.available ? (
                      <span className="provider-badge unavailable" title={report.statusReason}>
                        needs setup
                      </span>
                    ) : null}
                    {!disabled && report?.attributionRequired ? (
                      <span className="provider-badge">credit shown</span>
                    ) : null}
                    {!disabled && report?.license ? (
                      <span className="provider-badge offline">{report.license}</span>
                    ) : null}
                  </span>
                </span>
                <span className="provider-buttons">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => patchArtistImages({ providerOrder: moveProviderInOrder(order, entry, -1) })}
                    aria-label={`Move ${name} up`}
                    disabled={disabled || index === 0}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => patchArtistImages({ providerOrder: moveProviderInOrder(order, entry, 1) })}
                    aria-label={`Move ${name} down`}
                    disabled={disabled || index === order.length - 1}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() =>
                      patchArtistImages({
                        providerOrder: disabled
                          ? addProviderToOrder(order, providerId)
                          : removeProviderFromOrder(order, providerId),
                      })
                    }
                    aria-label={disabled ? `Enable ${name}` : `Disable ${name}`}
                    aria-pressed={!disabled}
                    data-testid={`artist-provider-toggle-${providerId}`}
                  >
                    <Power size={13} />
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
                <MarqueeText as="strong">{report.name}</MarqueeText>
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
      </div>

      <div className="settings-subsection">
        <h3>Cache</h3>
        <div className="setting-row">
          <span>
            <strong>Cached artist pictures</strong>
            <em>
              {stats
                ? `${stats.artists} picture${stats.artists === 1 ? "" : "s"} · ${formatBytes(stats.bytes)}${
                    stats.misses > 0
                      ? ` · ${stats.misses} artist${stats.misses === 1 ? "" : "s"} without a picture`
                      : ""
                  }`
                : "Loading…"}
            </em>
          </span>
          <span className="artist-image-actions">
            <button type="button" onClick={() => void load()} aria-label="Refresh cache statistics">
              <RefreshCw size={15} />
            </button>
          </span>
        </div>

        <div className="setting-row">
          <span>
            <strong>Refresh artist pictures</strong>
            <em>
              {refreshJob?.running
                ? `Refreshing ${refreshJob.done} of ${refreshJob.total}…`
                : "Re-query the sources for every artist in the cache, including those with no picture yet"}
            </em>
          </span>
          <span className="artist-image-actions">
            {refreshJob?.running ? (
              <button
                type="button"
                onClick={() => {
                  cancelRefresh.current = true;
                }}
                data-testid="cancel-refresh-artist-images"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void refreshAll()}
                disabled={!config.enabled || clearing}
                data-testid="refresh-artist-images"
              >
                <RefreshCw size={15} /> Refresh
              </button>
            )}
          </span>
        </div>

        {lastRefresh ? (
          <p
            className="muted artist-image-refresh-summary"
            data-testid="artist-images-refresh-summary"
          >
            Last refresh: {lastRefresh.ready} of {lastRefresh.total} artist
            {lastRefresh.total === 1 ? "" : "s"} had a picture
            {lastRefresh.reason ? ` · ${lastRefresh.reason}` : ""}
          </p>
        ) : null}

        <div className="setting-row">
          <span>
            <strong>Clear artist picture cache</strong>
            <em>The index is emptied and pictures are fetched again on demand. Cached files are not deleted.</em>
          </span>
          <span className="artist-image-actions">
            <button
              type="button"
              onClick={() => void clearCache()}
              disabled={clearing || refreshJob?.running === true}
              data-testid="clear-artist-images"
            >
              <Trash2 size={15} /> {clearing ? "Clearing…" : "Clear"}
            </button>
          </span>
        </div>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}
