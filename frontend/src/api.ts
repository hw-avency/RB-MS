const API_BASE = import.meta.env.VITE_API_BASE_URL || window.location.origin;

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type TokenProvider = () => Promise<string | null>;
type RequestOptions = {
  headers?: Record<string, string>;
  payload?: unknown;
  timeoutMs?: number;
};

export type ApiFetchResult<T> = {
  status: number;
  ok: boolean;
  body: T | string | null;
};

let authTokenProvider: TokenProvider | null = null;

export const setAuthTokenProvider = (provider: TokenProvider) => {
  authTokenProvider = provider;
};

export async function apiFetch<T>(path: string, method: HttpMethod, options: RequestOptions = {}): Promise<ApiFetchResult<T>> {
  const { headers, payload, timeoutMs } = options;
  const token = authTokenProvider ? await authTokenProvider() : null;
  const controller = new AbortController();
  const timeout = timeoutMs ? window.setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {})
      },
      signal: controller.signal,
      ...(typeof payload === 'undefined' ? {} : { body: JSON.stringify(payload) })
    });

    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const body = response.status === 204 ? null : isJson ? await response.json() : await response.text();

    return {
      status: response.status,
      ok: response.ok,
      body: body as T | string | null
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError('Request timed out', 408, { cause: 'timeout' });
    }

    throw new ApiError(error instanceof Error ? error.message : 'Network request failed', 0, {
      cause: 'network_error'
    });
  } finally {
    if (timeout) {
      window.clearTimeout(timeout);
    }
  }
}

async function request<T>(path: string, method: HttpMethod, options: RequestOptions = {}): Promise<T> {
  const result = await apiFetch<T>(path, method, options);

  if (!result.ok) {
    const body = result.body;
    const message =
      typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `Request failed with status ${result.status}`;
    throw new ApiError(message, result.status, body);
  }

  return result.body as T;
}

export function get<T>(path: string, headers?: Record<string, string>, timeoutMs?: number): Promise<T> {
  return request<T>(path, 'GET', { headers, timeoutMs });
}

export function post<T>(path: string, payload: unknown, headers?: Record<string, string>, timeoutMs?: number): Promise<T> {
  return request<T>(path, 'POST', { payload, headers, timeoutMs });
}

export function patch<T>(path: string, payload: unknown, headers?: Record<string, string>, timeoutMs?: number): Promise<T> {
  return request<T>(path, 'PATCH', { payload, headers, timeoutMs });
}

export function del<T>(path: string, headers?: Record<string, string>, timeoutMs?: number): Promise<T> {
  return request<T>(path, 'DELETE', { headers, timeoutMs });
}

export { API_BASE };
