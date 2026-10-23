/**
 * The lyrics dock: provider choice, offset, translation, romanization, typography, theme and
 * Mirrors the controls Better Lyrics exposes in its lyrics dock, rebuilt as Cadence
 * React components. Written for Cadence.
 */

import { useEffect, useState } from "react";
import {
  ChevronDown,
  Download,
  FolderOpen,
  Languages,
  Minus,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { LyricsCandidate, LyricsSettings } from "../../../shared/types";
import { TRANSLATION_LANGUAGES } from "./translationLanguages";

interface LyricsDockProps {
  settings: LyricsSettings;
  onPatch: (patch: Partial<LyricsSettings>) => void;
  candidates: LyricsCandidate[];
  activeSource: string | null;
  onSelectSource: (source: string) => void;
  providerStatus: { provider: string; status: string; detail?: string }[];
  onReload: () => void;
  onSaveSidecar: () => void;
  onChooseFile: () => void;
  syncLabel: string;
  busy: boolean;
  /** Hover visibility: faded out and non-interactive while true. */
  concealed?: boolean;
  /** Reports whether a popover is open, so the controls stay visible while it is in use. */
  onPopoverChange?: (open: boolean) => void;
}

export function LyricsDock({
  settings,
  onPatch,
  candidates,
  activeSource,
  onSelectSource,
  providerStatus,
  onReload,
  onSaveSidecar,
  onChooseFile,
  syncLabel,
  busy,
  concealed = false,
  onPopoverChange,
}: LyricsDockProps) {
  const [panel, setPanel] = useState<"none" | "sources" | "appearance">("none");
  const [languageOpen, setLanguageOpen] = useState(false);

  useEffect(() => {
    onPopoverChange?.(panel !== "none" || languageOpen);
  }, [panel, languageOpen, onPopoverChange]);

  return (
    <div className={`lyrics-dock ${concealed ? "is-concealed" : ""}`} data-testid="lyrics-dock">
      <div className="dock-group dock-status" title={syncLabel} data-testid="sync-label">
        <span className={`sync-dot sync-${syncLabel.toLowerCase().replace(/\s+/g, "-")}`} />
        {syncLabel}
      </div>

      <div className="dock-group">
        <button
          type="button"
          className="dock-button"
          onClick={() => setPanel(panel === "sources" ? "none" : "sources")}
          title="Lyrics source"
          aria-expanded={panel === "sources"}
        >
          <Sparkles size={16} /> Source <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className="dock-button"
          onClick={() => setPanel(panel === "appearance" ? "none" : "appearance")}
          title="Lyrics appearance"
          aria-expanded={panel === "appearance"}
        >
          <Settings2 size={16} /> Style
        </button>
        <button
          type="button"
          className="dock-button"
          onClick={() => setLanguageOpen(open => !open)}
          title="Translate lyrics"
          aria-expanded={languageOpen}
        >
          <Languages size={16} /> {settings.translationLanguage ? languageLabel(settings.translationLanguage) : "Translate"}
        </button>
        <button
          type="button"
          className={`dock-button ${settings.romanization ? "active" : ""}`}
          onClick={() => onPatch({ romanization: !settings.romanization })}
          title="Romanize lyrics"
        >
          <Wand2 size={16} /> Romanize
        </button>
      </div>

      <div className="dock-group dock-offset" title="Lyrics timing offset">
        <button type="button" className="dock-icon" onClick={() => onPatch({ offsetMs: settings.offsetMs - 100 })}>
          <Minus size={14} />
        </button>
        <span className="offset-value">{settings.offsetMs > 0 ? "+" : ""}{(settings.offsetMs / 1000).toFixed(1)}s</span>
        <button type="button" className="dock-icon" onClick={() => onPatch({ offsetMs: settings.offsetMs + 100 })}>
          <Plus size={14} />
        </button>
      </div>

      <div className="dock-group dock-actions">
        <button type="button" className="dock-icon" onClick={onReload} title="Reload lyrics" disabled={busy}>
          <RefreshCw size={16} className={busy ? "spin" : undefined} />
        </button>
        <button type="button" className="dock-icon" onClick={onChooseFile} title="Open a lyrics file">
          <FolderOpen size={16} />
        </button>
        <button type="button" className="dock-icon" onClick={onSaveSidecar} title="Save lyrics next to the track">
          <Download size={16} />
        </button>
      </div>

      {panel === "sources" ? (
        <div className="dock-popover dock-sources">
          <div className="popover-title">Lyrics source</div>
          {candidates.length === 0 ? <div className="muted">No lyrics found for this track.</div> : null}
          {candidates.map(candidate => (
            <button
              type="button"
              key={`${candidate.source}-${candidate.provider}`}
              className={`source-row ${activeSource === candidate.source ? "active" : ""}`}
              onClick={() => {
                onSelectSource(candidate.source);
                setPanel("none");
              }}
            >
              <span>
                <strong>{candidate.provider}</strong>
                <em>{candidate.syncHint === "richsync" ? "Word synced" : candidate.syncHint === "synced" ? "Line synced" : "Unsynced"}</em>
              </span>
              {candidate.cached ? <span className="badge">cached</span> : null}
            </button>
          ))}
          <div className="popover-divider" />
          <div className="popover-title">Providers</div>
          {providerStatus.map(entry => (
            <div className="provider-row" key={entry.provider}>
              <span>{entry.provider}</span>
              <span className={`provider-${entry.status}`}>{entry.detail || entry.status}</span>
            </div>
          ))}
        </div>
      ) : null}

      {panel === "appearance" ? (
        <div className="dock-popover dock-appearance">
          <label className="slider-row">
            <span>Font size</span>
            <input
              type="range"
              min={1.5}
              max={5.5}
              step={0.1}
              value={settings.fontSizeRem}
              onChange={event => onPatch({ fontSizeRem: Number(event.target.value) })}
            />
            <output>{settings.fontSizeRem.toFixed(1)}rem</output>
          </label>
          <label className="slider-row">
            <span>Weight</span>
            <input
              type="range"
              min={300}
              max={900}
              step={50}
              value={settings.fontWeight}
              onChange={event => onPatch({ fontWeight: Number(event.target.value) })}
            />
            <output>{settings.fontWeight}</output>
          </label>
          <label className="slider-row">
            <span>Line height</span>
            <input
              type="range"
              min={1}
              max={2}
              step={0.05}
              value={settings.lineHeight}
              onChange={event => onPatch({ lineHeight: Number(event.target.value) })}
            />
            <output>{settings.lineHeight.toFixed(2)}</output>
          </label>
          <label className="slider-row">
            <span>Active</span>
            <input
              type="range"
              min={0.4}
              max={1}
              step={0.02}
              value={settings.activeOpacity}
              onChange={event => onPatch({ activeOpacity: Number(event.target.value) })}
            />
            <output>{Math.round(settings.activeOpacity * 100)}%</output>
          </label>
          <label className="slider-row">
            <span>Inactive</span>
            <input
              type="range"
              min={0.05}
              max={0.9}
              step={0.02}
              value={settings.inactiveOpacity}
              onChange={event => onPatch({ inactiveOpacity: Number(event.target.value) })}
            />
            <output>{Math.round(settings.inactiveOpacity * 100)}%</output>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.showCredits}
              onChange={event => onPatch({ showCredits: event.target.checked })}
            />
            <span>Show songwriters</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.passiveScroll}
              onChange={event => onPatch({ passiveScroll: event.target.checked })}
            />
            <span>Auto-scroll unsynced lyrics</span>
          </label>
        </div>
      ) : null}

      {languageOpen ? (
        <div className="dock-popover dock-languages">
          <div className="popover-title">Translate to</div>
          <button
            type="button"
            className={`source-row ${settings.translationLanguage === "" ? "active" : ""}`}
            onClick={() => {
              onPatch({ translationLanguage: "" });
              setLanguageOpen(false);
            }}
          >
            <span>
              <strong>Off</strong>
            </span>
          </button>
          <div className="language-list">
            {TRANSLATION_LANGUAGES.map(language => (
              <button
                type="button"
                key={language.code}
                className={`source-row ${settings.translationLanguage === language.code ? "active" : ""}`}
                onClick={() => {
                  onPatch({ translationLanguage: language.code });
                  setLanguageOpen(false);
                }}
              >
                <span>
                  <strong>{language.name}</strong>
                  <em>{language.native}</em>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function languageLabel(code: string): string {
  return TRANSLATION_LANGUAGES.find(language => language.code === code)?.name ?? code.toUpperCase();
}
