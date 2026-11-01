import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  unifiedTags,
  type Comment,
  type Track,
  type User,
} from "./api";
import { ArrangeShell, type ArrangeAddApi } from "./ArrangeView";
import { newClipForTrack } from "./clips";
import { TrackInspector } from "./TrackInspector";
import Transport from "./Transport";
import {
  ChangePasswordPanel,
  FilterBar,
  TrackList,
  type CheckedSummary,
  type TrackChecks,
} from "./TrackList";
import {
  SPLIT_W_DEFAULT,
  SPLIT_W_KEY,
  SPLIT_W_MAX,
  SPLIT_W_MIN,
  filterTracks,
  persistHideReleased,
  persistMode,
  persistShowOthers,
  persistSort,
  readHideReleased,
  readMode,
  readShowOthers,
  readSort,
  sortTracks,
  usePersistedWidth,
  type AppMode,
  type FilterId,
  type PoolSort,
  type SortKey,
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
    <StudioShell
      user={user}
      onLogout={() => {
        setUser(null);
        setError(null);
      }}
      error={error}
      onError={setError}
    />
  );
}

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
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<Track | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(readShowOthers);
  const [hideReleased, setHideReleased] = useState(readHideReleased);
  const [sort, setSort] = useState(readSort);
  const [accountOpen, setAccountOpen] = useState(false);
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

  const splitCol = usePersistedWidth(
    SPLIT_W_KEY,
    SPLIT_W_DEFAULT,
    SPLIT_W_MIN,
    SPLIT_W_MAX,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await api.listTracks();
        if (!cancelled) setTracks(rows);
      } catch (err) {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : "Failed to load tracks");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

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

  function setHideReleasedPersist(value: boolean) {
    setHideReleased(value);
    persistHideReleased(value);
  }

  function toggleSort(key: SortKey) {
    const next: PoolSort =
      sort.key === key
        ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" };
    setSort(next);
    persistSort(next);
  }

  function patchTrack(trackId: string, patch: Partial<Track>) {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
    );
  }

  function patchTrackComments(trackId: string, next: Comment[]) {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, comments: next } : t)),
    );
  }

  /** Play a track in the transport, or unload it if it is the current one. */
  function togglePlayTrack(track: Track) {
    setSelectedId(track.id);
    if (playing?.id === track.id) {
      setPlaying(null);
      return;
    }
    setStopToken((n) => n + 1);
    setPlaying(track);
  }

  function onArrangementPlayingChange(playingArr: boolean) {
    if (playingArr) setPlaying(null);
  }

  const allTags = unifiedTags(
    tracks.flatMap((t) => t.comments.map((c) => c.body)),
  );

  const filtered = filterTracks({
    tracks,
    hideReleased,
    filter,
    tagFilter,
  });
  const visible = sortTracks(filtered, sort);
  // Hover previews a row; otherwise the selected row stays shown.
  const inspectedId = hoveredId ?? selectedId;
  const inspected = inspectedId
    ? (visible.find((t) => t.id === inspectedId) ?? null)
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
    onClear: () => setCheckedIds(new Set()),
    onCreateArrangement: createArrangementFromChecked,
  };

  const filters = {
    filter,
    tagFilter,
    hideReleased,
    showOthers,
    sort,
    allTags,
    visibleCount: visible.length,
    visibleTotalSec,
    onFilter: setFilter,
    onTagFilter: setTagFilter,
    onHideReleased: setHideReleasedPersist,
    onShowOthers: setShowOthersPersist,
    onToggleSort: toggleSort,
  };

  return (
    <div className={`app studio mode-${mode}`}>
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
              Pool
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
              Arrange
            </button>
          </div>
          <div className="toolbar-right">
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
          track={playing}
          onEnded={() => {
            /* keep last track selected in transport */
          }}
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
              playingId={playing?.id ?? null}
              selectedId={selectedId}
              checks={checks}
              showOthers={showOthers}
              tagFilter={tagFilter}
              sort={sort}
              canDragToArrange={
                mode === "arrange" && !!arrangeApi?.isOwner
              }
              loading={loading}
              onTogglePlay={togglePlayTrack}
              onSelect={(t) => setSelectedId(t.id)}
              onHover={setHoveredId}
              onTagClick={setTagFilter}
              onToggleSort={toggleSort}
              onCommentsChange={patchTrackComments}
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
              active={mode === "arrange"}
              onError={onError}
              onAddApiChange={setArrangeApi}
              onArrangementPlayingChange={onArrangementPlayingChange}
              stopToken={stopToken}
              openRequest={openArrangement}
            />
          </div>
        )}
      </div>

      {inspected && <TrackInspector track={inspected} user={user} />}
    </div>
  );
}
