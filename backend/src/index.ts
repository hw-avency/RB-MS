import cors from 'cors';
import { canCancelBooking } from './auth/bookingAuth';
import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { BookedFor, BookingSlot, DaySlot, Prisma, ResourceKind } from '@prisma/client';
import { prisma } from './prisma';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const configuredTitle = process.env.APP_TITLE ?? process.env.PAGE_TITLE ?? process.env.VITE_PAGE_TITLE;
const APP_TITLE = configuredTitle?.trim() || 'RB-MS';
app.set('trust proxy', 1);

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const configuredOrigins = (process.env.FRONTEND_URL ?? process.env.CORS_ORIGIN ?? process.env.FRONTEND_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => Boolean(origin));
const FRONTEND_URL = configuredOrigins[0] ?? '';
const PASSWORD_SALT_ROUNDS = Number(process.env.PASSWORD_SALT_ROUNDS ?? 12);
const normalizedNodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
const isRenderRuntime = process.env.RENDER === 'true' || Boolean(process.env.RENDER_EXTERNAL_URL);
const isProd = normalizedNodeEnv === 'production' || isRenderRuntime;
const AUTH_BYPASS_ENABLED = process.env.AUTH_BYPASS === 'true' && !isProd;
const cookieSameSite: 'none' | 'lax' = (process.env.COOKIE_SAMESITE === 'none' || process.env.COOKIE_SAMESITE === 'lax')
  ? process.env.COOKIE_SAMESITE
  : (isProd ? 'none' : 'lax');
const cookieSecure = typeof process.env.COOKIE_SECURE === 'string'
  ? process.env.COOKIE_SECURE === 'true'
  : isProd;
const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID?.trim();
const ENTRA_CLIENT_ID = process.env.ENTRA_CLIENT_ID?.trim();
const ENTRA_CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET;
const ENTRA_REDIRECT_URI = process.env.ENTRA_REDIRECT_URI?.trim();
const ENTRA_POST_LOGIN_REDIRECT = process.env.ENTRA_POST_LOGIN_REDIRECT?.trim() ?? `${process.env.FRONTEND_URL ?? ''}/#/`;
const GRAPH_APP_SCOPE = 'https://graph.microsoft.com/.default';

const corsOptions = {
  origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (configuredOrigins.length === 0) {
      callback(null, true);
      return;
    }

    if (!origin) {
      callback(null, true);
      return;
    }

    callback(null, configuredOrigins.includes(origin));
  },
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

const bookingNoStorePaths = new Set(['/bookings', '/occupancy', '/admin/bookings']);
app.use((req, res, next) => {
  if (req.method === 'GET' && bookingNoStorePaths.has(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RESOURCE_KINDS = new Set<ResourceKind>(['TISCH', 'PARKPLATZ', 'RAUM', 'SONSTIGES']);
const BOOKED_FOR_VALUES = new Set<BookedFor>(['SELF', 'GUEST']);

const parseResourceKind = (value: unknown): ResourceKind | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase() as ResourceKind;
  return RESOURCE_KINDS.has(normalized) ? normalized : null;
};

const parseBookedFor = (value: unknown): BookedFor => {
  if (typeof value !== 'string') return 'SELF';
  const normalized = value.trim().toUpperCase() as BookedFor;
  return BOOKED_FOR_VALUES.has(normalized) ? normalized : 'SELF';
};

const normalizeGuestName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

type EmployeeRole = 'admin' | 'user';
type SessionRecord = {
  id: string;
  userId?: string;
  employeeId?: string;
  expiresAt: Date;
  graphAccessToken?: string;
  graphTokenExpiresAt?: Date;
};
type AuthUser = { id: string; email: string; displayName: string; role: EmployeeRole; isActive: boolean; source: 'local' | 'entra' };

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      authUser?: AuthUser;
      authSession?: SessionRecord;
      authFailureReason?: 'MISSING_SESSION_COOKIE' | 'SESSION_INVALID_OR_EXPIRED' | 'USER_MISSING_OR_INACTIVE';
    }
  }
}

const createRequestId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const attachRequestId: express.RequestHandler = (req, res, next) => {
  const requestId = createRequestId();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};

app.use(attachRequestId);

const SESSION_COOKIE_NAME = 'rbms_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
type OidcFlowState = { nonce: string; createdAt: Date };
const OIDC_STATE_TTL_MS = 1000 * 60 * 10;
const parseCookies = (cookieHeader?: string): Record<string, string> => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rawValue] = part.split('=');
    if (!rawKey || rawValue.length === 0) return acc;
    acc[rawKey.trim()] = decodeURIComponent(rawValue.join('=').trim());
    return acc;
  }, {});
};

const applySessionCookies = (res: express.Response, session: SessionRecord) => {
  res.cookie(SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
};

const clearSessionCookies = (res: express.Response) => {
  const options = { httpOnly: true, secure: cookieSecure, sameSite: cookieSameSite, path: '/' };
  res.clearCookie(SESSION_COOKIE_NAME, options);
};

const createSession = async (identity: { userId?: string; employeeId?: string }, options?: { graphAccessToken?: string; graphTokenExpiresInSeconds?: number }): Promise<SessionRecord> => {
  if (!identity.userId && !identity.employeeId) {
    throw new Error('SESSION_IDENTITY_MISSING');
  }

  const now = Date.now();
  const graphTokenExpiresAt = options?.graphTokenExpiresInSeconds
    ? new Date(now + (options.graphTokenExpiresInSeconds * 1000))
    : undefined;
  const session: SessionRecord = {
    id: crypto.randomUUID(),
    ...(identity.userId ? { userId: identity.userId } : {}),
    ...(identity.employeeId ? { employeeId: identity.employeeId } : {}),
    expiresAt: new Date(now + SESSION_TTL_MS),
    ...(options?.graphAccessToken ? { graphAccessToken: options.graphAccessToken } : {}),
    ...(graphTokenExpiresAt ? { graphTokenExpiresAt } : {})
  };
  await prisma.session.create({
    data: {
      id: session.id,
      userId: session.userId,
      employeeId: session.employeeId,
      expiresAt: session.expiresAt,
      graphAccessToken: session.graphAccessToken,
      graphTokenExpiresAt: session.graphTokenExpiresAt
    }
  });
  return session;
};

const destroySession = async (sessionId?: string) => {
  if (!sessionId) return;
  await prisma.session.deleteMany({ where: { id: sessionId } });
};
const ENTRA_AUTHORITY = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`;
const ENTRA_DISCOVERY_URL = `${ENTRA_AUTHORITY}/.well-known/openid-configuration`;
type OidcMetadata = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
type Jwk = { kid?: string; kty?: string; use?: string; alg?: string; n?: string; e?: string };
type IdTokenClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
  tid?: string;
  oid?: string;
  email?: string;
  preferred_username?: string;
  name?: string;
};
let oidcMetadataCache: OidcMetadata | null = null;
let jwksCache: { keys: Jwk[] } | null = null;
let graphAppTokenCache: { token: string; expiresAt: number } | null = null;

const parseBase64UrlJson = <T>(value: string): T => {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as T;
};

const createOidcState = async (): Promise<{ state: string; nonce: string }> => {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  await prisma.oidcState.create({
    data: {
      state,
      nonce,
      createdAt: new Date()
    }
  });
  return { state, nonce };
};

const consumeOidcState = async (state: string): Promise<OidcFlowState | null> => {
  const current = await prisma.$transaction(async (tx) => {
    const found = await tx.oidcState.findUnique({ where: { state } });
    if (!found) return null;
    await tx.oidcState.delete({ where: { state } });
    return found;
  });

  if (!current) return null;
  if (Date.now() - current.createdAt.getTime() > OIDC_STATE_TTL_MS) return null;
  return current;
};

const isEntraConfigured = (): boolean => Boolean(ENTRA_TENANT_ID && ENTRA_CLIENT_ID && ENTRA_CLIENT_SECRET && ENTRA_REDIRECT_URI);

const loadOidcMetadata = async (): Promise<OidcMetadata> => {
  if (oidcMetadataCache) return oidcMetadataCache;
  const response = await fetch(ENTRA_DISCOVERY_URL);
  if (!response.ok) throw new Error('OIDC_DISCOVERY_FAILED');
  oidcMetadataCache = await response.json() as OidcMetadata;
  return oidcMetadataCache;
};

const loadJwks = async (jwksUri: string): Promise<{ keys: Jwk[] }> => {
  if (jwksCache) return jwksCache;
  const response = await fetch(jwksUri);
  if (!response.ok) throw new Error('JWKS_FETCH_FAILED');
  jwksCache = await response.json() as { keys: Jwk[] };
  return jwksCache;
};

const verifyIdToken = async (idToken: string, expectedNonce: string): Promise<IdTokenClaims> => {
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('INVALID_ID_TOKEN_FORMAT');
  }

  const header = parseBase64UrlJson<{ kid?: string; alg?: string }>(encodedHeader);
  const claims = parseBase64UrlJson<IdTokenClaims>(encodedPayload);
  const metadata = await loadOidcMetadata();
  const jwks = await loadJwks(metadata.jwks_uri);
  const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (!key) throw new Error('JWKS_KEY_NOT_FOUND');

  const verifier = crypto.createPublicKey({ key, format: 'jwk' });
  const signedContent = `${encodedHeader}.${encodedPayload}`;
  const signature = Buffer.from(encodedSignature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const signatureValid = crypto.verify('RSA-SHA256', Buffer.from(signedContent), verifier, signature);
  if (!signatureValid) throw new Error('INVALID_ID_TOKEN_SIGNATURE');

  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (claims.iss !== metadata.issuer) throw new Error('INVALID_ISSUER');
  if (!audience.includes(ENTRA_CLIENT_ID as string)) throw new Error('INVALID_AUDIENCE');
  if (!claims.exp || claims.exp <= now) throw new Error('ID_TOKEN_EXPIRED');
  if (claims.nonce !== expectedNonce) throw new Error('INVALID_NONCE');

  return claims;
};

const originGuardExcludedPaths = new Set(['/auth/login', '/auth/logout']);
const requireAllowedMutationOrigin: express.RequestHandler = (req, res, next) => {
  const isMutationMethod = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
  if (!isMutationMethod) {
    next();
    return;
  }

  if (originGuardExcludedPaths.has(req.path) || req.path.startsWith('/auth/entra/')) {
    next();
    return;
  }

  if (configuredOrigins.length === 0) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (origin && !configuredOrigins.includes(origin)) {
    res.status(403).json({ error: 'forbidden', code: 'ORIGIN_NOT_ALLOWED', message: 'Request blocked (Origin)' });
    return;
  }

  if (!origin) {
    const referer = req.get('referer');
    const refererAllowed = Boolean(referer && configuredOrigins.some((allowedOrigin) => referer.startsWith(allowedOrigin)));
    if (!refererAllowed) {
      res.status(403).json({ error: 'forbidden', code: 'ORIGIN_NOT_ALLOWED', message: 'Request blocked (Origin)' });
      return;
    }
  }

  next();
};

const attachAuthUser: express.RequestHandler = async (req, _res, next) => {
  if (AUTH_BYPASS_ENABLED) {
    const devUserHeader = req.get('x-dev-user')?.trim().toLowerCase();
    if (devUserHeader === 'admin') {
      req.authUser = {
        id: 'dev-admin',
        email: 'dev@local',
        displayName: 'Dev Admin',
        role: 'admin',
        isActive: true,
        source: 'local'
      };
      next();
      return;
    }

    if (devUserHeader) {
      const devUserId = req.get('x-dev-user-id')?.trim() || `dev-${devUserHeader.replace(/[^a-z0-9_-]+/g, '-')}`;
      const devUserEmail = req.get('x-dev-user-email')?.trim().toLowerCase() || `${devUserHeader}@local`;
      const devUserRoleHeader = req.get('x-dev-user-role')?.trim().toLowerCase();
      const devUserRole: EmployeeRole = devUserRoleHeader === 'admin' ? 'admin' : 'user';
      req.authUser = {
        id: devUserId,
        email: devUserEmail,
        displayName: devUserHeader,
        role: devUserRole,
        isActive: true,
        source: 'local'
      };
      next();
      return;
    }
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) {
    req.authFailureReason = 'MISSING_SESSION_COOKIE';
    next();
    return;
  }

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    await destroySession(sessionId);
    req.authFailureReason = 'SESSION_INVALID_OR_EXPIRED';
    next();
    return;
  }

  const localUser = session.userId
    ? await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true
      }
    })
    : null;
  const employeeUser = !localUser && session.employeeId
    ? await prisma.employee.findUnique({
      where: { id: session.employeeId },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true
      }
    })
    : null;
  const authIdentity = localUser
    ? { ...localUser, source: 'local' as const }
    : employeeUser
      ? { ...employeeUser, source: 'entra' as const }
      : null;

  if (!authIdentity || !authIdentity.isActive) {
    await destroySession(sessionId);
    req.authFailureReason = 'USER_MISSING_OR_INACTIVE';
    next();
    return;
  }

  const refreshedExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.update({
    where: { id: session.id },
    data: { expiresAt: refreshedExpiresAt }
  });
  req.authSession = {
    id: session.id,
    userId: session.userId ?? undefined,
    employeeId: session.employeeId ?? undefined,
    expiresAt: refreshedExpiresAt,
    graphAccessToken: session.graphAccessToken ?? undefined,
    graphTokenExpiresAt: session.graphTokenExpiresAt ?? undefined
  };
  req.authUser = {
    id: authIdentity.id,
    email: authIdentity.email,
    displayName: authIdentity.displayName,
    role: authIdentity.role === 'admin' ? 'admin' : 'user',
    isActive: authIdentity.isActive,
    source: authIdentity.source
  };

  next();
};

const requireAuthenticated: express.RequestHandler = (req, res, next) => {
  if (!req.authUser) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return;
  }

  next();
};

const requireAdmin: express.RequestHandler = (req, res, next) => {
  if (!req.authUser) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return;
  }

  if (!req.authUser.isActive || req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
    return;
  }

  next();
};

const toDateOnly = (value: string): Date | null => {
  if (!DATE_PATTERN.test(value)) {
    return null;
  }

  const [yearPart, monthPart, dayPart] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (
    Number.isNaN(yearPart)
    || Number.isNaN(monthPart)
    || Number.isNaN(dayPart)
  ) {
    return null;
  }

  const parsed = new Date(Date.UTC(yearPart, monthPart - 1, dayPart));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (
    parsed.getUTCFullYear() !== yearPart
    || parsed.getUTCMonth() + 1 !== monthPart
    || parsed.getUTCDate() !== dayPart
  ) {
    return null;
  }

  return parsed;
};

const toISODateOnly = (value: Date): string => value.toISOString().slice(0, 10);

const BERLIN_TIME_ZONE = 'Europe/Berlin';
const ROOM_WORK_START_MINUTE = 7 * 60;
const ROOM_WORK_END_MINUTE = 18 * 60;

const getTimeZoneOffsetMs = (date: Date, timeZone: string): number => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number.parseInt(values.get('year') ?? '', 10);
  const month = Number.parseInt(values.get('month') ?? '', 10);
  const day = Number.parseInt(values.get('day') ?? '', 10);
  const hour = Number.parseInt(values.get('hour') ?? '', 10);
  const minute = Number.parseInt(values.get('minute') ?? '', 10);
  const second = Number.parseInt(values.get('second') ?? '', 10);

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - date.getTime();
};

const zonedDateTimeToUtc = (year: number, month: number, day: number, hour: number, minute: number, second = 0): Date => {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = getTimeZoneOffsetMs(utcGuess, BERLIN_TIME_ZONE);
  return new Date(utcGuess.getTime() - offset);
};

const getBerlinDayBoundsUtc = (date: Date): { dayStartUtc: Date; dayEndUtc: Date } => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));

  return {
    dayStartUtc: zonedDateTimeToUtc(year, month, day, 0, 0, 0),
    dayEndUtc: zonedDateTimeToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0, 0)
  };
};

const mergeTimeIntervals = (intervals: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> => {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  const merged = [{ ...sorted[0] }];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = merged[merged.length - 1];
    if (current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }

  return merged;
};

const toFreeTimeWindows = (
  occupied: Array<{ start: number; end: number }>,
  dayStart = ROOM_WORK_START_MINUTE,
  dayEnd = ROOM_WORK_END_MINUTE
): Array<{ start: number; end: number }> => {
  const free: Array<{ start: number; end: number }> = [];
  let cursor = dayStart;

  for (const interval of occupied) {
    const start = Math.max(interval.start, dayStart);
    const end = Math.min(interval.end, dayEnd);
    if (end <= dayStart || start >= dayEnd) continue;
    if (start > cursor) free.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }

  if (cursor < dayEnd) {
    free.push({ start: cursor, end: dayEnd });
  }

  return free;
};

const addUtcDays = (value: Date, days: number): Date => {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const endOfCurrentYear = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), 11, 31));
};

const datesInRange = (from: Date, to: Date): Date[] => {
  const dates: Date[] = [];
  const cursor = new Date(from);

  while (cursor <= to) {
    dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
};

const DAY_SLOT_KINDS = new Set<ResourceKind>(['TISCH', 'PARKPLATZ']);
const DAY_SLOTS = new Set<DaySlot>(['AM', 'PM', 'FULL']);
const BOOKING_SLOTS = new Set<BookingSlot>(['FULL_DAY', 'MORNING', 'AFTERNOON', 'CUSTOM']);
type BookingWindowInput = { mode: 'day'; daySlot: DaySlot } | { mode: 'time'; startMinute: number; endMinute: number };

const isDaySlotKind = (kind: ResourceKind): boolean => DAY_SLOT_KINDS.has(kind);

const parseDaySlot = (value: unknown): DaySlot | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase() as DaySlot;
  return DAY_SLOTS.has(normalized) ? normalized : null;
};

const parseBookingSlot = (value: unknown): BookingSlot | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase() as BookingSlot;
  return BOOKING_SLOTS.has(normalized) ? normalized : null;
};

const overlapsDaySlot = (a: DaySlot, b: DaySlot): boolean => {
  if (a === 'FULL' || b === 'FULL') return true;
  return a === b;
};

const parseTimeToMinute = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

const minuteToHHMM = (value: number | null | undefined): string | undefined => {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const bookingSlotToDaySlot = (slot: BookingSlot | null | undefined): DaySlot | null => {
  if (slot === 'FULL_DAY') return 'FULL';
  if (slot === 'MORNING') return 'AM';
  if (slot === 'AFTERNOON') return 'PM';
  return null;
};

const bookingToWindow = (booking: { daySlot: DaySlot | null; startTime: Date | null; endTime: Date | null; slot: BookingSlot; startMinute: number | null; endMinute: number | null }): BookingWindowInput | null => {
  const normalizedDaySlot = booking.daySlot ?? bookingSlotToDaySlot(booking.slot);
  if (normalizedDaySlot) return { mode: 'day', daySlot: normalizedDaySlot };

  const startMinute = booking.startMinute ?? (booking.startTime ? booking.startTime.getUTCHours() * 60 + booking.startTime.getUTCMinutes() : null);
  const endMinute = booking.endMinute ?? (booking.endTime ? booking.endTime.getUTCHours() * 60 + booking.endTime.getUTCMinutes() : null);
  if (typeof startMinute !== 'number' || typeof endMinute !== 'number') return null;
  return { mode: 'time', startMinute, endMinute };
};

const windowsOverlap = (left: BookingWindowInput, right: BookingWindowInput): boolean => {
  if (left.mode === 'day' && right.mode === 'day') {
    return overlapsDaySlot(left.daySlot, right.daySlot);
  }
  if (left.mode === 'time' && right.mode === 'time') {
    return left.startMinute < right.endMinute && right.startMinute < left.endMinute;
  }
  return false;
};

const resolveBookingWindow = ({ deskKind, daySlot, slot, startTime, endTime }: { deskKind: ResourceKind; daySlot?: unknown; slot?: unknown; startTime?: unknown; endTime?: unknown }): { ok: true; value: BookingWindowInput } | { ok: false; message: string } => {
  if (!isDaySlotKind(deskKind)) {
    const startMinute = parseTimeToMinute(startTime);
    const endMinute = parseTimeToMinute(endTime);
    if (startMinute === null || endMinute === null) {
      return { ok: false, message: 'Für Räume sind startTime und endTime im Format HH:MM erforderlich.' };
    }
    if (startMinute >= endMinute) {
      return { ok: false, message: 'endTime muss nach startTime liegen.' };
    }
    return { ok: true, value: { mode: 'time', startMinute, endMinute } };
  }

  const parsedDaySlot = parseDaySlot(daySlot) ?? bookingSlotToDaySlot(parseBookingSlot(slot ?? 'FULL_DAY'));
  if (!parsedDaySlot) {
    return { ok: false, message: 'Für diese Ressource ist daySlot=AM|PM|FULL erforderlich.' };
  }

  return { ok: true, value: { mode: 'day', daySlot: parsedDaySlot } };
};

const getRouteId = (value: string | string[] | undefined): string | null => {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
};


const getIdsFromQuery = (value: string | string[] | undefined): string[] => {
  const raw = Array.isArray(value) ? value.join(',') : value ?? '';
  return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
};

type PrismaScalarType = 'String' | 'Int' | 'Float' | 'Boolean' | 'DateTime' | 'Json' | 'Bytes' | 'BigInt';
type DbScalarField = {
  name: string;
  type: PrismaScalarType;
  isRequired: boolean;
  isId: boolean;
  hasDefaultValue: boolean;
  isUpdatedAt: boolean;
};
type DbTableMeta = {
  modelName: string;
  routeName: string;
  delegateKey: string;
  scalarFields: DbScalarField[];
};

type DbDelegate = {
  findMany: (args: { take: number; skip: number; orderBy: { createdAt: 'desc' } | { id: 'desc' }; where?: Record<string, unknown> }) => Promise<unknown[]>;
  count: (args?: { where?: Record<string, unknown> }) => Promise<number>;
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  delete: (args: { where: { id: string } }) => Promise<unknown>;
  deleteMany: (args?: { where?: Record<string, unknown> }) => Promise<{ count: number }>;
};

const toRouteName = (modelName: string): string => modelName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
const toDelegateKey = (modelName: string): string => `${modelName.charAt(0).toLowerCase()}${modelName.slice(1)}`;

const DB_TABLES: DbTableMeta[] = Prisma.dmmf.datamodel.models.map((model) => ({
  modelName: model.name,
  routeName: toRouteName(model.name),
  delegateKey: toDelegateKey(model.name),
  scalarFields: model.fields
    .filter((field): field is typeof field & { type: PrismaScalarType } => field.kind === 'scalar')
    .map((field) => ({
      name: field.name,
      type: field.type,
      isRequired: Boolean(field.isRequired),
      isId: Boolean(field.isId),
      hasDefaultValue: Boolean(field.hasDefaultValue),
      isUpdatedAt: Boolean(field.isUpdatedAt)
    }))
}));

const DB_TABLES_BY_ROUTE = new Map(DB_TABLES.map((table) => [table.routeName, table]));

const getDbTableMeta = (table: string): DbTableMeta | null => DB_TABLES_BY_ROUTE.get(table) ?? null;

const getDbDelegate = (meta: DbTableMeta): DbDelegate | null => {
  const delegates = prisma as unknown as Record<string, DbDelegate | undefined>;
  return delegates[meta.delegateKey] ?? null;
};

const parseDbFieldValue = (field: DbScalarField, raw: unknown): unknown => {
  if (raw === null) {
    if (field.isRequired) {
      throw new Error(`Field \"${field.name}\" ist erforderlich.`);
    }
    return null;
  }

  switch (field.type) {
    case 'String':
      if (typeof raw !== 'string') throw new Error(`Field \"${field.name}\" muss ein String sein.`);
      return raw;
    case 'Boolean':
      if (typeof raw !== 'boolean') throw new Error(`Field \"${field.name}\" muss true/false sein.`);
      return raw;
    case 'Int': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new Error(`Field \"${field.name}\" muss eine ganze Zahl sein.`);
      return raw;
    }
    case 'Float':
      if (typeof raw !== 'number') throw new Error(`Field \"${field.name}\" muss eine Zahl sein.`);
      return raw;
    case 'DateTime': {
      if (typeof raw !== 'string') throw new Error(`Field \"${field.name}\" muss ein ISO-Datum sein.`);
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw new Error(`Field \"${field.name}\" enthält kein gültiges Datum.`);
      return parsed;
    }
    case 'Json':
      return raw;
    case 'BigInt': {
      if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
      if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw);
      throw new Error(`Field \"${field.name}\" muss eine BigInt-kompatible Zahl sein.`);
    }
    case 'Bytes': {
      if (typeof raw !== 'string') throw new Error(`Field \"${field.name}\" muss als Base64-String gesendet werden.`);
      return Buffer.from(raw, 'base64');
    }
    default:
      return raw;
  }
};

