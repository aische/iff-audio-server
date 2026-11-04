const API_URL = import.meta.env.VITE_API_URL;

if (!API_URL) {
  throw new Error("VITE_API_URL is required");
}

export type User = { id: string; email: string };

export type Comment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  userId: string;
  userEmail: string;
};

/** Band-wide tag. */
export type Tag = {
  id: string;
  name: string;
  /** Optional grouping for browsing; null = uncategorized. */
  category: string | null;
};

/** A shared tag on a track. */
export type TrackTag = {
  tagId: string;
  addedAt: string;
  /** Null when the user who added it no longer exists. */
  addedByEmail: string | null;
};

export type Track = {
  id: string;
  filename: string;
  present: boolean;
  sizeBytes: number;
  durationSeconds: number | null;
  /** Release label this track was published on; null = unreleased. */
  releasedOn: string | null;
  mtime: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  tags: TrackTag[];
};

/** Ordered sequence item: play [inSec, outSec), then pauseSec silence, at gain. */
export type ArrangementClip = {
  instanceId: string;
  trackId: string;
  inSec: number;
  outSec: number;
  pauseSec: number;
  /** Linear gain 0..2 (1 = unity). */
  gain: number;
};

export type ArrangementSummary = {
  id: string;
  name: string;
  clipCount: number;
  createdAt: string;
  updatedAt: string;
  userId: string;
  userEmail: string;
};

export type Arrangement = {
  id: string;
  name: string;
  clips: ArrangementClip[];
  createdAt: string;
  updatedAt: string;
  userId: string;
  userEmail: string;
};

type ErrorBody = { error?: string };

/** Separators between comment tokens (kept by `split` so text round-trips). */
export const TOKEN_SEP = /([^A-Za-z0-9#_:-]+)/;

/**
 * Personal keywords: `#words` in a comment body. They only highlight and
 * help search; shared tags are separate (`Track.tags`).
 */
export function parseKeywords(body: string): string[] {
  const out = new Set<string>();
  for (const s of body.split(TOKEN_SEP)) {
    const name = s.replace(/^#+/, "").replaceAll("#", "");
    if (s.startsWith("#") && name) out.add(name);
  }
  return [...out];
}

/** Valid shared tag name (after stripping a leading '#'), or null. */
export function normalizeTagName(raw: string): string | null {
  const name = raw.trim().replace(/^#+/, "");
  return /^[A-Za-z0-9_:-]{1,64}$/.test(name) ? name : null;
}

/** Tags of one track, resolved and sorted by category then name. */
export function trackTagList(
  track: Track,
  tagsById: ReadonlyMap<string, Tag>,
): { tag: Tag; link: TrackTag }[] {
  return track.tags
    .flatMap((link) => {
      const tag = tagsById.get(link.tagId);
      return tag ? [{ tag, link }] : [];
    })
    .sort((a, b) => compareTags(a.tag, b.tag));
}

/** Category (uncategorized last), then name, case-insensitive. */
export function compareTags(a: Tag, b: Tag): number {
  if (a.category !== b.category) {
    if (a.category == null) return 1;
    if (b.category == null) return -1;
    return a.category.localeCompare(b.category, undefined, {
      sensitivity: "base",
    });
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export const SESSION_EXPIRED_MESSAGE =
  "Your session has expired. Please sign in again.";

let onSessionLost: (() => void) | null = null;

/** Called when a request fails with 401 because the session is gone. */
export function setSessionLostHandler(fn: (() => void) | null) {
  onSessionLost = fn;
}

/**
 * Report a lost session and return the error to throw. Callers usually show
 * the thrown message, so it matches what the login form shows.
 */
function sessionLost(): Error {
  onSessionLost?.();
  return new Error(SESSION_EXPIRED_MESSAGE);
}

async function request<T>(
  path: string,
  init?: RequestInit & {
    json?: unknown;
    /** A 401 here means wrong credentials, not a lost session. */
    allow401?: boolean;
  },
): Promise<T> {
  const headers = new Headers(init?.headers);
  let body = init?.body;

  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    body,
    credentials: "include",
  });

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? ((await res.json()) as T | ErrorBody)
    : undefined;

  if (!res.ok) {
    if (res.status === 401 && !init?.allow401) throw sessionLost();
    const message =
      data && typeof data === "object" && "error" in data && data.error
        ? data.error
        : `Request failed (${res.status})`;
    throw new Error(message);
  }

  return data as T;
}

export function trackStreamUrl(id: string) {
  return `${API_URL}/tracks/${id}/download`;
}

/** Link that makes the browser save the MP3 (streamed, with its own progress). */
export function trackDownloadUrl(id: string) {
  return `${trackStreamUrl(id)}?download=1`;
}

export const api = {
  me: () => request<User>("/auth/me"),

  login: (email: string, password: string) =>
    request<User>("/auth/login", {
      method: "POST",
      json: { email, password },
      allow401: true,
    }),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/auth/change-password", {
      method: "POST",
      json: { currentPassword, newPassword },
      allow401: true,
    }),

  listTracks: () => request<Track[]>("/tracks"),

  getTrackPeaks: (trackId: string) =>
    request<{ peaks: number[]; durationSec: number }>(
      `/tracks/${trackId}/peaks`,
    ),

  setTrackReleasedOn: (trackId: string, releasedOn: string | null) =>
    request<{ id: string; releasedOn: string | null; updatedAt: string }>(
      `/tracks/${trackId}`,
      { method: "PATCH", json: { releasedOn } },
    ),

  getTrackComments: (trackId: string) =>
    request<Comment[]>(`/tracks/${trackId}/comments`),

  setTrackComment: (trackId: string, body: string) =>
    request<Comment | undefined>(`/tracks/${trackId}/comments`, {
      method: "PUT",
      json: { body },
    }),

  listTags: () => request<Tag[]>("/tags"),

  addTrackTag: (trackId: string, name: string) =>
    request<{ tag: Tag; link: TrackTag }>(`/tracks/${trackId}/tags`, {
      method: "POST",
      json: { name },
    }),

  removeTrackTag: (trackId: string, tagId: string) =>
    request<void>(`/tracks/${trackId}/tags/${tagId}`, { method: "DELETE" }),

  /** Renaming onto an existing name (case-insensitive) merges into it. */
  updateTag: (id: string, patch: { name?: string; category?: string | null }) =>
    request<{ tag: Tag; mergedFrom: string | null }>(`/tags/${id}`, {
      method: "PATCH",
      json: patch,
    }),

  deleteTag: (id: string) =>
    request<void>(`/tags/${id}`, { method: "DELETE" }),

  listArrangements: () => request<ArrangementSummary[]>("/arrangements"),

  createArrangement: (name: string, clips?: ArrangementClip[]) =>
    request<Arrangement>("/arrangements", {
      method: "POST",
      json: clips ? { name, clips } : { name },
    }),

  getArrangement: (id: string) => request<Arrangement>(`/arrangements/${id}`),

  copyArrangement: (id: string) =>
    request<Arrangement>(`/arrangements/${id}/copy`, { method: "POST" }),

  updateArrangement: (
    id: string,
    patch: { name?: string; clips?: ArrangementClip[] },
  ) =>
    request<Arrangement>(`/arrangements/${id}`, {
      method: "PUT",
      json: patch,
    }),

  deleteArrangement: (id: string) =>
    request<void>(`/arrangements/${id}`, { method: "DELETE" }),

};
