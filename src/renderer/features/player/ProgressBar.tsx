/**
 * The Now Playing progress bar: a 4px track with a white fill and a small knob, the elapsed time
 * on the left and the total (or remaining) time on the right. Written for Cadence after Better
 * Lyrics' `createProgressBar`.
 *
 * Like the reference, the fill and knob are driven by transforms so the clock ticks never touch
 * layout, a click glides to the clicked position, a drag previews the position and only seeks on
 * release, and the right-hand time is a button that flips between total and remaining (persisted
 * in `playback.showRemainingTime`) with a short cross-fade between the two widths.
 */

import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { formatTime } from "../../player/queue";
import { usePlayer } from "../../state/playerStore";
import { useSettings } from "../../state/settingsStore";

const GLIDE_MS = 260;
const KEY_STEP_S = 5;
const FAST_KEY_STEP_S = 30;

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function ProgressBar({ className = "" }: { className?: string }) {
  const { position, duration, seek, seekBy } = usePlayer(
    useShallow(state => ({
      position: state.position,
      duration: state.duration,
      seek: state.seek,
      seekBy: state.seekBy,
    }))
  );
  const showRemaining = useSettings(state => state.settings?.playback.showRemainingTime ?? false);
  const patchSettings = useSettings(state => state.patch);
  /** Position under the pointer while dragging; the clock resumes driving the bar on release. */
  const [scrub, setScrub] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLButtonElement | null>(null);

  const displayed = scrub ?? Math.min(position, duration || position);
  const progress = duration > 0 ? clamp01(displayed / duration) : 0;
  const endLabel =
    showRemaining && duration > 0 ? `-${formatTime(Math.max(0, duration - displayed))}` : formatTime(duration);

  const positionFor = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width) * (duration || 0);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrub(positionFor(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (scrub === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setScrub(positionFor(event.clientX));
  };
  const endScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (scrub === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const target = positionFor(event.clientX);
    setScrub(null);
    seek(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let delta = 0;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") delta = -(event.shiftKey ? FAST_KEY_STEP_S : KEY_STEP_S);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") delta = event.shiftKey ? FAST_KEY_STEP_S : KEY_STEP_S;
    else if (event.key === "Home") seek(0);
    else if (event.key === "End") seek(duration);
    else return;
    event.preventDefault();
    if (delta !== 0) seekBy(delta);
  };

  /** Better Lyrics animates the time label from the old text's box to the new one. */
  const toggleEndMode = () => {
    const node = endRef.current;
    const next = !showRemaining;
    if (node) {
      const first = node.getBoundingClientRect();
      patchSettings({ playback: { showRemainingTime: next } });
      // Measure after React commits the new label, then animate from the old box.
      requestAnimationFrame(() => {
        const last = node.getBoundingClientRect();
        const dx = first.right - last.right;
        const scale = last.width > 0 ? first.width / last.width : 1;
        node.animate(
          [
            { transform: `translateX(${dx}px) scale(${scale})`, opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
          { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
        );
      });
    } else {
      patchSettings({ playback: { showRemainingTime: next } });
    }
  };

  return (
    <div className={`np-progress ${className}`} data-testid="np-progress">
      <div
        ref={barRef}
        className={`np-progress__bar ${scrub !== null ? "is-dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration || 0)}
        aria-valuenow={Math.round(displayed)}
        aria-valuetext={formatTime(displayed)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onKeyDown={onKeyDown}
        style={{ "--np-progress": progress } as CSSProperties}
      >
        <div className="np-progress__fill-clip">
          <div
            className="np-progress__fill"
            style={{ transform: `scaleX(${progress})`, transition: scrub !== null ? "none" : `transform ${GLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` }}
          />
        </div>
        <div className="np-progress__knob" style={{ left: `${progress * 100}%` }} data-testid="np-progress-knob">
          <span className="np-progress__knob-dot" />
        </div>
      </div>
      <div className="np-progress__times">
        <span className="np-progress__elapsed" data-testid="np-progress-elapsed">{formatTime(displayed)}</span>
        <button
          ref={endRef}
          type="button"
          className="np-progress__end"
          data-mode={showRemaining ? "remaining" : "total"}
          onClick={toggleEndMode}
          title={showRemaining ? "Show total time" : "Show remaining time"}
          data-testid="np-progress-end"
        >
          {endLabel}
        </button>
      </div>
    </div>
  );
}