const parseDbPayload = (meta: DbTableMeta, payload: unknown, mode: 'create' | 'update'): Record<string, unknown> => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Payload muss ein Objekt sein.');
  }

  const record = payload as Record<string, unknown>;
  const editableFields = meta.scalarFields.filter((field) => !field.isId && !field.isUpdatedAt);
  const parsedData: Record<string, unknown> = {};

  for (const field of editableFields) {
    if (!(field.name in record)) continue;
    parsedData[field.name] = parseDbFieldValue(field, record[field.name]);
  }

  if (mode === 'create') {
    for (const field of editableFields) {
      if (field.name in parsedData) continue;
      if (!field.isRequired || field.hasDefaultValue) continue;
      throw new Error(`Field \"${field.name}\" ist erforderlich.`);
    }
  }

  return parsedData;
};

const sendConflict = (res: express.Response, message: string, details: Record<string, unknown>) => {
  res.status(409).json({
    error: 'conflict',
    message,
    details
  });
};

const normalizeEmail = (value: string): string => value.trim().toLowerCase();
const hashPassword = async (value: string): Promise<string> => bcrypt.hash(value, PASSWORD_SALT_ROUNDS);

type BookingTx = Prisma.TransactionClient;
type BookingIdentity = { normalizedEmail: string; userKey: string; entraOid: string | null; emailAliases: string[] };
type BookingWithDeskContext = Prisma.BookingGetPayload<{ include: { desk: { select: { name: true; kind: true } } } }>;
type BookingWithCreator = Prisma.BookingGetPayload<{ include: { createdByEmployee: { select: { id: true; displayName: true; email: true } } } }>;
type CreatorSummary = { id: string; displayName: string; email: string };

const resolveCreatedBySummary = (params: {
  createdBy: { id: string; displayName: string | null; email: string } | null;
  fallbackUser?: CreatorSummary | null;
}): CreatorSummary => {
  if (params.createdBy) {
    return {
      id: params.createdBy.id,
      displayName: params.createdBy.displayName?.trim() || params.createdBy.email,
      email: params.createdBy.email
    };
  }

  if (params.fallbackUser) {
    return params.fallbackUser;
  }

  return {
    id: 'legacy-missing-created-by',
    displayName: 'Unbekannt',
    email: ''
  };
};

const bookingUserKeyForDate = (userKey: string, date: Date): string => `booking:user:${userKey}:date:${toISODateOnly(date)}`;
const bookingDeskKeyForDate = (deskId: string, date: Date): string => `booking:desk:${deskId}:date:${toISODateOnly(date)}`;

const acquireBookingLock = async (tx: BookingTx, key: string) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
};

const findBookingIdentity = async (userEmail: string): Promise<BookingIdentity> => {
  const normalizedEmail = normalizeEmail(userEmail);
  const employee = await prisma.employee.findUnique({ where: { email: normalizedEmail }, select: { entraOid: true } });
  const entraOid = employee?.entraOid ?? null;
  const aliasRows = entraOid
    ? await prisma.employee.findMany({ where: { entraOid }, select: { email: true } })
    : [];
  const emailAliases = Array.from(new Set([normalizedEmail, ...aliasRows.map((row) => normalizeEmail(row.email))]));
  return {
    normalizedEmail,
    userKey: entraOid ?? normalizedEmail,
    entraOid,
    emailAliases
  };
};


const requireActorEmployee = async (req: express.Request): Promise<{ id: string; displayName: string; email: string; role: EmployeeRole }> => {
  if (!req.authUser) {
    const error = new Error('Authentication required');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }

  if (AUTH_BYPASS_ENABLED && req.authUser.source === 'local' && !req.authSession?.employeeId) {
    return {
      id: req.authUser.id,
      displayName: req.authUser.displayName,
      email: req.authUser.email,
      role: req.authUser.role
    };
  }

  const normalizedEmail = normalizeEmail(req.authUser.email);
  const employee = req.authSession?.employeeId
    ? await prisma.employee.findUnique({ where: { id: req.authSession.employeeId }, select: { id: true, displayName: true, email: true, role: true, isActive: true } })
    : await prisma.employee.findUnique({ where: { email: normalizedEmail }, select: { id: true, displayName: true, email: true, role: true, isActive: true } });

  if (!employee || !employee.isActive) {
    if (AUTH_BYPASS_ENABLED && req.authUser.source === 'local') {
      return {
        id: req.authUser.id,
        displayName: req.authUser.displayName,
        email: req.authUser.email,
        role: req.authUser.role
      };
    }

    const error = new Error('No active employee mapped to current session');
    (error as Error & { status?: number }).status = 403;
    throw error;
  }

  return {
    id: employee.id,
    displayName: employee.displayName,
    email: employee.email,
    role: employee.role === 'admin' ? 'admin' : 'user'
  };
};

const findOverlappingBooking = async (tx: BookingTx, params: {
  identity: BookingIdentity;
  date: Date;
  targetKind: ResourceKind;
  window: BookingWindowInput;
}): Promise<BookingWithDeskContext | null> => {
  const matches = await tx.booking.findMany({
    where: {
      date: params.date,
      userEmail: { in: params.identity.emailAliases },
      desk: { kind: params.targetKind }
    },
    include: { desk: { select: { name: true, kind: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });

  return matches.find((booking) => {
    const bookingWindow = bookingToWindow(booking);
    return bookingWindow ? windowsOverlap(params.window, bookingWindow) : false;
  }) ?? null;
};

const findDuplicateUserDateGroups = (bookings: Array<{ id: string; userEmail: string | null; date: Date; desk: { kind: ResourceKind } }>) => {
  const counts = new Map<string, number>();
  for (const booking of bookings) {
    if (!booking.userEmail) continue;
    const key = `${normalizeEmail(booking.userEmail)}|${toISODateOnly(booking.date)}|${booking.desk.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).filter(([, count]) => count > 1);
};

const mapBookingResponse = (booking: BookingWithCreator & { employeeId?: string | null }) => ({
  id: booking.id,
  deskId: booking.deskId,
  userEmail: booking.userEmail,
  employeeId: booking.employeeId ?? null,
  bookedFor: booking.bookedFor,
  guestName: booking.guestName,
  createdByEmployee: booking.createdByEmployee,
  createdBy: booking.createdByEmployee,
  createdByUserId: booking.createdByEmployeeId,
  createdByEmployeeId: booking.createdByEmployeeId,
  date: booking.date,
  daySlot: booking.daySlot,
  slot: booking.slot,
  startTime: minuteToHHMM(booking.startMinute ?? (booking.startTime ? booking.startTime.getUTCHours() * 60 + booking.startTime.getUTCMinutes() : null)) ?? null,
  endTime: minuteToHHMM(booking.endMinute ?? (booking.endTime ? booking.endTime.getUTCHours() * 60 + booking.endTime.getUTCMinutes() : null)) ?? null,
  createdAt: booking.createdAt
});

const getEmployeePhotoUrl = (employeeId: string): string => `/employees/${employeeId}/photo`;

const getGraphAppAccessToken = async (): Promise<string | null> => {
  if (!ENTRA_TENANT_ID || !ENTRA_CLIENT_ID || !ENTRA_CLIENT_SECRET) {
    return null;
  }

  if (graphAppTokenCache && graphAppTokenCache.expiresAt > Date.now() + 60_000) {
    return graphAppTokenCache.token;
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`;
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ENTRA_CLIENT_ID,
      client_secret: ENTRA_CLIENT_SECRET,
      scope: GRAPH_APP_SCOPE
    })
  });

  if (!response.ok) {
    return null;
  }

  const tokenPayload = await response.json() as { access_token?: string; expires_in?: number };
  if (!tokenPayload.access_token) {
    return null;
  }

  graphAppTokenCache = {
    token: tokenPayload.access_token,
    expiresAt: Date.now() + ((tokenPayload.expires_in ?? 300) * 1000)
  };

  return graphAppTokenCache.token;
};

