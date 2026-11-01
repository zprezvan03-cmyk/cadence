/** Keyboard shortcut reference, opened with ? or from Settings. */

import { useEffect } from "react";
import { Keyboard, X } from "lucide-react";
import { useUi } from "../state/uiStore";
import { usePresence } from "./usePresence";

const GROUPS: Array<{ title: string; shortcuts: Array<[string, string]> }> = [
  {
    title: "Playback",
    shortcuts: [
      ["Space", "Play / pause"],
      ["Ctrl/Cmd + P", "Play / pause"],
      ["Left / Right", "Seek back / forward 5 seconds"],
      ["Shift + Left / Right", "Previous / next track"],
      ["Ctrl/Cmd + Left / Right", "Previous / next track"],
      ["Up / Down", "Volume up / down"],
      ["Ctrl/Cmd + Up / Down", "Volume up / down"],
      ["M", "Mute / unmute"],
      ["S", "Shuffle on/off"],
      ["R", "Cycle repeat"],
      ["Ctrl/Cmd + L", "Favourite current track"],
    ],
  },
  {
    title: "Views",
    shortcuts: [
      ["L", "Now Playing / lyrics"],
      ["Q", "Queue"],
      ["N or F", "Fullscreen lyrics"],
      ["F11", "Fullscreen lyrics and window"],
      ["Ctrl/Cmd + Shift + P", "Mini player"],
      ["Esc", "Close panel or leave fullscreen"],
    ],
  },
  {
    title: "Library",
    shortcuts: [
      ["Ctrl/Cmd + K", "Search"],
      ["Ctrl/Cmd + O", "Add music folder"],
      ["Ctrl/Cmd + Shift + R", "Rescan library"],
      ["?", "This shortcut list"],
    ],
  },
];

export function ShortcutsHelp() {
  const open = useUi(state => state.shortcutsHelpOpen);
  const setOpen = useUi(state => state.setShortcutsHelpOpen);
  const presence = usePresence(open);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!presence.mounted) return null;

  return (
    <div
      className={`modal-backdrop ${presence.phaseClass}`}
      data-presence={presence.phase}
      onClick={close}
    >
      <div
        className="modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        data-testid="shortcuts-help"
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="shortcuts-title">
            <Keyboard size={19} /> Keyboard shortcuts
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close keyboard shortcuts"
            data-testid="shortcuts-close"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <div className="shortcuts-groups">
          {GROUPS.map(group => (
            <section key={group.title} className="shortcuts-group">
              <h3>{group.title}</h3>
              <dl>
                {group.shortcuts.map(([keys, label]) => (
                  <div key={`${keys}-${label}`}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="shortcuts-note">
          Shortcuts pause while you are typing in a text field. Keyboard media keys and the system
          tray also control playback when Cadence is in the background.
        </p>
      </div>
    </div>
  );
}
