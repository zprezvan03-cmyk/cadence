/**
 * The Now Playing Customization Studio.
 *
 * A drawer over the live Now Playing view: every edit writes to a draft profile that
 * the view renders immediately (same tree, same playback clock), while nothing is
 * persisted until Save. Built-in profiles open read-only — Duplicate makes the
 * editable custom copy — so a shipped preset can never be damaged. Includes the
 * grid-constrained layout editor (components snap into named slots, never free
 * pixels), profile import/export through the validated JSON envelope, and the
 * optional per-context profile activation. Written for Cadence.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
  NowPlayingProfile,
  NowPlayingProfileConfig,
  NowPlayingProfilesSettings,
} from "../../../shared/types";
import {
  BASE_NOW_PLAYING_PROFILE_CONFIG,
  BUILT_IN_NOW_PLAYING_PROFILES,
  cloneNowPlayingProfile,
  createCustomNowPlayingProfileId,
  normalizeNowPlayingProfile,
  parseNowPlayingProfileJson,
  serializeNowPlayingProfile,
} from "../../../shared/nowPlayingProfiles";
import { FONT_OPTIONS } from "../../../shared/fonts";

export interface StudioSavePayload {
  customProfiles: NowPlayingProfile[];
  activeProfileId: string;
  contextSwitching: NowPlayingProfilesSettings["contextSwitching"];
}

interface CustomizationStudioProps {
  profilesSettings: NowPlayingProfilesSettings;
  draft: NowPlayingProfile;
  onDraftChange: (next: NowPlayingProfile) => void;
  /** The surface on screen when the Studio opened; the editor starts on its config. */
  initialMode: "windowed" | "fullscreen";
  onSave: (payload: StudioSavePayload) => void;
  onClose: () => void;
  phaseClass?: string;
  phase?: string;
}

type Mode = "windowed" | "fullscreen";
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
const MOTION_KEYS: (keyof NowPlayingProfileConfig)[] = [
  "lyricTransition",
  "motionIntensity",
  "motionDurationScale",
];

function upsertCustom(list: NowPlayingProfile[], profile: NowPlayingProfile): NowPlayingProfile[] {
  const index = list.findIndex(entry => entry.id === profile.id);
  if (index === -1) return [...list, cloneNowPlayingProfile(profile)];
  const next = [...list];
  next[index] = cloneNowPlayingProfile(profile);
  return next;
}

