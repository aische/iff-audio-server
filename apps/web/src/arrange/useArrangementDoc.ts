import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api, type Arrangement, type ArrangementClip } from "../api";

const AUTOSAVE_MS = 600;

export type SaveState = "idle" | "saving" | "saved" | "error";

function arrangementSnapshot(name: string, clips: ArrangementClip[]) {
  return JSON.stringify({ name, clips });
}

/**
 * One arrangement as an editable document: loads it, holds the local draft
 * (name + clips), and autosaves the owner's edits after a short debounce.
 * A save still pending when the editor closes is flushed on unmount.
 */
export function useArrangementDoc(
  arrangementId: string,
  userId: string,
  onError: (message: string | null) => void,
) {
  const [arrangement, setArrangement] = useState<Arrangement | null>(null);
  const [clips, setClips] = useState<ArrangementClip[]>([]);
  const [name, setName] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const savedSnapshotRef = useRef("");
  const saveSeqRef = useRef(0);
  const isOwner = arrangement?.userId === userId;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const row = await api.getArrangement(arrangementId);
        if (cancelled) return;
        savedSnapshotRef.current = arrangementSnapshot(row.name, row.clips);
        saveSeqRef.current += 1;
        setArrangement(row);
        setClips(row.clips);
        setName(row.name);
        setSaveState("idle");
        onError(null);
      } catch (err) {
        if (!cancelled) {
          onError(
            err instanceof Error ? err.message : "Failed to load arrangement",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [arrangementId, onError]);

  const persist = useEffectEvent(
    async (nextName: string, nextClips: ArrangementClip[]) => {
      if (!arrangement || !isOwner) return;
      const snap = arrangementSnapshot(nextName, nextClips);
      if (snap === savedSnapshotRef.current) {
        setSaveState("idle");
        return;
      }
      const seq = ++saveSeqRef.current;
      setSaveState("saving");
      try {
        let savedName = "";
        let savedClips: ArrangementClip[] = [];
        try {
          const saved = JSON.parse(savedSnapshotRef.current) as {
            name: string;
            clips: ArrangementClip[];
          };
          savedName = saved.name;
          savedClips = saved.clips;
        } catch {
          /* first save after a bad/empty snapshot */
        }
        const patch: { name?: string; clips?: ArrangementClip[] } = {};
        if (nextName !== savedName) patch.name = nextName;
        if (JSON.stringify(nextClips) !== JSON.stringify(savedClips)) {
          patch.clips = nextClips;
        }
        if (patch.name === undefined && patch.clips === undefined) {
          savedSnapshotRef.current = snap;
          setSaveState("idle");
          return;
        }
        const updated = await api.updateArrangement(arrangementId, patch);
        if (seq !== saveSeqRef.current) return;
        // Keep local draft as source of truth so server normalization
        // (gain clamp, etc.) does not immediately re-dirty the editor.
        const committedName = updated.name;
        savedSnapshotRef.current = arrangementSnapshot(committedName, nextClips);
        if (committedName !== nextName) setName(committedName);
        setArrangement((prev) =>
          prev
            ? {
                ...prev,
                name: committedName,
                clips: nextClips,
                updatedAt: updated.updatedAt,
              }
            : prev,
        );
        setSaveState("saved");
        onError(null);
      } catch (err) {
        if (seq !== saveSeqRef.current) return;
        setSaveState("error");
        onError(
          err instanceof Error ? err.message : "Failed to save arrangement",
        );
      }
    },
  );

  useEffect(() => {
    if (!isOwner) return;
    if (arrangementSnapshot(name, clips) === savedSnapshotRef.current) {
      return;
    }
    const t = window.setTimeout(() => {
      void persist(name, clips);
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [clips, name, isOwner]);

  // Closing the editor (back to list, opening another arrangement, logout)
  // cancels the debounce above; save whatever it was still holding.
  const flushPendingSave = useEffectEvent(() => {
    if (!isOwner) return;
    if (arrangementSnapshot(name, clips) === savedSnapshotRef.current) return;
    void persist(name, clips);
  });
  useEffect(() => {
    return () => flushPendingSave();
  }, []);

  return { arrangement, isOwner, name, setName, clips, setClips, saveState };
}
