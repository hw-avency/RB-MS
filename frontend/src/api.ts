const API_BASE = import.meta.env.VITE_API_BASE_URL || window.location.origin;
const REQUEST_TIMEOUT_MS = 6000;

export type ApiErrorCode = 'BACKEND_UNREACHABLE' | 'UNAUTHORIZED' | 'SERVER_ERROR' | 'CSRF_FAILED' | 'UNKNOWN';
export type ApiErrorKind = 'BACKEND_UNREACHABLE' | 'HTTP_ERROR';

type ErrorPayload = {
  code?: string;
  message?: string;
};

export class ApiError extends Error {
  status: number;
  details: unknown;
  code: ApiErrorCode;
  kind: ApiErrorKind;
  backendCode?: string;
  requestId?: string;
  method: HttpMethod;
  path: string;

  constructor(params: {
    message: string;
    status: number;
    code: ApiErrorCode;
    kind: ApiErrorKind;
    details?: unknown;
    backendCode?: string;
    requestId?: string;
    method: HttpMethod;
    path: string;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.kind = params.kind;
    this.details = params.details;
    this.backendCode = params.backendCode;
    this.requestId = params.requestId;
    this.method = params.method;
    this.path = params.path;
  }
}

type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
const CSRF_COOKIE_NAME = 'rbms_csrf';

let backendAvailable = true;
type AuthFailureContext = {
  method: HttpMethod;
  url: string;
  status: number;
  code?: string;
};

let lastAuthMeFailure: AuthFailureContext | null = null;

const readCookie = (name: string): string | null => {
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
};

const isMutationMethod = (method: HttpMethod): boolean => method !== 'GET' && method !== 'HEAD';

const isCsrfFailure = (status: number, backendCode?: string): boolean => {
  return status === 403 && (backendCode === 'CSRF_MISSING' || backendCode === 'CSRF_INVALID');
};

async function initCsrfCookie(): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/csrf`, {
    method: 'GET',
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error('CSRF_INIT_FAILED');
  }
}

const mapStatusToCode = (status: number): ApiErrorCode => {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'UNKNOWN';
};

const normalizeErrorMessage = (body: unknown, status: number): string => {
  const backendCode = toBackendCode(body);
  if (status === 403 && (backendCode === 'CSRF_MISSING' || backendCode === 'CSRF_INVALID')) {
    return 'Aktion fehlgeschlagen (CSRF). Bitte Seite neu laden.';
  }

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

const toBackendCode = (body: unknown): string | undefined => {
  if (typeof body === 'object' && body !== null && 'code' in body && typeof (body as ErrorPayload).code === 'string') {
    return (body as ErrorPayload).code;
  }

  return undefined;
};

async function sendRequest(path: string, method: HttpMethod, payload?: unknown, signal?: AbortSignal): Promise<Response> {
  if (isMutationMethod(method) && !readCookie(CSRF_COOKIE_NAME)) {
    await initCsrfCookie();
  }

  const csrfToken = isMutationMethod(method) ? readCookie(CSRF_COOKIE_NAME) : null;
  return fetch(`${API_BASE}${path}`, {
    method,
    signal,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
    },
    ...(typeof payload === 'undefined' ? {} : { body: JSON.stringify(payload) })
  });
}

async function request<T>(path: string, method: HttpMethod, payload?: unknown): Promise<T> {
  if (!backendAvailable && !path.endsWith('/health') && !path.endsWith('/api/health')) {
    throw new ApiError({
      message: 'Backend nicht erreichbar. Bitte prüfen, ob der Server läuft.',
      status: 0,
      code: 'BACKEND_UNREACHABLE',
      kind: 'BACKEND_UNREACHABLE',
      method,
      path
    });
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await sendRequest(path, method, payload, controller.signal);

    if (isMutationMethod(method)) {
      const contentType = response.headers.get('content-type') ?? '';
      const isJson = contentType.includes('application/json');
      const body = isJson ? await response.clone().json() : await response.clone().text();
      const backendCode = toBackendCode(body);

      if (isCsrfFailure(response.status, backendCode)) {
        await initCsrfCookie();
        response = await sendRequest(path, method, payload, controller.signal);
      }
    }
  } catch {
    backendAvailable = false;
    throw new ApiError({
      message: 'Backend nicht erreichbar. Bitte prüfen, ob der Server läuft.',
      status: 0,
      code: 'BACKEND_UNREACHABLE',
      kind: 'BACKEND_UNREACHABLE',
      method,
      path
    });
  } finally {
    window.clearTimeout(timeout);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await response.json() : await response.text();
  const requestId = response.headers.get('x-request-id') ?? undefined;

  if (!response.ok) {
    const backendCode = toBackendCode(body);
    const code = isCsrfFailure(response.status, backendCode) ? 'CSRF_FAILED' : mapStatusToCode(response.status);

    if (import.meta.env.DEV) {
      console.warn('API_HTTP_ERROR', {
        method,
        url: `${API_BASE}${path}`,
        status: response.status,
        code: backendCode,
        requestId
      });
    }

    if (path === '/auth/me' && response.status === 401) {
      lastAuthMeFailure = {
        method,
        url: `${API_BASE}${path}`,
        status: response.status,
        code: backendCode
      };
    }

    const error = new ApiError({
      message: normalizeErrorMessage(body, response.status),
      status: response.status,
      code,
      kind: 'HTTP_ERROR',
      details: body,
      backendCode,
      requestId,
      method,
      path
    });

    throw error;
  }

  backendAvailable = true;
  return body as T;
}

export async function ensureCsrfCookie(): Promise<void> {
  if (!readCookie(CSRF_COOKIE_NAME)) {
    await initCsrfCookie();
  }
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

export function consumeLastAuthMeFailure(): AuthFailureContext | null {
  const failure = lastAuthMeFailure;
  lastAuthMeFailure = null;
  return failure;
}

export function resetClientCaches(): void {
  backendAvailable = true;
  lastAuthMeFailure = null;
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
