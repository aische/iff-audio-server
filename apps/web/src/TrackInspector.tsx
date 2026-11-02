import {
  TOKEN_SEP,
  trackTagList,
  type Comment,
  type Tag,
  type Track,
  type User,
} from "./api";
import { formatDuration, shortTitle } from "./format";

function CommentBody({ body }: { body: string }) {
  return (
    <>
      {body.split(TOKEN_SEP).map((part, i) =>
        part.length > 1 && part.startsWith("#") ? (
          <span key={i} className="inspector-keyword">
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
 * Read-only detail card for one track (last hovered in the library or the
 * arrangement, else the selected row).
 * Pointer-transparent (except its hide button) so it never blocks the rows
 * underneath.
 */
export function TrackInspector({
  track,
  user,
  tagsById,
  onHide,
}: {
  track: Track;
  user: User;
  tagsById: ReadonlyMap<string, Tag>;
  onHide: () => void;
}) {
  const title = shortTitle(track.filename);
  const tags = trackTagList(track, tagsById);
  // Own comment first, then others in server (creation) order.
  const comments: Comment[] = [
    ...track.comments.filter((c) => c.userId === user.id),
    ...track.comments.filter((c) => c.userId !== user.id),
  ];

  return (
    <aside className="inspector" aria-live="polite" aria-label="Track details">
      <button
        type="button"
        className="inspector-hide"
        aria-label="Hide track info"
        title="Hide (toggle with the info button)"
        onClick={onHide}
      >
        ×
      </button>
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
            {tags.map(({ tag, link }) => (
              <span
                key={tag.id}
                className="inspector-tag"
                title={`added by ${link.addedByEmail ?? "a removed user"}`}
              >
                {tag.category && (
                  <span className="inspector-tag-cat">{tag.category}</span>
                )}
                {tag.name}
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
