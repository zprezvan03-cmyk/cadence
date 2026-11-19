/** Settings entry point for the live Now Playing Customization Studio. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal } from "lucide-react";
import type { NowPlayingLayoutMode, NowPlayingProfile } from "../../../shared/types";
import { useCurrentMediaItem, useCurrentTrack } from "../../app/hooks";
import { usePresence } from "../../app/usePresence";
import { usePlayer } from "../../state/playerStore";
import { useSettings } from "../../state/settingsStore";
import { CustomizationStudio } from "../lyrics/CustomizationStudio";
import { LyricsView } from "../lyrics/LyricsView";

export function NowPlayingAppearance() {
  const profiles = useSettings(state => state.settings?.nowPlayingProfiles);
  const lyricsOn = useSettings(state => state.settings?.lyrics.showLyricsInFullscreen ?? true);
  const patch = useSettings(state => state.patch);
  const [open, setOpen] = useState(false);
  const [initialMode, setInitialMode] = useState<NowPlayingLayoutMode>("fullscreen");
  const presence = usePresence(open);
  const launcher = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!presence.mounted && !open && restoreFocus.current) {
      restoreFocus.current = false;
      launcher.current?.focus({ preventScroll: true });
    }
  }, [presence.mounted, open]);

  return (
    <div className="settings-subsection" data-testid="settings-now-playing">
      <h3>Now Playing</h3>
      <div className="setting-row">
        <span>
          <strong>Layout and appearance</strong>
          <em>Preview and customize the Lyrics On and Lyrics Off layouts independently.</em>
        </span>
        <button
          type="button"
          ref={launcher}
          data-testid="customize-now-playing"
          aria-label="Customize Now Playing"
          aria-haspopup="dialog"
          disabled={!profiles}
          onClick={() => {
            setInitialMode(lyricsOn ? "fullscreen" : "lyricsOff");
            restoreFocus.current = true;
            setOpen(true);
          }}
        >
          <SlidersHorizontal size={16} /> Customize
        </button>
      </div>
      {presence.mounted && profiles ? createPortal(
        <CustomizationStudio
          profilesSettings={profiles}
          initialMode={initialMode}
          renderPreview={(profile, mode) => <StudioPreview profile={profile} mode={mode} />}
          onSave={payload => patch({ nowPlayingProfiles: payload }, { optimistic: false })}
          onClose={() => setOpen(false)}
          phaseClass={presence.phaseClass}
          phase={presence.phase}
        />,
        document.body
      ) : null}
    </div>
  );
}

function StudioPreview({ profile, mode }: { profile: NowPlayingProfile; mode: NowPlayingLayoutMode }) {
  const track = useCurrentTrack();
  const item = useCurrentMediaItem();
  const playing = usePlayer(state => state.isPlaying);
  const frame = useRef<HTMLDivElement>(null);
  const space = useRef<HTMLDivElement>(null);
  const windowed = mode === "windowed";

  useLayoutEffect(() => {
    const node = frame.current;
    const available = space.current;
    if (!node || !available) return;
    // Use the actual target proportions, then fit the whole composition in the preview.
    // Narrowing the real layout to the drawer's leftover width would hide the artwork.
    const content = windowed ? document.querySelector<HTMLElement>("#root .content-scroll") : null;
    const fit = () => {
      const width = content?.clientWidth || window.innerWidth;
      const height = content?.clientHeight || window.innerHeight;
      const scale = Math.min(available.clientWidth / width, available.clientHeight / height, 1);
      node.style.setProperty("--studio-preview-width", `${width}px`);
      node.style.setProperty("--studio-preview-height", `${height}px`);
      node.style.setProperty("--studio-preview-scale", String(scale));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(available);
    if (content) observer.observe(content);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [windowed]);

  return (
    <div className="np-studio-preview" inert>
      <div className="studio-preview-label">
        <span>Live preview</span>
        <span>{windowed ? "Windowed" : mode === "lyricsOff" ? "Lyrics Off" : "Lyrics On"}</span>
      </div>
      <div className="studio-preview-space" ref={space}>
        <div className="studio-preview-frame" ref={frame}>
          <div className="studio-preview-screen">
            <LyricsView track={track} item={item} playing={playing} fullscreen={!windowed} preview={{ mode, profile }} />
          </div>
        </div>
      </div>
    </div>
  );
}
