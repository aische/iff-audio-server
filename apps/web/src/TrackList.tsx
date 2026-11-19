import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  api,
  trackDownloadUrl,
  type Comment,
  type Tag,
  type Track,
  type User,
} from "./api";
import { formatDuration, shortTitle } from "./format";
import { TRACK_MIME } from "./mime";
import { usePeaks } from "./peaks";
import { PeaksCanvas } from "./PeaksCanvas";
import { playedFraction, usePlayback, usePlaybackFrame } from "./playback";
import { RowVisibility } from "./rowVisibility";
import {
  TagFilterSelect,
  TagNamesDatalist,
  TrackTagChips,
  type TrackTagActions,
} from "./Tags";
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
  type SearchScope,
  type SortKey,
  usePersistedWidth,
} from "./uiPersist";

const AUTOSAVE_MS = 500;

export type TrackListFilters = {
  filter: FilterId;
  /** Shared tag id. */
  tagFilter: string | null;
  hideReleased: boolean;
  showOthers: boolean;
  sort: PoolSort;
  tags: Tag[];
  /** Tracks per tag id (all tracks, unfiltered). */
  tagCounts: ReadonlyMap<string, number>;
  search: string;
  searchScope: SearchScope;
  /** Global "edit tags" toggle: removal × on row chips. */
  tagEditing: boolean;
  visibleCount: number;
  visibleTotalSec: number;
  onFilter: (id: FilterId) => void;
  onTagFilter: (tagId: string | null) => void;
  onSearch: (value: string) => void;
  onSearchScope: (scope: SearchScope) => void;
  onTagEditing: (value: boolean) => void;
  onHideReleased: (value: boolean) => void;
  onShowOthers: (value: boolean) => void;
  onToggleSort: (key: SortKey) => void;
};

/** Checked tracks across all filters (hidden ones included). */
export type CheckedSummary = {
  count: number;
  totalSec: number;
  /** Checked tracks the current filters hide. */
  hiddenCount: number;
  /** Checked tracks that are already released. */
  releasedCount: number;
  onClear: () => void;
  /** Create an arrangement from the checked tracks; rejects on failure. */
  onCreateArrangement: (name: string) => Promise<void>;
};

/** Per-row checkbox state for the track list. */
export type TrackChecks = {
  checkedIds: ReadonlySet<string>;
  onToggle: (trackId: string) => void;
  onSetMany: (trackIds: string[], checked: boolean) => void;
};

function CheckedBar({ checked }: { checked: CheckedSummary }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  if (checked.count === 0) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await checked.onCreateArrangement(trimmed);
      setName("");
      setNaming(false);
    } catch {
      // Parent reports the error; keep the form open to retry.
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="checked-bar">
      <span
        className="checked-meta"
        title={
          checked.hiddenCount > 0
            ? `${checked.hiddenCount} checked track(s) are hidden by the current filters but still count`
            : undefined
        }
      >
        ☑ {checked.count} checked · {formatDuration(Math.floor(checked.totalSec))}
        {checked.hiddenCount > 0 && (
          <span className="checked-hidden"> · {checked.hiddenCount} hidden</span>
        )}
        {checked.releasedCount > 0 && (
          <span
            className="checked-released"
            title="Some checked tracks are already released"
          >
            {" "}
            · ⚠ {checked.releasedCount} released
          </span>
        )}
      </span>
      {naming ? (
        <form className="checked-create" onSubmit={onSubmit}>
          <input
            autoFocus
            value={name}
            disabled={busy}
            maxLength={200}
            placeholder="arrangement name"
            aria-label="New arrangement name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <button type="submit" className="filterButton" disabled={busy}>
            {busy ? "creating…" : "create"}
          </button>
          <button
            type="button"
            className="filterButton"
            disabled={busy}
            onClick={() => setNaming(false)}
          >
            ×
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="filterButton"
          title="Create an arrangement from the checked tracks, in list order"
          onClick={() => setNaming(true)}
        >
          new arrangement
        </button>
      )}
      <button
        type="button"
        className="filterButton"
        title="Uncheck all tracks"
        onClick={checked.onClear}
      >
        uncheck
      </button>
    </span>
  );
}

