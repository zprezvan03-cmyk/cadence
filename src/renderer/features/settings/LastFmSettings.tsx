/**
 * last.fm connection controls. Cadence has no shared API key, so the user
 * creates a free last.fm API account, pastes its key/secret here, and
 * authorizes Cadence in the browser. Nothing leaves this machine except the
 * signed requests the scrobbler itself makes.
 */

import { useEffect, useState } from "react";
import { ExternalLink, Link2, Unlink } from "lucide-react";
import type { LastFmSettings as LastFmSettingsValues } from "../../../shared/types";
import {
  isLastFmConnected,
  lastFmAuthUrl,
  lastFmGetSession,
  lastFmGetToken,
} from "../../../main/scrobble/lastfmCore";

interface Props {
  settings: LastFmSettingsValues;
  patchSettings: (patch: { scrobbling: Partial<LastFmSettingsValues> }) => Promise<void>;
  showToast: (message: string) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Something went wrong.");
}

export function LastFmSettings({ settings, patchSettings, showToast }: Props) {
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [apiSecret, setApiSecret] = useState(settings.apiSecret);
  const [pendingToken, setPendingToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "finish" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setApiKey(settings.apiKey), [settings.apiKey]);
  useEffect(() => setApiSecret(settings.apiSecret), [settings.apiSecret]);

  const trimmedKey = apiKey.trim();
  const trimmedSecret = apiSecret.trim();
  const connected = isLastFmConnected(settings);
  const credentialsChanged = trimmedKey !== settings.apiKey || trimmedSecret !== settings.apiSecret;

  const saveCredentials = async (): Promise<{ apiKey: string; apiSecret: string } | null> => {
    if (!trimmedKey || !trimmedSecret) {
      setError("Paste both the last.fm API key and shared secret first.");
      return null;
    }
    // A session key belongs to one API account; changing credentials must
    // not silently keep scrobbling into the previous account.
    await patchSettings({
      scrobbling: {
        apiKey: trimmedKey,
        apiSecret: trimmedSecret,
        ...(credentialsChanged ? { sessionKey: "", username: "", enabled: false } : {}),
      },
    });
    return { apiKey: trimmedKey, apiSecret: trimmedSecret };
  };

  const onSave = async () => {
    setBusy("save");
    setError(null);
    try {
      if (await saveCredentials()) setMessage("last.fm API credentials saved.");
    } catch (saveError) {
      setError(describe(saveError));
    } finally {
      setBusy(null);
    }
  };

  const onConnect = async () => {
    setBusy("connect");
    setError(null);
    setMessage(null);
    try {
      const credentials = await saveCredentials();
      if (!credentials) return;
      const token = await lastFmGetToken(credentials);
      setPendingToken(token);
      const url = lastFmAuthUrl(credentials.apiKey, token);
      if (window.cadence?.app?.openExternal) {
        await window.cadence.app.openExternal(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      setMessage("Approve Cadence in your browser, then choose “Finish connecting”.");
    } catch (connectError) {
      setError(describe(connectError));
    } finally {
      setBusy(null);
    }
  };

  const onFinish = async () => {
    if (!pendingToken) return;
    setBusy("finish");
    setError(null);
    try {
      const credentials = { apiKey: trimmedKey, apiSecret: trimmedSecret };
      const session = await lastFmGetSession(credentials, pendingToken);
      await patchSettings({
        scrobbling: {
          ...credentials,
          sessionKey: session.sessionKey,
          username: session.username,
          enabled: true,
        },
      });
      setPendingToken("");
      setMessage(session.username ? `Connected as ${session.username}.` : "Connected to last.fm.");
      showToast("Connected to last.fm");
    } catch (finishError) {
      setError(describe(finishError));
    } finally {
      setBusy(null);
    }
  };

  const onDisconnect = async () => {
    setError(null);
    setPendingToken("");
    await patchSettings({ scrobbling: { sessionKey: "", username: "", enabled: false } });
    setMessage("Disconnected. Your API key stays saved so reconnecting is one click.");
    showToast("Disconnected from last.fm");
  };

  return (
    <div className="settings-subsection lastfm-settings" data-testid="settings-lastfm">
      <h3>last.fm scrobbling</h3>
      <label className="setting-row">
        <span>
          <strong>Scrobble to last.fm</strong>
          <em>
            Send “now playing” updates and scrobble each song after half of it (or four minutes)
            has actually played. Songs under 31 seconds never scrobble.
          </em>
        </span>
        <input
          type="checkbox"
          checked={settings.enabled}
          data-testid="lastfm-enabled"
          onChange={event => void patchSettings({ scrobbling: { enabled: event.target.checked } })}
        />
      </label>

      <label className="setting-row lastfm-field">
        <span>
          <strong>API key</strong>
          <em>Create a free API account at last.fm/api/account/create, then paste its key here.</em>
        </span>
        <input
          type="text"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder="last.fm API key"
          data-testid="lastfm-api-key"
          onChange={event => setApiKey(event.target.value)}
        />
      </label>
      <label className="setting-row lastfm-field">
        <span>
          <strong>Shared secret</strong>
          <em>Used only on this computer to sign last.fm requests; it is never sent anywhere else.</em>
        </span>
        <input
          type="password"
          value={apiSecret}
          autoComplete="off"
          spellCheck={false}
          placeholder="last.fm shared secret"
          data-testid="lastfm-api-secret"
          onChange={event => setApiSecret(event.target.value)}
        />
      </label>

      <div className="setting-row lastfm-actions">
        <span>
          <strong>{connected ? `Connected${settings.username ? ` as ${settings.username}` : ""}` : "Not connected"}</strong>
          <em>
            {connected
              ? settings.enabled
                ? "Scrobbling is on."
                : "Connected, but scrobbling is paused above."
              : pendingToken
                ? "Waiting for you to approve Cadence in your browser."
                : "Save your API account details, then connect your last.fm user."}
          </em>
        </span>
        <span className="lastfm-buttons">
          {credentialsChanged ? (
            <button type="button" onClick={() => void onSave()} disabled={busy !== null}>
              Save credentials
            </button>
          ) : null}
          {!connected && !pendingToken ? (
            <button
              type="button"
              className="primary"
              data-testid="lastfm-connect"
              onClick={() => void onConnect()}
              disabled={busy !== null || !trimmedKey || !trimmedSecret}
            >
              <Link2 size={14} /> {busy === "connect" ? "Opening last.fm…" : "Connect last.fm"}
            </button>
          ) : null}
          {pendingToken ? (
            <button
              type="button"
              className="primary"
              data-testid="lastfm-finish"
              onClick={() => void onFinish()}
              disabled={busy !== null}
            >
              <ExternalLink size={14} /> {busy === "finish" ? "Checking…" : "Finish connecting"}
            </button>
          ) : null}
          {connected ? (
            <button type="button" data-testid="lastfm-disconnect" onClick={() => void onDisconnect()}>
              <Unlink size={14} /> Disconnect
            </button>
          ) : null}
        </span>
      </div>

      {message ? (
        <p className="lastfm-message" role="status" data-testid="lastfm-message">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="lastfm-message error" role="alert" data-testid="lastfm-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
