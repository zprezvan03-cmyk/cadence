/**
 * The Now Playing Customization Studio.
 *
 * Opened from Appearance over a live Now Playing preview: every edit writes to a draft
 * profile rendered immediately against the shared playback clock, while nothing is
 * persisted until Save. Built-in profiles open read-only — Duplicate makes the
 * editable custom copy — so a shipped preset can never be damaged. Includes the
 * grid-constrained layout editor (components snap into named slots, never free
 * pixels), profile import/export through the validated JSON envelope, and the
 * optional per-context profile activation. Written for Cadence.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Check,
  Copy,
  Download,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import type {
  NowPlayingLayoutMode,
  NowPlayingProfile,
  NowPlayingProfileConfig,
  NowPlayingProfilesSettings,
} from "../../../shared/types";
import {
  BASE_NOW_PLAYING_PROFILE_CONFIG,
  DEFAULT_NOW_PLAYING_PROFILE_ID,
  BUILT_IN_NOW_PLAYING_PROFILES,
  cloneNowPlayingProfile,
  createCustomNowPlayingProfileId,
  getEffectiveNowPlayingProfile,
  getLyricsOffNowPlayingProfile,
  listNowPlayingProfiles,
  normalizeNowPlayingProfile,
  parseNowPlayingProfileJson,
  serializeNowPlayingProfile,
} from "../../../shared/nowPlayingProfiles";
import { fontStack, normalizeFontId } from "../../../shared/fonts";
import { useSystemFonts } from "../../state/fontsStore";

interface CustomizationStudioProps {
  profilesSettings: NowPlayingProfilesSettings;
  initialMode: NowPlayingLayoutMode;
  renderPreview: (profile: NowPlayingProfile, mode: NowPlayingLayoutMode) => ReactNode;
  onSave: (payload: NowPlayingProfilesSettings) => Promise<void>;
  onClose: () => void;
  phaseClass: string;
  phase: string;
}

const EDIT_MODES: [NowPlayingLayoutMode, string][] = [
  ["fullscreen", "Lyrics On"], ["lyricsOff", "Lyrics Off"], ["windowed", "Windowed"],
];
type DragComponent = "artwork" | "metadata";

const LAYOUT_KEYS: (keyof NowPlayingProfileConfig)[] = [
  "artworkVisible",
  "artworkScale",
  "controlsScale",
  "lyricsMaxWidth",
  "spacingScale",
  "artworkSlot",
  "metadataSlot",
  "metadataVisible",
  "dockVisible",
  "controlsVisible",
  "lyricsAlignment",
];
const TYPOGRAPHY_KEYS: (keyof NowPlayingProfileConfig)[] = [
  "lyricsScale",
  "translationScale",
  "romanizationScale",
  "titleScale",
  "metadataScale",
  "fontId",
  "translationFontId",
  "romanizationFontId",
  "lyricsWeight",
  "lineSpacingScale",
  "letterSpacingEm",
];
const APPEARANCE_KEYS: (keyof NowPlayingProfileConfig)[] = [
  "activeColor",
  "inactiveColor",
  "inactiveOpacityScale",
  "activeLineScale",
  "inactiveBlurPx",
];
const KARAOKE_KEYS: (keyof NowPlayingProfileConfig)[] = [
  "karaokeStyle",
  "karaokeIntensity",
  "activeWordScale",
];
const BACKGROUND_KEYS: (keyof NowPlayingProfileConfig)[] = [
  "backgroundMode",
  "backgroundIntensity",
  "backgroundBlurPx",
  "effectSpeed",
  "effectDensity",
];
function upsertCustom(list: NowPlayingProfile[], profile: NowPlayingProfile): NowPlayingProfile[] {
  const index = list.findIndex(entry => entry.id === profile.id);
  if (index === -1) return [...list, cloneNowPlayingProfile(profile)];
  const next = [...list];
  next[index] = cloneNowPlayingProfile(profile);
  return next;
}

/** Profile choices are part of the draft too. Changing layout tabs never changes a choice. */
function activateProfile(settings: NowPlayingProfilesSettings, mode: NowPlayingLayoutMode, id: string): NowPlayingProfilesSettings {
  if (mode === "lyricsOff") return { ...settings, lyricsOffProfileId: id };
  if (!settings.contextSwitching.enabled) return { ...settings, activeProfileId: id };
  const key = mode === "fullscreen" ? "fullscreenProfileId" : "windowedProfileId";
  return { ...settings, contextSwitching: { ...settings.contextSwitching, [key]: id } };
}

