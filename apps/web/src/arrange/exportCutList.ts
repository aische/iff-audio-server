import type { ArrangementClip, Track } from "../api";
import { formatClock, shortTitle } from "../format";
import { formatClockTenths, formatPause } from "./format";
import { buildSchedule, clipDuration } from "./timeline";

function sanitizeDownloadName(name: string) {
  const cleaned = name
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return cleaned || "arrangement";
}

/** Collapse tabs / newlines so a value stays on its line. */
function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

type Column = { header: string; align: "left" | "right" };

const COLUMNS: Column[] = [
  { header: "#", align: "right" },
  { header: "start", align: "right" },
  { header: "title", align: "left" },
  { header: "from", align: "right" },
  { header: "to", align: "right" },
  { header: "length", align: "right" },
  { header: "pause", align: "right" },
  { header: "gain", align: "right" },
];

const COLUMN_GAP = "  ";

/**
 * Plain-text cut list for people: running start time in the show, title,
 * in / out points, length, pause after the clip and gain. Pause and gain
 * are blank when there is none / unity.
 */
export function buildCutList(
  name: string,
  clips: ArrangementClip[],
  trackById: Map<string, Track>,
) {
  const { segs, totalSec } = buildSchedule(clips);
  // One audio segment per clip, in clip order.
  const audioSegs = segs.filter((s) => s.kind === "audio");

  const rows = clips.map((clip, i) => {
    const track = trackById.get(clip.trackId);
    const pause = clip.pauseSec >= 0.05 ? formatPause(clip.pauseSec) : "";
    const gain =
      Math.abs(clip.gain - 1) >= 0.005 ? `×${clip.gain.toFixed(2)}` : "";
    return [
      String(i + 1),
      formatClock(audioSegs[i]?.arrStart ?? 0),
      track ? oneLine(shortTitle(track.filename)) : "(missing track)",
      formatClockTenths(clip.inSec),
      formatClockTenths(clip.outSec),
      formatClock(clipDuration(clip)),
      pause,
      gain,
    ];
  });

  const table = [COLUMNS.map((c) => c.header), ...rows];
  const widths = COLUMNS.map((_, col) =>
    Math.max(...table.map((cells) => cells[col]!.length)),
  );
  const lines = table.map((cells) =>
    cells
      .map((cell, col) =>
        COLUMNS[col]!.align === "right"
          ? cell.padStart(widths[col]!)
          : cell.padEnd(widths[col]!),
      )
      .join(COLUMN_GAP)
      .trimEnd(),
  );

  const count = `${clips.length} ${clips.length === 1 ? "track" : "tracks"}`;
  return [
    oneLine(name) || "Arrangement",
    `${count} · total ${formatClock(totalSec)}`,
    "",
    ...lines,
    "",
  ].join("\n");
}

function downloadTextFile(filename: string, body: string, mime: string) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking right after click() can cancel the download in Firefox / Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Download the arrangement's cut list as `<name>.txt`. */
export function downloadCutList(
  name: string,
  clips: ArrangementClip[],
  trackById: Map<string, Track>,
) {
  downloadTextFile(
    `${sanitizeDownloadName(name)}.txt`,
    buildCutList(name, clips, trackById),
    "text/plain;charset=utf-8",
  );
}
