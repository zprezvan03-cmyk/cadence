/**
 * YouTube Music account panel (Settings → YouTube Music).
 *
 * Guest mode is the default and fully functional: browsing, search and discovery need no Google
 * account and Cadence never interrupts guest browsing with a login prompt. Connecting an account
 * is optional: the user pastes the `Cookie` header value from music.youtube.com (never a
 * password) and Cadence stores it in the operating system's credential store (DPAPI / Secret
 * Service / Keychain) via the `secrets` bridge API — never in settings JSON, never logged. The
 * cookie is forwarded verbatim to music.youtube.com only; Cadence does not derive SAPISIDHASH
 * authorization or PO tokens from it.
 */

import { useEffect, useState } from "react";
import { Link2, Unlink, Youtube } from "lucide-react";
import { useYtm } from "../../state/ytmusicStore";
import { useUi } from "../../state/uiStore";

export function YtmAccountSettings() {
  const account = useYtm(state => state.account);
  const checkAccount = useYtm(state => state.checkAccount);
  const connectAccount = useYtm(state => state.connectAccount);
  const disconnectAccount = useYtm(state => state.disconnectAccount);
  const showToast = useUi(state => state.showToast);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [cookie, setCookie] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void checkAccount();
  }, [checkAccount]);

  const connect = async () => {
    if (!cookie.trim()) return;
    setBusy(true);
    await connectAccount(cookie, name);
    setBusy(false);
    setCookie("");
    setExpanded(false);
    const status = useYtm.getState().account;
    if (status.mode === "connected") showToast("Google account connected for YouTube Music.");
    else if (status.mode === "error") showToast(status.detail);
  };

  const disconnect = async () => {
    setBusy(true);
    await disconnectAccount();
    setBusy(false);
    showToast("Disconnected. Cadence is back in Guest mode — browsing still works without an account.");
  };

  return (
    <div className="settings-subsection" data-testid="ytm-account-settings">
      <h3>YouTube Music account</h3>
      <div className="setting-row">
        <span>
          <strong>Status</strong>
          <p className="muted">
            {account.mode === "guest" ? (
              <span data-testid="ytm-account-guest">Guest mode — no Google account connected. Browsing and search work without one.</span>
            ) : null}
            {account.mode === "connected" ? (
              <span data-testid="ytm-account-connected">
                <Youtube size={12} /> Connected as {account.name}
              </span>
            ) : null}
            {account.mode === "error" ? (
              <span data-testid="ytm-account-error" className="error-text">Error: {account.detail}</span>
            ) : null}
          </p>
        </span>
        {account.mode === "connected" ? (
          <button type="button" className="ghost-button" data-testid="ytm-disconnect" disabled={busy} onClick={() => void disconnect()}>
            <Unlink size={14} /> Disconnect
          </button>
        ) : (
          <button type="button" className="ghost-button" data-testid="ytm-connect-toggle" disabled={busy} onClick={() => setExpanded(v => !v)}>
            <Link2 size={14} /> Connect Google Account
          </button>
        )}
      </div>

      {expanded && account.mode !== "connected" ? (
        <div className="ytm-connect-form" data-testid="ytm-connect-form">
          <p className="muted">
            Optional. Open <code>music.youtube.com</code> in a browser while signed in, open DevTools →
            Network → any request → copy the <code>cookie</code> request header. Cadence never asks for
            your password and never logs this value: it is stored only in your operating system's
            credential store and sent only to music.youtube.com. Treat it like a password — anyone with
            it can act as your account on YouTube.
          </p>
          <label className="ytm-field">
            <span>Display name (shown in Cadence)</span>
            <input
              type="text"
              value={name}
              placeholder="e.g. alex@gmail.com"
              data-testid="ytm-account-name"
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label className="ytm-field">
            <span>Cookie header value</span>
            <textarea
              value={cookie}
              rows={3}
              placeholder="VISITOR_INFO1_LIVE=…; SAPISID=…; …"
              data-testid="ytm-account-cookie"
              onChange={event => setCookie(event.target.value)}
            />
          </label>
          <div className="heading-actions">
            <button
              type="button"
              className="primary"
              data-testid="ytm-connect-submit"
              disabled={busy || !cookie.trim()}
              onClick={() => void connect()}
            >
              Store in OS keychain &amp; connect
            </button>
            <button type="button" className="ghost-button" onClick={() => setExpanded(false)}>
              Cancel
            </button>
          </div>
          <p className="muted">
            Continue as Guest instead: just close this form — Guest mode stays available before, during
            and after any account connection.
          </p>
        </div>
      ) : null}
    </div>
  );
}
