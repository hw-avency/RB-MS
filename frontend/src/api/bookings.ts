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

const safeJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
};

const extractErrorMessage = (body: unknown, status: number): string => {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof (body as { message?: unknown }).message === 'string') {
    return (body as { message: string }).message;
  }

  return `Request failed with status ${status}`;
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

  const body = await safeJson(response);
  logMutation('ROOM_CREATE_RESPONSE', { requestId: meta.requestId, status: response.status, ok: response.ok });
  logMutation('ROOM_CREATE_BODY', { requestId: meta.requestId, bodySnippet: toBodySnippet(body) });

  if (!response.ok) {
    throw new Error(extractErrorMessage(body, response.status));
  }
}

export async function cancelBooking(bookingId: string, meta?: BookingMutationMeta): Promise<void> {
  if (!bookingId) {
    throw new Error('Missing bookingId');
  }

  const method = 'DELETE';
  const path = `/bookings/${bookingId}`;
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

  const body = await safeJson(response);

  if (meta) {
    logMutation('ROOM_CANCEL_RESPONSE', { requestId: meta.requestId, status: response.status, ok: response.ok });
    logMutation('ROOM_CANCEL_BODY', { requestId: meta.requestId, bodySnippet: toBodySnippet(body) });
  }

  if (!response.ok) {
    throw new Error(extractErrorMessage(body, response.status));
  }
}
