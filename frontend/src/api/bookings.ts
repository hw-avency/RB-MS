import { API_BASE } from '../api';

const DEV_AUTH_QUERY_PARAM = 'devAuth';
const DEV_AUTH_QUERY_VALUE = '1';

const shouldUseDevAuthBypass = (): boolean => {
  if (typeof window === 'undefined') return false;

  const bypassAllowedByBuild = import.meta.env.DEV || import.meta.env.VITE_AUTH_BYPASS === 'true';
  if (!bypassAllowedByBuild) return false;

  const query = new URLSearchParams(window.location.search);
  return query.get(DEV_AUTH_QUERY_PARAM) === DEV_AUTH_QUERY_VALUE;
};

const buildCancelHeaders = (): HeadersInit => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (shouldUseDevAuthBypass()) {
    headers['x-dev-user'] = 'admin';
  }

  return headers;
};

const safeJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
};

export async function cancelBooking(bookingId: string): Promise<void> {
  if (!bookingId) {
    throw new Error('Missing bookingId');
  }

  const method = 'DELETE';
  const path = `/bookings/${bookingId}`;
  const url = `${API_BASE}${path}`;
  const headers = buildCancelHeaders();

  console.log('[CANCEL] request', { method, url, headers });

  const response = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers
  });

  const body = await safeJson(response);
  console.log('[CANCEL] response', { status: response.status, ok: response.ok });
  console.log('[CANCEL] body', body);

  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
}