export function CustomizationStudio({
  profilesSettings,
  draft,
  onDraftChange,
  initialMode,
  onSave,
  onClose,
  phaseClass = "",
  phase,
}: CustomizationStudioProps) {
  const [editMode, setEditMode] = useState<Mode>(initialMode);
  const [workingCustoms, setWorkingCustoms] = useState<NowPlayingProfile[]>(() =>
    profilesSettings.customProfiles.map(cloneNowPlayingProfile)
  );
  const [context, setContext] = useState(profilesSettings.contextSwitching);
  const [past, setPast] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [importText, setImportText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [dragComponent, setDragComponent] = useState<DragComponent | null>(null);
  const committedRef = useRef(JSON.stringify(draft));

  const readOnly = draft.builtIn;
  const cfg = draft[editMode];

  const displayProfiles = useMemo(() => {
    const customs = workingCustoms.map(profile =>
      profile.id === draft.id ? draft : profile
    );
    const all = [...BUILT_IN_NOW_PLAYING_PROFILES, ...customs];
    return all.some(profile => profile.id === draft.id) ? all : [...all, draft];
  }, [workingCustoms, draft]);

  const savedVersion = useMemo(
    () =>
      [...BUILT_IN_NOW_PLAYING_PROFILES, ...profilesSettings.customProfiles].find(
        profile => profile.id === draft.id
      ),
    [profilesSettings.customProfiles, draft.id]
  );
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(savedVersion ?? null) ||
    JSON.stringify(context) !== JSON.stringify(profilesSettings.contextSwitching) ||
    JSON.stringify(workingCustoms.map(profile => profile.id)) !==
      JSON.stringify(profilesSettings.customProfiles.map(profile => profile.id));

  /* ------------------------------------------------------------ history */

  const apply = (next: NowPlayingProfile, record = false) => {
    if (record) {
      setPast(history => [...history.slice(-49), JSON.stringify(draft)]);
      setFuture([]);
      committedRef.current = JSON.stringify(next);
    }
    setConfirmDiscard(false);
    onDraftChange(next);
  };

  const commit = () => {
    const current = JSON.stringify(draft);
    if (current === committedRef.current) return;
    setPast(history => [...history.slice(-49), committedRef.current]);
    setFuture([]);
    committedRef.current = current;
  };

  const restore = (snapshot: string) => {
    const parsed = normalizeNowPlayingProfile(JSON.parse(snapshot), draft.builtIn);
    if (!parsed) return;
    committedRef.current = snapshot;
    onDraftChange(parsed);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
      if (typing || readOnly) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* --------------------------------------------------------- profile ops */

  const switchEditing = (profile: NowPlayingProfile) => {
    // Keep in-progress edits in the working list when moving between customs.
    if (!draft.builtIn) setWorkingCustoms(list => upsertCustom(list, draft));
    setPast([]);
    setFuture([]);
    setConfirmDelete(false);
    committedRef.current = JSON.stringify(profile);
    onDraftChange(cloneNowPlayingProfile(profile));
  };

  const duplicateDraft = () => {
    const copy = cloneNowPlayingProfile(draft);
    copy.id = createCustomNowPlayingProfileId();
    copy.name = `${draft.name} copy`.slice(0, 60);
    copy.builtIn = false;
    setWorkingCustoms(list => [...list, cloneNowPlayingProfile(copy)]);
    setPast([]);
    setFuture([]);
    committedRef.current = JSON.stringify(copy);
    onDraftChange(copy);
    setMessage(`Duplicated as “${copy.name}”. This copy is yours to edit.`);
  };

  const createNew = () => {
    const fresh = cloneNowPlayingProfile(BUILT_IN_NOW_PLAYING_PROFILES[0]);
    fresh.id = createCustomNowPlayingProfileId();
    fresh.name = "My profile";
    fresh.description = "";
    fresh.builtIn = false;
    if (!draft.builtIn) setWorkingCustoms(list => upsertCustom(list, draft));
    setWorkingCustoms(list => [...list, cloneNowPlayingProfile(fresh)]);
    setPast([]);
    setFuture([]);
    committedRef.current = JSON.stringify(fresh);
    onDraftChange(fresh);
  };

  const deleteDraft = () => {
    if (draft.builtIn) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setWorkingCustoms(list => list.filter(profile => profile.id !== draft.id));
    setContext(current => ({
      ...current,
      windowedProfileId:
        current.windowedProfileId === draft.id ? "balanced" : current.windowedProfileId,
      fullscreenProfileId:
        current.fullscreenProfileId === draft.id ? "balanced" : current.fullscreenProfileId,
    }));
    setConfirmDelete(false);
    setMessage(`Deleted “${draft.name}”. Save to make it permanent.`);
    switchEditing(BUILT_IN_NOW_PLAYING_PROFILES[0]);
  };

  const resetKeys = (keys: (keyof NowPlayingProfileConfig)[]) => {
    const patch: Partial<NowPlayingProfileConfig> = {};
    for (const key of keys) {
      (patch as Record<string, unknown>)[key] = BASE_NOW_PLAYING_PROFILE_CONFIG[key];
    }
    apply({ ...draft, [editMode]: { ...cfg, ...patch } }, true);
  };

  const resetAll = () => {
    apply(
      {
        ...draft,
        windowed: { ...BASE_NOW_PLAYING_PROFILE_CONFIG },
        fullscreen: { ...BASE_NOW_PLAYING_PROFILE_CONFIG },
      },
      true
    );
  };

  const requestClose = () => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      setMessage("You have unsaved changes — close again to discard them, or Save first.");
      return;
    }
    onClose();
  };

  const save = () => {
    const customs = draft.builtIn ? workingCustoms : upsertCustom(workingCustoms, draft);
    onSave({ customProfiles: customs, activeProfileId: draft.id, contextSwitching: context });
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
    const overwrite = workingCustoms.some(entry => entry.id === profile.id);
    setWorkingCustoms(list => upsertCustom(list, profile));
    setPast([]);
    setFuture([]);
    committedRef.current = JSON.stringify(profile);
    onDraftChange(cloneNowPlayingProfile(profile));
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
      setCfg({ metadataSlot: zone === "top" ? "top" : "artwork", metadataVisible: true }, true);
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
      cfg.artworkSlot === zone &&
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
    <div
      className={`np-studio-backdrop ${phaseClass}`}
      data-presence={phase}
      onMouseDown={event => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <aside
        className="np-studio"
        role="dialog"
        aria-modal="true"
        aria-label="Customize Now Playing"
        data-testid="customization-studio"
      >
        <header className="studio-header">
          <div>
            <h2>Customize</h2>
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
            <button type="button" className="dock-icon" onClick={requestClose} title="Close" aria-label="Close customization" data-testid="studio-close">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="studio-profiles" role="list" aria-label="Profiles">
          {displayProfiles.map(profile => (
            <button
              type="button"
              key={profile.id}
              role="listitem"
              className={`studio-profile-row ${profile.id === draft.id ? "active" : ""}`}
              onClick={() => switchEditing(profile)}
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
          <button type="button" className="studio-button" onClick={resetAll} disabled={readOnly}>
            <RotateCcw size={14} /> Reset all
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

        <div className="studio-mode-toggle" role="group" aria-label="Surface to edit">
          {(["windowed", "fullscreen"] as Mode[]).map(mode => (
            <button
              type="button"
              key={mode}
              className={editMode === mode ? "active" : ""}
              aria-pressed={editMode === mode}
              onClick={() => setEditMode(mode)}
            >
              {mode === "windowed" ? "Windowed" : "Fullscreen"}
            </button>
          ))}
        </div>

        <fieldset className="studio-sections" disabled={readOnly}>
          <Section title="Layout" onReset={() => resetKeys(LAYOUT_KEYS)}>
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
                  {zone !== "top" && cfg.artworkSlot !== zone ? (
                    <span className="studio-slot-lyrics">Lyrics</span>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="studio-note">
              Drag Artwork or Title &amp; artist into a slot (or click a chip, then a slot).
              Lyrics always take the remaining column, so nothing can overlap.
            </p>
            <SliderRow label="Artwork size" value={cfg.artworkScale} min={0.6} max={1.25} step={0.01} format={pct} onChange={v => setCfg({ artworkScale: v })} onCommit={commit} />
            <SliderRow label="Lyrics max width" value={cfg.lyricsMaxWidth} min={640} max={1280} step={10} format={v => `${Math.round(v)}px`} onChange={v => setCfg({ lyricsMaxWidth: Math.round(v) })} onCommit={commit} />
            <SliderRow label="Control size" value={cfg.controlsScale} min={0.8} max={1.2} step={0.01} format={pct} onChange={v => setCfg({ controlsScale: v })} onCommit={commit} />
            <SliderRow label="Spacing" value={cfg.spacingScale} min={0.8} max={1.25} step={0.01} format={pct} onChange={v => setCfg({ spacingScale: v })} onCommit={commit} />
            <SelectRow label="Lyrics alignment" value={cfg.lyricsAlignment} options={[["left", "Left"], ["center", "Center"]]} onChange={v => setCfg({ lyricsAlignment: v as typeof cfg.lyricsAlignment }, true)} />
            <ToggleRow label="Show artwork" checked={cfg.artworkVisible} onChange={v => setCfg({ artworkVisible: v }, true)} />
            <ToggleRow label="Show title & artist" checked={cfg.metadataVisible} onChange={v => setCfg({ metadataVisible: v }, true)} />
            <ToggleRow label="Show playback controls" checked={cfg.controlsVisible} onChange={v => setCfg({ controlsVisible: v }, true)} />
            <ToggleRow label="Show lyrics dock" checked={cfg.dockVisible} onChange={v => setCfg({ dockVisible: v }, true)} />
          </Section>

          <Section title="Typography" onReset={() => resetKeys(TYPOGRAPHY_KEYS)}>
            <SliderRow label="Main lyrics size" testId="studio-lyrics-scale" value={cfg.lyricsScale} min={0.7} max={1.35} step={0.01} format={pct} onChange={v => setCfg({ lyricsScale: v })} onCommit={commit} />
            <SliderRow label="Translation size" value={cfg.translationScale} min={0.7} max={1.35} step={0.01} format={pct} onChange={v => setCfg({ translationScale: v })} onCommit={commit} />
            <SliderRow label="Romanization size" value={cfg.romanizationScale} min={0.7} max={1.35} step={0.01} format={pct} onChange={v => setCfg({ romanizationScale: v })} onCommit={commit} />
            <SliderRow label="Title size" value={cfg.titleScale} min={0.75} max={1.25} step={0.01} format={pct} onChange={v => setCfg({ titleScale: v })} onCommit={commit} />
            <SliderRow label="Artist / album size" value={cfg.metadataScale} min={0.75} max={1.25} step={0.01} format={pct} onChange={v => setCfg({ metadataScale: v })} onCommit={commit} />
            <SliderRow label="Line spacing" value={cfg.lineSpacingScale} min={0.85} max={1.4} step={0.01} format={pct} onChange={v => setCfg({ lineSpacingScale: v })} onCommit={commit} />
            <SliderRow label="Letter spacing" value={cfg.letterSpacingEm} min={-0.02} max={0.08} step={0.005} format={v => `${v.toFixed(3)}em`} onChange={v => setCfg({ letterSpacingEm: v })} onCommit={commit} />
            <FontRow label="Lyrics font" value={cfg.fontId} onChange={v => setCfg({ fontId: v }, true)} />
            <FontRow label="Translation font" value={cfg.translationFontId} onChange={v => setCfg({ translationFontId: v }, true)} />
            <FontRow label="Romanization font" value={cfg.romanizationFontId} onChange={v => setCfg({ romanizationFontId: v }, true)} />
            <SelectRow
              label="Lyrics weight"
              value={String(cfg.lyricsWeight)}
              options={[["0", "From Settings"], ...[300, 400, 500, 600, 700, 800, 900].map(w => [String(w), String(w)] as [string, string])]}
              onChange={v => setCfg({ lyricsWeight: Number(v) }, true)}
            />
          </Section>

          <Section title="Lyrics appearance" onReset={() => resetKeys(APPEARANCE_KEYS)}>
            <ColorRow label="Active line colour" value={cfg.activeColor} onChange={v => setCfg({ activeColor: v }, true)} />
            <ColorRow label="Inactive line colour" value={cfg.inactiveColor} onChange={v => setCfg({ inactiveColor: v }, true)} />
            <SliderRow label="Inactive opacity" value={cfg.inactiveOpacityScale} min={0.4} max={1.6} step={0.01} format={pct} onChange={v => setCfg({ inactiveOpacityScale: v })} onCommit={commit} />
            <SliderRow label="Active line scale" value={cfg.activeLineScale} min={0.9} max={1.2} step={0.01} format={pct} onChange={v => setCfg({ activeLineScale: v })} onCommit={commit} />
            <SliderRow label="Inactive blur" value={cfg.inactiveBlurPx} min={0} max={6} step={0.5} format={v => `${v}px`} onChange={v => setCfg({ inactiveBlurPx: v })} onCommit={commit} />
          </Section>

          <Section title="Karaoke highlight" onReset={() => resetKeys(KARAOKE_KEYS)}>
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

          <Section title="Motion" onReset={() => resetKeys(MOTION_KEYS)}>
            <SelectRow
              label="Line transition"
              value={cfg.lyricTransition}
              options={[["scale", "Scale"], ["fade", "Fade"], ["slide", "Slide"], ["none", "None"]]}
              onChange={v => setCfg({ lyricTransition: v as typeof cfg.lyricTransition }, true)}
            />
            <SliderRow label="Intensity" value={cfg.motionIntensity} min={0} max={1.5} step={0.01} format={pct} onChange={v => setCfg({ motionIntensity: v })} onCommit={commit} />
            <SliderRow label="Duration" value={cfg.motionDurationScale} min={0.5} max={1.75} step={0.05} format={pct} onChange={v => setCfg({ motionDurationScale: v })} onCommit={commit} />
            <p className="studio-note">The system and app reduced-motion settings always take precedence.</p>
          </Section>
        </fieldset>

        <section className="studio-section">
          <h3>Per-context profiles</h3>
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
          <button type="button" className="studio-button primary" onClick={save} data-testid="studio-save">
            <Save size={14} /> Save &amp; apply
          </button>
        </footer>
      </aside>
    </div>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function Section({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="studio-section">
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
  return (
    <SelectRow
      label={label}
      value={value}
      options={[["", "App font"], ...FONT_OPTIONS.map(option => [option.id, option.label] as [string, string])]}
      onChange={onChange}
    />
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