type GraphPhotoPayload = { photoData: Buffer; photoType: string; photoEtag: string };

const readGraphPhoto = async (url: string, accessToken: string): Promise<GraphPhotoPayload | null> => {
  const graphResponse = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (graphResponse.status === 404) {
    return null;
  }

  if (!graphResponse.ok) {
    throw new Error('GRAPH_PHOTO_FETCH_FAILED');
  }

  const photoData = Buffer.from(await graphResponse.arrayBuffer());
  const photoType = graphResponse.headers.get('content-type') ?? 'image/jpeg';
  const photoEtag = crypto.createHash('sha256').update(photoData).digest('hex');
  return { photoData, photoType, photoEtag };
};

const saveEmployeePhoto = async (employeeId: string, photo: GraphPhotoPayload | null) => {
  const existingEmployee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, photoEtag: true, photoUrl: true, photoData: true }
  });

  if (!existingEmployee) return;

  if (!photo) {
    if (!existingEmployee.photoData && existingEmployee.photoUrl) {
      return;
    }

    await prisma.employee.update({
      where: { id: employeeId },
      data: {
        photoUrl: getEmployeePhotoUrl(employeeId),
        photoEtag: null,
        photoData: null,
        photoType: null,
        photoUpdatedAt: null
      }
    });
    return;
  }

  if (existingEmployee.photoEtag === photo.photoEtag && existingEmployee.photoUrl) {
    return;
  }

  await prisma.employee.update({
    where: { id: employeeId },
    data: {
      photoUrl: getEmployeePhotoUrl(employeeId),
      photoEtag: photo.photoEtag,
      photoData: new Uint8Array(photo.photoData),
      photoType: photo.photoType,
      photoUpdatedAt: new Date()
    }
  });
};

const syncEmployeePhotoFromGraph = async (employeeId: string, graphAccessToken: string) => {
  try {
    const photo = await readGraphPhoto('https://graph.microsoft.com/v1.0/me/photo/$value', graphAccessToken);
    await saveEmployeePhoto(employeeId, photo);
  } catch {
    return;
  }
};

const syncEmployeePhotoWithAppToken = async (employee: { id: string; entraOid: string | null; email: string }) => {
  const appAccessToken = await getGraphAppAccessToken();
  if (!appAccessToken) return;

  const graphUserIdentifier = employee.entraOid ?? employee.email;

  try {
    const encodedUserId = encodeURIComponent(graphUserIdentifier);
    const photo = await readGraphPhoto(`https://graph.microsoft.com/v1.0/users/${encodedUserId}/photo/$value`, appAccessToken);
    await saveEmployeePhoto(employee.id, photo);
  } catch {
    return;
  }
};

const isValidEmailInput = (value: string): boolean => value.includes('@');

const isValidEmployeeRole = (value: string): value is EmployeeRole => value === 'admin' || value === 'user';

const employeeSelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true,
  photoUrl: true
} satisfies Prisma.EmployeeSelect;

const getActiveEmployeesByEmail = async (emails: string[]) => {
  if (emails.length === 0) {
    return new Map<string, { id: string; displayName: string; photoUrl: string | null }>();
  }

  const uniqueEmails = Array.from(new Set(emails.map((email) => normalizeEmail(email))));
  const employees = await prisma.employee.findMany({
    where: {
      isActive: true,
      email: { in: uniqueEmails }
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      photoUrl: true
    }
  });

  return new Map(employees.map((employee) => [employee.email, { id: employee.id, displayName: employee.displayName, photoUrl: employee.photoUrl ?? getEmployeePhotoUrl(employee.id) }]));
};

const getDeskContext = async (deskId: string) => prisma.desk.findUnique({
  where: { id: deskId },
  select: { id: true, name: true, floorplanId: true, kind: true, allowSeriesOverride: true, floorplan: { select: { defaultAllowSeries: true } } }
});

const resolveEffectiveAllowSeries = (desk: { allowSeriesOverride: boolean | null; floorplan?: { defaultAllowSeries: boolean } | null }): boolean => (
  desk.allowSeriesOverride ?? desk.floorplan?.defaultAllowSeries ?? true
);


app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', title: APP_TITLE });
  } catch {
    res.status(500).json({ status: 'error', title: APP_TITLE });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', title: APP_TITLE });
  } catch {
    res.status(500).json({ status: 'error', title: APP_TITLE });
  }
});

app.use(attachAuthUser);
app.use(requireAllowedMutationOrigin);

const ensureBreakglassAdmin = async () => {
  console.log('BREAKGLASS_ENV_PRESENT', { emailSet: Boolean(ADMIN_EMAIL), passwordSet: Boolean(ADMIN_PASSWORD) });

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const existingBreakglass = await prisma.user.findUnique({
      where: { email: ADMIN_EMAIL },
      select: { id: true }
    });
    const breakglassHash = await hashPassword(ADMIN_PASSWORD);
    await prisma.user.upsert({
      where: { email: ADMIN_EMAIL },
      update: {
        displayName: 'Breakglass Admin',
        role: 'admin',
        isActive: true,
        passwordHash: breakglassHash
      },
      create: {
        email: ADMIN_EMAIL,
        displayName: 'Breakglass Admin',
        role: 'admin',
        isActive: true,
        passwordHash: breakglassHash
      }
    });
    console.log('BREAKGLASS_UPSERT', { email: ADMIN_EMAIL, created: !existingBreakglass, role: 'admin' });
  } else {
    console.warn('Breakglass skipped: ADMIN_EMAIL or ADMIN_PASSWORD missing');
  }
};

const backfillLegacyBookingCreators = async () => {
  const bookingsMissingCreatorEmail = await prisma.booking.findMany({
    where: { createdByEmail: null },
    select: { id: true, userEmail: true }
  });

  if (bookingsMissingCreatorEmail.length === 0) return;

  let updatedCount = 0;
  for (const booking of bookingsMissingCreatorEmail) {
    if (!booking.userEmail) continue;
    await prisma.booking.update({ where: { id: booking.id }, data: { createdByEmail: normalizeEmail(booking.userEmail) } });
    updatedCount += 1;
  }

  if (updatedCount > 0) {
    console.info('BOOKING_CREATOR_EMAIL_BACKFILL_DONE', { total: bookingsMissingCreatorEmail.length, updated: updatedCount });
  }
};

const upsertEmployeeFromEntraLogin = async (claims: { oid: string; tid: string; email: string; name: string }) => {
  const normalizedEmail = normalizeEmail(claims.email);

  return prisma.$transaction(async (tx) => {
    let employee = await tx.employee.findFirst({
      where: { OR: [{ entraOid: claims.oid }, { email: normalizedEmail }] }
    });

    if (!employee) {
      employee = await tx.employee.create({
        data: {
          email: normalizedEmail,
          displayName: claims.name,
          role: 'user',
          isActive: true,
          entraOid: claims.oid,
          tenantId: claims.tid,
          lastLoginAt: new Date()
        }
      });
    } else {
      employee = await tx.employee.update({
        where: { id: employee.id },
        data: {
          email: normalizedEmail,
          displayName: claims.name,
          entraOid: claims.oid,
          tenantId: claims.tid,
          lastLoginAt: new Date(),
          isActive: true
        }
      });
    }

    await tx.employee.update({
      where: { id: employee.id },
      data: {
        photoUrl: employee.photoUrl ?? getEmployeePhotoUrl(employee.id)
      }
    });

    return {
      id: employee.id,
      email: employee.email,
      displayName: employee.displayName,
      role: employee.role,
      employeeId: employee.id
    };
  });
};

app.get('/auth/entra/start', async (_req, res) => {
  if (!isEntraConfigured()) {
    res.status(500).json({ code: 'ENTRA_NOT_CONFIGURED', message: 'Microsoft Entra login is not configured' });
    return;
  }

  const metadata = await loadOidcMetadata();
  const { state, nonce } = await createOidcState();
  const query = new URLSearchParams({
    client_id: ENTRA_CLIENT_ID as string,
    response_type: 'code',
    redirect_uri: ENTRA_REDIRECT_URI as string,
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state,
    nonce
  });

  res.redirect(302, `${metadata.authorization_endpoint}?${query.toString()}`);
});

app.get('/auth/entra/callback', async (req, res) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const stateParam = typeof req.query.state === 'string' ? req.query.state : '';
    const oidcState = await consumeOidcState(stateParam);
    if (!code || !oidcState) {
      res.status(401).json({ code: 'OIDC_VALIDATION_FAILED', message: 'Invalid callback parameters' });
      return;
    }

    const metadata = await loadOidcMetadata();
    const tokenResponse = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: ENTRA_CLIENT_ID as string,
        client_secret: ENTRA_CLIENT_SECRET as string,
        code,
        grant_type: 'authorization_code',
        redirect_uri: ENTRA_REDIRECT_URI as string,
        scope: 'openid profile email User.Read'
      })
    });

    if (!tokenResponse.ok) {
      res.status(401).json({ code: 'OIDC_VALIDATION_FAILED', message: 'Token exchange failed' });
      return;
    }

    const tokenPayload = await tokenResponse.json() as { id_token?: string; access_token?: string; expires_in?: number };
    if (!tokenPayload.id_token) {
      res.status(401).json({ code: 'OIDC_VALIDATION_FAILED', message: 'id_token is missing' });
      return;
    }

    const claims = await verifyIdToken(tokenPayload.id_token, oidcState.nonce);
    const tid = typeof claims.tid === 'string' ? claims.tid : null;
    const oid = typeof claims.oid === 'string' ? claims.oid : null;

    if (!tid || tid !== ENTRA_TENANT_ID) {
      res.status(403).json({ code: 'TENANT_NOT_ALLOWED', message: 'Tenant not allowed' });
      return;
    }

    const emailClaim = claims.email ?? claims.preferred_username;
    const email = typeof emailClaim === 'string' ? normalizeEmail(emailClaim) : null;
    const name = typeof claims.name === 'string' ? claims.name.trim() : '';

    if (!oid || !email || !name) {
      res.status(401).json({ code: 'OIDC_VALIDATION_FAILED', message: 'Required claims are missing' });
      return;
    }

    const user = await upsertEmployeeFromEntraLogin({ oid, tid, email, name });
    if (tokenPayload.access_token) {
      await syncEmployeePhotoFromGraph(user.employeeId, tokenPayload.access_token);
    } else {
      await syncEmployeePhotoWithAppToken({ id: user.employeeId, entraOid: oid, email });
    }
    const session = await createSession({ employeeId: user.employeeId }, {
      graphAccessToken: tokenPayload.access_token,
      graphTokenExpiresInSeconds: tokenPayload.expires_in
    });
    applySessionCookies(res, session);

    res.redirect(302, ENTRA_POST_LOGIN_REDIRECT);
  } catch (error) {
    const requestId = req.requestId ?? 'unknown';
    console.error('ENTRA_CALLBACK_ERROR', { requestId, errorName: error instanceof Error ? error.name : 'UnknownError' });
    res.status(401).json({ code: 'OIDC_VALIDATION_FAILED', message: 'Entra callback validation failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  const requestId = req.requestId ?? 'unknown';

  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'email and password are required' });
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    console.log('LOGIN_ATTEMPT', { requestId, email: normalizedEmail, ip: req.ip });

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, displayName: true, passwordHash: true, role: true, isActive: true }
    });

    if (!user || !user.isActive) {
      console.log('LOGIN_FAIL_USER_NOT_FOUND', { requestId, email: normalizedEmail });
      res.status(401).json({ code: 'USER_NOT_FOUND', message: 'Invalid credentials' });
      return;
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      console.log('LOGIN_FAIL_PASSWORD_MISMATCH', { requestId, userId: user.id });
      res.status(401).json({ code: 'PASSWORD_MISMATCH', message: 'Invalid credentials' });
      return;
    }

    const session = await createSession({ userId: user.id });
    applySessionCookies(res, session);

    const employee = await prisma.employee.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, entraOid: true }
    });
    if (employee) {
      await syncEmployeePhotoWithAppToken(employee);
      await prisma.employee.update({
        where: { id: employee.id },
        data: { lastLoginAt: new Date() }
      });
    }

    console.log('LOGIN_SUCCESS', { requestId, userId: user.id, role: user.role });

    res.status(200).json({
      user: {
        id: user.id,
        name: user.displayName,
        email: user.email,
        displayName: user.displayName,
        role: user.role === 'admin' ? 'admin' : 'user'
      }
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const errorMessage = error instanceof Error ? error.message : 'Unexpected login error';
    console.error('LOGIN_ERROR', { requestId, errorName, errorMessage });
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Login failed' });
  }
});

app.post('/auth/logout', async (req, res) => {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  await destroySession(sessionId);
  clearSessionCookies(res);
  res.status(204).send();
});

app.get('/auth/me', (req, res) => {
  const requestId = req.requestId ?? 'unknown';
  if (!isProd) {
    const hasSessionCookie = Boolean(parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]);
    console.log('ME_DEBUG', {
      requestId,
      hasSessionCookie,
      hasSession: Boolean(req.authSession),
      hasAuthUser: Boolean(req.authUser),
      authFailureReason: req.authFailureReason ?? null
    });
  }

  if (!req.authUser) {
    res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    return;
  }

  if (req.authSession) {
    applySessionCookies(res, req.authSession);
  }

  res.status(200).json({
    user: {
      id: req.authUser.id,
      name: req.authUser.displayName,
      email: req.authUser.email,
      displayName: req.authUser.displayName,
      role: req.authUser.role
    }
  });
});

app.get('/auth/csrf', (req, res) => {
  res.status(204).send();
});

app.get('/user/me/photo', requireAuthenticated, async (req, res) => {
  const graphAccessToken = req.authSession?.graphAccessToken;
  const graphTokenExpiresAt = req.authSession?.graphTokenExpiresAt;

  if (!graphAccessToken || !graphTokenExpiresAt || graphTokenExpiresAt.getTime() <= Date.now()) {
    res.status(204).send();
    return;
  }

  const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
    headers: {
      authorization: `Bearer ${graphAccessToken}`
    }
  });

  if (graphResponse.status === 404) {
    res.status(204).send();
    return;
  }

  if (!graphResponse.ok) {
    res.status(502).json({ code: 'GRAPH_PHOTO_FETCH_FAILED', message: 'Could not load profile photo from Graph' });
    return;
  }

  const contentType = graphResponse.headers.get('content-type') ?? 'image/jpeg';
  const photoBuffer = Buffer.from(await graphResponse.arrayBuffer());
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Content-Type', contentType);
  res.status(200).send(photoBuffer);
});

app.use(requireAuthenticated);


app.get('/admin/db/tables', requireAdmin, (_req, res) => {
  res.json(DB_TABLES.map((table) => ({
    name: table.routeName,
    model: table.modelName,
    columns: table.scalarFields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.isRequired,
      id: field.isId,
      hasDefaultValue: field.hasDefaultValue
    }))
  })));
});

app.get('/admin/db/:table/rows', requireAdmin, async (req, res) => {
  const tableName = getRouteId(req.params.table);
  const table = tableName ? getDbTableMeta(tableName) : null;
  if (!table) {
    res.status(404).json({ error: 'not_found', message: 'Tabelle nicht gefunden' });
    return;
  }

  const delegate = getDbDelegate(table);
  if (!delegate) {
    res.status(500).json({ error: 'config_error', message: 'Delegate nicht verfügbar' });
    return;
  }

  const rawLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
  const rawOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
  const limit = Number.isNaN(rawLimit) ? 100 : Math.max(1, Math.min(250, rawLimit));
  const offset = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
  const orderBy = table.scalarFields.some((field) => field.name === 'createdAt') ? { createdAt: 'desc' as const } : { id: 'desc' as const };
  const restrictedUserFilter = table.modelName === 'User' && ADMIN_EMAIL
    ? { email: ADMIN_EMAIL }
    : undefined;

  const [rows, total] = await Promise.all([
    delegate.findMany({ take: limit, skip: offset, orderBy, where: restrictedUserFilter }),
    delegate.count({ where: restrictedUserFilter })
  ]);

  res.json({ rows, total, limit, offset });
});

