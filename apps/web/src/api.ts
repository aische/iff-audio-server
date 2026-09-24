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

export type Track = {
  id: string;
  filename: string;
  present: boolean;
  sizeBytes: number;
  durationSeconds: number | null;
  mtime: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
};

export type ArrangementClip = {
  instanceId: string;
  trackId: string;
  startSec: number;
  offsetSec: number;
  durationSec: number;
  lane: number;
};

export type ArrangementSummary = {
  id: string;
  name: string;
  clipCount: number;
  createdAt: string;
  updatedAt: string;
};

export type Arrangement = {
  id: string;
  name: string;
  clips: ArrangementClip[];
  createdAt: string;
  updatedAt: string;
  userId: string;
};

type ErrorBody = { error?: string };

/** Parse #tags from comment text. */
export function parseTags(str: string): string[] {
  return str.split(/[^A-Za-z0-9#_:-]/).flatMap((s) => {
    const c = s.charAt(0);
    const r = s.slice(1);
    if (c === "#" && r.length) return [r];
    return [];
  });
}

export function unifiedTags(bodies: string[]): string[] {
  const set = new Set<string>();
  for (const body of bodies) {
    for (const tag of parseTags(body)) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
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

export const api = {
  me: () => request<User>("/auth/me"),

  login: (email: string, password: string) =>
    request<User>("/auth/login", {
      method: "POST",
      json: { email, password },
    }),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/auth/change-password", {
      method: "POST",
      json: { currentPassword, newPassword },
    }),

  listTracks: () => request<Track[]>("/tracks"),

  getTrackComments: (trackId: string) =>
    request<Comment[]>(`/tracks/${trackId}/comments`),

  setTrackComment: (trackId: string, body: string) =>
    request<Comment | undefined>(`/tracks/${trackId}/comments`, {
      method: "PUT",
      json: { body },
    }),

  listArrangements: () => request<ArrangementSummary[]>("/arrangements"),

  createArrangement: (name: string) =>
    request<Arrangement>("/arrangements", {
      method: "POST",
      json: { name },
    }),

  getArrangement: (id: string) => request<Arrangement>(`/arrangements/${id}`),

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

  downloadTrack: async (id: string, filename: string) => {
    const res = await fetch(trackStreamUrl(id), {
      credentials: "include",
    });
    if (!res.ok) {
      let message = `Download failed (${res.status})`;
      try {
        const data = (await res.json()) as ErrorBody;
        if (data.error) message = data.error;
      } catch {
        // ignore non-JSON error bodies
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};