export function FilterBar({
  filters,
  checked,
  mode,
  showOthersToggle,
}: {
  filters: TrackListFilters;
  checked: CheckedSummary;
  mode: AppMode;
  showOthersToggle: boolean;
}) {
  const {
    filter,
    tagFilter,
    hideReleased,
    showOthers,
    tags,
    tagCounts,
    search,
    searchScope,
    tagEditing,
    visibleCount,
    visibleTotalSec,
    onFilter,
    onTagFilter,
    onSearch,
    onSearchScope,
    onTagEditing,
    onHideReleased,
    onShowOthers,
  } = filters;
  const tagName = tagFilter
    ? (tags.find((t) => t.id === tagFilter)?.name ?? null)
    : null;

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
      <TagFilterSelect
        tags={tags}
        counts={tagCounts}
        value={tagFilter}
        onChange={onTagFilter}
      />
      {mode === "pool" && (
        <button
          type="button"
          className={tagEditing ? "filterButton tagEditOn" : "filterButton"}
          aria-pressed={tagEditing}
          title={
            tagEditing
              ? "Tag removal is on: × on each tag removes it from that track for everyone — click to turn off"
              : "Turn on to remove tags from tracks (shows × on each tag)"
          }
          onClick={() => onTagEditing(!tagEditing)}
        >
          {tagEditing ? "edit tags: on" : "edit tags"}
        </button>
      )}
      <span className="search-box">
        <input
          type="search"
          className={search ? "search-input search-active" : "search-input"}
          value={search}
          placeholder="search titles, tags, comments…"
          aria-label="Search tracks"
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onSearch("");
          }}
        />
        <button
          type="button"
          className="filterButton search-scope"
          title={
            searchScope === "mine"
              ? "Search looks at your comments only — click to include everyone's"
              : "Search looks at everyone's comments — click for yours only"
          }
          onClick={() =>
            onSearchScope(searchScope === "mine" ? "all" : "mine")
          }
        >
          {searchScope === "mine" ? "my comments" : "all comments"}
        </button>
      </span>
      <span className="filter-meta">
        ({tagName ?? filter}) [{visibleCount} tracks ·{" "}
        {formatDuration(Math.floor(visibleTotalSec))}]
      </span>
      {tagName && (
        <button
          type="button"
          className="tagButton"
          onClick={() => onTagFilter(null)}
        >
          clear {tagName}
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
      <CheckedBar checked={checked} />
    </div>
  );
}

