import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  api,
  trackStreamUrl,
  unifiedTags,
  type Comment,
  type Track,
  type User,
} from "./api";
import { ArrangeShell } from "./ArrangeView";

const SHOW_OTHERS_KEY = "iff-show-other-comments";
const TITLE_W_KEY = "iff-title-width";
const COMMENT_W_KEY = "iff-comment-width";
const AUTOSAVE_MS = 500;

const TITLE_W_DEFAULT = 210;
const TITLE_W_MIN = 80;
const TITLE_W_MAX = 480;
const COMMENT_W_DEFAULT = 300;
const COMMENT_W_MIN = 120;
const COMMENT_W_MAX = 900;

type FilterId = "all" | "commented";

function readStoredWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  } catch {
    return fallback;
  }
}

function usePersistedWidth(
  key: string,
  initial: number,
  min: number,
  max: number,
) {
  const [width, setWidth] = useState(() =>
    readStoredWidth(key, initial, min, max),
  );
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // ignore
    }
  }, [key, width]);

  function onResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      setWidth(
        Math.min(
          max,
          Math.max(min, Math.round(startW + (ev.clientX - startX))),
        ),
      );
    };
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  function reset() {
    setWidth(initial);
  }

  return { width, onResizePointerDown, reset };
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const mm = String(m);
  const padded = mm.length < 2 ? `\u00a0${mm}` : mm;
  return `${padded}:${String(s).padStart(2, "0")}`;
}

function shortTitle(filename: string): string {
  return filename.replace(/\.aif\.mp3$/i, "").replace(/\.mp3$/i, "");
}

function readShowOthers(): boolean {
  try {
    return localStorage.getItem(SHOW_OTHERS_KEY) === "1";
  } catch {
    return false;
  }
}

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
    <PoolView
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

function PoolView({
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
  const [filter, setFilter] = useState<FilterId>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(readShowOthers);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mode, setMode] = useState<"pool" | "arrange">("pool");
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

  function setShowOthersPersist(value: boolean) {
    setShowOthers(value);
    try {
      localStorage.setItem(SHOW_OTHERS_KEY, value ? "1" : "0");
    } catch {
      // ignore
    }
  }

  function patchTrackComments(trackId: string, next: Comment[]) {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, comments: next } : t)),
    );
  }

  const visible = tracks.filter((t) => {
    if (filter === "commented" && t.comments.length === 0) return false;
    if (tagFilter) {
      const tags = unifiedTags(t.comments.map((c) => c.body));
      if (!tags.includes(tagFilter)) return false;
    }
    return true;
  });

  return (
    <div className="app">
      {error && mode === "arrange" && (
        <p className="error arr-error">{error}</p>
      )}
      {mode === "arrange" ? (
        <ArrangeShell
          tracks={tracks}
          onBack={() => setMode("pool")}
          onError={onError}
        />
      ) : (
        <>
          <div className="audiodiv">
            {playing ? (
              <audio
                key={playing.id}
                controls
                autoPlay
                preload="metadata"
                src={trackStreamUrl(playing.id)}
              />
            ) : (
              <div className="audio-placeholder" />
            )}
          </div>

          <div className="toolbar">
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
                    setFilter(id);
                    setTagFilter(null);
                  }}
                >
                  {label}
                </button>
              ))}
              <span className="filter-meta">
                ({tagFilter ? `#${tagFilter}` : filter}) [{visible.length}{" "}
                tracks]
              </span>
              {tagFilter && (
                <button
                  type="button"
                  className="tagButton"
                  onClick={() => setTagFilter(null)}
                >
                  clear tag
                </button>
              )}
              <button
                type="button"
                className={
                  showOthers ? "filterButton filterSelected" : "filterButton"
                }
                onClick={() => setShowOthersPersist(!showOthers)}
                title="Show other users' comments under each row"
              >
                {showOthers ? "others on" : "others off"}
              </button>
              <button
                type="button"
                className="filterButton"
                onClick={() => setMode("arrange")}
              >
                arrange
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

          <div className="content">
            {accountOpen && (
              <ChangePasswordPanel
                onError={onError}
                onClose={() => setAccountOpen(false)}
              />
            )}

            {error && <p className="error">{error}</p>}

            {loading ? (
              <p className="status-line">Loading tracks…</p>
            ) : tracks.length === 0 ? (
              <p className="status-line">
                No tracks. Sync the library folder into the database.
              </p>
            ) : (
              <div className="trackList" style={colStyle}>
                <div className="col-header">
                  <div className="trackBox1">
                    <div className="trackDur" aria-hidden="true" />
                    <div className="trackTitle col-label">title</div>
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
                </div>
                {visible.map((track) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    user={user}
                    playing={playing?.id === track.id}
                    showOthers={showOthers}
                    tagFilter={tagFilter}
                    onPlay={() => {
                      if (track.present) setPlaying(track);
                    }}
                    onTagClick={setTagFilter}
                    onCommentsChange={(next) =>
                      patchTrackComments(track.id, next)
                    }
                    onError={onError}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TrackRow({
  track,
  user,
  playing,
  showOthers,
  tagFilter,
  onPlay,
  onTagClick,
  onCommentsChange,
  onError,
}: {
  track: Track;
  user: User;
  playing: boolean;
  showOthers: boolean;
  tagFilter: string | null;
  onPlay: () => void;
  onTagClick: (tag: string) => void;
  onCommentsChange: (comments: Comment[]) => void;
  onError: (message: string | null) => void;
}) {
  const mine = track.comments.find((c) => c.userId === user.id);
  const others = track.comments.filter((c) => c.userId !== user.id);
  const [draft, setDraft] = useState(mine?.body ?? "");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const draftRef = useRef(draft);
  const savedBodyRef = useRef(mine?.body ?? "");
  const seqRef = useRef(0);

  // Keep draft in sync when server comments change externally (e.g. after reload)
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

  const persist = useEffectEvent(async (body: string) => {
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
  });

  useEffect(() => {
    draftRef.current = draft;
    if (draft.trim() === savedBodyRef.current.trim()) {
      setSaveState("idle");
      return;
    }
    const t = window.setTimeout(() => {
      void persist(draft);
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [draft, persist]);

  const tags = unifiedTags(track.comments.map((c) => c.body));

  return (
    <div
      className={[
        "track1",
        playing ? "track-playing" : "",
        !track.present ? "track-missing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="trackBox1">
        <div className="trackDur">{formatDuration(track.durationSeconds)}</div>
        <button
          type="button"
          className="trackTitle"
          disabled={!track.present}
          title={track.filename}
          onClick={onPlay}
        >
          {shortTitle(track.filename)}
          {!track.present && " (missing)"}
        </button>
      </div>
      <div className="trackBox2">
        <div className="input_box1">
          <input
            value={draft}
            placeholder="comment… use #tags"
            aria-label={`Comment for ${track.filename}`}
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
      {tags.length > 0 && (
        <div className="tag-row">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={
                tagFilter === tag ? "tagButton tagButtonSelected" : "tagButton"
              }
              onClick={() => onTagClick(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {showOthers && others.length > 0 && (
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

function ChangePasswordPanel({
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
