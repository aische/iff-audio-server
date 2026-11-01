import { unifiedTags, type Comment, type Track, type User } from "./api";
import { formatDuration, shortTitle } from "./format";

/** Same token split as `parseTags`: separators are kept so text round-trips. */
const TOKEN_SEP = /([^A-Za-z0-9#_:-]+)/;

function CommentBody({ body }: { body: string }) {
  return (
    <>
      {body.split(TOKEN_SEP).map((part, i) =>
        part.length > 1 && part.startsWith("#") ? (
          <span key={i} className="inspector-tag">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Read-only detail card for one track (hovered, else selected).
 * Pointer-transparent so it never blocks the rows underneath.
 */
export function TrackInspector({
  track,
  user,
}: {
  track: Track;
  user: User;
}) {
  const title = shortTitle(track.filename);
  const tags = unifiedTags(track.comments.map((c) => c.body));
  // Own comment first, then others in server (creation) order.
  const comments: Comment[] = [
    ...track.comments.filter((c) => c.userId === user.id),
    ...track.comments.filter((c) => c.userId !== user.id),
  ];

  return (
    <aside className="inspector" aria-live="polite" aria-label="Track details">
      <div className="inspector-head">
        <div className="inspector-title">{title}</div>
        {title !== track.filename && (
          <div className="inspector-filename">{track.filename}</div>
        )}
        <div className="inspector-meta">
          <span>{formatDuration(track.durationSeconds).trim()}</span>
          <span>{formatSize(track.sizeBytes)}</span>
          <span title="File modified">{formatDate(track.mtime)}</span>
          <span className={track.releasedOn ? "inspector-released" : ""}>
            {track.releasedOn ? `released: ${track.releasedOn}` : "unreleased"}
          </span>
          {!track.present && (
            <span className="inspector-missing">missing</span>
          )}
        </div>
        {tags.length > 0 && (
          <div className="inspector-tags">
            {tags.map((tag) => (
              <span key={tag} className="inspector-tag">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>
      {comments.length === 0 ? (
        <div className="inspector-empty">No comments.</div>
      ) : (
        <ul className="inspector-comments">
          {comments.map((c) => (
            <li key={c.id}>
              <div className="inspector-comment-meta">
                <span className="inspector-author">
                  {c.userId === user.id ? "you" : c.userEmail}
                </span>
                <span>{formatDate(c.updatedAt)}</span>
              </div>
              <div className="inspector-comment-body">
                <CommentBody body={c.body} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
