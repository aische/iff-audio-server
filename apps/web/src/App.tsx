import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  unifiedTags,
  type Comment,
  type Track,
  type User,
} from "./api";
import { ArrangeShell, type ArrangeAddApi } from "./ArrangeView";
import Transport from "./Transport";
import {
  ChangePasswordPanel,
  FilterBar,
  TrackList,
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
  const [filter, setFilter] = useState<FilterId>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(readShowOthers);
  const [hideReleased, setHideReleased] = useState(readHideReleased);
  const [sort, setSort] = useState(readSort);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mode, setMode] = useState<AppMode>(readMode);
  const [arrangeApi, setArrangeApi] = useState<ArrangeAddApi | null>(null);
  const [stopToken, setStopToken] = useState(0);

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
    if (next === "pool") {
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

  function playTrack(track: Track) {
    setStopToken((n) => n + 1);
    setPlaying(track);
    setSelectedId(track.id);
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
  const visibleTotalSec = visible.reduce(
    (sum, t) => sum + (t.durationSeconds ?? 0),
    0,
  );

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
              showOthers={showOthers}
              tagFilter={tagFilter}
              sort={sort}
              canDragToArrange={
                mode === "arrange" && !!arrangeApi?.isOwner
              }
              loading={loading}
              onPlay={playTrack}
              onSelect={(t) => setSelectedId(t.id)}
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
          <>
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
            <div className="studio-right">
              <ArrangeShell
                user={user}
                tracks={tracks}
                onError={onError}
                onAddApiChange={setArrangeApi}
                onArrangementPlayingChange={onArrangementPlayingChange}
                stopToken={stopToken}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
