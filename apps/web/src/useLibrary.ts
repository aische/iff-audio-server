import { useEffect, useRef, useState } from "react";
import { api, type Comment, type Tag, type Track } from "./api";
import type { TagManagerActions, TrackTagActions } from "./Tags";

/** Retry delay when a refetch was overtaken by a local edit. */
const REFETCH_RETRY_MS = 1000;

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Tracks and shared tags, loaded when the change revision first arrives and
 * reloaded whenever it changes (someone else, a library sync, or our own
 * write changed something). Local edits update state right away.
 *
 * A reload that was in flight while a local edit landed may hold data from
 * before that edit; it is dropped and retried instead of overwriting it.
 */
export function useLibrary(
  rev: string | null,
  onError: (message: string | null) => void,
  /** A tag was merged into another (renamed onto its name). */
  onTagMerged: (fromId: string, toId: string) => void,
) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedOnceRef = useRef(false);
  // Bumped on every local edit; see the hook's doc comment.
  const localEditSeqRef = useRef(0);

  useEffect(() => {
    if (rev == null) return;
    let cancelled = false;
    let retry: number | undefined;

    function load() {
      const seq = localEditSeqRef.current;
      Promise.all([api.listTracks(), api.listTags()]).then(
        ([trackRows, tagRows]) => {
          if (cancelled) return;
          if (seq !== localEditSeqRef.current) {
            retry = window.setTimeout(load, REFETCH_RETRY_MS);
            return;
          }
          setTracks(trackRows);
          setTags(tagRows);
          setLoading(false);
          loadedOnceRef.current = true;
        },
        (err: unknown) => {
          if (cancelled) return;
          // Later failures keep the data we have; the next change retries.
          if (!loadedOnceRef.current) {
            onError(errorMessage(err, "Failed to load tracks"));
            setLoading(false);
          }
        },
      );
    }

    load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [rev, onError]);

  function editTracks(fn: (prev: Track[]) => Track[]) {
    localEditSeqRef.current += 1;
    setTracks(fn);
  }

  function editTags(fn: (prev: Tag[]) => Tag[]) {
    localEditSeqRef.current += 1;
    setTags(fn);
  }

  function patchTrack(trackId: string, patch: Partial<Track>) {
    editTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
    );
  }

  function patchTrackComments(trackId: string, next: Comment[]) {
    editTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, comments: next } : t)),
    );
  }

  const tagActions: TrackTagActions = {
    onAdd: async (trackId, name) => {
      try {
        const { tag, link } = await api.addTrackTag(trackId, name);
        editTags((prev) =>
          prev.some((t) => t.id === tag.id) ? prev : [...prev, tag],
        );
        editTracks((prev) =>
          prev.map((t) =>
            t.id !== trackId || t.tags.some((l) => l.tagId === tag.id)
              ? t
              : { ...t, tags: [...t.tags, link] },
          ),
        );
        onError(null);
        return true;
      } catch (err) {
        onError(errorMessage(err, "Failed to add tag"));
        return false;
      }
    },
    onRemove: async (trackId, tagId) => {
      try {
        await api.removeTrackTag(trackId, tagId);
        editTracks((prev) =>
          prev.map((t) =>
            t.id === trackId
              ? { ...t, tags: t.tags.filter((l) => l.tagId !== tagId) }
              : t,
          ),
        );
        onError(null);
      } catch (err) {
        onError(errorMessage(err, "Failed to remove tag"));
      }
    },
  };

  const tagManagerActions: TagManagerActions = {
    onUpdate: async (tagId, patch) => {
      try {
        const { tag, mergedFrom } = await api.updateTag(tagId, patch);
        if (mergedFrom) {
          // Links of the merged tag now point at the target (no duplicates).
          editTracks((prev) =>
            prev.map((t) => {
              const from = t.tags.find((l) => l.tagId === mergedFrom);
              if (!from) return t;
              const rest = t.tags.filter((l) => l.tagId !== mergedFrom);
              return rest.some((l) => l.tagId === tag.id)
                ? { ...t, tags: rest }
                : { ...t, tags: [...rest, { ...from, tagId: tag.id }] };
            }),
          );
          onTagMerged(mergedFrom, tag.id);
        }
        editTags((prev) =>
          prev
            .filter((t) => t.id !== mergedFrom)
            .map((t) => (t.id === tag.id ? tag : t)),
        );
        onError(null);
        return true;
      } catch (err) {
        onError(errorMessage(err, "Failed to update tag"));
        return false;
      }
    },
    onDelete: async (tagId) => {
      try {
        await api.deleteTag(tagId);
        editTags((prev) => prev.filter((t) => t.id !== tagId));
        editTracks((prev) =>
          prev.map((t) =>
            t.tags.some((l) => l.tagId === tagId)
              ? { ...t, tags: t.tags.filter((l) => l.tagId !== tagId) }
              : t,
          ),
        );
        onError(null);
      } catch (err) {
        onError(errorMessage(err, "Failed to delete tag"));
      }
    },
  };

  return {
    tracks,
    tags,
    loading,
    patchTrack,
    patchTrackComments,
    tagActions,
    tagManagerActions,
  };
}