export function CustomizationStudio({
  profilesSettings,
  initialMode,
  renderPreview,
  onSave,
  onClose,
  phaseClass,
  phase,
}: CustomizationStudioProps) {
  const [working, setWorking] = useState(() => structuredClone(profilesSettings));
  const [editMode, setEditMode] = useState(initialMode);
  const [saving, setSaving] = useState(false);
  const [past, setPast] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [importText, setImportText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [dragComponent, setDragComponent] = useState<DragComponent | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const retrySave = useRef(false);
  const lyricsOff = editMode === "lyricsOff";
  const draft = lyricsOff ? getLyricsOffNowPlayingProfile(working) : getEffectiveNowPlayingProfile(working, editMode === "fullscreen");
  const readOnly = draft.builtIn;
  const cfg = draft[editMode];
  const context = working.contextSwitching;
  const displayProfiles = listNowPlayingProfiles(working);
  const committedRef = useRef(JSON.stringify(draft));
  const dirty = JSON.stringify(working) !== JSON.stringify(profilesSettings);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => dialog.close();
  }, []);

  useLayoutEffect(() => {
    if (!saving && retrySave.current) {
      retrySave.current = false;
      saveRef.current?.focus({ preventScroll: true });
    }
  }, [saving]);

  const editingKey = `${editMode}:${draft.id}`;
  const previousKey = useRef(editingKey);
  useLayoutEffect(() => {
    if (previousKey.current === editingKey) return;
    previousKey.current = editingKey;
    committedRef.current = JSON.stringify(draft);
    setPast([]);
    setFuture([]);
    setConfirmDelete(false);
    setDragComponent(null);
  }, [editingKey, draft]);

  const writeDraft = (profile: NowPlayingProfile) => setWorking(current => ({
    ...current,
    customProfiles: upsertCustom(current.customProfiles, profile),
  }));
  const setContext = (next: NowPlayingProfilesSettings["contextSwitching"]) => {
    setConfirmDiscard(false);
    setWorking(current => ({ ...current, contextSwitching: next }));
  };

  /* ------------------------------------------------------------ history */

  const apply = (next: NowPlayingProfile, record = false) => {
    if (record) {
      setPast(history => [...history.slice(-49), JSON.stringify(draft)]);
      setFuture([]);
      committedRef.current = JSON.stringify(next);
    }
    setConfirmDiscard(false);
    writeDraft(next);
  };

  const commit = () => {
    const current = JSON.stringify(draft);
    const previous = committedRef.current;
    if (current === previous) return;
    setPast(history => [...history.slice(-49), previous]);
    setFuture([]);
    committedRef.current = current;
  };

  const restore = (snapshot: string) => {
    const parsed = normalizeNowPlayingProfile(JSON.parse(snapshot), draft.builtIn);
    if (!parsed) return;
    committedRef.current = snapshot;
    writeDraft(parsed);
  };

  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast(past.slice(0, -1));
    setFuture(entries => [JSON.stringify(draft), ...entries]);
    restore(previous);
  };

  const redo = () => {
    const [nextSnapshot, ...rest] = future;
    if (!nextSnapshot) return;
    setFuture(rest);
    setPast(entries => [...entries, JSON.stringify(draft)]);
    restore(nextSnapshot);
  };

  const onEditorKey = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (phase === "exiting" || saving || readOnly) return;
    const target = event.target;
    if (target instanceof Element && target.closest("textarea, input[type=text]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
  };

  /* --------------------------------------------------------- profile ops */

  const selectProfile = (id: string) => {
    setConfirmDiscard(false);
    setWorking(current => activateProfile(current, editMode, id));
  };

  const addProfile = (profile: NowPlayingProfile) => {
    setConfirmDiscard(false);
    setWorking(current => activateProfile({
      ...current,
      customProfiles: upsertCustom(current.customProfiles, profile),
    }, editMode, profile.id));
    // Importing over the current profile doesn't change the editing id.
    committedRef.current = JSON.stringify(profile);
    setPast([]);
    setFuture([]);
  };

  const duplicateDraft = () => {
    const copy = cloneNowPlayingProfile(draft);
    copy.id = createCustomNowPlayingProfileId();
    copy.name = `${draft.name} copy`.slice(0, 60);
    copy.builtIn = false;
    addProfile(copy);
    setMessage(`Duplicated as “${copy.name}”. This copy is yours to edit.`);
  };

  const createNew = () => {
    const fresh = cloneNowPlayingProfile(BUILT_IN_NOW_PLAYING_PROFILES[0]);
    fresh.id = createCustomNowPlayingProfileId();
    fresh.name = "My profile";
    fresh.description = "";
    fresh.builtIn = false;
    addProfile(fresh);
  };

  const deleteDraft = () => {
    if (draft.builtIn) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const remainingId = (id: string) => id === draft.id ? DEFAULT_NOW_PLAYING_PROFILE_ID : id;
    setWorking(current => ({
      ...current,
      customProfiles: current.customProfiles.filter(profile => profile.id !== draft.id),
      activeProfileId: remainingId(current.activeProfileId),
      lyricsOffProfileId: remainingId(current.lyricsOffProfileId),
      contextSwitching: {
        ...current.contextSwitching,
        windowedProfileId: remainingId(current.contextSwitching.windowedProfileId),
        fullscreenProfileId: remainingId(current.contextSwitching.fullscreenProfileId),
      },
    }));
    setConfirmDelete(false);
    setConfirmDiscard(false);
    setMessage(`Deleted “${draft.name}”. Save to make it permanent.`);
  };

  const resetKeys = (keys: (keyof NowPlayingProfileConfig)[]) => {
    const patch: Partial<NowPlayingProfileConfig> = {};
    for (const key of keys) {
      (patch as Record<string, unknown>)[key] = BASE_NOW_PLAYING_PROFILE_CONFIG[key];
    }
    apply({ ...draft, [editMode]: { ...cfg, ...patch } }, true);
  };

  const resetLayout = () => apply({ ...draft, [editMode]: { ...BASE_NOW_PLAYING_PROFILE_CONFIG } }, true);

  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      setMessage("You have unsaved changes — close again to discard them, or Save first.");
      return;
    }
    onClose();
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(working);
      onClose();
    } catch {
      retrySave.current = true;
      setMessage("Could not save Now Playing profiles. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------- import/export */

  const exportDraft = async () => {
    const text = serializeNowPlayingProfile(draft);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      /* clipboard may be unavailable; the download below still works */
    }
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${draft.id}.cadence-profile.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* download best-effort */
    }
    setMessage(
      copied
        ? "Profile JSON copied to the clipboard and downloaded."
        : "Profile JSON downloaded."
    );
  };

  const importProfile = () => {
    const result = parseNowPlayingProfileJson(importText);
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    const profile = result.profile;
    const collidesBuiltIn = BUILT_IN_NOW_PLAYING_PROFILES.some(entry => entry.id === profile.id);
    if (collidesBuiltIn) profile.id = createCustomNowPlayingProfileId();
    const overwrite = working.customProfiles.some(entry => entry.id === profile.id);
    addProfile(profile);
    setImportText("");
    setMessage(
      overwrite
        ? `Imported profile replaced your existing “${profile.name}”. Save to keep it.`
        : `Imported “${profile.name}”. Save to keep it.`
    );
  };

  /* -------------------------------------------------------------- helpers */

  const setCfg = (patch: Partial<NowPlayingProfileConfig>, record = false) =>
    apply({ ...draft, [editMode]: { ...cfg, ...patch } }, record);

  const assignSlot = (component: DragComponent, zone: "left" | "right" | "top") => {
    if (readOnly) return;
    if (component === "artwork") {
      if (zone === "top") return;
      setCfg({ artworkSlot: zone, artworkVisible: true }, true);
    } else {
      setCfg(zone === "top"
        ? { metadataSlot: "top", metadataVisible: true }
        : { metadataSlot: "artwork", metadataVisible: true, artworkSlot: lyricsOff ? (zone === "left" ? "right" : "left") : zone }, true);
    }
    setDragComponent(null);
  };

  const zoneOccupants = (zone: "left" | "right" | "top"): DragComponent[] => {
    const occupants: DragComponent[] = [];
    if (zone !== "top" && cfg.artworkSlot === zone && cfg.artworkVisible) occupants.push("artwork");
    if (zone === "top" && cfg.metadataSlot === "top" && cfg.metadataVisible) occupants.push("metadata");
    if (
      zone !== "top" &&
      cfg.metadataSlot === "artwork" &&
      (lyricsOff ? cfg.artworkSlot !== zone : cfg.artworkSlot === zone) &&
      cfg.metadataVisible
    ) {
      occupants.push("metadata");
    }
    return occupants;
  };

  const chip = (component: DragComponent) => (
    <span
      key={component}
      className={`studio-chip ${dragComponent === component ? "selected" : ""}`}
      draggable={!readOnly}
      onDragStart={() => setDragComponent(component)}
      onClick={event => {
        event.stopPropagation();
        if (!readOnly) setDragComponent(dragComponent === component ? null : component);
      }}
      title={readOnly ? undefined : "Drag to a slot, or click then click a slot"}
    >
      {component === "artwork" ? "Artwork" : "Title & artist"}
    </span>
  );

  /* ------------------------------------------------------------------ UI */

  return (
    <dialog
      className={`np-studio-stage ${phaseClass}`}
      ref={dialogRef}
      aria-labelledby="np-studio-title"
      onCancel={event => {
        event.preventDefault();
        requestClose();
      }}
      onKeyDown={onEditorKey}
      onMouseDown={event => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      {renderPreview(draft, editMode)}
      <aside
        className="np-studio"
        data-testid="customization-studio"
        data-presence={phase}
        inert={phase === "exiting" || saving}
        aria-busy={saving}
      >
        <header className="studio-header">
          <div>
            <h2 id="np-studio-title">Customize Now Playing</h2>
            <p>
              {draft.name}
              {readOnly ? " · Built-in (protected)" : " · Custom"}
              {dirty ? " · Unsaved changes" : ""}
            </p>
          </div>
          <div className="studio-header-actions">
            <button type="button" className="dock-icon" onClick={undo} disabled={readOnly || past.length === 0} title="Undo (Ctrl+Z)" aria-label="Undo">
              <Undo2 size={16} />
            </button>
            <button type="button" className="dock-icon" onClick={redo} disabled={readOnly || future.length === 0} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
              <Redo2 size={16} />
            </button>
            <button type="button" className="dock-icon" onClick={requestClose} ref={closeRef} title="Close" aria-label="Close customization" data-testid="studio-close">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="studio-mode-toggle" role="group" aria-label="Surface to edit">
          {EDIT_MODES.map(([mode, label]) => (
            <button
              type="button"
              key={mode}
              className={editMode === mode ? "active" : ""}
              aria-pressed={editMode === mode}
              data-mode={mode}
              onClick={() => {
                setConfirmDiscard(false);
                setEditMode(mode);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="studio-profiles" role="list" aria-label="Profiles">
          {displayProfiles.map(profile => (
            <button
              type="button"
              key={profile.id}
              role="listitem"
              className={`studio-profile-row ${profile.id === draft.id ? "active" : ""}`}
              aria-pressed={profile.id === draft.id}
              onClick={() => selectProfile(profile.id)}
              data-profile-id={profile.id}
            >
              <span>{profile.name}</span>
              <span className="badge">{profile.builtIn ? "Built-in" : "Custom"}</span>
            </button>
          ))}
        </div>

        <div className="studio-profile-actions">
          <button type="button" className="studio-button" onClick={duplicateDraft} data-testid="studio-duplicate">
            <Copy size={14} /> Duplicate
          </button>
          <button type="button" className="studio-button" onClick={createNew}>
            <Plus size={14} /> New
          </button>
          <button
            type="button"
            className="studio-button danger"
            onClick={deleteDraft}
            disabled={readOnly}
          >
            <Trash2 size={14} /> {confirmDelete ? "Confirm delete" : "Delete"}
          </button>
          <button type="button" className="studio-button" onClick={resetLayout} disabled={readOnly}>
            <RotateCcw size={14} /> Reset layout
          </button>
        </div>

        {!readOnly ? (
          <label className="studio-field">
            <span>Profile name</span>
            <input
              type="text"
              value={draft.name}
              maxLength={60}
              onChange={event => apply({ ...draft, name: event.target.value })}
              onBlur={commit}
              data-testid="studio-profile-name"
            />
          </label>
        ) : (
          <p className="studio-note">
            Built-in profiles can be previewed and activated but not edited. Duplicate this
            profile to make it yours.
          </p>
        )}

        <fieldset className="studio-sections" disabled={readOnly}>
          <Section title="Layout" onReset={() => resetKeys(LAYOUT_KEYS)}>
            {editMode === "windowed" ? (
              <p className="studio-note" data-testid="studio-windowed-layout-note">
                The windowed layout has no artwork column or inline playback controls, so
                artwork, placement and playback-control settings are set in the Lyrics On and Off tabs.
              </p>
            ) : null}
            <div className="studio-layout-editor" aria-label="Layout slots">
              {(["left", "right", "top"] as const).map(zone => (
                <div
                  key={zone}
                  className={`studio-slot slot-${zone}`}
                  onDragOver={event => event.preventDefault()}
                  onDrop={() => dragComponent && assignSlot(dragComponent, zone)}
                  onClick={() => dragComponent && assignSlot(dragComponent, zone)}
                >
                  <span className="studio-slot-label">
                    {zone === "top" ? "Top bar" : zone === "left" ? "Left column" : "Right column"}
                  </span>
                  {zoneOccupants(zone).map(chip)}
                  {!lyricsOff && zone !== "top" && cfg.artworkSlot !== zone ? (
                    <span className="studio-slot-lyrics">Lyrics</span>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="studio-note">
              Drag Artwork or Title &amp; artist into a slot (or click a chip, then a slot).{" "}
              {lyricsOff ? "Track details sit beside the artwork or above the layout." : "Lyrics always take the remaining column, so nothing can overlap."}
            </p>
            <SliderRow label="Artwork size" value={cfg.artworkScale} min={0.6} max={1.25} step={0.01} format={pct} onChange={v => setCfg({ artworkScale: v })} onCommit={commit} />
            {!lyricsOff && <SliderRow label="Lyrics max width" value={cfg.lyricsMaxWidth} min={720} max={1280} step={10} format={v => `${Math.round(v)}px`} onChange={v => setCfg({ lyricsMaxWidth: Math.round(v) })} onCommit={commit} />}
            <SliderRow label="Control size" value={cfg.controlsScale} min={0.8} max={1.2} step={0.01} format={pct} onChange={v => setCfg({ controlsScale: v })} onCommit={commit} />
            <SliderRow label="Spacing" value={cfg.spacingScale} min={0.8} max={1.25} step={0.01} format={pct} onChange={v => setCfg({ spacingScale: v })} onCommit={commit} />
            {!lyricsOff && <SelectRow label="Lyrics alignment" value={cfg.lyricsAlignment} options={[["left", "Left"], ["center", "Center"]]} onChange={v => setCfg({ lyricsAlignment: v as typeof cfg.lyricsAlignment }, true)} />}
            <ToggleRow label="Show artwork" checked={cfg.artworkVisible} onChange={v => setCfg({ artworkVisible: v }, true)} />
            <ToggleRow label="Show title & artist" checked={cfg.metadataVisible} onChange={v => setCfg({ metadataVisible: v }, true)} />
            <ToggleRow label="Show playback controls" checked={cfg.controlsVisible} onChange={v => setCfg({ controlsVisible: v }, true)} />
            {!lyricsOff && <ToggleRow label="Show lyrics dock" checked={cfg.dockVisible} onChange={v => setCfg({ dockVisible: v }, true)} />}
          </Section>

          <Section title="Typography" onReset={() => resetKeys(TYPOGRAPHY_KEYS)}>
            {!lyricsOff && <SliderRow label="Main lyrics size" testId="studio-lyrics-scale" value={cfg.lyricsScale} min={0.7} max={1.35} step={0.01} format={pct} onChange={v => setCfg({ lyricsScale: v })} onCommit={commit} />}
            {!lyricsOff && <SliderRow label="Translation size" value={cfg.translationScale} min={0.7} max={1.35} step={0.01} format={pct} onChange={v => setCfg({ translationScale: v })} onCommit={commit} />}
            {!lyricsOff && <SliderRow label="Romanization size" value={cfg.romanizationScale} min={0.7} max={1.35} step={0.01} format={pct} onChange={v => setCfg({ romanizationScale: v })} onCommit={commit} />}
            <SliderRow label="Title size" value={cfg.titleScale} min={0.75} max={1.25} step={0.01} format={pct} onChange={v => setCfg({ titleScale: v })} onCommit={commit} />
            <SliderRow label="Artist / album size" value={cfg.metadataScale} min={0.75} max={1.25} step={0.01} format={pct} onChange={v => setCfg({ metadataScale: v })} onCommit={commit} />
            {!lyricsOff && <SliderRow label="Line spacing" value={cfg.lineSpacingScale} min={0.85} max={1.4} step={0.01} format={pct} onChange={v => setCfg({ lineSpacingScale: v })} onCommit={commit} />}
            {!lyricsOff && <SliderRow label="Letter spacing" value={cfg.letterSpacingEm} min={-0.02} max={0.08} step={0.005} format={v => `${v.toFixed(3)}em`} onChange={v => setCfg({ letterSpacingEm: v })} onCommit={commit} />}
            {!lyricsOff && <FontRow label="Lyrics font" value={cfg.fontId} onChange={v => setCfg({ fontId: v }, true)} />}
            {!lyricsOff && <FontRow label="Translation font" value={cfg.translationFontId} onChange={v => setCfg({ translationFontId: v }, true)} />}
            {!lyricsOff && <FontRow label="Romanization font" value={cfg.romanizationFontId} onChange={v => setCfg({ romanizationFontId: v }, true)} />}
            {!lyricsOff && <SelectRow
              label="Lyrics weight"
              value={String(cfg.lyricsWeight)}
              options={[["0", "From Settings"], ...[300, 400, 500, 600, 700, 800, 900].map(w => [String(w), String(w)] as [string, string])]}
              onChange={v => setCfg({ lyricsWeight: Number(v) }, true)}
            />}
          </Section>

          <Section title="Lyrics appearance" hidden={lyricsOff} onReset={() => resetKeys(APPEARANCE_KEYS)}>
            <ColorRow label="Active line colour" value={cfg.activeColor} onChange={v => setCfg({ activeColor: v }, true)} />
            <ColorRow label="Inactive line colour" value={cfg.inactiveColor} onChange={v => setCfg({ inactiveColor: v }, true)} />
            <SliderRow label="Inactive opacity" value={cfg.inactiveOpacityScale} min={0.4} max={1.6} step={0.01} format={pct} onChange={v => setCfg({ inactiveOpacityScale: v })} onCommit={commit} />
            <SliderRow label="Active line scale" value={cfg.activeLineScale} min={0.9} max={1.2} step={0.01} format={pct} onChange={v => setCfg({ activeLineScale: v })} onCommit={commit} />
            <SliderRow label="Inactive blur" value={cfg.inactiveBlurPx} min={0} max={6} step={0.5} format={v => `${v}px`} onChange={v => setCfg({ inactiveBlurPx: v })} onCommit={commit} />
          </Section>

          <Section title="Karaoke highlight" hidden={lyricsOff} onReset={() => resetKeys(KARAOKE_KEYS)}>
            <SelectRow
              label="Style"
              value={cfg.karaokeStyle}
              options={[["sweep", "Progressive sweep"], ["solid", "Solid"], ["gradient", "Gradient sweep"], ["glow", "Subtle glow"], ["minimal", "Minimal"]]}
              onChange={v => setCfg({ karaokeStyle: v as typeof cfg.karaokeStyle }, true)}
            />
            <SliderRow label="Intensity" value={cfg.karaokeIntensity} min={0} max={1} step={0.01} format={pct} onChange={v => setCfg({ karaokeIntensity: v })} onCommit={commit} />
            <SliderRow label="Active word scale" value={cfg.activeWordScale} min={1} max={1.2} step={0.01} format={pct} onChange={v => setCfg({ activeWordScale: v })} onCommit={commit} />
            <p className="studio-note">
              Word effects follow the file&rsquo;s real word timings. Line-timed lyrics keep
              line highlighting — Cadence never invents syllable timing.
            </p>
          </Section>

          <Section title="Background" onReset={() => resetKeys(BACKGROUND_KEYS)}>
            <SelectRow
              label="Mode"
              testId="studio-background-mode"
              value={cfg.backgroundMode}
              options={[["fluid", "Fluid artwork (shader)"], ["blurred-artwork", "Blurred artwork"], ["gradient", "Artwork gradient"], ["solid", "Solid"], ["particles", "Particles (canvas)"], ["visualizer", "Visualizer (canvas)"]]}
              onChange={v => setCfg({ backgroundMode: v as typeof cfg.backgroundMode }, true)}
            />
            <SliderRow label="Intensity" value={cfg.backgroundIntensity} min={0.2} max={1} step={0.01} format={pct} onChange={v => setCfg({ backgroundIntensity: v })} onCommit={commit} />
            <SliderRow label="Artwork blur" value={cfg.backgroundBlurPx} min={0} max={60} step={1} format={v => `${Math.round(v)}px`} onChange={v => setCfg({ backgroundBlurPx: Math.round(v) })} onCommit={commit} />
            <SliderRow label="Effect speed" value={cfg.effectSpeed} min={0.25} max={2} step={0.05} format={pct} onChange={v => setCfg({ effectSpeed: v })} onCommit={commit} />
            <SliderRow label="Effect density" value={cfg.effectDensity} min={0.25} max={1.5} step={0.05} format={pct} onChange={v => setCfg({ effectDensity: v })} onCommit={commit} />
            <p className="studio-note">
              Canvas effects run only while music plays and the window is visible, and stop
              completely when another background is chosen.
            </p>
          </Section>
        </fieldset>

        <section className="studio-section">
          <h3>Legacy windowed profiles</h3>
          <ToggleRow
            label="Use different profiles for windowed and fullscreen"
            checked={context.enabled}
            onChange={v => setContext({ ...context, enabled: v })}
          />
          <SelectRow
            label="Windowed profile"
            value={context.windowedProfileId}
            options={displayProfiles.map(p => [p.id, p.name] as [string, string])}
            onChange={v => setContext({ ...context, windowedProfileId: v })}
          />
          <SelectRow
            label="Fullscreen profile"
            value={context.fullscreenProfileId}
            options={displayProfiles.map(p => [p.id, p.name] as [string, string])}
            onChange={v => setContext({ ...context, fullscreenProfileId: v })}
          />
        </section>

        <section className="studio-section">
          <h3>Import / export</h3>
          <div className="studio-profile-actions">
            <button type="button" className="studio-button" onClick={() => void exportDraft()} data-testid="studio-export">
              <Download size={14} /> Export profile
            </button>
          </div>
          <label className="studio-field">
            <span>Import profile JSON</span>
            <textarea
              value={importText}
              onChange={event => setImportText(event.target.value)}
              placeholder='{"kind":"cadence-now-playing-profile", …}'
              rows={4}
              data-testid="studio-import-text"
            />
          </label>
          <button type="button" className="studio-button" onClick={importProfile} disabled={!importText.trim()} data-testid="studio-import">
            <Upload size={14} /> Import
          </button>
          <p className="studio-note">
            Imports are validated field by field. A profile file is data only — it can never
            run code. Importing over an existing custom profile replaces it after you Save.
          </p>
        </section>

        {message ? (
          <p className="studio-message" role="status">
            <Check size={14} /> {message}
          </p>
        ) : null}

        <footer className="studio-footer">
          <button type="button" className="studio-button" onClick={requestClose}>
            {confirmDiscard ? "Discard changes" : "Cancel"}
          </button>
          <button type="button" className="studio-button primary" ref={saveRef} onClick={() => void save()} disabled={saving} data-testid="studio-save">
            <Save size={14} /> {saving ? "Saving…" : "Save & apply"}
          </button>
        </footer>
      </aside>
    </dialog>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function Section({
  title,
  onReset,
  children,
  hidden,
}: {
  title: string;
  hidden?: boolean;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="studio-section" hidden={hidden}>
      <div className="studio-section-head">
        <h3>{title}</h3>
        <button type="button" className="studio-reset" onClick={onReset} title={`Reset ${title}`}>
          <RotateCcw size={12} /> Reset
        </button>
      </div>
      {children}
    </section>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  onCommit,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  onCommit: () => void;
  testId?: string;
}) {
  return (
    <label className="studio-row">
      <span className="studio-row-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        data-testid={testId}
        aria-label={label}
      />
      <output>{format(value)}</output>
    </label>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
  testId?: string;
}) {
  return (
    <label className="studio-row">
      <span className="studio-row-label">{label}</span>
      <select value={value} onChange={event => onChange(event.target.value)} data-testid={testId} aria-label={label}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function FontRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const families = useSystemFonts(state => state.families);
  const loadFonts = useSystemFonts(state => state.load);
  useEffect(() => {
    void loadFonts();
  }, [loadFonts]);
  const normalized = normalizeFontId(value);
  const missing =
    normalized !== "system" &&
    normalized !== "monospace" &&
    !families.some(family => family.family.toLowerCase() === normalized.toLowerCase());
  const options: [string, string][] = [
    ["", "App font"],
    ["system", "System default"],
    ["monospace", "Monospace"],
    ...(missing ? [[normalized, `${normalized} (not installed)`] as [string, string]] : []),
    ...families.map(family => [family.family, family.family] as [string, string]),
  ];
  return (
    <label className="studio-row">
      <span className="studio-row-label">{label}</span>
      <select value={value} onChange={event => onChange(event.target.value)} aria-label={label}>
        {options.map(([optionValue, optionLabel]) => (
          <option
            key={optionValue}
            value={optionValue}
            style={optionValue ? { fontFamily: fontStack(optionValue) } : undefined}
          >
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="studio-row studio-toggle">
      <span className="studio-row-label">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        aria-label={label}
      />
    </label>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="studio-row">
      <span className="studio-row-label">{label}</span>
      <span className="studio-color">
        <input
          type="color"
          value={value || "#ffffff"}
          onChange={event => onChange(event.target.value)}
          aria-label={label}
        />
        <span>{value || "Theme"}</span>
        {value ? (
          <button type="button" className="studio-reset" onClick={() => onChange("")}>
            Use theme
          </button>
        ) : null}
      </span>
    </div>
  );
}
