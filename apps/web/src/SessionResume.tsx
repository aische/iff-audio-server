import type { Track } from "./api";
import { shortTitle } from "./format";

/**
 * What the dock offers while nothing is loaded (pool mode): continue the
 * last played track, and the tracks still waiting for the user's comment.
 * Nothing here plays on its own; play is always the user's click.
 */
export function SessionResume({
  lastPlayed,
  waitingCount,
  waitingShown,
  onPlay,
  onShow,
  onShowWaiting,
}: {
  /** Last played track, if it is still in the library and playable. */
  lastPlayed: Track | null;
  /** Tracks without the user's comment (released ones per hide-released). */
  waitingCount: number;
  /** The list already shows exactly those tracks. */
  waitingShown: boolean;
  onPlay: (track: Track) => void;
  /** Focus the row and bring it into view (revealing it if hidden). */
  onShow: (track: Track) => void;
  onShowWaiting: () => void;
}) {
  if (!lastPlayed && waitingCount === 0) {
    return <span className="transport-placeholder">no track</span>;
  }

  return (
    <div className="resume" aria-label="Pick up where you left off">
      {lastPlayed && (
        <span className="resume-continue">
          <button
            type="button"
            className="transport-play"
            aria-label={`Continue ${lastPlayed.filename}`}
            title="Play the track you played last (from the start)"
            onClick={() => onPlay(lastPlayed)}
          >
            play
          </button>
          <span className="transport-id">
            <span className="transport-kicker resume-kicker">continue</span>
            <span className="resume-title" title={lastPlayed.filename}>
              {shortTitle(lastPlayed.filename)}
            </span>
          </span>
          <button
            type="button"
            className="resume-action"
            title="Scroll to this track in the list and focus it"
            onClick={() => onShow(lastPlayed)}
          >
            show
          </button>
        </span>
      )}
      {waitingCount > 0 && (
        <button
          type="button"
          className={
            waitingShown ? "resume-action resume-waiting-on" : "resume-action"
          }
          title="List only the tracks you have not commented on yet"
          onClick={onShowWaiting}
        >
          {waitingCount} {waitingCount === 1 ? "track" : "tracks"} without
          your comment
        </button>
      )}
    </div>
  );
}
