import { API_BASE } from '../api';
import { logMutation, toBodySnippet } from './mutationLogger';

const DEV_AUTH_QUERY_PARAM = 'devAuth';
const DEV_AUTH_QUERY_VALUE = '1';

type BookingMutationMeta = {
  requestId: string;
};

export type BookingCancelPreview = {
  bookingId: string;
  isSeries: boolean;
  seriesBookingCount: number;
  recurringBookingId: string | null;
  recurringGroupId: string | null;
  recurrence: {
    id: string;
    startDate: string;
    endDate: string;
    patternType: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
    interval: number;
  } | null;
};

type BookingCancelPreviewResponse = {
  bookingId: string;
  isSeries: boolean;
  seriesBookingCount: number;
  recurringBookingId?: string;
  recurringGroupId?: string;
  recurrence?: {
    id: string;
    startDate: string;
    endDate: string;
    patternType: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
    interval: number;
  };
};

const parseBookingCancelPreviewResponse = (body: unknown): BookingCancelPreviewResponse | null => {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const payload = body as Record<string, unknown>;
  if (typeof payload.bookingId !== 'string' || typeof payload.isSeries !== 'boolean' || typeof payload.seriesBookingCount !== 'number') {
    return null;
  }

  const recurringBookingId = typeof payload.recurringBookingId === 'string' ? payload.recurringBookingId : undefined;
  const recurringGroupId = typeof payload.recurringGroupId === 'string' ? payload.recurringGroupId : undefined;

  let recurrence: BookingCancelPreviewResponse['recurrence'];
  if (typeof payload.recurrence === 'object' && payload.recurrence !== null) {
    const recurrencePayload = payload.recurrence as Record<string, unknown>;
    if (
      typeof recurrencePayload.id === 'string'
      && typeof recurrencePayload.startDate === 'string'
      && typeof recurrencePayload.endDate === 'string'
      && (recurrencePayload.patternType === 'DAILY'
        || recurrencePayload.patternType === 'WEEKLY'
        || recurrencePayload.patternType === 'MONTHLY'
        || recurrencePayload.patternType === 'YEARLY')
      && typeof recurrencePayload.interval === 'number'
    ) {
      recurrence = {
        id: recurrencePayload.id,
        startDate: recurrencePayload.startDate,
        endDate: recurrencePayload.endDate,
        patternType: recurrencePayload.patternType,
        interval: recurrencePayload.interval
      };
    }
  }

  return {
    bookingId: payload.bookingId,
    isSeries: payload.isSeries,
    seriesBookingCount: payload.seriesBookingCount,
    recurringBookingId,
    recurringGroupId,
    recurrence
  };
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

export async function cancelBooking(bookingId: string, scope: 'single' | 'series' | 'resource_day_self' = 'single', meta?: BookingMutationMeta): Promise<{ deletedCount: number; scope: 'single' | 'series' | 'resource_day_self' }> {
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
    && ((body as { scope?: unknown }).scope === 'single' || (body as { scope?: unknown }).scope === 'series' || (body as { scope?: unknown }).scope === 'resource_day_self')
  ) {
    return {
      deletedCount: (body as { deletedCount: number }).deletedCount,
      scope: (body as { scope: 'single' | 'series' | 'resource_day_self' }).scope
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

export async function fetchBookingCancelPreview(bookingId: string): Promise<BookingCancelPreview> {
  if (!bookingId) {
    throw new Error('Missing bookingId');
  }

  const method = 'GET';
  const path = `/bookings/${bookingId}/cancel-preview`;
  const url = `${API_BASE}${path}`;

  const response = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: buildHeaders()
  });

  const body = await readBodySafe(response);
  if (!response.ok) {
    throw new Error(extractMessage(body) || `HTTP ${response.status}`);
  }

  const preview = parseBookingCancelPreviewResponse(body);
  if (preview) {
    return {
      bookingId: preview.bookingId,
      isSeries: preview.isSeries,
      seriesBookingCount: preview.seriesBookingCount,
      recurringBookingId: preview.recurringBookingId ?? null,
      recurringGroupId: preview.recurringGroupId ?? null,
      recurrence: preview.recurrence ?? null
    };
  }

  throw new Error('Ungültige Antwort für Storno-Vorschau.');
}
