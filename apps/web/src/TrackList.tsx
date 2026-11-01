import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  api,
  unifiedTags,
  type Comment,
  type Track,
  type User,
} from "./api";
import { formatDuration, shortTitle } from "./format";
import { TRACK_MIME } from "./mime";
import {
  COMMENT_W_KEY,
  COMMENT_W_DEFAULT,
  COMMENT_W_MAX,
  COMMENT_W_MIN,
  TITLE_W_KEY,
  TITLE_W_DEFAULT,
  TITLE_W_MAX,
  TITLE_W_MIN,
  type AppMode,
  type FilterId,
  type PoolSort,
  type SortKey,
  usePersistedWidth,
} from "./uiPersist";

const AUTOSAVE_MS = 500;

export type TrackListFilters = {
  filter: FilterId;
  tagFilter: string | null;
  hideReleased: boolean;
  showOthers: boolean;
  sort: PoolSort;
  allTags: string[];
  visibleCount: number;
  visibleTotalSec: number;
  onFilter: (id: FilterId) => void;
  onTagFilter: (tag: string | null) => void;
  onHideReleased: (value: boolean) => void;
  onShowOthers: (value: boolean) => void;
  onToggleSort: (key: SortKey) => void;
};

export function FilterBar({
  filters,
  mode,
  showOthersToggle,
}: {
  filters: TrackListFilters;
  mode: AppMode;
  showOthersToggle: boolean;
}) {
  const {
    filter,
    tagFilter,
    hideReleased,
    showOthers,
    allTags,
    visibleCount,
    visibleTotalSec,
    onFilter,
    onTagFilter,
    onHideReleased,
    onShowOthers,
  } = filters;

  return (
    <div className="filter-row">
      {(
        [
          ["all", "all"],
          ["commented", "commented"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={
            filter === id && !tagFilter
              ? "filterButton filterSelected"
              : "filterButton"
          }
          onClick={() => {
            onFilter(id);
            onTagFilter(null);
          }}
        >
          {label}
        </button>
      ))}
      {allTags.length > 0 && (
        <select
          className={tagFilter ? "tagSelect tagSelectActive" : "tagSelect"}
          value={tagFilter ?? ""}
          onChange={(e) => onTagFilter(e.target.value || null)}
          aria-label="Filter by tag"
        >
          <option value="">tags…</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>
              #{tag}
            </option>
          ))}
        </select>
      )}
      <span className="filter-meta">
        ({tagFilter ? `#${tagFilter}` : filter}) [{visibleCount} tracks ·{" "}
        {formatDuration(Math.floor(visibleTotalSec))}]
      </span>
      {tagFilter && (
        <button
          type="button"
          className="tagButton"
          onClick={() => onTagFilter(null)}
        >
          clear #{tagFilter}
        </button>
      )}
      <button
        type="button"
        className={
          hideReleased ? "filterButton filterSelected" : "filterButton"
        }
        onClick={() => onHideReleased(!hideReleased)}
        title="Hide tracks that already have a release label"
      >
        {hideReleased ? "released hidden" : "released shown"}
      </button>
      {showOthersToggle && mode === "pool" && (
        <button
          type="button"
          className={
            showOthers ? "filterButton filterSelected" : "filterButton"
          }
          onClick={() => onShowOthers(!showOthers)}
          title="Show other users' comments under each row"
        >
          {showOthers ? "others on" : "others off"}
        </button>
      )}
    </div>
  );
}

function SortHeader({
  className,
  label,
  sortKey,
  sort,
  onToggle,
}: {
  className: string;
  label: string;
  sortKey: SortKey;
  sort: PoolSort;
  onToggle: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      className={`${className} col-sort${active ? " col-sort-active" : ""}`}
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      }
      title={`Sort by ${label}`}
      onClick={() => onToggle(sortKey)}
    >
      {label}
      {active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </button>
  );
}

