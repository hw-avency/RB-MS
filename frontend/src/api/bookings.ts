import { API_BASE } from '../api';
import { logMutation, toBodySnippet } from './mutationLogger';

const DEV_AUTH_QUERY_PARAM = 'devAuth';
const DEV_AUTH_QUERY_VALUE = '1';

type BookingMutationMeta = {
  requestId: string;
};

type RoomCreatePayload = {
  deskId: string;
  userEmail: string;
  bookedFor?: 'SELF' | 'GUEST';
  guestName?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  overwrite?: boolean;
};

const shouldUseDevAuthBypass = (): boolean => {
  if (typeof window === 'undefined') return false;

  const bypassAllowedByBuild = import.meta.env.DEV || import.meta.env.VITE_AUTH_BYPASS === 'true';
  if (!bypassAllowedByBuild) return false;

  const query = new URLSearchParams(window.location.search);
  return query.get(DEV_AUTH_QUERY_PARAM) === DEV_AUTH_QUERY_VALUE;
};

const buildHeaders = (): HeadersInit => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (shouldUseDevAuthBypass()) {
    headers['x-dev-user'] = 'admin';
  }

  return headers;
};

const readBodySafe = async (response: Response): Promise<unknown> => {
  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const isJson = contentType.includes('application/json');

  try {
    if (isJson) {
      const text = await response.text();
      if (!text.trim()) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return { raw: text };
      }
    }

    const text = await response.text();
    return text.trim() ? { raw: text } : null;
  } catch {
    return null;
  }
};

const extractMessage = (body: unknown): string | null => {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof (body as { message?: unknown }).message === 'string') {
    return (body as { message: string }).message;
  }

  if (typeof body === 'object' && body !== null && 'raw' in body && typeof (body as { raw?: unknown }).raw === 'string') {
    const raw = (body as { raw: string }).raw.trim();
    return raw || null;
  }

  return null;
};

const extractErrorMessage = (body: unknown, status: number): string => {
  return extractMessage(body) || `Request failed with status ${status}`;
};

export async function createRoomBooking(payload: RoomCreatePayload, meta: BookingMutationMeta): Promise<void> {
  const method = 'POST';
  const path = '/bookings';
  const url = `${API_BASE}${path}`;

  logMutation('ROOM_CREATE_REQUEST', { requestId: meta.requestId, method, url, body: payload });

  const response = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: buildHeaders(),
    body: JSON.stringify(payload)
  });

  const body = await readBodySafe(response);
  logMutation('ROOM_CREATE_RESPONSE', { requestId: meta.requestId, status: response.status, ok: response.ok });
  logMutation('ROOM_CREATE_BODY', { requestId: meta.requestId, bodySnippet: toBodySnippet(body) });

  if (!response.ok) {
    throw new Error(extractErrorMessage(body, response.status));
  }
}

export async function cancelBooking(bookingId: string, scope: 'single' | 'series' = 'single', meta?: BookingMutationMeta): Promise<{ deletedCount: number; scope: 'single' | 'series' }> {
  if (!bookingId) {
    throw new Error('Missing bookingId');
  }

  const method = 'DELETE';
  const query = new URLSearchParams({ scope });
  const path = `/bookings/${bookingId}?${query.toString()}`;
  const url = `${API_BASE}${path}`;

  if (meta) {
    logMutation('ROOM_CANCEL_REQUEST', { requestId: meta.requestId, method, url, body: null });
  }

  const response = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: buildHeaders()
  });

  const body = await readBodySafe(response);

  if (meta) {
    logMutation('ROOM_CANCEL_RESPONSE', { requestId: meta.requestId, status: response.status, ok: response.ok });
    logMutation('ROOM_CANCEL_BODY', { requestId: meta.requestId, bodySnippet: toBodySnippet(body) });
  }

  if (!response.ok) {
    throw new Error(extractMessage(body) || `HTTP ${response.status}`);
  }

  if (
    typeof body === 'object'
    && body !== null
    && 'deletedCount' in body
    && typeof (body as { deletedCount?: unknown }).deletedCount === 'number'
    && 'scope' in body
    && ((body as { scope?: unknown }).scope === 'single' || (body as { scope?: unknown }).scope === 'series')
  ) {
    return {
      deletedCount: (body as { deletedCount: number }).deletedCount,
      scope: (body as { scope: 'single' | 'series' }).scope
    };
  }

  return { deletedCount: 0, scope };
}

export async function cancelRecurringBookingInstances(recurringBookingId: string, mode: 'ALL' | 'FUTURE' = 'ALL', anchorDate?: string, meta?: BookingMutationMeta): Promise<{ deletedCount: number }> {
  if (!recurringBookingId) {
    throw new Error('Missing recurringBookingId');
  }

  const method = 'DELETE';
  const query = new URLSearchParams({ mode });
  if (anchorDate) {
    query.set('anchorDate', anchorDate);
  }
  const path = `/recurring-bookings/${recurringBookingId}/instances?${query.toString()}`;
  const url = `${API_BASE}${path}`;

  if (meta) {
    logMutation('SERIES_CANCEL_REQUEST', { requestId: meta.requestId, method, url, body: null });
  }

  const response = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: buildHeaders()
  });

  const body = await readBodySafe(response);

  if (meta) {
    logMutation('SERIES_CANCEL_RESPONSE', { requestId: meta.requestId, status: response.status, ok: response.ok });
    logMutation('SERIES_CANCEL_BODY', { requestId: meta.requestId, bodySnippet: toBodySnippet(body) });
  }

  if (!response.ok) {
    throw new Error(extractMessage(body) || `HTTP ${response.status}`);
  }

  if (typeof body === 'object' && body !== null && 'deletedCount' in body && typeof (body as { deletedCount?: unknown }).deletedCount === 'number') {
    return { deletedCount: (body as { deletedCount: number }).deletedCount };
  }

  return { deletedCount: 0 };
}