app.post('/admin/db/:table/rows', requireAdmin, async (req, res) => {
  const tableName = getRouteId(req.params.table);
  const table = tableName ? getDbTableMeta(tableName) : null;
  if (!table) {
    res.status(404).json({ error: 'not_found', message: 'Tabelle nicht gefunden' });
    return;
  }

  const delegate = getDbDelegate(table);
  if (!delegate) {
    res.status(500).json({ error: 'config_error', message: 'Delegate nicht verfügbar' });
    return;
  }

  try {
    const data = parseDbPayload(table, req.body?.data ?? {}, 'create');
    const created = await delegate.create({ data });
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: 'validation', message: error instanceof Error ? error.message : 'Ungültige Daten' });
  }
});

app.delete('/admin/db/:table/rows', requireAdmin, async (req, res) => {
  const tableName = getRouteId(req.params.table);
  const table = tableName ? getDbTableMeta(tableName) : null;

  if (!table) {
    res.status(404).json({ error: 'not_found', message: 'Tabelle nicht gefunden' });
    return;
  }

  const delegate = getDbDelegate(table);
  if (!delegate) {
    res.status(500).json({ error: 'config_error', message: 'Delegate nicht verfügbar' });
    return;
  }

  try {
    const result = await delegate.deleteMany({});
    res.status(200).json({ deleted: result.count });
  } catch (error) {
    res.status(400).json({ error: 'validation', message: error instanceof Error ? error.message : 'Tabelle leeren fehlgeschlagen' });
  }
});

app.patch('/admin/db/:table/rows/:id', requireAdmin, async (req, res) => {
  const tableName = getRouteId(req.params.table);
  const table = tableName ? getDbTableMeta(tableName) : null;
  const id = getRouteId(req.params.id);

  if (!table || !id) {
    res.status(404).json({ error: 'not_found', message: 'Datensatz nicht gefunden' });
    return;
  }

  const delegate = getDbDelegate(table);
  if (!delegate) {
    res.status(500).json({ error: 'config_error', message: 'Delegate nicht verfügbar' });
    return;
  }

  try {
    const data = parseDbPayload(table, req.body?.data ?? {}, 'update');
    const updated = await delegate.update({ where: { id }, data });
    res.json(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Datensatz nicht gefunden' });
      return;
    }

    res.status(400).json({ error: 'validation', message: error instanceof Error ? error.message : 'Ungültige Daten' });
  }
});

app.delete('/admin/db/:table/rows/:id', requireAdmin, async (req, res) => {
  const tableName = getRouteId(req.params.table);
  const table = tableName ? getDbTableMeta(tableName) : null;
  const id = getRouteId(req.params.id);

  if (!table || !id) {
    res.status(404).json({ error: 'not_found', message: 'Datensatz nicht gefunden' });
    return;
  }

  const delegate = getDbDelegate(table);
  if (!delegate) {
    res.status(500).json({ error: 'config_error', message: 'Delegate nicht verfügbar' });
    return;
  }

  try {
    await delegate.delete({ where: { id } });
    res.status(204).end();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Datensatz nicht gefunden' });
      return;
    }

    res.status(400).json({ error: 'validation', message: error instanceof Error ? error.message : 'Löschen fehlgeschlagen' });
  }
});

app.get('/admin/employees', requireAdmin, async (_req, res) => {
  const employees = await prisma.employee.findMany({
    select: employeeSelect,
    orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }, { email: 'asc' }]
  });

  res.status(200).json(employees.map((employee) => ({
    ...employee,
    photoUrl: employee.photoUrl ?? getEmployeePhotoUrl(employee.id)
  })));
});

app.get('/employees', async (_req, res) => {
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: {
      id: true,
      email: true,
      displayName: true,
      photoUrl: true
    },
    orderBy: [{ displayName: 'asc' }, { email: 'asc' }]
  });

  res.status(200).json(employees.map((employee) => ({
    ...employee,
    photoUrl: employee.photoUrl ?? getEmployeePhotoUrl(employee.id)
  })));
});


app.get('/employees/:id/photo', async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const employee = await prisma.employee.findUnique({
    where: { id },
    select: { photoData: true, photoType: true, photoUpdatedAt: true }
  });

  if (!employee?.photoData) {
    res.status(404).json({ error: 'not_found', message: 'Employee photo not found' });
    return;
  }

  res.setHeader('Cache-Control', 'private, max-age=300');
  if (employee.photoUpdatedAt) {
    res.setHeader('Last-Modified', employee.photoUpdatedAt.toUTCString());
  }
  res.setHeader('Content-Type', employee.photoType ?? 'image/jpeg');
  res.status(200).send(Buffer.from(employee.photoData));
});

app.post('/admin/employees', requireAdmin, async (req, res) => {
  const { email, displayName, role } = req.body as { email?: string; displayName?: string; role?: string };

  if (!email || !displayName) {
    res.status(400).json({ error: 'validation', message: 'email and displayName are required' });
    return;
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedDisplayName = displayName.trim();

  if (!isValidEmailInput(normalizedEmail)) {
    res.status(400).json({ error: 'validation', message: 'email must contain @' });
    return;
  }

  if (!normalizedDisplayName) {
    res.status(400).json({ error: 'validation', message: 'displayName must not be empty' });
    return;
  }

  if (typeof role !== 'undefined' && !isValidEmployeeRole(role)) {
    res.status(400).json({ error: 'validation', message: 'role must be admin or user' });
    return;
  }

  try {
    const employee = await prisma.$transaction(async (tx) => {
      const createdEmployee = await tx.employee.create({
        data: {
          email: normalizedEmail,
          displayName: normalizedDisplayName,
          role: role ?? 'user',
          photoUrl: null
        },
        select: employeeSelect
      });

      await tx.employee.update({
        where: { id: createdEmployee.id },
        data: { photoUrl: getEmployeePhotoUrl(createdEmployee.id) }
      });

      return { id: createdEmployee.id, email: normalizedEmail, entraOid: null };
    });

    await syncEmployeePhotoWithAppToken(employee);

    const createdEmployee = await prisma.employee.findUnique({ where: { id: employee.id }, select: employeeSelect });
    if (!createdEmployee) {
      res.status(500).json({ error: 'server_error', message: 'Employee could not be loaded after create' });
      return;
    }

    res.status(201).json({ ...createdEmployee, photoUrl: createdEmployee.photoUrl ?? getEmployeePhotoUrl(createdEmployee.id) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      sendConflict(res, 'Employee email already exists', { email: normalizedEmail });
      return;
    }

    throw error;
  }
});

app.patch('/admin/employees/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { displayName, isActive, role } = req.body as { displayName?: string; isActive?: boolean; role?: string };
  if (typeof displayName === 'undefined' && typeof isActive === 'undefined' && typeof role === 'undefined') {
    res.status(400).json({ error: 'validation', message: 'displayName, isActive or role must be provided' });
    return;
  }

  const trimmedDisplayName = typeof displayName === 'string' ? displayName.trim() : undefined;
  if (typeof trimmedDisplayName === 'string' && !trimmedDisplayName) {
    res.status(400).json({ error: 'validation', message: 'displayName must not be empty' });
    return;
  }

  if (typeof role !== 'undefined' && !isValidEmployeeRole(role)) {
    res.status(400).json({ error: 'validation', message: 'role must be admin or user' });
    return;
  }

  const existing = await prisma.employee.findUnique({
    where: { id },
    select: { id: true, role: true, email: true, isActive: true }
  });

  if (!existing) {
    res.status(404).json({ error: 'not_found', message: 'Employee not found' });
    return;
  }

  const nextRole = role ?? existing.role;
  const nextIsActive = typeof isActive === 'boolean' ? isActive : existing.isActive;

  if (existing.role === 'admin' && (nextRole !== 'admin' || !nextIsActive)) {
    const adminCount = await prisma.employee.count({ where: { role: 'admin', isActive: true } });
    if (adminCount <= 1) {
      res.status(409).json({ error: 'conflict', message: 'Mindestens ein Admin muss erhalten bleiben.' });
      return;
    }
  }

  try {
    const updated = await prisma.employee.update({
      where: { id },
      data: {
        ...(typeof trimmedDisplayName === 'string' ? { displayName: trimmedDisplayName } : {}),
        ...(typeof isActive === 'boolean' ? { isActive } : {}),
        ...(typeof role === 'string' ? { role } : {})
      },
      select: employeeSelect
    });

    if (req.authUser && req.authUser.email === existing.email) {
      req.authUser.role = updated.role as EmployeeRole;
      req.authUser.isActive = updated.isActive;
    }

    res.status(200).json(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Employee not found' });
      return;
    }

    throw error;
  }
});

app.delete('/admin/employees/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const employee = await prisma.employee.findUnique({ where: { id }, select: { role: true, isActive: true } });
  if (!employee) {
    res.status(404).json({ error: 'not_found', message: 'Employee not found' });
    return;
  }

  if (employee.role === 'admin' && employee.isActive) {
    const adminCount = await prisma.employee.count({ where: { role: 'admin', isActive: true } });
    if (adminCount <= 1) {
      res.status(409).json({ error: 'conflict', message: 'Mindestens ein Admin muss erhalten bleiben.' });
      return;
    }
  }

  try {
    const updated = await prisma.employee.update({
      where: { id },
      data: { isActive: false },
      select: employeeSelect
    });

    res.status(200).json(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Employee not found' });
      return;
    }

    throw error;
  }
});

app.get('/me', (req, res) => {
  res.status(200).json({
    id: req.authUser?.id,
    email: req.authUser?.email,
    displayName: req.authUser?.displayName,
    role: req.authUser?.role
  });
});

app.get('/floorplans', async (_req, res) => {
  const floorplans = await prisma.floorplan.findMany({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] });
  res.status(200).json(floorplans);
});

app.get('/floorplans/:id', async (req, res) => {
  const floorplan = await prisma.floorplan.findUnique({ where: { id: req.params.id } });

  if (!floorplan) {
    res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
    return;
  }

  res.status(200).json(floorplan);
});

app.get('/floorplans/:id/desks', async (req, res) => {
  const desks = await prisma.desk.findMany({
    where: { floorplanId: req.params.id },
    include: { floorplan: { select: { defaultAllowSeries: true } } },
    orderBy: { createdAt: 'asc' }
  });

  res.status(200).json(desks.map((desk) => ({
    id: desk.id,
    floorplanId: desk.floorplanId,
    name: desk.name,
    kind: desk.kind,
    allowSeriesOverride: desk.allowSeriesOverride,
    effectiveAllowSeries: resolveEffectiveAllowSeries(desk),
    position: desk.x === null || desk.y === null ? null : { x: desk.x, y: desk.y },
    x: desk.x,
    y: desk.y,
    createdAt: desk.createdAt
  })));
});

app.post('/bookings', async (req, res) => {
  const { deskId, userEmail, date, replaceExisting, overwrite, daySlot, slot, startTime, endTime, bookedFor, guestName } = req.body as {
    deskId?: string;
    userEmail?: string;
    date?: string;
    replaceExisting?: boolean;
    overwrite?: boolean;
    daySlot?: string;
    slot?: string;
    startTime?: string;
    endTime?: string;
    bookedFor?: string;
    guestName?: string;
  };

  if (!deskId || !date) {
    res.status(400).json({ error: 'validation', message: 'deskId and date are required' });
    return;
  }

  const currentUser = req.authUser;
  if (!currentUser) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return;
  }

  let actorEmployee;
  try {
    actorEmployee = await requireActorEmployee(req);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 403;
    res.status(status).json({ error: status === 401 ? 'unauthorized' : 'forbidden', message: (error as Error).message });
    return;
  }

  const bookingMode = parseBookedFor(bookedFor);
  const normalizedGuestName = normalizeGuestName(guestName);
  if (bookingMode === 'GUEST') {
    if (!normalizedGuestName || normalizedGuestName.length < 2) {
      res.status(400).json({ error: 'validation', message: 'guestName muss mindestens 2 Zeichen haben.' });
      return;
    }
  } else if (normalizedGuestName) {
    res.status(400).json({ error: 'validation', message: 'guestName is only allowed for guest bookings' });
    return;
  }


  const parsedDate = toDateOnly(date);
  if (!parsedDate) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const desk = await getDeskContext(deskId);
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const bookingWindowResult = resolveBookingWindow({ deskKind: desk.kind, daySlot, slot, startTime, endTime });
  if (!bookingWindowResult.ok) {
    res.status(400).json({ error: 'validation', message: bookingWindowResult.message });
    return;
  }

  const bookingWindow = bookingWindowResult.value;
  const shouldReplaceExisting = overwrite ?? replaceExisting ?? false;
  const identity = bookingMode === 'SELF' ? await findBookingIdentity(userEmail ?? actorEmployee.email) : null;

  const result = await prisma.$transaction(async (tx) => {
    if (identity) {
      await acquireBookingLock(tx, bookingUserKeyForDate(identity.userKey, parsedDate));
    }
    await acquireBookingLock(tx, bookingDeskKeyForDate(deskId, parsedDate));

    const conflictingUserBookings = identity
      ? (await tx.booking.findMany({
        where: {
          date: parsedDate,
          bookedFor: 'SELF',
          userEmail: { in: identity.emailAliases },
          desk: { kind: desk.kind }
        },
        include: { desk: { select: { name: true, kind: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      })).filter((booking) => {
        const candidateWindow = bookingToWindow(booking);
        return candidateWindow ? windowsOverlap(bookingWindow, candidateWindow) : false;
      })
      : [];

    const existingUserBooking = conflictingUserBookings[0] ?? null;
    if (identity && existingUserBooking && existingUserBooking.deskId !== deskId && !shouldReplaceExisting) {
      return {
        kind: 'conflict' as const,
        message: 'User already has a booking for this date and resource kind',
        details: {
          conflictKind: desk.kind,
          existingBooking: {
            id: existingUserBooking.id,
            deskId: existingUserBooking.deskId,
            deskName: existingUserBooking.desk?.name ?? existingUserBooking.deskId,
            daySlot: existingUserBooking.daySlot ?? bookingSlotToDaySlot(existingUserBooking.slot)
          },
          requestedDesk: { id: deskId, name: desk.name },
          date
        }
      };
    }

    const ignoredBookingIds = new Set<string>(conflictingUserBookings.map((booking) => booking.id));
    const deskBookings = await tx.booking.findMany({ where: { deskId, date: parsedDate }, orderBy: [{ createdAt: 'desc' }] });
    const targetDeskBooking = deskBookings.find((candidate) => {
      const candidateWindow = bookingToWindow(candidate);
      return candidateWindow ? windowsOverlap(bookingWindow, candidateWindow) && !ignoredBookingIds.has(candidate.id) : false;
    });

    if (targetDeskBooking) {
      return { kind: 'conflict' as const, message: 'Desk is already booked for this Zeitraum', details: { deskId, date, bookingId: targetDeskBooking.id } };
    }

    if (identity && bookingWindow.mode === 'day' && shouldReplaceExisting && conflictingUserBookings.length > 0) {
      await tx.booking.deleteMany({ where: { id: { in: conflictingUserBookings.map((booking) => booking.id) } } });
    }

    const created = await tx.booking.create({
      data: {
        deskId,
        userEmail: bookingMode === 'SELF' ? (identity?.normalizedEmail ?? actorEmployee.email) : null,
        employeeId: bookingMode === 'SELF' ? actorEmployee.id : null,
        bookedFor: bookingMode,
        guestName: bookingMode === 'GUEST' ? normalizedGuestName : null,
        createdByEmployeeId: actorEmployee.id,
        createdByUserId: currentUser.source === 'local' ? currentUser.id : null,
        createdByEmail: currentUser.email,
        date: parsedDate,
        daySlot: bookingWindow.mode === 'day' ? bookingWindow.daySlot : null,
        startTime: bookingWindow.mode === 'time' ? new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate(), Math.floor(bookingWindow.startMinute / 60), bookingWindow.startMinute % 60, 0, 0)) : null,
        endTime: bookingWindow.mode === 'time' ? new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate(), Math.floor(bookingWindow.endMinute / 60), bookingWindow.endMinute % 60, 0, 0)) : null,
        slot: bookingWindow.mode === 'day' ? (bookingWindow.daySlot === 'FULL' ? 'FULL_DAY' : bookingWindow.daySlot === 'AM' ? 'MORNING' : 'AFTERNOON') : 'CUSTOM',
        startMinute: bookingWindow.mode === 'time' ? bookingWindow.startMinute : null,
        endMinute: bookingWindow.mode === 'time' ? bookingWindow.endMinute : null
      },
      include: { createdByEmployee: { select: { id: true, displayName: true, email: true } } }
    });

    if (process.env.DEBUG === '1') {
      console.info('BOOKING_CREATE', {
        actorEmployeeId: actorEmployee.id,
        bookedFor: bookingMode,
        employeeId: created.employeeId ?? null,
        guestName: bookingMode === 'GUEST' ? normalizedGuestName : null,
        createdByEmployeeId: created.createdByEmployeeId
      });
    }

    return { kind: 'ok' as const, status: 201, booking: created };
  });

  if (result.kind === 'conflict') {
    sendConflict(res, result.message, result.details);
    return;
  }

  res.status(result.status).json(mapBookingResponse(result.booking));
});


