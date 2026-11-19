import { useEffect, useRef, useState } from "react";
import { api, type ActivityEvent } from "./api";

function seenKey(userId: string) {
  return `iff-activity-seen:${userId}`;
}

function readSeen(userId: string): number | null {
  try {
    const raw = localStorage.getItem(seenKey(userId));
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function persistSeen(userId: string, id: number) {
  try {
    localStorage.setItem(seenKey(userId), String(id));
  } catch {
    // ignore
  }
}

/**
 * Other users' activity this browser has not dismissed yet, newest first.
 * Refetched whenever the change feed moves. The "seen" cursor is per user
 * and per browser; a first visit starts at the latest event, not the
 * backlog.
 */
export function useActivity(rev: string | null, userId: string) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  // Undefined until the first fetch reads it from storage.
  const seenRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (rev == null) return;
    if (seenRef.current === undefined) seenRef.current = readSeen(userId);
    let cancelled = false;
    (async () => {
      try {
        const seen = seenRef.current;
        const res = await api.getEvents(seen ?? undefined);
        if (cancelled) return;
        if (seen == null || res.events.length === 0) {
          // Nothing from others up to `latest`: move the cursor along.
          if (seen == null || res.latest > seen) {
            seenRef.current = res.latest;
            persistSeen(userId, res.latest);
          }
          setEvents([]);
          return;
        }
        // A dismiss may have moved the cursor while this was in flight.
        const cursor = seenRef.current ?? 0;
        setEvents(res.events.filter((e) => e.id > cursor));
      } catch {
        // Offline / server down: the next change retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rev, userId]);

  /** Mark everything shown as seen (in this browser). */
  function dismiss() {
    const top = events[0]?.id;
    if (top != null && top > (seenRef.current ?? 0)) {
      seenRef.current = top;
      persistSeen(userId, top);
    }
    setEvents([]);
  }

  return { events, dismiss };
}
