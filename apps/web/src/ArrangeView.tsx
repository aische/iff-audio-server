import { useEffect, useEffectEvent, useState, type FormEvent } from "react";
import { api, type ArrangementSummary, type Track, type User } from "./api";
import { ArrangementListSection } from "./arrange/ArrangementList";
import { ArrangeEditor, type ArrangeAddApi } from "./arrange/ArrangeEditor";

export type { ArrangeAddApi };

// ---------------------------------------------------------------------------
// ArrangeShell — arrangement list + editor, rendered as a right panel.
// ---------------------------------------------------------------------------

export function ArrangeShell({
  user,
  tracks,
  rev,
  active,
  onError,
  onAddApiChange,
  onArrangementPlayingChange,
  stopToken,
  onHoverTrack,
  onSelectTrack,
  openRequest,
  onCheckTracks,
}: {
  user: User;
  tracks: Track[];
  /** Server change revision; the list and read-only arrangements refetch on change. */
  rev: string | null;
  /** False while the panel is mounted but hidden (pool mode). */
  active: boolean;
  onError: (message: string | null) => void;
  onAddApiChange: (api: ArrangeAddApi | null) => void;
  onArrangementPlayingChange: (playing: boolean) => void;
  stopToken: number;
  /** Pointer entered a clip of this track, or left it (null); drives the info card. */
  onHoverTrack: (trackId: string | null) => void;
  /** Track of the selected clip, or null (none selected / no arrangement open). */
  onSelectTrack: (trackId: string | null) => void;
  /** Open this arrangement (e.g. one just created from checked tracks). */
  openRequest: { id: string; seq: number } | null;
  /** Replace the library's checked tracks with these track ids. */
  onCheckTracks: (trackIds: string[]) => void;
}) {
  const [list, setList] = useState<ArrangementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(
    () => openRequest?.id ?? null,
  );
  const [handledOpenSeq, setHandledOpenSeq] = useState(
    () => openRequest?.seq ?? 0,
  );
  if (openRequest && openRequest.seq !== handledOpenSeq) {
    setHandledOpenSeq(openRequest.seq);
    setActiveId(openRequest.id);
  }
  const [newName, setNewName] = useState("");
  const [copyingId, setCopyingId] = useState<string | null>(null);

  /**
   * `background`: a reload because something changed. It leaves the error
   * line alone (it may be telling the user why they were sent back here)
   * and only reports a failure while nothing has loaded yet.
   */
  function load({ background = false } = {}) {
    return api
      .listArrangements()
      .then(
        (rows) => {
          setList(rows);
          if (!background) onError(null);
        },
        (err: unknown) => {
          if (background && !loading) return;
          onError(
            err instanceof Error ? err.message : "Failed to load arrangements",
          );
        },
      )
      .finally(() => setLoading(false));
  }

  function refresh() {
    setLoading(true);
    return load();
  }

  // Load on mount and whenever the list is showing and something changed
  // (including coming back from an arrangement). No "Loading…" flash.
  const loadOnChange = useEffectEvent(() => void load({ background: true }));
  useEffect(() => {
    if (!activeId) loadOnChange();
  }, [rev, activeId]);

  // Report null API while list view is showing.
  useEffect(() => {
    if (!activeId) onAddApiChange(null);
  }, [activeId, onAddApiChange]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const row = await api.createArrangement(name);
      setNewName("");
      await refresh();
      setActiveId(row.id);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create");
    }
  }

  async function onCopy(id: string) {
    setCopyingId(id);
    try {
      const row = await api.copyArrangement(id);
      onError(null);
      setActiveId(row.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to copy");
    } finally {
      setCopyingId(null);
    }
  }

  if (activeId) {
    return (
      <ArrangeEditor
        key={activeId}
        arrangementId={activeId}
        user={user}
        tracks={tracks}
        rev={rev}
        active={active}
        onBack={() => setActiveId(null)}
        onGone={() => {
          setActiveId(null);
          onError("That arrangement was deleted by its owner.");
        }}
        onOpen={setActiveId}
        onError={onError}
        onAddApiChange={onAddApiChange}
        onCheckTracks={onCheckTracks}
        onHoverTrack={onHoverTrack}
        onSelectTrack={onSelectTrack}
        onArrangementPlayingChange={onArrangementPlayingChange}
        stopToken={stopToken}
      />
    );
  }

  const mine = list.filter((a) => a.userId === user.id);
  const others = list.filter((a) => a.userId !== user.id);

  return (
    <div className="arr-panel">
      <div className="arr-toolbar">
        <span className="arr-toolbar-title">arrangements</span>
      </div>
      <div className="arr-list-body">
        <form className="arr-create" onSubmit={onCreate}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="new arrangement name"
            required
          />
          <button type="submit" className="filterButton">
            create
          </button>
        </form>
        {loading ? (
          <p className="arr-muted">Loading…</p>
        ) : list.length === 0 ? (
          <p className="arr-muted">
            No arrangements yet. Create one, then drag tracks into the sequence.
          </p>
        ) : (
          <>
            <ArrangementListSection
              title="yours"
              items={mine}
              empty="You have no arrangements yet."
              onOpen={setActiveId}
              onDelete={async (a) => {
                if (!confirm(`Delete "${a.name}"?`)) return;
                try {
                  await api.deleteArrangement(a.id);
                  await refresh();
                } catch (err) {
                  onError(
                    err instanceof Error ? err.message : "Delete failed",
                  );
                }
              }}
            />
            <ArrangementListSection
              title="others"
              items={others}
              empty="No arrangements from other users yet."
              showOwner
              onOpen={setActiveId}
              onCopy={(a) => void onCopy(a.id)}
              copyingId={copyingId}
            />
          </>
        )}
      </div>
    </div>
  );
}
