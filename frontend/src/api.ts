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

async function request<T>(path: string, method: HttpMethod, payload?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {})
    },
    ...(typeof payload === 'undefined' ? {} : { body: JSON.stringify(payload) })
  });

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

export function get<T>(path: string, headers?: Record<string, string>): Promise<T> {
  return request<T>(path, 'GET', undefined, headers);
}

export function post<T>(path: string, payload: unknown, headers?: Record<string, string>): Promise<T> {
  return request<T>(path, 'POST', payload, headers);
}

export function patch<T>(path: string, payload: unknown, headers?: Record<string, string>): Promise<T> {
  return request<T>(path, 'PATCH', payload, headers);
}

export function del<T>(path: string, headers?: Record<string, string>): Promise<T> {
  return request<T>(path, 'DELETE', undefined, headers);
}

export { API_BASE };