app.put('/bookings/:id', async (req, res) => {
  const id = getRouteId(req.params.id);
  const { deskId, date, daySlot, slot, startTime, endTime, guestName } = req.body as { deskId?: string; date?: string; daySlot?: string; slot?: string; startTime?: string; endTime?: string; guestName?: string };
  if (!id || !deskId) {
    res.status(400).json({ error: 'validation', message: 'id and deskId are required' });
    return;
  }

  if (date) {
    const parsedDate = toDateOnly(date);
    if (!parsedDate) {
      res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
      return;
    }
  }

  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'not_found', message: 'Booking not found' });
    return;
  }

  let actorEmployee;
  try {
    actorEmployee = await requireActorEmployee(req);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 403;
    res.status(status).json({ error: status === 401 ? 'unauthorized' : 'forbidden', message: (error as Error).message });
    return;
  }

  if (req.authUser?.role !== 'admin' && !canCancelBooking({ booking: { bookedFor: existing.bookedFor, employeeId: existing.employeeId, createdByEmployeeId: existing.createdByEmployeeId }, actor: { employeeId: actorEmployee.id, email: req.authUser?.email ?? '', isAdmin: false } })) {
    res.status(403).json({ error: 'forbidden', message: 'Cannot update booking of another user' });
    return;
  }

  const nextDesk = await getDeskContext(deskId);
  if (!nextDesk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const bookingDate = date ? toDateOnly(date) ?? existing.date : existing.date;

  if (date && bookingDate.getTime() !== existing.date.getTime()) {
    res.status(400).json({ error: 'validation', message: 'date does not match existing booking date' });
    return;
  }

  const bookingWindowResult = resolveBookingWindow({ deskKind: nextDesk.kind, daySlot: typeof daySlot === 'undefined' ? (existing.daySlot ?? bookingSlotToDaySlot(existing.slot)) : daySlot, slot: typeof slot === 'undefined' ? existing.slot : slot, startTime: typeof startTime === 'undefined' ? minuteToHHMM(existing.startMinute) : startTime, endTime: typeof endTime === 'undefined' ? minuteToHHMM(existing.endMinute) : endTime });
  if (!bookingWindowResult.ok) {
    res.status(400).json({ error: 'validation', message: bookingWindowResult.message });
    return;
  }

  const nextGuestName = existing.bookedFor === 'GUEST' ? normalizeGuestName(typeof guestName === 'undefined' ? existing.guestName : guestName) : null;
  if (existing.bookedFor === 'GUEST' && (!nextGuestName || nextGuestName.length < 2)) {
    res.status(400).json({ error: 'validation', message: 'guestName muss mindestens 2 Zeichen haben.' });
    return;
  }

  if (existing.bookedFor === 'SELF' && !actorEmployee.id) {
    res.status(400).json({ error: 'validation', message: 'employeeId is required for SELF bookings' });
    return;
  }

  const nextWindow = bookingWindowResult.value;
  const conflicts = await prisma.booking.findMany({ where: { deskId, date: bookingDate, id: { not: existing.id } }, orderBy: [{ createdAt: 'desc' }] });
  const conflict = conflicts.find((candidate) => {
    const candidateWindow = bookingToWindow(candidate);
    return candidateWindow ? windowsOverlap(nextWindow, candidateWindow) : false;
  });
  if (conflict) {
    sendConflict(res, 'Desk is already booked for this date', { deskId, date: toISODateOnly(bookingDate), bookingId: conflict.id });
    return;
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: {
      deskId,
      employeeId: existing.bookedFor === 'SELF' ? actorEmployee.id : null,
      guestName: nextGuestName,
      createdByEmployeeId: actorEmployee.id,
      daySlot: nextWindow.mode === 'day' ? nextWindow.daySlot : null,
      startMinute: nextWindow.mode === 'time' ? nextWindow.startMinute : null,
      endMinute: nextWindow.mode === 'time' ? nextWindow.endMinute : null,
      startTime: nextWindow.mode === 'time' ? new Date(Date.UTC(bookingDate.getUTCFullYear(), bookingDate.getUTCMonth(), bookingDate.getUTCDate(), Math.floor(nextWindow.startMinute / 60), nextWindow.startMinute % 60, 0, 0)) : null,
      endTime: nextWindow.mode === 'time' ? new Date(Date.UTC(bookingDate.getUTCFullYear(), bookingDate.getUTCMonth(), bookingDate.getUTCDate(), Math.floor(nextWindow.endMinute / 60), nextWindow.endMinute % 60, 0, 0)) : null,
      slot: nextWindow.mode === 'day' ? (nextWindow.daySlot === 'FULL' ? 'FULL_DAY' : nextWindow.daySlot === 'AM' ? 'MORNING' : 'AFTERNOON') : 'CUSTOM'
    },
    include: { createdByEmployee: { select: { id: true, displayName: true, email: true } } }
  });
  res.status(200).json(mapBookingResponse(updated));
});

app.delete('/bookings/:id', async (req, res) => {
  const requestId = req.requestId ?? 'unknown';
  const userId = req.authUser?.id ?? null;
  const id = getRouteId(req.params.id);

  if (!id) {
    console.warn('BOOKING_CANCEL', { requestId, userId, bookingId: null, resourceType: null, status: 400, error: 'id is required' });
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    const existing = await prisma.booking.findUnique({
      where: { id },
      include: { desk: { select: { kind: true } } }
    });
    if (!existing) {
      console.warn('BOOKING_CANCEL', { requestId, userId, bookingId: id, resourceType: null, status: 404, error: 'Booking not found' });
      res.status(404).json({ error: 'not_found', message: 'Booking not found' });
      return;
    }

    if (!req.authUser) {
      console.warn('BOOKING_CANCEL', { requestId, userId, bookingId: id, resourceType: existing.desk?.kind ?? null, status: 401, error: 'Authentication required' });
      res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
      return;
    }

    let actorEmployee;
    try {
      actorEmployee = await requireActorEmployee(req);
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 403;
      console.warn('BOOKING_CANCEL', { requestId, userId, bookingId: id, resourceType: existing.desk?.kind ?? null, status, error: (error as Error).message });
      res.status(status).json({ error: status === 401 ? 'unauthorized' : 'forbidden', message: (error as Error).message });
      return;
    }

    const allowed = canCancelBooking({
      booking: {
        bookedFor: existing.bookedFor,
        employeeId: existing.employeeId,
        createdByEmployeeId: existing.createdByEmployeeId
      },
      actor: {
        employeeId: actorEmployee.id,
        email: req.authUser.email,
        isAdmin: req.authUser.role === 'admin'
      }
    });

    if (process.env.DEBUG === '1') {
      console.info('CANCEL_AUTHZ_CHECK', {
        bookingId: id,
        bookedFor: existing.bookedFor,
        employeeId: existing.employeeId,
        createdByEmployeeId: existing.createdByEmployeeId,
        actorEmployeeId: actorEmployee.id,
        actorIsAdmin: req.authUser.role === 'admin',
        allowed
      });
    }

    if (!allowed) {
      console.warn('BOOKING_CANCEL', { requestId, userId, bookingId: id, resourceType: existing.desk?.kind ?? null, status: 403, error: 'Not allowed to cancel this booking' });
      res.status(403).json({ code: 'FORBIDDEN', message: 'Not allowed to cancel this booking' });
      return;
    }

    await prisma.booking.delete({ where: { id } });
    console.info('BOOKING_CANCEL', { requestId, userId, bookingId: id, resourceType: existing.desk?.kind ?? null, status: 200, error: null });
    res.status(200).json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unexpected booking cancel error';
    console.error('BOOKING_CANCEL', { requestId, userId, bookingId: id, resourceType: null, status: 500, error: errorMessage });
    res.status(500).json({ error: 'internal_error', message: 'Booking cancel failed' });
  }
});


