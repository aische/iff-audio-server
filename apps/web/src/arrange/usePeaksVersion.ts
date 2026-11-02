import { useEffect, useMemo, useState } from "react";
import type { ArrangementClip } from "../api";
import { loadPeaks } from "../peaks";

/**
 * Preload waveform peaks for every track in the arrangement. The returned
 * number bumps once a batch has loaded, so waveforms know to redraw.
 */
export function usePeaksVersion(clips: ArrangementClip[]) {
  const [peaksVersion, setPeaksVersion] = useState(0);
  const peakTrackKey = useMemo(
    () => [...new Set(clips.map((c) => c.trackId))].sort().join(","),
    [clips],
  );

  useEffect(() => {
    if (!peakTrackKey) return;
    const ids = peakTrackKey.split(",").filter(Boolean);
    let cancelled = false;
    void Promise.all(ids.map((id) => loadPeaks(id).catch(() => null))).then(
      () => {
        if (!cancelled) setPeaksVersion((v) => v + 1);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [peakTrackKey]);

  return peaksVersion;
}
