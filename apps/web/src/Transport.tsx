import type { Track } from "./api";
import { formatClock, formatDuration, shortTitle } from "./format";
import { usePlayback, usePlaybackSeconds } from "./playback";

export type TransportProps = {
  /** Loaded track (live library row, so title/duration stay fresh). */
  track: Track | null;
  /** Playing track is loaded but not in the current list query. */
  hiddenByFilters?: boolean;
  /** Clear only what hides the playing track; must not stop audio. */
  onRevealInList?: () => void;
};

/** Library transport bar: controls for the shared playback (playback.ts). */
export default function Transport({
  track,
  hiddenByFilters = false,
  onRevealInList,
}: TransportProps) {
  if (!track) {
    return (
      <div className="transport transport-empty">
        <span className="transport-placeholder">no track</span>
      </div>
    );
  }

  return (
    <TransportActive
      track={track}
      hiddenByFilters={hiddenByFilters}
      onRevealInList={onRevealInList}
    />
  );
}

function TransportActive({
  track,
  hiddenByFilters,
  onRevealInList,
}: {
  track: Track;
  hiddenByFilters: boolean;
  onRevealInList?: () => void;
}) {
  const { isPlaying, duration, togglePause, seek } = usePlayback();
  // Only this component re-renders on time updates.
  const currentTime = usePlaybackSeconds();

  const displayDuration = duration ?? track.durationSeconds ?? null;

  return (
    <div className="transport">
      <button
        type="button"
        className="transport-play"
        onClick={togglePause}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? "pause" : "play"}
      </button>
      <span className="transport-title">{shortTitle(track.filename)}</span>
      {hiddenByFilters && (
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
      )}
      <span className="transport-time">
        {formatClock(currentTime)}
        {" / "}
        {formatDuration(
          displayDuration != null ? Math.floor(displayDuration) : null,
        )}
      </span>
      {displayDuration != null && (
        <input
          type="range"
          className="transport-scrub"
          min={0}
          max={Math.max(1, Math.floor(displayDuration))}
          value={Math.min(currentTime, Math.floor(displayDuration))}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Scrub"
        />
      )}
    </div>
  );
}
