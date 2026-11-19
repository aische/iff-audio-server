import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  SESSION_EXPIRED_MESSAGE,
  api,
  setSessionLostHandler,
  type Comment,
  type Track,
  type User,
} from "./api";
import { ArrangeShell, type ArrangeAddApi } from "./ArrangeView";
import { newClipForTrack } from "./clips";
import { KeyMap } from "./KeyMap";
import { usePlayback } from "./playback";
import { PlaybackProvider } from "./PlaybackProvider";
import { SessionResume } from "./SessionResume";
import { TrackInspector } from "./TrackInspector";
import { useChangeFeed } from "./useChangeFeed";
import { useLibrary } from "./useLibrary";
import { useLibraryShortcuts } from "./useLibraryShortcuts";
import { TagManager } from "./Tags";
import Transport from "./Transport";
import {
  ChangePasswordPanel,
  FilterBar,
  TrackList,
  type CheckedSummary,
  type RowRequest,
  type TrackChecks,
} from "./TrackList";
import {
  SPLIT_W_DEFAULT,
  SPLIT_W_KEY,
  SPLIT_W_MAX,
  SPLIT_W_MIN,
  filterTracks,
  persistHideReleased,
  persistLastPlayed,
  persistMode,
  persistSearchScope,
  persistShowInspector,
  persistShowOthers,
  persistSort,
  readHideReleased,
  readLastPlayed,
  readMode,
  readSearchScope,
  readShowInspector,
  readShowOthers,
  readSort,
  sortTracks,
  trackHiddenBy,
  usePersistedWidth,
  type AppMode,
  type FilterId,
  type PoolSort,
  type SearchScope,
  type SortKey,
  type TrackQuery,
} from "./uiPersist";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.me();
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Only while logged in: a 401 from the boot-time `me()` check just means
  // "not signed in yet", not an expired session.
  useEffect(() => {
    if (!user) return;
    setSessionLostHandler(() => {
      setUser(null);
      setError(SESSION_EXPIRED_MESSAGE);
    });
    return () => setSessionLostHandler(null);
  }, [user]);

  if (booting) {
    return (
      <div className="app">
        <p className="status-line">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app login-shell">
        <h1>iff audio</h1>
        {error && <p className="error">{error}</p>}
        <LoginForm
          onSuccess={(u) => {
            setError(null);
            setUser(u);
          }}
          onError={setError}
        />
      </div>
    );
  }

  return (
    <PlaybackProvider>
      <StudioShell
        user={user}
        onLogout={() => {
          setUser(null);
          setError(null);
        }}
        error={error}
        onError={setError}
      />
    </PlaybackProvider>
  );
}

/** Grace period before the info card hides after the pointer leaves a track. */
const HOVER_CLEAR_DELAY_MS = 150;

