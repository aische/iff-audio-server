import { useEffect, useState } from "react";
import { api } from "./api";

const POLL_MS = 5000;

/**
 * Server change revision, polled every few seconds while the tab is visible
 * and right away when it becomes visible or focused again. Null until the
 * first poll answers. Consumers refetch their data when it changes.
 */
export function useChangeFeed(): string | null {
  const [rev, setRev] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let inflight = false;

    // `force`: the first poll runs even in a background tab, since the
    // initial data load waits for it.
    async function poll(force = false) {
      if (stopped || inflight) return;
      if (!force && document.visibilityState !== "visible") return;
      inflight = true;
      try {
        const res = await api.getChanges();
        // Same string as before → React skips the re-render.
        if (!stopped) setRev(res.rev);
      } catch {
        // Offline or server down: try again on the next tick. A lost session
        // is handled globally (api.ts → login form).
      } finally {
        inflight = false;
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible") void poll();
    }

    const timer = window.setInterval(() => void poll(), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    void poll(true);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  return rev;
}
