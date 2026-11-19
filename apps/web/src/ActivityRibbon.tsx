import { useState, type ReactNode } from "react";
import type { ActivityEvent } from "./api";
import { shortTitle } from "./format";

/** Events named on the ribbon line itself; the rest sit behind "+N more". */
const INLINE_COUNT = 3;

function who(e: ActivityEvent) {
  if (!e.actorEmail) return e.kind === "tracks_added" ? "library" : "someone";
  return e.actorEmail.split("@")[0];
}

function describe(e: ActivityEvent): ReactNode {
  const title = e.trackFilename ? (
    <span className="activity-track">{shortTitle(e.trackFilename)}</span>
  ) : (
    "a track"
  );
  const actor = <span className="activity-who">{who(e)}</span>;
  switch (e.kind) {
    case "comment":
      return (
        <>
          {actor} commented on {title}
        </>
      );
    case "tag":
      return (
        <>
          {actor} tagged {title}{" "}
          <span className="activity-tag">#{e.detail}</span>
        </>
      );
    case "released":
      return (
        <>
          {actor} marked {title} released ({e.detail})
        </>
      );
    case "tracks_added": {
      const n = Number(e.detail) || 1;
      return e.trackFilename && n === 1 ? (
        <>new track: {title}</>
      ) : (
        <>
          {n} new {n === 1 ? "track" : "tracks"}
        </>
      );
    }
  }
}

function when(e: ActivityEvent) {
  return new Date(e.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Thin "what's new" line under the dock: who commented, tagged or released
 * what since this browser last dismissed it. Clicking an entry shows its
 * track in the list (focus only, never play). Non-blocking; × marks all
 * as seen.
 */
export function ActivityRibbon({
  events,
  onShowTrack,
  onDismiss,
}: {
  events: ActivityEvent[];
  /** Focus and reveal the track's row. */
  onShowTrack: (trackId: string) => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (events.length === 0) return null;

  const inline = events.slice(0, INLINE_COUNT);
  const more = events.length - inline.length;

  function item(e: ActivityEvent) {
    const trackId = e.trackId;
    return (
      <button
        key={e.id}
        type="button"
        className="activity-item"
        title={`${when(e)}${trackId ? " — show in list" : ""}`}
        disabled={!trackId}
        onClick={() => trackId && onShowTrack(trackId)}
      >
        {describe(e)}
      </button>
    );
  }

  return (
    <section className="activity" aria-label="Band activity">
      <div className="activity-line">
        <span className="activity-kicker">new</span>
        <span className="activity-items">
          {inline.map((e, i) => (
            <span key={e.id} className="activity-entry">
              {i > 0 && (
                <span className="activity-sep" aria-hidden="true">
                  ·
                </span>
              )}
              {item(e)}
            </span>
          ))}
        </span>
        {more > 0 && (
          <button
            type="button"
            className="activity-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "less" : `+${more} more`}
          </button>
        )}
        <button
          type="button"
          className="activity-dismiss"
          aria-label="Dismiss activity"
          title="Mark all as seen"
          onClick={() => {
            setExpanded(false);
            onDismiss();
          }}
        >
          ×
        </button>
      </div>
      {expanded && more > 0 && (
        <ul className="activity-list">
          {events.slice(INLINE_COUNT).map((e) => (
            <li key={e.id}>
              <span className="activity-when">{when(e)}</span>
              {item(e)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
