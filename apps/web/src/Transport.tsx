import { useRef, type ReactNode } from "react";
import type { Track } from "./api";
import { formatClock, formatDuration, shortTitle } from "./format";
import { usePeaks } from "./peaks";
import { PeaksCanvas } from "./PeaksCanvas";
import {
  playedFraction,
  usePlayback,
  usePlaybackFrame,
  usePlaybackSeconds,
} from "./playback";

export type TransportProps = {
  /** Loaded track (live library row, so title/duration stay fresh). */
  track: Track | null;
  /**
   * `dock`: the Now Playing stage (pool mode). `compact`: one line, for
   * arrange mode, where the arrangement's own transport is the main control.
   */
  variant?: "dock" | "compact";
  /** Playing track is loaded but not in the current list query. */
  hiddenByFilters?: boolean;
  /** Clear only what hides the playing track; must not stop audio. */
  onRevealInList?: () => void;
  /** Focus the playing track's comment field (dock only). */
  onComment?: () => void;
};

const DOCK_WAVE_COLOR = "rgba(230, 226, 216, 0.42)";

/**
 * Library transport for the shared playback (playback.ts). It is a dock, not
 * a takeover: list, search and per-row editing stay usable beside it.
 */
export default function Transport({
  track,
  variant = "dock",
  hiddenByFilters = false,
  onRevealInList,
  onComment,
}: TransportProps) {
  if (!track) {
    return (
      <div className={`transport transport-empty transport-${variant}`}>
        <span className="transport-placeholder">no track</span>
      </div>
    );
  }

  return (
    <TransportActive
      track={track}
      variant={variant}
      hiddenByFilters={hiddenByFilters}
      onRevealInList={onRevealInList}
      onComment={onComment}
    />
  );
}

function TransportActive({
  track,
  variant,
  hiddenByFilters,
  onRevealInList,
  onComment,
}: {
  track: Track;
  variant: "dock" | "compact";
  hiddenByFilters: boolean;
  onRevealInList?: () => void;
  onComment?: () => void;
}) {
  const { isPlaying, duration, togglePause, seek } = usePlayback();
  // Only this component re-renders on time updates (about once a second).
  const currentTime = usePlaybackSeconds();

  const displayDuration = duration ?? track.durationSeconds ?? null;
  const maxSec =
    displayDuration != null ? Math.max(1, Math.floor(displayDuration)) : null;

  const playButton = (
    <button
      type="button"
      className="transport-play"
      onClick={togglePause}
      aria-label={isPlaying ? "Pause" : "Play"}
    >
      {isPlaying ? "pause" : "play"}
    </button>
  );

  const hidden = hiddenByFilters && (
    <span className="transport-hidden">
      <span className="transport-hidden-label">not in list</span>
      {onRevealInList && (
        <button
          type="button"
          className="transport-reveal"
          title="Clear only what hides this track from the list (keeps playing)"
          onClick={onRevealInList}
        >
          show
        </button>
      )}
    </span>
  );

  const clock = (
    <span className="transport-time">
      <span className="transport-time-now">{formatClock(currentTime)}</span>
      {" / "}
      {formatDuration(
        displayDuration != null ? Math.floor(displayDuration) : null,
      )}
    </span>
  );

  const scrub = maxSec != null && (
    <input
      type="range"
      className="transport-scrub"
      min={0}
      max={maxSec}
      value={Math.min(currentTime, maxSec)}
      onChange={(e) => seek(Number(e.target.value))}
      aria-label="Scrub"
    />
  );

  if (variant === "compact") {
    return (
      <div
        className="transport transport-compact"
        title="Library playback. The arrangement has its own transport."
      >
        {playButton}
        <span className="transport-kicker">library</span>
        <span className="transport-title">{shortTitle(track.filename)}</span>
        {hidden}
        {clock}
        {scrub}
      </div>
    );
  }

  return (
    <section className="transport transport-dock" aria-label="Now playing">
      <div className="transport-head">
        {playButton}
        <div className="transport-id">
          <span className="transport-kicker">
            {isPlaying ? "now playing" : "paused"}
          </span>
          <span className="transport-title" title={track.filename}>
            {shortTitle(track.filename)}
          </span>
        </div>
        {hidden}
        {onComment && (
          <button
            type="button"
            className="transport-comment"
            title="Jump to this track's comment field in the list (keeps playing)"
            onClick={onComment}
          >
            comment
          </button>
        )}
        {clock}
      </div>
      <DockWave
        trackId={track.id}
        duration={displayDuration}
        scrub={scrub}
      />
    </section>
  );
}

/**
 * Waveform of the playing track with the played part tinted and a moving
 * playhead. A transparent range input on top does the seeking, so mouse,
 * drag and keyboard all work.
 */
function DockWave({
  trackId,
  duration,
  scrub,
}: {
  trackId: string;
  duration: number | null;
  scrub: ReactNode;
}) {
  const rec = usePeaks(trackId);
  const progressRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);

  usePlaybackFrame((sec) => {
    const p = playedFraction(sec, duration ?? rec?.durationSec ?? null);
    if (progressRef.current) {
      progressRef.current.style.transform = `scaleX(${p})`;
    }
    if (headRef.current) {
      headRef.current.style.transform = `translateX(${p * 100}%)`;
    }
  });

  return (
    <div className="transport-wave">
      {rec ? (
        <PeaksCanvas
          rec={rec}
          color={DOCK_WAVE_COLOR}
          className="transport-wave-canvas"
        />
      ) : (
        <div className="wave-flat" aria-hidden />
      )}
      <div ref={progressRef} className="transport-wave-progress" aria-hidden />
      <div ref={headRef} className="wave-playhead" aria-hidden />
      {scrub}
    </div>
  );
}