/** Header checkbox: checks/unchecks every visible, present track. */
function CheckAllBox({
  tracks,
  checks,
}: {
  tracks: Track[];
  checks: TrackChecks;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const ids = tracks.filter((t) => t.present).map((t) => t.id);
  const n = ids.filter((id) => checks.checkedIds.has(id)).length;
  const all = ids.length > 0 && n === ids.length;
  const some = n > 0 && !all;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className="track-check"
      checked={all}
      disabled={ids.length === 0}
      title={all ? "Uncheck all shown tracks" : "Check all shown tracks"}
      aria-label={all ? "Uncheck all shown tracks" : "Check all shown tracks"}
      onChange={() => checks.onSetMany(ids, !all)}
    />
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

const ROW_WAVE_COLOR = "rgba(230, 226, 216, 0.32)";
const ROW_WAVE_PLAYING_COLOR = "rgba(140, 193, 82, 0.75)";

/**
 * Compact waveform for a library row. Peaks load only once the row comes on
 * screen (shared observer), and stay cached (peaks.ts).
 */
function RowWaveform({
  track,
  playing,
  visibility,
}: {
  track: Track;
  playing: boolean;
  visibility: RowVisibility;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const rec = usePeaks(track.id, seen);

  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    return visibility.observe(el, () => setSeen(true));
  }, [seen, visibility]);

  return (
    <div ref={ref} className="row-wave">
      {rec ? (
        <PeaksCanvas
          rec={rec}
          color={playing ? ROW_WAVE_PLAYING_COLOR : ROW_WAVE_COLOR}
          className="row-wave-canvas"
        />
      ) : (
        <div className="wave-flat" aria-hidden />
      )}
      {playing && (
        <RowPlayhead
          duration={track.durationSeconds ?? rec?.durationSec ?? null}
        />
      )}
    </div>
  );
}

/**
 * Playhead on the playing row; only this component follows the time, and it
 * draws via a ref. Clicking seeks (this row is what is playing, so seeking
 * never changes the track).
 */
function RowPlayhead({ duration }: { duration: number | null }) {
  const playback = usePlayback();
  const headRef = useRef<HTMLDivElement>(null);
  const total = playback.duration ?? duration;

  usePlaybackFrame((sec) => {
    if (headRef.current) {
      headRef.current.style.transform = `translateX(${playedFraction(sec, total) * 100}%)`;
    }
  });

  return (
    <div
      className="row-wave-seek"
      title="Seek"
      onClick={(e) => {
        if (!total) return;
        const box = e.currentTarget.getBoundingClientRect();
        playback.seek(((e.clientX - box.left) / box.width) * total);
      }}
    >
      <div ref={headRef} className="wave-playhead row-wave-playhead" />
    </div>
  );
}

function TrackRow({
  track,
  user,
  mode,
  playing,
  focused,
  selected,
  checked,
  focusComment,
  showOthers,
  showComments,
  visibility,
  tagFilter,
  tagsById,
  tagActions,
  tagEditing,
  draggable,
  onTogglePlay,
  onToggleChecked,
  onCommentFocused,
  onFocusRow,
  onHover,
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
  /** Pool mode: the row being edited / inspected (independent of playing). */
  focused: boolean;
  selected: boolean;
  checked: boolean;
  /** Scroll to and focus the comment field, then call onCommentFocused. */
  focusComment: boolean;
  showOthers: boolean;
  showComments: boolean;
  visibility: RowVisibility;
  tagFilter: string | null;
  tagsById: ReadonlyMap<string, Tag>;
  tagActions: TrackTagActions;
  tagEditing: boolean;
  draggable: boolean;
  onTogglePlay: () => void;
  onToggleChecked: () => void;
  onCommentFocused: () => void;
  /** Pointer down or keyboard focus anywhere in the row (pool mode). */
  onFocusRow: () => void;
  onHover: (hovered: boolean) => void;
  onTagClick: (tagId: string) => void;
  onCommentsChange: (comments: Comment[]) => void;
  onReleasedOnChange: (releasedOn: string | null) => void;
  onAddToArrangement?: (trackId: string) => void;
  onError: (message: string | null) => void;
}) {
  const pool = mode === "pool";
  const mine = track.comments.find((c) => c.userId === user.id);
  const others = track.comments.filter((c) => c.userId !== user.id);
  const [draft, setDraft] = useState(mine?.body ?? "");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const draftRef = useRef(draft);
  const savedBodyRef = useRef(mine?.body ?? "");
  const seqRef = useRef(0);
  const commentInputRef = useRef<HTMLInputElement>(null);

  const commentFocused = useEffectEvent(onCommentFocused);
  useEffect(() => {
    if (!focusComment) return;
    const input = commentInputRef.current;
    if (input) {
      input.scrollIntoView({ block: "nearest" });
      input.focus();
    }
    commentFocused();
  }, [focusComment]);

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

  return (
    <div
      className={[
        "track1",
        mode === "arrange" ? "track1-compact" : "",
        playing ? "track-playing" : "",
        focused ? "track-focused" : "",
        selected ? "track-selected" : "",
        checked && track.present ? "track-checked" : "",
        !track.present ? "track-missing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-track-id={track.id}
      // Pool rows can hold keyboard focus themselves (j/k, enter, esc).
      tabIndex={pool ? -1 : undefined}
      // Capture phase: controls in the row stop propagation of their own
      // events, but clicking any of them still focuses the row. Focusing
      // never changes what is playing.
      onPointerDownCapture={pool ? onFocusRow : undefined}
      onFocusCapture={pool ? onFocusRow : undefined}
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
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
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
        <input
          type="checkbox"
          className="track-check"
          checked={checked && track.present}
          disabled={!track.present}
          title={checked ? "Uncheck" : "Check"}
          aria-label={`${checked ? "Uncheck" : "Check"} ${track.filename}`}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleChecked}
        />
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
        {showComments && (
          <RowWaveform
            track={track}
            playing={playing}
            visibility={visibility}
          />
        )}
      </div>
      {showComments && (
        <div className="trackBox2">
          <div className="input_box1">
            <input
              ref={commentInputRef}
              value={draft}
              placeholder="comment… #keywords"
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
      {track.present ? (
        <a
          className="track-dl"
          href={trackDownloadUrl(track.id)}
          download={track.filename}
          // Dragging from here drags the row (into an arrangement), not the link.
          draggable={false}
          title={`Download ${track.filename}`}
          aria-label={`Download ${track.filename}`}
          onClick={(e) => e.stopPropagation()}
        >
          ↓
        </a>
      ) : (
        <span
          className="track-dl track-dl-off"
          title="File missing from the library"
          aria-hidden="true"
        >
          ↓
        </span>
      )}
      <div
        className="release-wrap"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ReleaseLabel
          track={track}
          onChange={onReleasedOnChange}
          onError={onError}
        />
      </div>
      <TrackTagChips
        track={track}
        tagsById={tagsById}
        myCommentBody={mine?.body ?? ""}
        editable={showComments}
        removable={showComments && tagEditing}
        tagFilter={tagFilter}
        actions={tagActions}
        onTagClick={onTagClick}
        onError={onError}
      />
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
  focusedId,
  onFocusRow,
  commentRequestId,
  onCommentRequestDone,
  selectedId,
  checks,
  showOthers,
  tagFilter,
  tags,
  tagsById,
  tagActions,
  tagEditing,
  sort,
  canDragToArrange,
  loading,
  onTogglePlay,
  onHover,
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
  /** Focused row (pool mode only; null in arrange mode). */
  focusedId: string | null;
  onFocusRow: (trackId: string) => void;
  /** Row whose comment field should take focus (dock "comment", `c`). */
  commentRequestId: string | null;
  onCommentRequestDone: () => void;
  /** Track of the clip selected in the arrangement (highlighted), if any. */
  selectedId: string | null;
  checks: TrackChecks;
  showOthers: boolean;
  tagFilter: string | null;
  tags: Tag[];
  tagsById: ReadonlyMap<string, Tag>;
  tagActions: TrackTagActions;
  tagEditing: boolean;
  sort: PoolSort;
  canDragToArrange: boolean;
  loading: boolean;
  onTogglePlay: (track: Track) => void;
  /** Pointer entered this row, or left it (null). */
  onHover: (trackId: string | null) => void;
  onTagClick: (tagId: string) => void;
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

  // Rows load their waveform peaks only when near the screen.
  const [visibility] = useState(() => new RowVisibility());
  const listRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      visibility.attach(el.closest(".studio-left"));
      return () => visibility.detach();
    },
    [visibility],
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
    <div ref={listRef} className="trackList" style={colStyle}>
      <TagNamesDatalist tags={tags} />
      <div className="col-header">
        <div className="trackBox1">
          <CheckAllBox tracks={tracks} checks={checks} />
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
          {showComments && <span className="row-wave-spacer" aria-hidden />}
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
          focused={focusedId === track.id}
          selected={selectedId === track.id}
          checked={checks.checkedIds.has(track.id)}
          focusComment={commentRequestId === track.id}
          onCommentFocused={onCommentRequestDone}
          onFocusRow={() => onFocusRow(track.id)}
          showOthers={showOthers}
          showComments={showComments}
          visibility={visibility}
          tagFilter={tagFilter}
          tagsById={tagsById}
          tagActions={tagActions}
          tagEditing={tagEditing}
          draggable={canDragToArrange && track.present}
          onTogglePlay={() => {
            if (track.present) onTogglePlay(track);
          }}
          onToggleChecked={() => {
            if (track.present) checks.onToggle(track.id);
          }}
          onHover={(on) => onHover(on ? track.id : null)}
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