app.post('/bookings/check-conflicts', async (req, res) => {
  const { deskId, userEmail, userId, start, end, weekdays, type, daySlot, startTime, endTime } = req.body as {
    deskId?: string;
    userEmail?: string;
    userId?: string;
    start?: string;
    end?: string;
    weekdays?: number[];
    type?: 'single' | 'range' | 'recurring';
    daySlot?: string;
    startTime?: string;
    endTime?: string;
  };

  if (!deskId || !userEmail || !start || !type) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail, start and type are required' });
    return;
  }

  const parsedStart = toDateOnly(start);
  const parsedEnd = toDateOnly(end ?? start);
  if (!parsedStart || !parsedEnd) {
    res.status(400).json({ error: 'validation', message: 'start/end must be in YYYY-MM-DD format' });
    return;
  }

  const desk = await getDeskContext(deskId);
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const requestWindowResult = resolveBookingWindow({ deskKind: desk.kind, daySlot, startTime, endTime });
  if (!requestWindowResult.ok) {
    res.status(400).json({ error: 'validation', message: requestWindowResult.message });
    return;
  }

  const targetDates = datesInRange(parsedStart, parsedEnd).filter((date) => {
    if (type === 'single') return toISODateOnly(date) === toISODateOnly(parsedStart);
    if (type === 'recurring') return Boolean(weekdays?.includes(date.getUTCDay()));
    return true;
  });

  if (targetDates.length === 0) {
    res.status(200).json({ hasConflicts: false, conflictDates: [], conflictSlots: [], conflictBookingIds: [], conflictResourceLabels: [] });
    return;
  }

  const identity = await findBookingIdentity(userEmail);
  const conflicts = await prisma.booking.findMany({
    where: {
      date: { in: targetDates },
      userEmail: { in: identity.emailAliases },
      desk: { kind: desk.kind }
    },
    include: { desk: { select: { name: true, kind: true } } },
    orderBy: [{ date: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
  });

  const byDate = new Map<string, { slots: DaySlot[]; resourceLabels: string[]; bookingIds: string[] }>();
  for (const booking of conflicts) {
    const bookingWindow = bookingToWindow(booking);
    if (!bookingWindow || !windowsOverlap(requestWindowResult.value, bookingWindow)) continue;
    const dateKey = toISODateOnly(booking.date);
    const item = byDate.get(dateKey) ?? { slots: [], resourceLabels: [], bookingIds: [] };
    const normalizedSlot = booking.daySlot ?? bookingSlotToDaySlot(booking.slot);
    if (normalizedSlot && !item.slots.includes(normalizedSlot)) item.slots.push(normalizedSlot);
    const deskName = booking.desk?.name ?? booking.deskId;
    if (!item.resourceLabels.includes(deskName)) item.resourceLabels.push(deskName);
    item.bookingIds.push(booking.id);
    byDate.set(dateKey, item);
  }

  const conflictDates = Array.from(byDate.keys());
  res.status(200).json({
    hasConflicts: conflictDates.length > 0,
    conflictDates,
    conflictBookingIds: conflictDates.flatMap((dateKey) => byDate.get(dateKey)?.bookingIds ?? []),
    conflictResourceLabels: conflictDates.flatMap((dateKey) => byDate.get(dateKey)?.resourceLabels ?? []),
    conflictSlots: conflictDates.map((dateISO) => ({ dateISO, slots: byDate.get(dateISO)?.slots ?? [], resourceLabels: byDate.get(dateISO)?.resourceLabels ?? [] })),
    conflictKind: desk.kind,
    userId
  });
});

app.post('/bookings/range', async (req, res) => {
  const { deskId, userEmail, from, to, weekdaysOnly, replaceExisting, overrideExisting } = req.body as {
    deskId?: string;
    userEmail?: string;
    from?: string;
    to?: string;
    weekdaysOnly?: boolean;
    replaceExisting?: boolean;
    overrideExisting?: boolean;
  };

  if (!deskId || !userEmail || !from || !to) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail, from and to are required' });
    return;
  }

  const parsedFrom = toDateOnly(from);
  const parsedTo = toDateOnly(to);
  if (!parsedFrom || !parsedTo) {
    res.status(400).json({ error: 'validation', message: 'from/to must be in YYYY-MM-DD format' });
    return;
  }

  if (parsedTo < parsedFrom) {
    res.status(400).json({ error: 'validation', message: 'to must be on or after from' });
    return;
  }

  const desk = await prisma.desk.findUnique({ where: { id: deskId }, select: { id: true, name: true, kind: true, floorplanId: true } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const includeWeekdaysOnly = weekdaysOnly !== false;
  const shouldOverrideExisting = overrideExisting ?? replaceExisting ?? false;
  const targetDates = datesInRange(parsedFrom, parsedTo).filter((date) => {
    if (!includeWeekdaysOnly) {
      return true;
    }

    const day = date.getUTCDay();
    return day >= 1 && day <= 5;
  });

  if (targetDates.length === 0) {
    res.status(201).json({ createdCount: 0, updatedCount: 0, skippedCount: 0, skippedDates: [], dates: [] });
    return;
  }

  const identity = await findBookingIdentity(userEmail);

  let actorEmployee;
  try {
    actorEmployee = await requireActorEmployee(req);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 403;
    res.status(status).json({ error: status === 401 ? 'unauthorized' : 'forbidden', message: (error as Error).message });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const lockKeys = Array.from(new Set(targetDates.flatMap((targetDate) => [
      bookingUserKeyForDate(identity.userKey, targetDate),
      bookingDeskKeyForDate(deskId, targetDate)
    ]))).sort();

    for (const lockKey of lockKeys) {
      await acquireBookingLock(tx, lockKey);
    }

    const existingUserBookings = await tx.booking.findMany({
      where: {
        date: { in: targetDates },
        userEmail: { in: identity.emailAliases },
        desk: { kind: desk.kind }
      },
      include: { desk: { select: { name: true, kind: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
    });

    const existingByDate = new Map<string, BookingWithDeskContext>();
    const duplicateIdsToDelete: string[] = [];
    for (const booking of existingUserBookings) {
      const key = toISODateOnly(booking.date);
      if (!existingByDate.has(key)) {
        existingByDate.set(key, booking);
      } else {
        duplicateIdsToDelete.push(booking.id);
      }
    }

    if (duplicateIdsToDelete.length > 0) {
      await tx.booking.deleteMany({ where: { id: { in: duplicateIdsToDelete } } });
    }

    const keepIds = Array.from(existingByDate.values()).map((booking) => booking.id);
    const deskSingleConflicts = await tx.booking.findMany({
      where: {
        deskId,
        date: { in: targetDates },
        id: { notIn: keepIds },
        userEmail: { notIn: identity.emailAliases }
      },
      orderBy: { date: 'asc' }
    });

    if (deskSingleConflicts.length > 0) {
      const conflictDates = deskSingleConflicts.map((booking) => toISODateOnly(booking.date));
      return {
        kind: 'conflict' as const,
        message: 'Range booking has conflicting dates',
        details: {
          deskId,
          from,
          to,
          weekdaysOnly: includeWeekdaysOnly,
          conflictingDates: conflictDates,
          conflictingDatesPreview: conflictDates.slice(0, 10)
        }
      };
    }

    let createdCount = 0;
    let updatedCount = 0;
    const skippedDates: string[] = [];
    const updatedDates: string[] = [];

    for (const targetDate of targetDates) {
      const dateKey = toISODateOnly(targetDate);
      const existing = existingByDate.get(dateKey);
      if (existing) {
        if (!shouldOverrideExisting) {
          skippedDates.push(dateKey);
          continue;
        }

        if (existing.deskId !== deskId || existing.userEmail !== identity.normalizedEmail) {
          await tx.booking.update({
            where: { id: existing.id },
            data: { deskId, userEmail: identity.normalizedEmail, employeeId: actorEmployee.id, bookedFor: 'SELF', guestName: null, createdByEmployeeId: actorEmployee.id }
          });
        }

        updatedCount += 1;
        updatedDates.push(dateKey);
        continue;
      }

      await tx.booking.create({ data: { deskId, userEmail: identity.normalizedEmail, employeeId: actorEmployee.id, createdByEmployeeId: actorEmployee.id, createdByUserId: req.authUser?.source === 'local' ? req.authUser.id : null, createdByEmail: req.authUser?.email ?? null, bookedFor: 'SELF', guestName: null, date: targetDate } });
      createdCount += 1;
    }

    return {
      kind: 'ok' as const,
      payload: {
        createdCount,
        updatedCount,
        skippedCount: skippedDates.length,
        skippedDates,
        updatedDates,
        dates: targetDates.map((targetDate) => toISODateOnly(targetDate))
      }
    };
  });

  if (result.kind === 'conflict') {
    sendConflict(res, result.message, result.details);
    return;
  }

  res.status(201).json(result.payload);
});

app.get('/bookings', async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const where: Prisma.BookingWhereInput = {};

  if (date) {
    const parsedDate = toDateOnly(date);
    if (!parsedDate) {
      res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
      return;
    }
    where.date = parsedDate;
  }

  if (from || to) {
    where.date = {};

    if (from) {
      const fromDate = toDateOnly(from);
      if (!fromDate) {
        res.status(400).json({ error: 'validation', message: 'from must be in YYYY-MM-DD format' });
        return;
      }
      where.date.gte = fromDate;
    }

    if (to) {
      const toDate = toDateOnly(to);
      if (!toDate) {
        res.status(400).json({ error: 'validation', message: 'to must be in YYYY-MM-DD format' });
        return;
      }
      where.date.lte = toDate;
    }
  }

  if (floorplanId) {
    where.desk = { floorplanId };
  }

  if (req.authUser?.role !== 'admin' && req.authUser?.id) {
    try {
      const actorEmployee = await requireActorEmployee(req);
      where.createdByEmployeeId = actorEmployee.id;
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 403;
      res.status(status).json({ error: status === 401 ? 'unauthorized' : 'forbidden', message: (error as Error).message });
      return;
    }
  }

  const bookings = await prisma.booking.findMany({
    where,
    select: {
      id: true,
      deskId: true,
      userEmail: true,
      employeeId: true,
      bookedFor: true,
      guestName: true,
      createdByEmployeeId: true,
      creatorUnknown: true,
      date: true,
      daySlot: true,
      startTime: true,
      endTime: true,
      slot: true,
      startMinute: true,
      endMinute: true,
      createdAt: true,
      createdByEmployee: { select: { id: true, displayName: true, email: true } },
      desk: { select: { kind: true } }
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
  });

  if (!isProd) {
    const duplicateGroups = findDuplicateUserDateGroups(bookings);
    if (duplicateGroups.length > 0) {
      console.warn('BOOKINGS_DUPLICATES_DETECTED', { count: duplicateGroups.length, sample: duplicateGroups.slice(0, 10) });
    }
  }

  const employeesByEmail = await getActiveEmployeesByEmail(bookings.map((booking) => booking.userEmail).filter((email): email is string => Boolean(email)));
  const usersByEmail = new Map((await prisma.user.findMany({
    where: {
      email: {
        in: Array.from(new Set(bookings.map((booking) => booking.userEmail).filter((email): email is string => Boolean(email)).map((email) => normalizeEmail(email))))
      }
    },
    select: { id: true, email: true, displayName: true }
  })).map((user) => [normalizeEmail(user.email), user]));
  const enrichedBookings = bookings.map((booking) => ({
    ...(function () {
      const normalizedUserEmail = booking.userEmail ? normalizeEmail(booking.userEmail) : null;
      const employee = normalizedUserEmail ? employeesByEmail.get(normalizedUserEmail) : undefined;
      const appUser = normalizedUserEmail ? usersByEmail.get(normalizedUserEmail) : undefined;
      const fallbackUser = booking.userEmail
        ? {
          id: appUser?.id ?? booking.createdByEmployeeId ?? `legacy-${normalizedUserEmail}`,
          displayName: employee?.displayName ?? appUser?.displayName ?? booking.userEmail,
          email: booking.userEmail
        }
        : null;
      const createdBy = resolveCreatedBySummary({
        createdBy: booking.createdByEmployee,
        fallbackUser
      });

      return {
        createdBy,
        createdByUserId: createdBy.id,
    createdByEmployeeId: booking.createdByEmployeeId,
        user: booking.bookedFor === 'SELF' && fallbackUser ? fallbackUser : null,
        userDisplayName: employee?.displayName,
        employeeId: booking.employeeId ?? employee?.id,
        userPhotoUrl: employee?.photoUrl ?? undefined
      };
    })(),
    id: booking.id,
    deskId: booking.deskId,
    userEmail: booking.userEmail,
    bookedFor: booking.bookedFor,
    guestName: booking.guestName,
    date: booking.date,
    createdAt: booking.createdAt,
    daySlot: booking.daySlot ?? bookingSlotToDaySlot(booking.slot),
    slot: booking.slot,
    startTime: minuteToHHMM(booking.startMinute ?? (booking.startTime ? booking.startTime.getUTCHours() * 60 + booking.startTime.getUTCMinutes() : null)),
    endTime: minuteToHHMM(booking.endMinute ?? (booking.endTime ? booking.endTime.getUTCHours() * 60 + booking.endTime.getUTCMinutes() : null))
  }));

  res.status(200).json(enrichedBookings);
});

app.get('/occupancy', async (req, res) => {
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;

  if (!floorplanId || !date) {
    res.status(400).json({ error: 'validation', message: 'floorplanId and date are required' });
    return;
  }

  const parsedDate = toDateOnly(date);
  if (!parsedDate) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const desks = await prisma.desk.findMany({
    where: { floorplanId },
    include: { floorplan: { select: { defaultAllowSeries: true } } },
    orderBy: { createdAt: 'asc' }
  });

  const deskIds = desks.map((desk) => desk.id);
  const bookingsInRange = await getBookingsForDateRange(parsedDate, parsedDate, floorplanId);
  const singleBookings = bookingsInRange.singleBookings
    .filter((booking) => deskIds.includes(booking.deskId))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  const recurringOccurrenceKeys = new Set(bookingsInRange.occurrences.map((occurrence) => `${occurrence.resourceId}|${occurrence.date}|${occurrence.createdByEmployeeId}`));
  const employeesByEmail = await getActiveEmployeesByEmail(singleBookings.map((booking) => booking.userEmail).filter((email): email is string => Boolean(email)));
  const bookingsByDeskId = new Map<string, typeof singleBookings>();
  for (const booking of singleBookings) {
    bookingsByDeskId.set(booking.deskId, [...(bookingsByDeskId.get(booking.deskId) ?? []), booking]);
  }

  const occupancyDesks = desks.map((desk) => {
    const deskBookings = bookingsByDeskId.get(desk.id) ?? [];
    const normalizedBookings = deskBookings.map((booking) => ({
      id: booking.id,
      userEmail: booking.userEmail,
      bookedFor: booking.bookedFor,
      guestName: booking.guestName,
      createdBy: booking.createdByEmployee,
      createdByUserId: booking.createdByEmployeeId,
      createdByEmployeeId: booking.createdByEmployeeId,
      creatorUnknown: booking.creatorUnknown,
      employeeId: booking.employeeId ?? (booking.userEmail ? employeesByEmail.get(normalizeEmail(booking.userEmail))?.id : undefined),
      userDisplayName: booking.userEmail ? employeesByEmail.get(normalizeEmail(booking.userEmail))?.displayName : undefined,
      userPhotoUrl: booking.userEmail ? (employeesByEmail.get(normalizeEmail(booking.userEmail))?.photoUrl ?? undefined) : undefined,
      deskName: desk.name,
      deskId: desk.id,
      type: recurringOccurrenceKeys.has(`${booking.deskId}|${toISODateOnly(booking.date)}|${booking.createdByEmployeeId}`) ? 'recurring' as const : 'single' as const,
      daySlot: booking.daySlot ?? bookingSlotToDaySlot(booking.slot),
      slot: booking.slot,
      startTime: minuteToHHMM(booking.startMinute ?? (booking.startTime ? booking.startTime.getUTCHours() * 60 + booking.startTime.getUTCMinutes() : null)),
      endTime: minuteToHHMM(booking.endMinute ?? (booking.endTime ? booking.endTime.getUTCHours() * 60 + booking.endTime.getUTCMinutes() : null))
    }));

    const primaryBooking = normalizedBookings[0] ?? null;
    return {
      id: desk.id,
      name: desk.name,
      kind: desk.kind,
      position: desk.x === null || desk.y === null ? null : { x: desk.x, y: desk.y },
      x: desk.x,
      y: desk.y,
      allowSeriesOverride: desk.allowSeriesOverride,
      effectiveAllowSeries: resolveEffectiveAllowSeries(desk),
      status: normalizedBookings.length > 0 ? 'booked' as const : 'free' as const,
      booking: primaryBooking,
      bookings: normalizedBookings
    };
  });

  const uniquePeopleByEmail = new Map<string, { email: string; userEmail: string; displayName?: string; photoUrl?: string; deskName?: string; deskId?: string }>();
  occupancyDesks.forEach((desk) => {
    for (const booking of desk.bookings ?? []) {
      if (booking.bookedFor !== 'SELF') {
        continue;
      }
      const userEmail = booking.userEmail ?? '';
      const normalizedEmail = normalizeEmail(userEmail);
      if (!userEmail || uniquePeopleByEmail.has(normalizedEmail)) {
        continue;
      }

      uniquePeopleByEmail.set(normalizedEmail, {
        email: userEmail,
        userEmail,
        displayName: employeesByEmail.get(normalizedEmail)?.displayName,
        photoUrl: employeesByEmail.get(normalizeEmail(userEmail))?.photoUrl ?? undefined,
        deskName: desk.name,
        deskId: desk.id
      });
    }
  });

  const people = Array.from(uniquePeopleByEmail.values())
    .sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email, 'de'));

  res.status(200).json({
    date: toISODateOnly(parsedDate),
    floorplanId,
    desks: occupancyDesks,
    people
  });
});

app.get('/resources/:resourceId/availability', async (req, res) => {
  const requestId = req.requestId ?? 'unknown';
  const resourceId = typeof req.params.resourceId === 'string' ? req.params.resourceId : '';
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;

  if (!resourceId || !date) {
    res.status(400).json({ error: 'validation', message: 'resourceId and date are required' });
    return;
  }

  const parsedDate = toDateOnly(date);
  if (!parsedDate) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const { dayStartUtc, dayEndUtc } = getBerlinDayBoundsUtc(parsedDate);

  const desk = await prisma.desk.findUnique({
    where: { id: resourceId },
    select: { id: true, name: true, kind: true, floorplanId: true }
  });

  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Resource not found' });
    return;
  }

  if (desk.kind !== 'RAUM') {
    res.status(400).json({ error: 'validation', message: 'Availability endpoint is only available for room resources' });
    return;
  }

  const bookings = await prisma.booking.findMany({
    where: {
      deskId: resourceId,
      startTime: { lt: dayEndUtc },
      endTime: { gt: dayStartUtc }
    },
    include: { createdByEmployee: { select: { id: true, displayName: true, email: true } } },
    orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }]
  });
  const bookingsInRange = await getBookingsForDateRange(parsedDate, parsedDate, desk.floorplanId);
  const recurringOccurrenceKeys = new Set(bookingsInRange.occurrences.map((occurrence) => `${occurrence.resourceId}|${occurrence.date}|${occurrence.createdByEmployeeId}`));

  console.info('ROOM_AVAILABILITY_QUERY', {
    requestId,
    resourceId,
    date,
    dayStart: dayStartUtc.toISOString(),
    dayEnd: dayEndUtc.toISOString(),
    bookingsCount: bookings.length
  });

  const employeesByEmail = await getActiveEmployeesByEmail(bookings.map((booking) => booking.userEmail).filter((email): email is string => Boolean(email)));
  const usersByEmail = new Map((await prisma.user.findMany({
    where: {
      email: {
        in: Array.from(new Set(bookings.map((booking) => booking.userEmail).filter((email): email is string => Boolean(email)).map((email) => normalizeEmail(email))))
      }
    },
    select: { id: true, email: true }
  })).map((user) => [normalizeEmail(user.email), user.id]));
  const mappedBookings = bookings.map((booking) => ({
    id: booking.id,
    resourceId,
    resourceType: desk.kind,
    start: booking.startTime?.toISOString() ?? null,
    end: booking.endTime?.toISOString() ?? null,
    startTime: minuteToHHMM(booking.startMinute ?? (booking.startTime ? booking.startTime.getUTCHours() * 60 + booking.startTime.getUTCMinutes() : null)),
    endTime: minuteToHHMM(booking.endMinute ?? (booking.endTime ? booking.endTime.getUTCHours() * 60 + booking.endTime.getUTCMinutes() : null)),
    bookedFor: booking.bookedFor,
    guestName: booking.guestName,
    employeeId: booking.employeeId ?? null,
    userId: booking.employeeId ?? null,
    createdBy: booking.createdByEmployee,
    createdByUserId: booking.createdByEmployeeId,
    createdByEmployeeId: booking.createdByEmployeeId,
    creatorUnknown: booking.creatorUnknown,
    type: recurringOccurrenceKeys.has(`${resourceId}|${toISODateOnly(booking.date)}|${booking.createdByEmployeeId}`) ? 'recurring' : 'single',
    user: {
      email: booking.userEmail,
      name: booking.bookedFor === 'GUEST'
        ? `Gast: ${booking.guestName ?? 'Unbekannt'}`
        : (booking.userEmail ? (employeesByEmail.get(normalizeEmail(booking.userEmail))?.displayName ?? booking.userEmail) : 'Unbekannt')
    }
  }));

  const occupiedIntervals = mergeTimeIntervals(bookings.flatMap((booking) => {
    const start = booking.startMinute ?? (booking.startTime ? booking.startTime.getUTCHours() * 60 + booking.startTime.getUTCMinutes() : null);
    const end = booking.endMinute ?? (booking.endTime ? booking.endTime.getUTCHours() * 60 + booking.endTime.getUTCMinutes() : null);
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return [];
    return [{ start, end }];
  }));

  const freeWindows = toFreeTimeWindows(occupiedIntervals).map((window) => ({
    startTime: minuteToHHMM(window.start),
    endTime: minuteToHHMM(window.end),
    label: `${minuteToHHMM(window.start)} – ${minuteToHHMM(window.end)}`
  }));

  res.status(200).json({
    requestId,
    resource: {
      id: desk.id,
      name: desk.name,
      type: desk.kind
    },
    date,
    dayStart: dayStartUtc.toISOString(),
    dayEnd: dayEndUtc.toISOString(),
    bookings: mappedBookings,
    freeWindows
  });
});

const recurringToWindow = (recurring: { period: DaySlot | null; startTime: string | null; endTime: string | null }, resourceKind: ResourceKind): BookingWindowInput | null => {
  if (resourceKind === 'RAUM') {
    if (!recurring.startTime || !recurring.endTime) return null;
    const startMinute = parseTimeToMinute(recurring.startTime);
    const endMinute = parseTimeToMinute(recurring.endTime);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) return null;
    return { mode: 'time', startMinute, endMinute };
  }

  if (!recurring.period) return null;
  return { mode: 'day', daySlot: recurring.period };
};