function ReleaseLabel({
  track,
  onChange,
  onError,
}: {
  track: Track;
  onChange: (releasedOn: string | null) => void;
  onError: (message: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(value: string | null) {
    const next = value?.trim() || null;
    if (next === track.releasedOn) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const row = await api.setTrackReleasedOn(track.id, next);
      onChange(row.releasedOn);
      setEditing(false);
      onError(null);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to save release label",
      );
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form
        className="release-edit"
        onSubmit={(e) => {
          e.preventDefault();
          void save(draft);
        }}
      >
        <input
          autoFocus
          value={draft}
          disabled={busy}
          placeholder="release…"
          aria-label={`Release label for ${track.filename}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button type="submit" className="release-btn" disabled={busy}>
          ok
        </button>
        {track.releasedOn && (
          <button
            type="button"
            className="release-btn"
            disabled={busy}
            title="Mark as unreleased"
            onClick={() => void save(null)}
          >
            clear
          </button>
        )}
        <button
          type="button"
          className="release-btn"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          ×
        </button>
      </form>
    );
  }

  return (
    <button
      type="button"
      className={
        track.releasedOn ? "release-label release-set" : "release-label"
      }
      title={
        track.releasedOn
          ? `Released on ${track.releasedOn} — click to edit`
          : "Mark as released"
      }
      onClick={() => {
        setDraft(track.releasedOn ?? "");
        setEditing(true);
      }}
    >
      {track.releasedOn ?? "rel"}
    </button>
  );
}

function TrackRow({
  track,
  user,
  mode,
  playing,
  selected,
  showOthers,
  showComments,
  tagFilter,
  draggable,
  onTogglePlay,
  onSelect,
  onTagClick,
  onCommentsChange,
  onReleasedOnChange,
  onAddToArrangement,
  onError,
}: {
  track: Track;
  user: User;
  mode: AppMode;
  playing: boolean;
  selected: boolean;
  showOthers: boolean;
  showComments: boolean;
  tagFilter: string | null;
  draggable: boolean;
  onTogglePlay: () => void;
  onSelect: () => void;
  onTagClick: (tag: string) => void;
  onCommentsChange: (comments: Comment[]) => void;
  onReleasedOnChange: (releasedOn: string | null) => void;
  onAddToArrangement?: (trackId: string) => void;
  onError: (message: string | null) => void;
}) {
  const mine = track.comments.find((c) => c.userId === user.id);
  const others = track.comments.filter((c) => c.userId !== user.id);
  const [draft, setDraft] = useState(mine?.body ?? "");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [downloading, setDownloading] = useState(false);
  const draftRef = useRef(draft);
  const savedBodyRef = useRef(mine?.body ?? "");
  const seqRef = useRef(0);

  useEffect(() => {
    const body = mine?.body ?? "";
    if (
      body !== savedBodyRef.current &&
      draftRef.current === savedBodyRef.current
    ) {
      setDraft(body);
      draftRef.current = body;
      savedBodyRef.current = body;
    }
  }, [mine?.body]);

  async function persist(body: string) {
    const trimmed = body.trim();
    if (trimmed === savedBodyRef.current.trim()) {
      setSaveState("idle");
      return;
    }
    const seq = ++seqRef.current;
    setSaveState("saving");
    try {
      const saved = await api.setTrackComment(track.id, body);
      if (seq !== seqRef.current) return;
      savedBodyRef.current = saved?.body ?? "";
      const withoutMine = track.comments.filter((c) => c.userId !== user.id);
      onCommentsChange(saved ? [...withoutMine, saved] : withoutMine);
      setSaveState("saved");
      onError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setSaveState("error");
      onError(err instanceof Error ? err.message : "Failed to save comment");
    }
  }

  const persistLater = useEffectEvent((body: string) => {
    void persist(body);
  });

  useEffect(() => {
    if (!showComments) return;
    draftRef.current = draft;
    if (draft.trim() === savedBodyRef.current.trim()) {
      setSaveState("idle");
      return;
    }
    const t = window.setTimeout(() => persistLater(draft), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [draft, showComments]);

  const tags = unifiedTags(track.comments.map((c) => c.body));

  return (
    <div
      className={[
        "track1",
        mode === "arrange" ? "track1-compact" : "",
        playing ? "track-playing" : "",
        selected ? "track-selected" : "",
        !track.present ? "track-missing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData(TRACK_MIME, track.id);
        e.dataTransfer.setData("text/plain", track.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onSelect}
      onDoubleClick={(e) => {
        // Double-clicking a control inside the row is not "add this track".
        if (
          e.target instanceof Element &&
          e.target.closest("button, input, select, a")
        ) {
          return;
        }
        if (mode === "arrange" && onAddToArrangement && track.present) {
          onAddToArrangement(track.id);
        }
      }}
    >
      <div className="trackBox1">
        <button
          type="button"
          className={playing ? "track-play track-play-active" : "track-play"}
          disabled={!track.present}
          title={playing ? `Stop ${track.filename}` : `Play ${track.filename}`}
          aria-label={
            playing ? `Stop ${track.filename}` : `Play ${track.filename}`
          }
          aria-pressed={playing}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePlay();
          }}
        >
          {playing ? "■" : "▶"}
        </button>
        <div className="trackDur">{formatDuration(track.durationSeconds)}</div>
        <span
          className="trackTitle"
          title={
            mode === "arrange" && draggable
              ? `${track.filename} — drag or double-click to add`
              : track.filename
          }
        >
          {shortTitle(track.filename)}
          {!track.present && " (missing)"}
        </span>
      </div>
      {showComments && (
        <div className="trackBox2">
          <div className="input_box1">
            <input
              value={draft}
              placeholder="comment… use #tags"
              aria-label={`Comment for ${track.filename}`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaveState("idle");
              }}
              onBlur={() => {
                if (draft.trim() !== savedBodyRef.current.trim()) {
                  void persist(draft);
                }
              }}
            />
          </div>
          <span
            className={[
              "save-hint",
              saveState === "error" ? "save-error" : "",
              saveState === "saved" ? "save-ok" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-live="polite"
          >
            {saveState === "saving"
              ? "…"
              : saveState === "saved"
                ? "✓"
                : saveState === "error"
                  ? "!"
                  : ""}
          </span>
        </div>
      )}
      <button
        type="button"
        className="track-dl"
        disabled={!track.present || downloading}
        title={`Download ${track.filename}`}
        aria-label={`Download ${track.filename}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!track.present || downloading) return;
          setDownloading(true);
          void api
            .downloadTrack(track.id, track.filename)
            .catch((err) =>
              onError(
                err instanceof Error ? err.message : "Failed to download",
              ),
            )
            .finally(() => setDownloading(false));
        }}
      >
        {downloading ? "…" : "↓"}
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ReleaseLabel
          track={track}
          onChange={onReleasedOnChange}
          onError={onError}
        />
      </div>
      {tags.length > 0 && (
        <div className="tag-row">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={
                tagFilter === tag ? "tagButton tagButtonSelected" : "tagButton"
              }
              onClick={(e) => {
                e.stopPropagation();
                onTagClick(tag);
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {showComments && showOthers && others.length > 0 && (
        <ul className="other-comments">
          {others.map((c) => (
            <li key={c.id}>
              <span className="other-email">{c.userEmail}</span>
              <span className="other-body">{c.body}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TrackList({
  tracks,
  user,
  mode,
  playingId,
  selectedId,
  showOthers,
  tagFilter,
  sort,
  canDragToArrange,
  loading,
  onTogglePlay,
  onSelect,
  onTagClick,
  onToggleSort,
  onCommentsChange,
  onReleasedOnChange,
  onAddToArrangement,
  onError,
}: {
  tracks: Track[];
  user: User;
  mode: AppMode;
  playingId: string | null;
  selectedId: string | null;
  showOthers: boolean;
  tagFilter: string | null;
  sort: PoolSort;
  canDragToArrange: boolean;
  loading: boolean;
  onTogglePlay: (track: Track) => void;
  onSelect: (track: Track) => void;
  onTagClick: (tag: string) => void;
  onToggleSort: (key: SortKey) => void;
  onCommentsChange: (trackId: string, comments: Comment[]) => void;
  onReleasedOnChange: (trackId: string, releasedOn: string | null) => void;
  onAddToArrangement?: (trackId: string) => void;
  onError: (message: string | null) => void;
}) {
  const showComments = mode === "pool";
  const titleCol = usePersistedWidth(
    TITLE_W_KEY,
    TITLE_W_DEFAULT,
    TITLE_W_MIN,
    TITLE_W_MAX,
  );
  const commentCol = usePersistedWidth(
    COMMENT_W_KEY,
    COMMENT_W_DEFAULT,
    COMMENT_W_MIN,
    COMMENT_W_MAX,
  );

  const colStyle = {
    "--title-w": `${titleCol.width}px`,
    "--comment-w": `${commentCol.width}px`,
  } as CSSProperties;

  if (loading) {
    return <p className="status-line">Loading tracks…</p>;
  }
  if (tracks.length === 0) {
    return (
      <p className="status-line">
        No tracks match. Sync the library or clear filters.
      </p>
    );
  }

  return (
    <div className="trackList" style={colStyle}>
      <div className="col-header">
        <div className="trackBox1">
          <span className="track-play-spacer" aria-hidden />
          <SortHeader
            className="trackDur"
            label="dur"
            sortKey="duration"
            sort={sort}
            onToggle={onToggleSort}
          />
          <SortHeader
            className="trackTitle"
            label="title"
            sortKey="name"
            sort={sort}
            onToggle={onToggleSort}
          />
        </div>
        <div
          className="col-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize title column"
          aria-valuemin={TITLE_W_MIN}
          aria-valuemax={TITLE_W_MAX}
          aria-valuenow={titleCol.width}
          title="Drag to resize title · double-click to reset"
          onPointerDown={titleCol.onResizePointerDown}
          onDoubleClick={titleCol.reset}
        />
        {showComments && (
          <>
            <div className="trackBox2">
              <div className="input_box1 col-label">comment</div>
            </div>
            <div
              className="col-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize comment column"
              aria-valuemin={COMMENT_W_MIN}
              aria-valuemax={COMMENT_W_MAX}
              aria-valuenow={commentCol.width}
              title="Drag to resize comment · double-click to reset"
              onPointerDown={commentCol.onResizePointerDown}
              onDoubleClick={commentCol.reset}
            />
          </>
        )}
      </div>
      {tracks.map((track) => (
        <TrackRow
          key={track.id}
          track={track}
          user={user}
          mode={mode}
          playing={playingId === track.id}
          selected={selectedId === track.id}
          showOthers={showOthers}
          showComments={showComments}
          tagFilter={tagFilter}
          draggable={canDragToArrange && track.present}
          onTogglePlay={() => {
            if (track.present) onTogglePlay(track);
          }}
          onSelect={() => onSelect(track)}
          onTagClick={onTagClick}
          onCommentsChange={(next) => onCommentsChange(track.id, next)}
          onReleasedOnChange={(releasedOn) =>
            onReleasedOnChange(track.id, releasedOn)
          }
          onAddToArrangement={onAddToArrangement}
          onError={onError}
        />
      ))}
    </div>
  );
}

export function ChangePasswordPanel({
  onError,
  onClose,
}: {
  onError: (message: string | null) => void;
  onClose: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setDone(false);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setDone(true);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Password change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-panel">
      <form className="login-form" onSubmit={onSubmit}>
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </label>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        <div className="account-actions">
          <button type="submit" disabled={busy}>
            {busy ? "Updating…" : "Update password"}
          </button>
          <button type="button" className="filterButton" onClick={onClose}>
            close
          </button>
        </div>
        {done && <p className="ok">Password updated</p>}
      </form>
    </div>
  );
}
