const API_BASE = import.meta.env.VITE_API_BASE_URL || window.location.origin;
const REQUEST_TIMEOUT_MS = 6000;

export type ApiErrorCode = 'BACKEND_UNREACHABLE' | 'UNAUTHORIZED' | 'SERVER_ERROR' | 'UNKNOWN';

export class ApiError extends Error {
  status: number;
  details: unknown;
  code: ApiErrorCode;

  constructor(message: string, status: number, code: ApiErrorCode, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

let backendAvailable = true;
let unauthorizedHandler: (() => void) | null = null;

const readCookie = (name: string): string | null => {
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
};

const mapStatusToCode = (status: number): ApiErrorCode => {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'UNKNOWN';
};

const normalizeErrorMessage = (body: unknown, status: number): string => {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
    return body.message;
  }

  if (status === 401 || status === 403) {
    return 'Nicht autorisiert.';
  }

  if (status >= 500) {
    return 'Serverfehler. Bitte versuche es später erneut.';
  }

  return `Request failed with status ${status}`;
};

async function request<T>(path: string, method: HttpMethod, payload?: unknown): Promise<T> {
  if (!backendAvailable && !path.endsWith('/health') && !path.endsWith('/api/health')) {
    throw new ApiError('Backend nicht erreichbar. Bitte prüfen, ob der Server läuft.', 0, 'BACKEND_UNREACHABLE');
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    const csrfToken = method === 'GET' ? null : readCookie('rbms_csrf');
    response = await fetch(`${API_BASE}${path}`, {
      method,
      signal: controller.signal,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
      },
      ...(typeof payload === 'undefined' ? {} : { body: JSON.stringify(payload) })
    });
  } catch {
    backendAvailable = false;
    throw new ApiError('Backend nicht erreichbar. Bitte prüfen, ob der Server läuft.', 0, 'BACKEND_UNREACHABLE');
  } finally {
    window.clearTimeout(timeout);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new ApiError(normalizeErrorMessage(body, response.status), response.status, mapStatusToCode(response.status), body);
    if (error.code === 'UNAUTHORIZED') {
      unauthorizedHandler?.();
    }
    throw error;
  }

  backendAvailable = true;
  return body as T;
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    await request<{ status: string }>('/health', 'GET');
    backendAvailable = true;
    return true;
  } catch {
    try {
      await request<{ status: string }>('/api/health', 'GET');
      backendAvailable = true;
      return true;
    } catch {
      backendAvailable = false;
      return false;
    }
  }
}

export function markBackendAvailable(value: boolean): void {
  backendAvailable = value;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path, 'GET');
}

export function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, 'POST', payload);
}

export function patch<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, 'PATCH', payload);
}

export function del<T>(path: string): Promise<T> {
  return request<T>(path, 'DELETE');
}

export { API_BASE };
