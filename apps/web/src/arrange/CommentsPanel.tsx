import type { Comment, Track } from "../api";

/** Read-only comments for the selected track; editing stays in the library. */
export function CommentsPanel({ track }: { track: Track | null }) {
  const comments = track?.comments ?? [];
  return (
    <div className="arr-comments">
      {comments.length === 0 ? (
        <p className="arr-comments-foot">
          No comments — edit in the library list.
        </p>
      ) : (
        <>
          <ul className="arr-comments-list">
            {comments.map((c) => (
              <CommentRow key={c.id} comment={c} />
            ))}
          </ul>
          <p className="arr-comments-foot">Edit comments in the library list.</p>
        </>
      )}
    </div>
  );
}

function CommentRow({ comment }: { comment: Comment }) {
  return (
    <li className="arr-comment">
      <span className="arr-comment-email">{comment.userEmail}</span>
      <span className="arr-comment-body">{comment.body}</span>
    </li>
  );
}