function LoginForm({
  onSuccess,
  onError,
}: {
  onSuccess: (user: User) => void;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError("");
    try {
      onSuccess(await api.login(email, password));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={onSubmit}>
      <label>
        Email
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function StudioShell({
  user,
  onLogout,
  error,
  onError,
}: {
  user: User;
  onLogout: () => void;
  error: string | null;
  onError: (message: string | null) => void;
}) {
  // Library playback only. Independent of search/filter/focus: query may
  // hide this track from the list without stopping playback (see better-ux.md).
  const playback = usePlayback();
  // Track of the clip selected in the open arrangement; the library
  // highlights it in arrange mode.
  const [arrangeSelectedTrackId, setArrangeSelectedTrackId] = useState<
    string | null
  >(null);
  // Hovered track (library row or arrangement clip); drives the info card,
  // which is hidden while nothing is hovered.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoverClearTimer = useRef<number | undefined>(undefined);
  const [filter, setFilter] = useState<FilterId>("all");
  // Rows commented on while "no comment from me" is on: they stay listed
  // until the filter is chosen again (see TrackQuery.keepIds).
  const [keptIds, setKeptIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchScope, setSearchScope] = useState(readSearchScope);
  // Not persisted: tag removal starts off on every load.
  const [tagEditing, setTagEditing] = useState(false);
  const [showOthers, setShowOthers] = useState(readShowOthers);
  const [hideReleased, setHideReleased] = useState(readHideReleased);
  const [sort, setSort] = useState(readSort);
  const [showInspector, setShowInspector] = useState(readShowInspector);
  const [accountOpen, setAccountOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  // Key map panel (pool mode; the library keys only work there).
  const [keysOpen, setKeysOpen] = useState(false);
  const [mode, setMode] = useState<AppMode>(readMode);
  // Mounted on first visit, then kept (hidden in pool mode) so the open
  // arrangement and its pending edits survive mode switches.
  const [arrangeMounted, setArrangeMounted] = useState(
    () => mode === "arrange",
  );
  const [arrangeApi, setArrangeApi] = useState<ArrangeAddApi | null>(null);
  const [stopToken, setStopToken] = useState(0);
  // Scratch subset: in memory only, independent of filters.
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [openArrangement, setOpenArrangement] = useState<{
    id: string;
    seq: number;
  } | null>(null);
  // Pool mode: the track being edited / inspected. Separate from playing and
  // from hover; never follows play (see better-ux.md, "parallel work").
  // Kept while the query hides its row; in memory only. Session resume:
  // starts on the last played track (focused, not played).
  const [focusedId, setFocusedId] = useState(readLastPlayed);
  // Last library track played in this browser; the idle dock offers it.
  const [lastPlayedId, setLastPlayedId] = useState(readLastPlayed);
  // One-shot row action (open its comment field / scroll to it); the row
  // clears it when done. Always paired with focus.
  const [rowRequest, setRowRequest] = useState<RowRequest | null>(null);

  const rev = useChangeFeed();
  const {
    tracks,
    tags,
    loading,
    patchTrack,
    patchTrackComments,
    tagActions,
    tagManagerActions,
  } = useLibrary(rev, onError, (fromId, toId) =>
    setTagFilter((cur) => (cur === fromId ? toId : cur)),
  );

  const splitCol = usePersistedWidth(
    SPLIT_W_KEY,
    SPLIT_W_DEFAULT,
    SPLIT_W_MIN,
    SPLIT_W_MAX,
  );

  // Clearing is delayed so the card doesn't flicker while the pointer
  // crosses gaps between rows; entering another row cancels it.
  const hoverTrack = useCallback((id: string | null) => {
    window.clearTimeout(hoverClearTimer.current);
    if (id) setHoveredId(id);
    else {
      hoverClearTimer.current = window.setTimeout(
        () => setHoveredId(null),
        HOVER_CLEAR_DELAY_MS,
      );
    }
  }, []);
  useEffect(() => () => window.clearTimeout(hoverClearTimer.current), []);

  function setModePersist(next: AppMode) {
    setMode(next);
    persistMode(next);
    if (next === "arrange") {
      setArrangeMounted(true);
    } else {
      setStopToken((n) => n + 1);
    }
  }

  function setShowOthersPersist(value: boolean) {
    setShowOthers(value);
    persistShowOthers(value);
  }

  function setSearchScopePersist(value: SearchScope) {
    setSearchScope(value);
    persistSearchScope(value);
  }

  function setHideReleasedPersist(value: boolean) {
    setHideReleased(value);
    persistHideReleased(value);
  }

  function setShowInspectorPersist(value: boolean) {
    setShowInspector(value);
    persistShowInspector(value);
  }

  function toggleSort(key: SortKey) {
    const next: PoolSort =
      sort.key === key
        ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" };
    setSort(next);
    persistSort(next);
  }

  function selectFilter(next: FilterId) {
    setFilter(next);
    setKeptIds(new Set());
  }

  function onCommentsChange(trackId: string, next: Comment[]) {
    if (filter === "uncommented") {
      setKeptIds((prev) => new Set(prev).add(trackId));
    }
    patchTrackComments(trackId, next);
  }

  /** Load and play a library track (stops the arrangement). */
  function playTrack(track: Track) {
    setStopToken((n) => n + 1);
    playback.play(track);
    setLastPlayedId(track.id);
    persistLastPlayed(track.id);
  }

  /** Play a track in the transport, or unload it if it is the current one. */
  function togglePlayTrack(track: Track) {
    if (playback.track?.id === track.id) {
      playback.stop();
      return;
    }
    playTrack(track);
  }

  function onArrangementPlayingChange(playingArr: boolean) {
    if (playingArr) playback.stop();
  }

  const tagsById = new Map(tags.map((t) => [t.id, t]));
  const tagCounts = new Map<string, number>();
  for (const t of tracks) {
    for (const l of t.tags) {
      tagCounts.set(l.tagId, (tagCounts.get(l.tagId) ?? 0) + 1);
    }
  }
  // A deleted or merged tag no longer filters anything.
  const activeTagFilter =
    tagFilter && tagsById.has(tagFilter) ? tagFilter : null;

  const query: TrackQuery = {
    hideReleased,
    filter,
    tagFilter: activeTagFilter,
    search,
    searchScope,
    userId: user.id,
    tagsById,
    keepIds: keptIds,
  };
  const filtered = filterTracks(tracks, query);
  const visible = sortTracks(filtered, sort);
  // Prefer live library row so transport title/duration stay fresh; keep the
  // snapshot if the file vanished from the DB mid-play.
  const loaded = playback.track;
  const playingTrack = loaded
    ? (tracks.find((t) => t.id === loaded.id) ?? loaded)
    : null;
  const playingHiddenByFilters =
    playingTrack != null && !visible.some((t) => t.id === playingTrack.id);

  /**
   * Bring a track back into the list without touching playback. Clears only
   * the parts of the query that hide it. Hide-released is turned off for
   * this session only; the saved preference is left as it is.
   */
  function revealInList(track: Track) {
    const hidden = trackHiddenBy(track, query);
    if (hidden.search) setSearch("");
    if (hidden.filter) selectFilter("all");
    if (hidden.tag) setTagFilter(null);
    if (hidden.released) setHideReleased(false);
  }

  function revealPlayingInList() {
    if (playingTrack) revealInList(playingTrack);
  }

  /** Focus a row and open its comment field (the row must be in the list). */
  function openComment(id: string) {
    setFocusedId(id);
    setRowRequest({ id, kind: "comment" });
  }

  /** Focus the playing track's comment field, revealing its row if hidden. */
  function commentOnPlaying() {
    if (!playingTrack) return;
    if (playingHiddenByFilters) revealPlayingInList();
    openComment(playingTrack.id);
  }

  /** Focus a row and scroll it into view, revealing it if hidden. */
  function showInList(track: Track) {
    revealInList(track);
    setFocusedId(track.id);
    setRowRequest({ id: track.id, kind: "show" });
  }

  // Session resume (idle dock): the last played track, and the tracks still
  // waiting for this user's comment, counted as the "no comment from me"
  // filter would list them (so the number matches the list it opens).
  const lastPlayed = lastPlayedId
    ? (tracks.find((t) => t.id === lastPlayedId && t.present) ?? null)
    : null;
  const waitingCount = filterTracks(tracks, {
    ...query,
    filter: "uncommented",
    tagFilter: null,
    search: "",
    keepIds: undefined,
  }).length;
  const waitingShown = filter === "uncommented" && !activeTagFilter && !search;

  function showWaiting() {
    selectFilter("uncommented");
    setTagFilter(null);
    setSearch("");
  }
  // Keys act on the focused row only while the query shows it.
  const focusedVisible = focusedId
    ? (visible.find((t) => t.id === focusedId) ?? null)
    : null;

  useLibraryShortcuts(mode === "pool", {
    moveFocus(delta) {
      if (visible.length === 0) return;
      const i = focusedVisible ? visible.indexOf(focusedVisible) : -1;
      const next =
        i < 0
          ? delta > 0
            ? 0
            : visible.length - 1
          : Math.min(visible.length - 1, Math.max(0, i + delta));
      const id = visible[next].id;
      setFocusedId(id);
      // The last input wins: the inspector follows the key until the
      // pointer enters another row.
      window.clearTimeout(hoverClearTimer.current);
      setHoveredId(null);
      // The row is already rendered; only its class changes.
      const el = document.querySelector<HTMLElement>(
        `.trackList .track1[data-track-id="${CSS.escape(id)}"]`,
      );
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
    },
    playFocused() {
      const t = focusedVisible;
      if (!t?.present) return;
      if (playback.track?.id === t.id) {
        // Already loaded: resume if paused; never restart or stop.
        if (!playback.isPlaying) playback.togglePause();
        return;
      }
      playTrack(t);
    },
    togglePause: playback.togglePause,
    commentFocused() {
      if (focusedVisible) openComment(focusedVisible.id);
    },
    toggleKeyMap: () => setKeysOpen((v) => !v),
    escape() {
      if (!keysOpen) return false;
      setKeysOpen(false);
      return true;
    },
  });

  // The comment field needs a row in the library (not a vanished file).
  const canCommentOnPlaying =
    mode === "pool" &&
    playingTrack != null &&
    tracks.some((t) => t.id === playingTrack.id);
  // Hover wins while the pointer is on a track; otherwise (pool mode) the
  // focused track. Never the playing track as such. Looked up in all
  // tracks: arrangement clips may be filtered out of the list.
  const inspectedId = hoveredId ?? (mode === "pool" ? focusedId : null);
  const inspected = inspectedId
    ? (tracks.find((t) => t.id === inspectedId) ?? null)
    : null;
  const visibleTotalSec = visible.reduce(
    (sum, t) => sum + (t.durationSeconds ?? 0),
    0,
  );

  // Missing files can't be played or arranged, so they never count.
  const checkedTracks = sortTracks(
    tracks.filter((t) => t.present && checkedIds.has(t.id)),
    sort,
  );
  const visibleIds = new Set(visible.map((t) => t.id));

  const checks: TrackChecks = {
    checkedIds,
    onToggle: (id) =>
      setCheckedIds((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    onSetMany: (ids, on) =>
      setCheckedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      }),
  };

  async function createArrangementFromChecked(name: string) {
    const clips = checkedTracks.flatMap((t) => newClipForTrack(t) ?? []);
    try {
      const row = await api.createArrangement(name, clips);
      onError(null);
      setOpenArrangement((prev) => ({ id: row.id, seq: (prev?.seq ?? 0) + 1 }));
      setModePersist("arrange");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create");
      throw err;
    }
  }

  const checked: CheckedSummary = {
    count: checkedTracks.length,
    totalSec: checkedTracks.reduce(
      (sum, t) => sum + (t.durationSeconds ?? 0),
      0,
    ),
    hiddenCount: checkedTracks.filter((t) => !visibleIds.has(t.id)).length,
    releasedCount: checkedTracks.filter((t) => t.releasedOn).length,
    onClear: () => setCheckedIds(new Set()),
    onCreateArrangement: createArrangementFromChecked,
  };

  const filters = {
    filter,
    tagFilter: activeTagFilter,
    hideReleased,
    showOthers,
    sort,
    tags,
    tagCounts,
    search,
    searchScope,
    tagEditing,
    tagManagerOpen: tagsOpen,
    visibleCount: visible.length,
    visibleTotalSec,
    onFilter: selectFilter,
    onTagFilter: setTagFilter,
    onSearch: setSearch,
    onSearchScope: setSearchScopePersist,
    onTagEditing: setTagEditing,
    onTagManager: () => setTagsOpen((v) => !v),
    onHideReleased: setHideReleasedPersist,
    onShowOthers: setShowOthersPersist,
    onToggleSort: toggleSort,
  };

  return (
    <div
      className={`app studio mode-${mode}${showInspector ? " inspector-on" : ""}`}
    >
      <header className="studio-chrome">
        <div className="studio-brand-row">
          <div className="studio-brand">
            <span className="studio-mark">iff</span>
            <span className="studio-title">audio</span>
          </div>
          <div className="mode-toggle" role="group" aria-label="App mode">
            <button
              type="button"
              className={
                mode === "pool"
                  ? "filterButton filterSelected"
                  : "filterButton"
              }
              aria-pressed={mode === "pool"}
              onClick={() => setModePersist("pool")}
            >
              Library
            </button>
            <button
              type="button"
              className={
                mode === "arrange"
                  ? "filterButton filterSelected"
                  : "filterButton"
              }
              aria-pressed={mode === "arrange"}
              onClick={() => setModePersist("arrange")}
            >
              Subsets
            </button>
          </div>
          <div className="toolbar-right">
            {mode === "pool" && (
              <button
                type="button"
                className={
                  keysOpen ? "filterButton filterSelected" : "filterButton"
                }
                aria-pressed={keysOpen}
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
                onClick={() => setKeysOpen((v) => !v)}
              >
                ?
              </button>
            )}
            <button
              type="button"
              className={
                showInspector ? "filterButton filterSelected" : "filterButton"
              }
              aria-pressed={showInspector}
              title="Show or hide the track info card"
              onClick={() => setShowInspectorPersist(!showInspector)}
            >
              info
            </button>
            <span className="user-email">{user.email}</span>
            <button
              type="button"
              className="filterButton"
              onClick={() => setAccountOpen((v) => !v)}
            >
              account
            </button>
            <button
              type="button"
              className="filterButton"
              onClick={async () => {
                try {
                  await api.logout();
                  onLogout();
                } catch (err) {
                  onError(
                    err instanceof Error ? err.message : "Logout failed",
                  );
                }
              }}
            >
              log out
            </button>
          </div>
        </div>

        <Transport
          track={playingTrack}
          variant={mode === "pool" ? "dock" : "compact"}
          hiddenByFilters={playingHiddenByFilters}
          onRevealInList={revealPlayingInList}
          onComment={canCommentOnPlaying ? commentOnPlaying : undefined}
          idle={
            <SessionResume
              lastPlayed={lastPlayed}
              waitingCount={waitingCount}
              waitingShown={waitingShown}
              onPlay={playTrack}
              onShow={showInList}
              onShowWaiting={showWaiting}
            />
          }
        />

        <div className="toolbar">
          <FilterBar
            filters={filters}
            checked={checked}
            mode={mode}
            showOthersToggle
          />
        </div>
      </header>

      {accountOpen && (
        <ChangePasswordPanel
          onError={onError}
          onClose={() => setAccountOpen(false)}
        />
      )}

      {keysOpen && mode === "pool" && (
        <KeyMap onClose={() => setKeysOpen(false)} />
      )}

      {tagsOpen && (
        <TagManager
          tags={tags}
          counts={tagCounts}
          actions={tagManagerActions}
          onError={onError}
          onClose={() => setTagsOpen(false)}
        />
      )}

      {error && <p className="error">{error}</p>}

      <div
        className={
          mode === "arrange" ? "studio-body studio-split" : "studio-body"
        }
      >
        <div
          className="studio-left"
          style={
            mode === "arrange"
              ? { width: splitCol.width, flex: `0 0 ${splitCol.width}px` }
              : undefined
          }
        >
          {tracks.length === 0 && !loading ? (
            <p className="status-line">
              No tracks. Sync the library folder into the database.
            </p>
          ) : (
            <TrackList
              tracks={visible}
              user={user}
              mode={mode}
              playingId={playingTrack?.id ?? null}
              focusedId={mode === "pool" ? focusedId : null}
              onFocusRow={setFocusedId}
              rowRequest={rowRequest}
              onRowRequestDone={() => setRowRequest(null)}
              selectedId={mode === "arrange" ? arrangeSelectedTrackId : null}
              checks={checks}
              showOthers={showOthers}
              tagFilter={activeTagFilter}
              tags={tags}
              tagsById={tagsById}
              tagActions={tagActions}
              tagEditing={tagEditing}
              sort={sort}
              canDragToArrange={
                mode === "arrange" && !!arrangeApi?.isOwner
              }
              loading={loading}
              onTogglePlay={togglePlayTrack}
              onHover={hoverTrack}
              onTagClick={setTagFilter}
              onToggleSort={toggleSort}
              onCommentsChange={onCommentsChange}
              onReleasedOnChange={(id, releasedOn) =>
                patchTrack(id, { releasedOn })
              }
              onAddToArrangement={
                arrangeApi?.isOwner
                  ? (id) => arrangeApi.addTrack(id)
                  : undefined
              }
              onError={onError}
            />
          )}
        </div>

        {mode === "arrange" && (
          <div
            className="split-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize library panel"
            aria-valuemin={SPLIT_W_MIN}
            aria-valuemax={SPLIT_W_MAX}
            aria-valuenow={splitCol.width}
            title="Drag to resize · double-click to reset"
            onPointerDown={splitCol.onResizePointerDown}
            onDoubleClick={splitCol.reset}
          />
        )}
        {arrangeMounted && (
          <div className="studio-right" hidden={mode !== "arrange"}>
            <ArrangeShell
              user={user}
              tracks={tracks}
              rev={rev}
              active={mode === "arrange"}
              onError={onError}
              onAddApiChange={setArrangeApi}
              onArrangementPlayingChange={onArrangementPlayingChange}
              stopToken={stopToken}
              onHoverTrack={hoverTrack}
              onSelectTrack={setArrangeSelectedTrackId}
              openRequest={openArrangement}
              onCheckTracks={(ids) => setCheckedIds(new Set(ids))}
            />
          </div>
        )}
      </div>

      {showInspector && inspected && (
        <TrackInspector
          track={inspected}
          user={user}
          tagsById={tagsById}
          onHide={() => setShowInspectorPersist(false)}
        />
      )}
    </div>
  );
}