const getBookingsForDateRange = async (from: Date, to: Date, floorplanId: string) => {
  const [singleBookings, recurringBookings] = await Promise.all([
    prisma.booking.findMany({
      where: {
        date: { gte: from, lte: to },
        desk: { floorplanId }
      },
      include: {
        desk: { select: { id: true, kind: true, floorplanId: true } },
        createdByEmployee: { select: { id: true, displayName: true, email: true } }
      }
    }),
    prisma.recurringBooking.findMany({
      where: {
        resource: { floorplanId },
        validFrom: { lte: to },
        OR: [{ validTo: null }, { validTo: { gte: from } }]
      },
      include: {
        resource: { select: { id: true, kind: true, floorplanId: true } },
        createdByEmployee: { select: { id: true, displayName: true, email: true } }
      }
    })
  ]);

  const occurrences = recurringBookings.flatMap((recurring) => {
    const end = recurring.validTo && recurring.validTo < to ? recurring.validTo : to;
    const rangeStart = recurring.validFrom > from ? recurring.validFrom : from;
    const window = recurringToWindow(recurring, recurring.resource.kind);
    if (!window) return [];

    return datesInRange(rangeStart, end)
      .filter((dateValue) => dateValue.getUTCDay() === recurring.weekday)
      .map((dateValue) => ({
        recurringId: recurring.id,
        resourceId: recurring.resourceId,
        date: toISODateOnly(dateValue),
        bookedFor: recurring.bookedFor,
        guestName: recurring.guestName,
        createdByEmployeeId: recurring.createdByEmployeeId,
        window
      }));
  });

  return { singleBookings, recurringBookings, occurrences };
};

app.post('/recurring-bookings', async (req, res) => {
  const { resourceId, weekdays, weekday, validFrom, validTo, bookedFor, guestName, period, startTime, endTime } = req.body as {
    resourceId?: string;
    weekdays?: number[];
    weekday?: number;
    validFrom?: string;
    validTo?: string | null;
    bookedFor?: BookedFor;
    guestName?: string | null;
    period?: DaySlot | null;
    startTime?: string | null;
    endTime?: string | null;
  };

  const normalizedWeekdays = Array.from(new Set(Array.isArray(weekdays) ? weekdays : (typeof weekday === 'number' ? [weekday] : [])));
  if (!resourceId || normalizedWeekdays.length === 0 || !validFrom) {
    res.status(400).json({ error: 'validation', message: 'resourceId, weekday(s) and validFrom are required' });
    return;
  }

  if (normalizedWeekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    res.status(400).json({ error: 'validation', message: 'weekday values must be between 0 and 6' });
    return;
  }

  const parsedValidFrom = toDateOnly(validFrom);
  const parsedValidTo = validTo ? toDateOnly(validTo) : null;
  if (!parsedValidFrom || (validTo && !parsedValidTo)) {
    res.status(400).json({ error: 'validation', message: 'validFrom/validTo must be in YYYY-MM-DD format' });
    return;
  }

  if (parsedValidTo && parsedValidTo < parsedValidFrom) {
    res.status(400).json({ error: 'validation', message: 'validTo must be on or after validFrom' });
    return;
  }

  let actorEmployee;
  try {
    actorEmployee = await requireActorEmployee(req);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 403;
    res.status(status).json({ error: status === 401 ? 'unauthorized' : 'forbidden', message: (error as Error).message });
    return;
  }

  const resource = await prisma.desk.findUnique({ where: { id: resourceId }, include: { floorplan: { select: { defaultAllowSeries: true } } } });
  if (!resource) {
    res.status(404).json({ error: 'not_found', message: 'Resource not found' });
    return;
  }

  if (!resolveEffectiveAllowSeries(resource)) {
    res.status(409).json({ error: 'conflict', message: 'Recurring bookings are not allowed for this resource' });
    return;
  }

  const normalizedBookedFor: BookedFor = bookedFor === 'GUEST' ? 'GUEST' : 'SELF';
  const normalizedGuestName = normalizedBookedFor === 'GUEST' ? (guestName?.trim() ?? '') : '';
  if (normalizedBookedFor === 'GUEST' && normalizedGuestName.length < 2) {
    res.status(400).json({ error: 'validation', message: 'guestName is required for guest bookings' });
    return;
  }

  const normalizedPeriod = period ? parseDaySlot(period) : null;
  if (resource.kind === 'RAUM') {
    if (normalizedPeriod) {
      res.status(400).json({ error: 'validation', message: 'period must be null for room recurrences' });
      return;
    }
    if (!startTime || !endTime || parseTimeToMinute(startTime) === null || parseTimeToMinute(endTime) === null || parseTimeToMinute(endTime)! <= parseTimeToMinute(startTime)!) {
      res.status(400).json({ error: 'validation', message: 'startTime and endTime are required for room recurrences' });
      return;
    }
  } else {
    if (!normalizedPeriod) {
      res.status(400).json({ error: 'validation', message: 'period is required for non-room recurrences' });
      return;
    }
    if (startTime || endTime) {
      res.status(400).json({ error: 'validation', message: 'startTime/endTime must be null for non-room recurrences' });
      return;
    }
  }

  const effectiveValidTo = parsedValidTo ?? endOfCurrentYear();
  const targetDates = datesInRange(parsedValidFrom, effectiveValidTo).filter((dateValue) => normalizedWeekdays.includes(dateValue.getUTCDay()));
  const recurrenceWindow = recurringToWindow({ period: normalizedPeriod, startTime: startTime ?? null, endTime: endTime ?? null }, resource.kind);
  if (!recurrenceWindow) {
    res.status(400).json({ error: 'validation', message: 'Invalid recurring booking window' });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const conflicts = await tx.booking.findMany({
      where: { date: { in: targetDates }, deskId: resourceId },
      include: { desk: { select: { name: true, kind: true } } }
    });

    const conflictDates = Array.from(new Set(conflicts
      .filter((booking) => {
        const candidateWindow = bookingToWindow(booking);
        return candidateWindow ? windowsOverlap(recurrenceWindow, candidateWindow) : false;
      })
      .map((booking) => toISODateOnly(booking.date))));

    if (conflictDates.length > 0) {
      return {
        kind: 'conflict' as const,
        message: 'Recurring series conflicts with existing bookings',
        details: { resourceId, conflictDates }
      };
    }

    const createdBookings = await Promise.all(targetDates.map((targetDate) => tx.booking.create({
      data: {
        deskId: resourceId,
        userEmail: normalizedBookedFor === 'SELF' ? actorEmployee.email : null,
        bookedFor: normalizedBookedFor,
        guestName: normalizedBookedFor === 'GUEST' ? normalizedGuestName : null,
        createdByEmployeeId: actorEmployee.id,
        createdByUserId: req.authUser?.source === 'local' ? req.authUser.id : null,
        createdByEmail: req.authUser?.email ?? null,
        date: targetDate,
        daySlot: recurrenceWindow.mode === 'day' ? recurrenceWindow.daySlot : null,
        slot: recurrenceWindow.mode === 'day' ? (recurrenceWindow.daySlot === 'FULL' ? 'FULL_DAY' : recurrenceWindow.daySlot === 'AM' ? 'MORNING' : 'AFTERNOON') : 'CUSTOM',
        startMinute: recurrenceWindow.mode === 'time' ? recurrenceWindow.startMinute : null,
        endMinute: recurrenceWindow.mode === 'time' ? recurrenceWindow.endMinute : null,
        startTime: recurrenceWindow.mode === 'time' ? new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), Math.floor(recurrenceWindow.startMinute / 60), recurrenceWindow.startMinute % 60, 0, 0)) : null,
        endTime: recurrenceWindow.mode === 'time' ? new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), Math.floor(recurrenceWindow.endMinute / 60), recurrenceWindow.endMinute % 60, 0, 0)) : null
      }
    })));

    const recurringBookings = await Promise.all(normalizedWeekdays.map((weekdayValue) => tx.recurringBooking.create({
      data: {
        resourceId,
        createdByEmployeeId: actorEmployee.id,
        weekday: weekdayValue,
        validFrom: parsedValidFrom,
        validTo: parsedValidTo,
        bookedFor: normalizedBookedFor,
        guestName: normalizedBookedFor === 'GUEST' ? normalizedGuestName : null,
        period: recurrenceWindow.mode === 'day' ? recurrenceWindow.daySlot : null,
        startTime: recurrenceWindow.mode === 'time' ? startTime : null,
        endTime: recurrenceWindow.mode === 'time' ? endTime : null
      }
    })));

    return {
      kind: 'ok' as const,
      payload: {
        recurringBookings,
        createdCount: createdBookings.length,
        updatedCount: 0,
        skippedCount: 0,
        skippedDates: []
      }
    };
  });

  if (result.kind === 'conflict') {
    sendConflict(res, result.message, result.details);
    return;
  }

  res.status(201).json(result.payload);
});

app.post('/recurring-bookings/bulk', async (_req, res) => {
  res.status(410).json({ error: 'deprecated', message: 'Use POST /recurring-bookings with resourceId and weekdays' });
});

app.get('/recurring-bookings', async (req, res) => {
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const recurringBookings = await prisma.recurringBooking.findMany({
    where: floorplanId ? { resource: { floorplanId } } : undefined,
    include: { resource: true, createdByEmployee: { select: { id: true, displayName: true, email: true } } },
    orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }]
  });

  res.status(200).json(recurringBookings);
});

app.post('/admin/floorplans', requireAdmin, async (req, res) => {
  const { name, imageUrl, defaultResourceKind, defaultAllowSeries, isDefault } = req.body as { name?: string; imageUrl?: string; defaultResourceKind?: ResourceKind; defaultAllowSeries?: boolean; isDefault?: boolean };

  if (!name || !imageUrl) {
    res.status(400).json({ error: 'validation', message: 'name and imageUrl are required' });
    return;
  }

  const parsedDefaultKind = typeof defaultResourceKind === 'undefined' ? 'TISCH' : parseResourceKind(defaultResourceKind);
  if (!parsedDefaultKind) {
    res.status(400).json({ error: 'validation', message: 'defaultResourceKind must be one of TISCH, PARKPLATZ, RAUM, SONSTIGES' });
    return;
  }

  if (typeof defaultAllowSeries !== 'undefined' && typeof defaultAllowSeries !== 'boolean') {
    res.status(400).json({ error: 'validation', message: 'defaultAllowSeries must be a boolean' });
    return;
  }

  if (typeof isDefault !== 'undefined' && typeof isDefault !== 'boolean') {
    res.status(400).json({ error: 'validation', message: 'isDefault must be a boolean' });
    return;
  }

  const floorplan = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.floorplan.updateMany({ data: { isDefault: false } });
    }

    return tx.floorplan.create({
      data: {
        name,
        imageUrl,
        defaultResourceKind: parsedDefaultKind,
        ...(typeof defaultAllowSeries === 'boolean' ? { defaultAllowSeries } : {}),
        ...(typeof isDefault === 'boolean' ? { isDefault } : {})
      }
    });
  });
  res.status(201).json(floorplan);
});

app.patch('/admin/floorplans/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { name, imageUrl, defaultResourceKind, defaultAllowSeries, isDefault } = req.body as { name?: string; imageUrl?: string; defaultResourceKind?: ResourceKind; defaultAllowSeries?: boolean; isDefault?: boolean };
  if (typeof name === 'undefined' && typeof imageUrl === 'undefined' && typeof defaultResourceKind === 'undefined' && typeof defaultAllowSeries === 'undefined' && typeof isDefault === 'undefined') {
    res.status(400).json({ error: 'validation', message: 'name, imageUrl, defaultResourceKind, defaultAllowSeries or isDefault must be provided' });
    return;
  }


  const parsedDefaultKind = typeof defaultResourceKind === 'undefined' ? null : parseResourceKind(defaultResourceKind);
  if (typeof defaultResourceKind !== 'undefined' && !parsedDefaultKind) {
    res.status(400).json({ error: 'validation', message: 'defaultResourceKind must be one of TISCH, PARKPLATZ, RAUM, SONSTIGES' });
    return;
  }

  if (typeof defaultAllowSeries !== 'undefined' && typeof defaultAllowSeries !== 'boolean') {
    res.status(400).json({ error: 'validation', message: 'defaultAllowSeries must be a boolean' });
    return;
  }
  if (typeof isDefault !== 'undefined' && typeof isDefault !== 'boolean') {
    res.status(400).json({ error: 'validation', message: 'isDefault must be a boolean' });
    return;
  }
  if (typeof name === 'string' && name.trim().length === 0) {
    res.status(400).json({ error: 'validation', message: 'name must not be empty' });
    return;
  }

  try {
    const updatedFloorplan = await prisma.$transaction(async (tx) => {
      if (isDefault === true) {
        await tx.floorplan.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      }

      return tx.floorplan.update({
        where: { id },
        data: {
          ...(typeof name === 'string' ? { name: name.trim() } : {}),
          ...(typeof imageUrl === 'string' ? { imageUrl } : {}),
          ...(parsedDefaultKind ? { defaultResourceKind: parsedDefaultKind } : {}),
          ...(typeof defaultAllowSeries === 'boolean' ? { defaultAllowSeries } : {}),
          ...(typeof isDefault === 'boolean' ? { isDefault } : {})
        }
      });
    });
    res.status(200).json(updatedFloorplan);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
      return;
    }
    throw error;
  }
});

app.delete('/admin/floorplans/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    await prisma.floorplan.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
      return;
    }

    throw error;
  }
});

app.post('/admin/floorplans/:id/desks', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { name, x, y, kind, allowSeriesOverride } = req.body as { name?: string; x?: number | null; y?: number | null; kind?: ResourceKind; allowSeriesOverride?: boolean | null };
  const parsedKind = typeof kind === 'undefined' ? null : parseResourceKind(kind);

  if (!name) {
    res.status(400).json({ error: 'validation', message: 'name is required' });
    return;
  }

  if ((x === null) !== (y === null)) {
    res.status(400).json({ error: 'validation', message: 'x and y must be provided together or both null' });
    return;
  }

  if (typeof x !== 'undefined' && x !== null && typeof x !== 'number') {
    res.status(400).json({ error: 'validation', message: 'x must be a number or null' });
    return;
  }

  if (typeof y !== 'undefined' && y !== null && typeof y !== 'number') {
    res.status(400).json({ error: 'validation', message: 'y must be a number or null' });
    return;
  }

  if (typeof kind !== 'undefined' && !parsedKind) {
    res.status(400).json({ error: 'validation', message: 'kind must be one of TISCH, PARKPLATZ, RAUM, SONSTIGES' });
    return;
  }

  if (typeof allowSeriesOverride !== 'undefined' && allowSeriesOverride !== null && typeof allowSeriesOverride !== 'boolean') {
    res.status(400).json({ error: 'validation', message: 'allowSeriesOverride must be boolean or null' });
    return;
  }

  const floorplan = await prisma.floorplan.findUnique({ where: { id }, select: { id: true, defaultResourceKind: true } });
  if (!floorplan) {
    res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
    return;
  }

  const desk = await prisma.desk.create({
    data: {
      floorplanId: id,
      name: name.slice(0, 60),
      x: typeof x === 'undefined' ? null : x,
      y: typeof y === 'undefined' ? null : y,
      kind: parsedKind ?? floorplan.defaultResourceKind,
      ...(typeof allowSeriesOverride !== 'undefined' ? { allowSeriesOverride } : {})
    }
  });
  res.status(201).json(desk);
});

app.delete('/admin/desks', requireAdmin, async (req, res) => {
  const ids = getIdsFromQuery(req.query.ids as string | string[] | undefined);
  if (ids.length === 0) {
    res.status(400).json({ error: 'validation', message: 'ids is required' });
    return;
  }

  const result = await prisma.desk.deleteMany({ where: { id: { in: ids } } });
  res.status(200).json({ deletedCount: result.count });
});

app.delete('/admin/desks/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    await prisma.desk.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Desk not found' });
      return;
    }
    throw error;
  }
});

