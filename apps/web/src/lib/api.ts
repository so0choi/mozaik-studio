import type {
  Box,
  Edits,
  Job,
  ManualDoc,
  ManualState,
  ReviewDoc,
  TracksDoc,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === 'string' && m) return m;
    if (Array.isArray(m) && m.length) return m.join(' ');
  }
  return fallback;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, '서버에 연결하지 못했습니다.');
  }
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw new ApiError(res.status, messageFrom(body, `요청에 실패했습니다. (${res.status})`));
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

export const api = {
  login: (username: string, password: string) =>
    request<unknown>('/api/auth/login', json('POST', { username, password })),
  logout: () => request<unknown>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ username: string; authDisabled?: boolean }>('/api/auth/me'),

  listJobs: () => request<Job[]>('/api/jobs'),
  getJob: (id: string) => request<Job>(`/api/jobs/${id}`),
  deleteJob: (id: string) => request<unknown>(`/api/jobs/${id}`, { method: 'DELETE' }),

  getTracks: (id: string) => request<TracksDoc>(`/api/jobs/${id}/tracks`),
  getReview: (id: string) => request<ReviewDoc>(`/api/jobs/${id}/review`),
  getEdits: (id: string) => request<Partial<Edits> | null>(`/api/jobs/${id}/edits`),
  putEdits: (id: string, edits: Edits) =>
    request<unknown>(`/api/jobs/${id}/edits`, json('PUT', edits)),

  postManual: (id: string, body: { manualId: string; anchor: { frame: number; box: Box }; otherAnchors: number[] }) =>
    request<unknown>(`/api/jobs/${id}/manual`, json('POST', body)),
  getManual: (id: string, mid: string) => request<ManualResponse>(`/api/jobs/${id}/manual/${mid}`),

  render: (id: string) => request<unknown>(`/api/jobs/${id}/render`, { method: 'POST' }),
};

/** GET /manual/:mid: state plus result. The result may be nested under `result` or inline. */
export interface ManualResponse {
  state: ManualState;
  result?: ManualDoc | null;
  frames?: Record<string, Box>;
  segments?: [number, number][];
  id?: string;
}

export function manualDocOf(mid: string, r: ManualResponse): ManualDoc | null {
  if (r.result && r.result.frames) return { ...r.result, id: r.result.id ?? mid };
  if (r.frames) return { id: r.id ?? mid, frames: r.frames, segments: r.segments ?? [] };
  return null;
}

export const videoUrl = (id: string) => `/api/jobs/${id}/video`;
export const outputUrl = (id: string) => `/api/jobs/${id}/output`;
/** tracks.json stores thumbs as `thumbs/<name>.jpg`; the API serves them by name only. */
export const thumbUrl = (id: string, path: string) =>
  `/api/jobs/${id}/thumbs/${path.split('/').pop()}`;

/** Multipart upload with progress. Rejects with ApiError carrying the server's message. */
export function uploadJob(
  file: File,
  onProgress: (percent: number) => void,
): Promise<Job> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/jobs');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Job);
      else reject(new ApiError(xhr.status, messageFrom(body, `업로드에 실패했습니다. (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new ApiError(0, '서버에 연결하지 못했습니다.'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