app.patch('/admin/desks/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { name, x, y, kind, allowSeriesOverride } = req.body as { name?: string; x?: number | null; y?: number | null; kind?: ResourceKind; allowSeriesOverride?: boolean | null };
  const hasName = typeof name !== 'undefined';
  const hasX = typeof x !== 'undefined';
  const hasY = typeof y !== 'undefined';
  const hasKind = typeof kind !== 'undefined';
  const parsedKind = hasKind ? parseResourceKind(kind) : null;

  const hasAllowSeriesOverride = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'allowSeriesOverride');

  if (!hasName && !hasX && !hasY && !hasKind && !hasAllowSeriesOverride) {
    res.status(400).json({ error: 'validation', message: 'name, x, y, kind or allowSeriesOverride must be provided' });
    return;
  }

  if (hasName && name.trim().length === 0) {
    res.status(400).json({ error: 'validation', message: 'name must not be empty' });
    return;
  }

  if (hasX && x !== null && typeof x !== 'number') {
    res.status(400).json({ error: 'validation', message: 'x must be a number or null' });
    return;
  }

  if (hasY && y !== null && typeof y !== 'number') {
    res.status(400).json({ error: 'validation', message: 'y must be a number or null' });
    return;
  }

  if ((hasX || hasY) && (x === null) !== (y === null)) {
    res.status(400).json({ error: 'validation', message: 'x and y must be provided together or both null' });
    return;
  }


  if (hasAllowSeriesOverride && allowSeriesOverride !== null && typeof allowSeriesOverride !== 'boolean') {
    res.status(400).json({ error: 'validation', message: 'allowSeriesOverride must be boolean or null' });
    return;
  }

  if (hasKind && !parsedKind) {
    res.status(400).json({ error: 'validation', message: 'kind must be one of TISCH, PARKPLATZ, RAUM, SONSTIGES' });
    return;
  }

  const data: { name?: string; x?: number | null; y?: number | null; kind?: ResourceKind; allowSeriesOverride?: boolean | null } = {};
  if (hasName) data.name = name.trim().slice(0, 60);
  if (hasX) data.x = x;
  if (hasY) data.y = y;
  if (hasKind && parsedKind) data.kind = parsedKind;
  if (hasAllowSeriesOverride) data.allowSeriesOverride = allowSeriesOverride ?? null;

  try {
    const updatedDesk = await prisma.desk.update({ where: { id }, data });
    res.status(200).json(updatedDesk);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Desk not found' });
      return;
    }
    throw error;
  }
});

app.post('/admin/desks/positions/mark-missing', requireAdmin, async (req, res) => {
  const { floorplanId } = req.body as { floorplanId?: string };
  const result = await prisma.desk.updateMany({
    where: {
      ...(floorplanId ? { floorplanId } : {}),
      x: 0,
      y: 0
    },
    data: {
      x: null,
      y: null
    }
  });

  res.status(200).json({ updatedCount: result.count });
});

app.get('/admin/bookings', requireAdmin, async (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;
  const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;

  const where: Prisma.BookingWhereInput = {};

  if (date) {
    const parsedDate = toDateOnly(date);
    if (!parsedDate) {
      res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
      return;
    }

    where.date = parsedDate;
  }

  if (from || to) {
    const rangeFilter = (where.date && typeof where.date === 'object' && 'equals' in where.date)
      ? { gte: (where.date as Prisma.DateTimeFilter).equals }
      : ((where.date as Prisma.DateTimeFilter | undefined) ?? {});

    if (from) {
      const fromDate = toDateOnly(from);
      if (!fromDate) {
        res.status(400).json({ error: 'validation', message: 'from must be in YYYY-MM-DD format' });
        return;
      }
      rangeFilter.gte = fromDate;
    }

    if (to) {
      const toDate = toDateOnly(to);
      if (!toDate) {
        res.status(400).json({ error: 'validation', message: 'to must be in YYYY-MM-DD format' });
        return;
      }
      rangeFilter.lte = toDate;
    }

    where.date = rangeFilter;
  } else if (!date) {
    const today = toDateOnly(toISODateOnly(new Date()));
    if (!today) {
      res.status(500).json({ error: 'internal', message: 'Unable to create default date filter' });
      return;
    }

    where.date = {
      gte: addUtcDays(today, -30),
      lte: addUtcDays(today, 30)
    };
  }

  if (floorplanId) {
    where.desk = { floorplanId };
  }

  if (employeeId) {
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { email: true } });
    if (!employee) {
      res.status(404).json({ error: 'not_found', message: 'Employee not found' });
      return;
    }
    where.userEmail = employee.email;
  }

  if (!isProd) {
    console.log('ADMIN_BOOKINGS_FILTER', {
      from: from ?? null,
      to: to ?? null,
      date: date ?? null,
      employeeId: employeeId ?? null,
      floorplanId: floorplanId ?? null
    });
  }

  const bookings = await prisma.booking.findMany({
    where,
    include: {
      desk: { select: { kind: true } },
      createdByEmployee: { select: { id: true, displayName: true, email: true } }
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
  });

  if (!isProd) {
    const duplicateGroups = findDuplicateUserDateGroups(bookings);
    if (duplicateGroups.length > 0) {
      console.warn('BOOKINGS_DUPLICATES_DETECTED', { count: duplicateGroups.length, sample: duplicateGroups.slice(0, 10) });
    }
  }

  const employeesByEmail = await getActiveEmployeesByEmail(bookings.map((booking) => booking.userEmail).filter((email): email is string => Boolean(email)));
  const usersByEmail = new Map((await prisma.user.findMany({
    where: {
      email: {
        in: Array.from(new Set(bookings.map((booking) => booking.userEmail).filter((email): email is string => Boolean(email)).map((email) => normalizeEmail(email))))
      }
    },
    select: { id: true, email: true, displayName: true }
  })).map((user) => [normalizeEmail(user.email), user]));

  const enrichedBookings = bookings.map((booking) => ({
    ...(function () {
      const normalizedUserEmail = booking.userEmail ? normalizeEmail(booking.userEmail) : null;
      const employee = normalizedUserEmail ? employeesByEmail.get(normalizedUserEmail) : undefined;
      const appUser = normalizedUserEmail ? usersByEmail.get(normalizedUserEmail) : undefined;
      const fallbackUser = booking.userEmail
        ? {
          id: appUser?.id ?? booking.createdByEmployeeId ?? `legacy-${normalizedUserEmail ?? 'unknown'}`,
          displayName: employee?.displayName ?? appUser?.displayName ?? booking.userEmail,
          email: booking.userEmail
        }
        : null;
      const createdBy = resolveCreatedBySummary({
        createdBy: booking.createdByEmployee,
        fallbackUser
      });

      return {
        createdBy,
        createdByUserId: createdBy.id,
    createdByEmployeeId: booking.createdByEmployeeId,
        user: booking.bookedFor === 'SELF' && fallbackUser ? fallbackUser : null,
        userDisplayName: employee?.displayName,
        employeeId: employee?.id
      };
    })(),
    id: booking.id,
    deskId: booking.deskId,
    userEmail: booking.userEmail,
    bookedFor: booking.bookedFor,
    guestName: booking.guestName,
    date: booking.date,
    createdAt: booking.createdAt,
    daySlot: booking.daySlot ?? bookingSlotToDaySlot(booking.slot),
    slot: booking.slot,
    startTime: minuteToHHMM(booking.startMinute ?? (booking.startTime ? booking.startTime.getUTCHours() * 60 + booking.startTime.getUTCMinutes() : null)),
    endTime: minuteToHHMM(booking.endMinute ?? (booking.endTime ? booking.endTime.getUTCHours() * 60 + booking.endTime.getUTCMinutes() : null)),
  }));

  res.status(200).json(enrichedBookings);
});

app.delete('/admin/bookings', requireAdmin, async (req, res) => {
  const ids = getIdsFromQuery(req.query.ids as string | string[] | undefined);
  if (ids.length === 0) {
    res.status(400).json({ error: 'validation', message: 'ids is required' });
    return;
  }

  const result = await prisma.booking.deleteMany({ where: { id: { in: ids } } });
  res.status(200).json({ deletedCount: result.count });
});

app.post('/admin/bookings/cleanup-duplicates', requireAdmin, async (_req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const bookings = await tx.booking.findMany({
      select: { id: true, userEmail: true, date: true, createdAt: true, desk: { select: { kind: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
    });

    const emails = Array.from(new Set(bookings.map((booking) => booking.userEmail).filter((email): email is string => Boolean(email)).map((email) => normalizeEmail(email))));
    const employees = emails.length > 0
      ? await tx.employee.findMany({ where: { email: { in: emails } }, select: { email: true, entraOid: true } })
      : [];
    const entraByEmail = new Map(employees.map((employee) => [normalizeEmail(employee.email), employee.entraOid]));

    const keepByKey = new Map<string, string>();
    const duplicatesToDelete: string[] = [];

    for (const booking of bookings) {
      if (!booking.userEmail) continue;
      const normalizedEmail = normalizeEmail(booking.userEmail);
      const key = `${entraByEmail.get(normalizedEmail) ?? normalizedEmail}|${toISODateOnly(booking.date)}|${booking.desk.kind}`;
      if (!keepByKey.has(key)) {
        keepByKey.set(key, booking.id);
      } else {
        duplicatesToDelete.push(booking.id);
      }
    }

    if (duplicatesToDelete.length > 0) {
      await tx.booking.deleteMany({ where: { id: { in: duplicatesToDelete } } });
    }

    return { deletedCount: duplicatesToDelete.length, affectedGroups: keepByKey.size };
  });

  res.status(200).json(result);
});

app.delete('/admin/bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const result = await prisma.booking.deleteMany({ where: { id } });
  if (result.count === 0) {
    res.status(404).json({ error: 'not_found', message: 'Booking not found' });
    return;
  }

  res.status(200).json({ deletedCount: result.count });
});

app.patch('/admin/bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { userEmail, date, deskId, slot, startTime, endTime } = req.body as { userEmail?: string; date?: string; deskId?: string; slot?: string; startTime?: string; endTime?: string };

  if (!userEmail && !date && !deskId && typeof slot === 'undefined' && typeof startTime === 'undefined' && typeof endTime === 'undefined') {
    res.status(400).json({ error: 'validation', message: 'userEmail, deskId, date, slot or time fields must be provided' });
    return;
  }

  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'not_found', message: 'Booking not found' });
    return;
  }

  const nextDateValue = date ? toDateOnly(date) : existing.date;
  if (date && !nextDateValue) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const nextDate = nextDateValue as Date;
  const nextDeskId = deskId ?? existing.deskId;
  const nextUserEmail = userEmail ? normalizeEmail(userEmail) : existing.userEmail;

  const nextDesk = await getDeskContext(nextDeskId);
  if (!nextDesk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const bookingWindowResult = resolveBookingWindow({
    deskKind: nextDesk.kind,
    daySlot: typeof slot === 'undefined' ? (existing.daySlot ?? bookingSlotToDaySlot(existing.slot)) : slot,
    slot: typeof slot === 'undefined' ? existing.slot : slot,
    startTime: typeof startTime === 'undefined' ? minuteToHHMM(existing.startMinute ?? (existing.startTime ? existing.startTime.getUTCHours() * 60 + existing.startTime.getUTCMinutes() : null)) : startTime,
    endTime: typeof endTime === 'undefined' ? minuteToHHMM(existing.endMinute ?? (existing.endTime ? existing.endTime.getUTCHours() * 60 + existing.endTime.getUTCMinutes() : null)) : endTime
  });
  if (!bookingWindowResult.ok) {
    res.status(400).json({ error: 'validation', message: bookingWindowResult.message });
    return;
  }
  const nextWindow = bookingWindowResult.value;

  if (nextDate.getTime() !== existing.date.getTime() || nextDeskId !== existing.deskId) {
    const conflictingBooking = await prisma.booking.findFirst({
      where: {
        id: { not: existing.id },
        deskId: nextDeskId,
        date: nextDate
      }
    });

    const overlappingDeskConflict = conflictingBooking && (() => { const conflictWindow = bookingToWindow(conflictingBooking); return conflictWindow ? windowsOverlap(nextWindow, conflictWindow) : false; })();

    if (overlappingDeskConflict) {
      sendConflict(res, 'Desk is already booked for this Zeitraum', { deskId: nextDeskId, date, bookingId: conflictingBooking.id });
      return;
    }

  }

  const userDateConflict = await prisma.booking.findFirst({
    where: {
      id: { not: existing.id },
      userEmail: nextUserEmail,
      date: nextDate,
      desk: { kind: nextDesk.kind }
    },
    include: { desk: { select: { id: true, name: true } } }
  });

  if (userDateConflict && (() => { const conflictWindow = bookingToWindow(userDateConflict); return conflictWindow ? windowsOverlap(nextWindow, conflictWindow) : false; })()) {
    sendConflict(res, 'User already has a booking for this date and resource kind', {
      conflictKind: nextDesk.kind,
      existingBooking: {
        id: userDateConflict.id,
        deskId: userDateConflict.deskId,
        deskName: userDateConflict.desk?.name ?? userDateConflict.deskId
      }
    });
    return;
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: {
      ...(userEmail ? { userEmail: nextUserEmail } : {}),
      ...(date ? { date: nextDate } : {}),
      ...(deskId ? { deskId: nextDeskId } : {}),
      daySlot: nextWindow.mode === 'day' ? nextWindow.daySlot : null,
      startTime: nextWindow.mode === 'time' ? new Date(Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth(), nextDate.getUTCDate(), Math.floor(nextWindow.startMinute / 60), nextWindow.startMinute % 60, 0, 0)) : null,
      endTime: nextWindow.mode === 'time' ? new Date(Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth(), nextDate.getUTCDate(), Math.floor(nextWindow.endMinute / 60), nextWindow.endMinute % 60, 0, 0)) : null,
      slot: nextWindow.mode === 'day' ? (nextWindow.daySlot === 'FULL' ? 'FULL_DAY' : nextWindow.daySlot === 'AM' ? 'MORNING' : 'AFTERNOON') : 'CUSTOM',
      startMinute: nextWindow.mode === 'time' ? nextWindow.startMinute : null,
      endMinute: nextWindow.mode === 'time' ? nextWindow.endMinute : null
    },
    include: { createdByEmployee: { select: { id: true, displayName: true, email: true } } }
  });

  const employee = updated.userEmail ? (await getActiveEmployeesByEmail([updated.userEmail])).get(normalizeEmail(updated.userEmail)) : undefined;
  const appUser = updated.userEmail ? await prisma.user.findUnique({ where: { email: normalizeEmail(updated.userEmail) }, select: { id: true, displayName: true, email: true } }) : null;
  const fallbackUser = updated.userEmail
    ? {
      id: appUser?.id ?? updated.createdByEmployeeId ?? `legacy-${normalizeEmail(updated.userEmail)}`,
      displayName: employee?.displayName ?? appUser?.displayName ?? updated.userEmail,
      email: updated.userEmail
    }
    : null;
  const createdBy = resolveCreatedBySummary({
    createdBy: updated.createdByEmployee,
    fallbackUser
  });

  res.status(200).json({
    ...updated,
    createdBy,
    createdByUserId: createdBy.id,
    createdByEmployeeId: updated.createdByEmployeeId,
    user: updated.bookedFor === 'SELF' && fallbackUser ? fallbackUser : null
  });
});

app.get('/admin/recurring-bookings', requireAdmin, async (req, res) => {
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const recurringBookings = await prisma.recurringBooking.findMany({
    where: floorplanId ? { resource: { floorplanId } } : undefined,
    include: {
      resource: { select: { id: true, name: true, floorplanId: true, kind: true } },
      createdByEmployee: { select: { id: true, displayName: true, email: true } }
    },
    orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }]
  });

  res.status(200).json(recurringBookings);
});

app.delete('/recurring-bookings/:id', async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const recurring = await prisma.recurringBooking.findUnique({ where: { id } });
  if (!recurring) {
    res.status(404).json({ error: 'not_found', message: 'Recurring booking not found' });
    return;
  }

  let actorEmployee;
  try {
    actorEmployee = await requireActorEmployee(req);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 403;
    res.status(status).json({ error: status === 401 ? 'unauthorized' : 'forbidden', message: (error as Error).message });
    return;
  }

  const isAdmin = req.authUser?.role === 'admin';
  if (!isAdmin && recurring.createdByEmployeeId !== actorEmployee.id) {
    res.status(403).json({ error: 'forbidden', message: 'Not allowed to delete this recurring booking' });
    return;
  }

  await prisma.recurringBooking.delete({ where: { id } });
  res.status(204).send();
});

const start = async () => {
  await ensureBreakglassAdmin();
  await backfillLegacyBookingCreators();
  app.listen(port, '0.0.0.0', () => {
    console.log(`${APP_TITLE} API listening on ${port}`);
  });
};

if (require.main === module) {
  void start();
}

export { app, start };
