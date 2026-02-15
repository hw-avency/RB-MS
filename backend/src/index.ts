import cors from 'cors';
import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

const app = express();
const port = Number(process.env.PORT ?? 3000);
app.set('trust proxy', 1);

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const configuredOrigins = (process.env.FRONTEND_URL ?? process.env.CORS_ORIGIN ?? process.env.FRONTEND_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => Boolean(origin));
const FRONTEND_URL = configuredOrigins[0] ?? '';
const DEFAULT_USER_PASSWORD = process.env.DEFAULT_USER_PASSWORD ?? 'ChangeMe123!';
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

type EmployeeRole = 'admin' | 'user';
type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: number;
  graphAccessToken?: string;
  graphTokenExpiresAt?: number;
};
type AuthUser = { id: string; email: string; displayName: string; role: EmployeeRole; isActive: boolean };

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
const sessions = new Map<string, SessionRecord>();
type OidcFlowState = { nonce: string; createdAt: number };
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

const createSession = (userId: string, options?: { graphAccessToken?: string; graphTokenExpiresInSeconds?: number }): SessionRecord => {
  const now = Date.now();
  const graphTokenExpiresAt = options?.graphTokenExpiresInSeconds
    ? now + (options.graphTokenExpiresInSeconds * 1000)
    : undefined;
  const session: SessionRecord = {
    id: crypto.randomUUID(),
    userId,
    expiresAt: now + SESSION_TTL_MS,
    ...(options?.graphAccessToken ? { graphAccessToken: options.graphAccessToken } : {}),
    ...(graphTokenExpiresAt ? { graphTokenExpiresAt } : {})
  };
  sessions.set(session.id, session);
  return session;
};

const destroySession = (sessionId?: string) => {
  if (!sessionId) return;
  sessions.delete(sessionId);
};

const oidcStates = new Map<string, OidcFlowState>();
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

const createOidcState = (): { state: string; nonce: string } => {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  oidcStates.set(state, { nonce, createdAt: Date.now() });
  return { state, nonce };
};

const consumeOidcState = (state: string): OidcFlowState | null => {
  const current = oidcStates.get(state) ?? null;
  oidcStates.delete(state);

  if (!current) return null;
  if (Date.now() - current.createdAt > OIDC_STATE_TTL_MS) return null;
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
        isActive: true
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

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    destroySession(sessionId);
    req.authFailureReason = 'SESSION_INVALID_OR_EXPIRED';
    next();
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      isActive: true
    }
  });

  if (!user || !user.isActive) {
    destroySession(sessionId);
    req.authFailureReason = 'USER_MISSING_OR_INACTIVE';
    next();
    return;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(session.id, session);
  req.authSession = session;
  req.authUser = {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role === 'admin' ? 'admin' : 'user',
    isActive: user.isActive
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
  findMany: (args: { take: number; skip: number; orderBy: { createdAt: 'desc' } | { id: 'desc' } }) => Promise<unknown[]>;
  count: () => Promise<number>;
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
type BookingWithDeskName = Prisma.BookingGetPayload<{ include: { desk: { select: { name: true } } } }>;

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

const buildUserBookingWhere = (identity: BookingIdentity, date: Date): Prisma.BookingWhereInput => {
  return {
    date,
    userEmail: { in: identity.emailAliases }
  };
};

const dedupeAndPickActiveBooking = async (tx: BookingTx, where: Prisma.BookingWhereInput): Promise<BookingWithDeskName | null> => {
  const matches = await tx.booking.findMany({
    where,
    include: { desk: { select: { name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });

  if (matches.length <= 1) {
    return matches[0] ?? null;
  }

  const [keep, ...duplicates] = matches;
  await tx.booking.deleteMany({ where: { id: { in: duplicates.map((row) => row.id) } } });
  return keep;
};

const findDuplicateUserDateGroups = (bookings: Array<{ id: string; userEmail: string; date: Date }>) => {
  const counts = new Map<string, number>();
  for (const booking of bookings) {
    const key = `${normalizeEmail(booking.userEmail)}|${toISODateOnly(booking.date)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).filter(([, count]) => count > 1);
};

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
  select: { id: true, name: true, floorplanId: true }
});


app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch {
    res.status(500).json({ status: 'error' });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch {
    res.status(500).json({ status: 'error' });
  }
});

app.use(attachAuthUser);
app.use(requireAllowedMutationOrigin);

const ensureBreakglassAdmin = async () => {
  const defaultHash = await hashPassword(DEFAULT_USER_PASSWORD);
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

  const employees = await prisma.employee.findMany({
    select: { email: true, displayName: true, role: true, isActive: true }
  });

  for (const employee of employees) {
    await prisma.user.upsert({
      where: { email: employee.email },
      update: {
        displayName: employee.displayName,
        role: employee.role,
        isActive: employee.isActive
      },
      create: {
        email: employee.email,
        displayName: employee.displayName,
        role: employee.role,
        isActive: employee.isActive,
        passwordHash: defaultHash
      }
    });
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

    const existingUser = await tx.user.findUnique({ where: { email: normalizedEmail } });
    const fallbackPasswordHash = existingUser?.passwordHash ?? await hashPassword(crypto.randomUUID());
    const user = await tx.user.upsert({
      where: { email: normalizedEmail },
      update: {
        displayName: claims.name,
        role: employee.role,
        isActive: employee.isActive
      },
      create: {
        email: normalizedEmail,
        displayName: claims.name,
        role: employee.role,
        isActive: true,
        passwordHash: fallbackPasswordHash
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true
      }
    });

    await tx.employee.update({
      where: { id: employee.id },
      data: {
        photoUrl: employee.photoUrl ?? getEmployeePhotoUrl(employee.id)
      }
    });

    return { ...user, employeeId: employee.id };
  });
};

app.get('/auth/entra/start', async (_req, res) => {
  if (!isEntraConfigured()) {
    res.status(500).json({ code: 'ENTRA_NOT_CONFIGURED', message: 'Microsoft Entra login is not configured' });
    return;
  }

  const metadata = await loadOidcMetadata();
  const { state, nonce } = createOidcState();
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
    const oidcState = consumeOidcState(stateParam);
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
    const session = createSession(user.id, {
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

    const session = createSession(user.id);
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

app.post('/auth/logout', (req, res) => {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  destroySession(sessionId);
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

  if (!graphAccessToken || !graphTokenExpiresAt || graphTokenExpiresAt <= Date.now()) {
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

  const [rows, total] = await Promise.all([
    delegate.findMany({ take: limit, skip: offset, orderBy }),
    delegate.count()
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
    const passwordHash = await hashPassword(DEFAULT_USER_PASSWORD);
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

      await tx.user.upsert({
        where: { email: normalizedEmail },
        update: {
          displayName: normalizedDisplayName,
          role: role ?? 'user',
          isActive: true
        },
        create: {
          email: normalizedEmail,
          displayName: normalizedDisplayName,
          role: role ?? 'user',
          isActive: true,
          passwordHash
        }
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
    const adminCount = await prisma.user.count({ where: { role: 'admin', isActive: true } });
    if (adminCount <= 1) {
      res.status(409).json({ error: 'conflict', message: 'Mindestens ein Admin muss erhalten bleiben.' });
      return;
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const employeeRow = await tx.employee.update({
        where: { id },
        data: {
          ...(typeof trimmedDisplayName === 'string' ? { displayName: trimmedDisplayName } : {}),
          ...(typeof isActive === 'boolean' ? { isActive } : {}),
          ...(typeof role === 'string' ? { role } : {})
        },
        select: employeeSelect
      });

      await tx.user.updateMany({
        where: { email: existing.email },
        data: {
          ...(typeof trimmedDisplayName === 'string' ? { displayName: trimmedDisplayName } : {}),
          ...(typeof isActive === 'boolean' ? { isActive } : {}),
          ...(typeof role === 'string' ? { role } : {})
        }
      });

      return employeeRow;
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
    const adminCount = await prisma.user.count({ where: { role: 'admin', isActive: true } });
    if (adminCount <= 1) {
      res.status(409).json({ error: 'conflict', message: 'Mindestens ein Admin muss erhalten bleiben.' });
      return;
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const employeeRow = await tx.employee.update({
        where: { id },
        data: { isActive: false },
        select: employeeSelect
      });
      await tx.user.updateMany({
        where: { email: employeeRow.email },
        data: { isActive: false }
      });
      return employeeRow;
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
  const floorplans = await prisma.floorplan.findMany({ orderBy: { createdAt: 'desc' } });
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
    orderBy: { createdAt: 'asc' }
  });

  res.status(200).json(desks);
});

app.post('/bookings', async (req, res) => {
  const { deskId, userEmail, date, replaceExisting } = req.body as { deskId?: string; userEmail?: string; date?: string; replaceExisting?: boolean };

  if (!deskId || !userEmail || !date) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail and date are required' });
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

  const identity = await findBookingIdentity(userEmail);
  const shouldReplaceExisting = replaceExisting ?? false;

  const result = await prisma.$transaction(async (tx) => {
    await acquireBookingLock(tx, bookingUserKeyForDate(identity.userKey, parsedDate));
    await acquireBookingLock(tx, bookingDeskKeyForDate(deskId, parsedDate));

    const existingUserBooking = await dedupeAndPickActiveBooking(tx, buildUserBookingWhere(identity, parsedDate));

    if (existingUserBooking && existingUserBooking.deskId !== deskId && !shouldReplaceExisting) {
      return {
        kind: 'conflict' as const,
        message: 'User already has a booking for this date',
        details: {
          existingBooking: {
            id: existingUserBooking.id,
            deskId: existingUserBooking.deskId,
            deskName: existingUserBooking.desk?.name ?? existingUserBooking.deskId
          },
          requestedDesk: {
            id: deskId,
            name: desk.name
          },
          date,
          replaceableDates: [date],
          replaceableDeskNames: [existingUserBooking.desk?.name ?? existingUserBooking.deskId]
        }
      };
    }

    const targetDeskBooking = await tx.booking.findFirst({
      where: {
        deskId,
        date: parsedDate,
        ...(existingUserBooking ? { id: { not: existingUserBooking.id } } : {})
      }
    });

    if (targetDeskBooking) {
      return {
        kind: 'conflict' as const,
        message: 'Desk is already booked for this date',
        details: {
          deskId,
          date,
          bookingId: targetDeskBooking.id
        }
      };
    }

    if (existingUserBooking) {
      if (existingUserBooking.deskId === deskId && existingUserBooking.userEmail === identity.normalizedEmail) {
        return { kind: 'ok' as const, status: 200, booking: existingUserBooking };
      }

      const updated = await tx.booking.update({
        where: { id: existingUserBooking.id },
        data: { deskId, userEmail: identity.normalizedEmail }
      });
      return { kind: 'ok' as const, status: 200, booking: updated };
    }

    const created = await tx.booking.create({
      data: {
        deskId,
        userEmail: identity.normalizedEmail,
        date: parsedDate
      }
    });

    return { kind: 'ok' as const, status: 201, booking: created };
  });

  if (result.kind === 'conflict') {
    sendConflict(res, result.message, result.details);
    return;
  }

  res.status(result.status).json(result.booking);
});

app.put('/bookings/:id', async (req, res) => {
  const id = getRouteId(req.params.id);
  const { deskId, date } = req.body as { deskId?: string; date?: string };
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

  const authEmail = req.authUser?.email;
  if (req.authUser?.role !== 'admin' && existing.userEmail !== authEmail) {
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

  const conflict = await prisma.booking.findUnique({ where: { deskId_date: { deskId, date: bookingDate } } });
  if (conflict && conflict.id !== existing.id) {
    sendConflict(res, 'Desk is already booked for this date', { deskId, date: toISODateOnly(bookingDate), bookingId: conflict.id });
    return;
  }

  const updated = await prisma.booking.update({ where: { id }, data: { deskId } });
  res.status(200).json(updated);
});

app.delete('/bookings/:id', async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'not_found', message: 'Booking not found' });
    return;
  }

  const authEmail = req.authUser?.email;
  if (req.authUser?.role !== 'admin' && existing.userEmail !== authEmail) {
    res.status(403).json({ error: 'forbidden', message: 'Cannot cancel booking of another user' });
    return;
  }

  await prisma.booking.delete({ where: { id } });
  res.status(200).json({ ok: true });
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

  const desk = await prisma.desk.findUnique({ where: { id: deskId }, select: { id: true, name: true } });
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
        userEmail: { in: identity.emailAliases }
      },
      include: { desk: { select: { name: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
    });

    const existingByDate = new Map<string, BookingWithDeskName>();
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
            data: { deskId, userEmail: identity.normalizedEmail }
          });
        }

        updatedCount += 1;
        updatedDates.push(dateKey);
        continue;
      }

      await tx.booking.create({ data: { deskId, userEmail: identity.normalizedEmail, date: targetDate } });
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

  if (req.authUser?.role !== 'admin') {
    where.userEmail = req.authUser?.email;
  }

  const bookings = await prisma.booking.findMany({
    where,
    select: {
      id: true,
      deskId: true,
      userEmail: true,
      date: true,
      createdAt: true
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
  });

  if (!isProd) {
    const duplicateGroups = findDuplicateUserDateGroups(bookings);
    if (duplicateGroups.length > 0) {
      console.warn('BOOKINGS_DUPLICATES_DETECTED', { count: duplicateGroups.length, sample: duplicateGroups.slice(0, 10) });
    }
  }

  const employeesByEmail = await getActiveEmployeesByEmail(bookings.map((booking) => booking.userEmail));
  const enrichedBookings = bookings.map((booking) => ({
    ...booking,
    employeeId: employeesByEmail.get(normalizeEmail(booking.userEmail))?.id,
    userDisplayName: employeesByEmail.get(normalizeEmail(booking.userEmail))?.displayName,
    userPhotoUrl: employeesByEmail.get(normalizeEmail(booking.userEmail))?.photoUrl ?? undefined
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
    orderBy: { createdAt: 'asc' }
  });

  const deskIds = desks.map((desk) => desk.id);
  const singleBookings = await prisma.booking.findMany({
    where: {
      date: parsedDate,
      deskId: { in: deskIds }
    }
  });

  const employeesByEmail = await getActiveEmployeesByEmail(singleBookings.map((booking) => booking.userEmail));

  const singleByDeskId = new Map(singleBookings.map((booking) => [booking.deskId, booking]));

  const occupancyDesks = desks.map((desk) => {
    const single = singleByDeskId.get(desk.id);
    if (single) {
      return {
        id: desk.id,
        name: desk.name,
        x: desk.x,
        y: desk.y,
        status: 'booked' as const,
        booking: {
          id: single.id,
          userEmail: single.userEmail,
          employeeId: employeesByEmail.get(normalizeEmail(single.userEmail))?.id,
          userDisplayName: employeesByEmail.get(normalizeEmail(single.userEmail))?.displayName,
          userPhotoUrl: employeesByEmail.get(normalizeEmail(single.userEmail))?.photoUrl ?? undefined,
          deskName: desk.name,
        deskId: desk.id,
          type: 'single' as const
        }
      };
    }

    return {
      id: desk.id,
      name: desk.name,
      x: desk.x,
      y: desk.y,
      status: 'free' as const,
      booking: null
    };
  });

  const uniquePeopleByEmail = new Map<string, { email: string; userEmail: string; displayName?: string; photoUrl?: string; deskName?: string; deskId?: string }>();
  occupancyDesks
    .filter((desk) => desk.booking)
    .forEach((desk) => {
      const userEmail = desk.booking?.userEmail ?? '';
      const normalizedEmail = normalizeEmail(userEmail);
      if (!userEmail || uniquePeopleByEmail.has(normalizedEmail)) {
        return;
      }

      uniquePeopleByEmail.set(normalizedEmail, {
        email: userEmail,
        userEmail,
        displayName: employeesByEmail.get(normalizedEmail)?.displayName,
        photoUrl: employeesByEmail.get(normalizedEmail)?.photoUrl ?? undefined,
        deskName: desk.name,
        deskId: desk.id
      });
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

app.post('/recurring-bookings', async (req, res) => {
  const { deskId, userEmail, weekday, validFrom, validTo } = req.body as {
    deskId?: string;
    userEmail?: string;
    weekday?: number;
    validFrom?: string;
    validTo?: string | null;
  };

  if (!deskId || !userEmail || typeof weekday !== 'number' || !validFrom) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail, weekday and validFrom are required' });
    return;
  }

  if (weekday < 0 || weekday > 6) {
    res.status(400).json({ error: 'validation', message: 'weekday must be between 0 and 6' });
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

  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const effectiveValidTo = parsedValidTo ?? endOfCurrentYear();
  const targetDates = datesInRange(parsedValidFrom, effectiveValidTo).filter((dateValue) => dateValue.getUTCDay() === weekday);
  const identity = await findBookingIdentity(userEmail);

  const result = await prisma.$transaction(async (tx) => {
    const lockKeys = Array.from(new Set(targetDates.flatMap((targetDate) => [
      bookingUserKeyForDate(identity.userKey, targetDate),
      bookingDeskKeyForDate(deskId, targetDate)
    ]))).sort();

    for (const lockKey of lockKeys) {
      await acquireBookingLock(tx, lockKey);
    }

    let createdCount = 0;
    let updatedCount = 0;
    for (const targetDate of targetDates) {
      const existingUserBooking = await dedupeAndPickActiveBooking(tx, buildUserBookingWhere(identity, targetDate));
      const existingDeskBooking = await tx.booking.findUnique({ where: { deskId_date: { deskId, date: targetDate } } });

      if (existingUserBooking) {
        if (existingUserBooking.deskId === deskId) {
          if (existingUserBooking.userEmail !== identity.normalizedEmail) {
            await tx.booking.update({ where: { id: existingUserBooking.id }, data: { userEmail: identity.normalizedEmail } });
            updatedCount += 1;
          }
          continue;
        }

        if (existingDeskBooking && existingDeskBooking.id !== existingUserBooking.id) {
          await tx.booking.delete({ where: { id: existingDeskBooking.id } });
        }

        await tx.booking.update({
          where: { id: existingUserBooking.id },
          data: { deskId, userEmail: identity.normalizedEmail }
        });
        updatedCount += 1;
        continue;
      }

      if (existingDeskBooking) {
        await tx.booking.update({ where: { id: existingDeskBooking.id }, data: { userEmail: identity.normalizedEmail } });
        updatedCount += 1;
        continue;
      }

      await tx.booking.create({ data: { deskId, userEmail: identity.normalizedEmail, date: targetDate } });
      createdCount += 1;
    }

    const recurringBooking = await tx.recurringBooking.create({
      data: {
        deskId,
        userEmail: identity.normalizedEmail,
        weekday,
        validFrom: parsedValidFrom,
        validTo: parsedValidTo
      }
    });

    return { recurringBooking, createdCount, updatedCount, dates: targetDates.map((targetDate) => toISODateOnly(targetDate)) };
  });

  res.status(201).json(result);
});

app.post('/recurring-bookings/bulk', async (req, res) => {
  const { deskId, userEmail, weekdays, validFrom, validTo, replaceExisting, overrideExisting } = req.body as {
    deskId?: string;
    userEmail?: string;
    weekdays?: number[];
    validFrom?: string;
    validTo?: string;
    replaceExisting?: boolean;
    overrideExisting?: boolean;
  };

  if (!deskId || !userEmail || !Array.isArray(weekdays) || !validFrom) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail, weekdays and validFrom are required' });
    return;
  }

  const uniqueWeekdays = Array.from(new Set(weekdays));
  if (uniqueWeekdays.length !== weekdays.length || uniqueWeekdays.length === 0) {
    res.status(400).json({ error: 'validation', message: 'weekdays must be unique and non-empty' });
    return;
  }

  if (uniqueWeekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6)) {
    res.status(400).json({ error: 'validation', message: 'weekdays must contain values between 0 and 6' });
    return;
  }

  const parsedValidFrom = toDateOnly(validFrom);
  const parsedValidTo = validTo ? toDateOnly(validTo) : endOfCurrentYear();
  if (!parsedValidFrom || !parsedValidTo) {
    res.status(400).json({ error: 'validation', message: 'validFrom/validTo must be in YYYY-MM-DD format' });
    return;
  }

  if (parsedValidTo < parsedValidFrom) {
    res.status(400).json({ error: 'validation', message: 'validTo must be on or after validFrom' });
    return;
  }

  const desk = await prisma.desk.findUnique({ where: { id: deskId }, select: { id: true } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const shouldOverrideExisting = overrideExisting ?? replaceExisting ?? false;
  const targetDates = datesInRange(parsedValidFrom, parsedValidTo).filter((date) => uniqueWeekdays.includes(date.getUTCDay()));
  const identity = await findBookingIdentity(userEmail);

  const result = await prisma.$transaction(async (tx) => {
    const lockKeys = Array.from(new Set(targetDates.flatMap((targetDate) => [
      bookingUserKeyForDate(identity.userKey, targetDate),
      bookingDeskKeyForDate(deskId, targetDate)
    ]))).sort();
    for (const lockKey of lockKeys) {
      await acquireBookingLock(tx, lockKey);
    }

    const bookingsForTargets = await tx.booking.findMany({
      where: {
        date: { in: targetDates },
        userEmail: { in: identity.emailAliases }
      },
      include: { desk: { select: { name: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
    });

    const existingByDate = new Map<string, BookingWithDeskName>();
    const duplicateIdsToDelete: string[] = [];
    for (const booking of bookingsForTargets) {
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
        date: { in: targetDates },
        deskId,
        id: { notIn: keepIds },
        userEmail: { notIn: identity.emailAliases }
      },
      orderBy: { date: 'asc' }
    });

    if (deskSingleConflicts.length > 0) {
      const conflictingDates = deskSingleConflicts.map((booking) => toISODateOnly(booking.date));
      return {
        kind: 'conflict' as const,
        message: 'Recurring series conflicts with existing single-day bookings',
        details: {
          deskId,
          weekdays: uniqueWeekdays,
          validFrom,
          validTo: toISODateOnly(parsedValidTo),
          conflictingDates,
          conflictingDatesPreview: conflictingDates.slice(0, 10)
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
          await tx.booking.update({ where: { id: existing.id }, data: { deskId, userEmail: identity.normalizedEmail } });
        }

        updatedCount += 1;
        updatedDates.push(dateKey);
        continue;
      }

      await tx.booking.create({ data: { deskId, userEmail: identity.normalizedEmail, date: targetDate } });
      createdCount += 1;
    }

    await tx.recurringBooking.deleteMany({
      where: {
        deskId,
        weekday: { in: uniqueWeekdays },
        validFrom: { lte: parsedValidTo },
        OR: [{ validTo: null }, { validTo: { gte: parsedValidFrom } }]
      }
    });

    const recurringBookings = await Promise.all(
      uniqueWeekdays.map((weekday) => tx.recurringBooking.create({
        data: {
          deskId,
          userEmail: identity.normalizedEmail,
          weekday,
          validFrom: parsedValidFrom,
          validTo: parsedValidTo
        }
      }))
    );

    return {
      kind: 'ok' as const,
      payload: {
        recurringBookings,
        createdCount,
        updatedCount,
        skippedCount: skippedDates.length,
        skippedDates,
        updatedDates
      }
    };
  });

  if (result.kind === 'conflict') {
    sendConflict(res, result.message, result.details);
    return;
  }

  res.status(201).json(result.payload);
});

app.get('/recurring-bookings', async (req, res) => {
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const recurringBookings = await prisma.recurringBooking.findMany({
    where: floorplanId ? { desk: { floorplanId } } : undefined,
    orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }]
  });

  res.status(200).json(recurringBookings);
});

app.post('/admin/floorplans', requireAdmin, async (req, res) => {
  const { name, imageUrl } = req.body as { name?: string; imageUrl?: string };

  if (!name || !imageUrl) {
    res.status(400).json({ error: 'validation', message: 'name and imageUrl are required' });
    return;
  }

  const floorplan = await prisma.floorplan.create({ data: { name, imageUrl } });
  res.status(201).json(floorplan);
});

app.patch('/admin/floorplans/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { name, imageUrl } = req.body as { name?: string; imageUrl?: string };
  if (typeof name === 'undefined' && typeof imageUrl === 'undefined') {
    res.status(400).json({ error: 'validation', message: 'name or imageUrl must be provided' });
    return;
  }

  if (typeof name === 'string' && name.trim().length === 0) {
    res.status(400).json({ error: 'validation', message: 'name must not be empty' });
    return;
  }

  try {
    const updatedFloorplan = await prisma.floorplan.update({
      where: { id },
      data: {
        ...(typeof name === 'string' ? { name: name.trim() } : {}),
        ...(typeof imageUrl === 'string' ? { imageUrl } : {})
      }
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

  const { name, x, y } = req.body as { name?: string; x?: number; y?: number };

  if (!name || typeof x !== 'number' || typeof y !== 'number') {
    res.status(400).json({ error: 'validation', message: 'name, x and y are required' });
    return;
  }

  const floorplan = await prisma.floorplan.findUnique({ where: { id } });
  if (!floorplan) {
    res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
    return;
  }

  const desk = await prisma.desk.create({ data: { floorplanId: id, name, x, y } });
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

  const { name, x, y } = req.body as { name?: string; x?: number; y?: number };
  const hasName = typeof name !== 'undefined';
  const hasX = typeof x !== 'undefined';
  const hasY = typeof y !== 'undefined';

  if (!hasName && !hasX && !hasY) {
    res.status(400).json({ error: 'validation', message: 'name, x or y must be provided' });
    return;
  }

  if (hasName && name.trim().length === 0) {
    res.status(400).json({ error: 'validation', message: 'name must not be empty' });
    return;
  }

  if (hasX && typeof x !== 'number') {
    res.status(400).json({ error: 'validation', message: 'x must be a number' });
    return;
  }

  if (hasY && typeof y !== 'number') {
    res.status(400).json({ error: 'validation', message: 'y must be a number' });
    return;
  }

  const data: { name?: string; x?: number; y?: number } = {};
  if (hasName) data.name = name.trim();
  if (hasX) data.x = x;
  if (hasY) data.y = y;

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
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
  });

  if (!isProd) {
    const duplicateGroups = findDuplicateUserDateGroups(bookings);
    if (duplicateGroups.length > 0) {
      console.warn('BOOKINGS_DUPLICATES_DETECTED', { count: duplicateGroups.length, sample: duplicateGroups.slice(0, 10) });
    }
  }

  const employeesByEmail = await getActiveEmployeesByEmail(bookings.map((booking) => booking.userEmail));
  const enrichedBookings = bookings.map((booking) => ({
    ...booking,
    employeeId: employeesByEmail.get(normalizeEmail(booking.userEmail))?.id,
    userDisplayName: employeesByEmail.get(normalizeEmail(booking.userEmail))?.displayName
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
      select: { id: true, userEmail: true, date: true, createdAt: true },
      orderBy: [{ date: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
    });

    const emails = Array.from(new Set(bookings.map((booking) => normalizeEmail(booking.userEmail))));
    const employees = emails.length > 0
      ? await tx.employee.findMany({ where: { email: { in: emails } }, select: { email: true, entraOid: true } })
      : [];
    const entraByEmail = new Map(employees.map((employee) => [normalizeEmail(employee.email), employee.entraOid]));

    const keepByKey = new Map<string, string>();
    const duplicatesToDelete: string[] = [];

    for (const booking of bookings) {
      const normalizedEmail = normalizeEmail(booking.userEmail);
      const key = `${entraByEmail.get(normalizedEmail) ?? normalizedEmail}|${toISODateOnly(booking.date)}`;
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

  const { userEmail, date, deskId } = req.body as { userEmail?: string; date?: string; deskId?: string };

  if (!userEmail && !date && !deskId) {
    res.status(400).json({ error: 'validation', message: 'userEmail, deskId or date must be provided' });
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

  if (nextDate.getTime() !== existing.date.getTime() || nextDeskId !== existing.deskId) {
    const conflictingBooking = await prisma.booking.findFirst({
      where: {
        id: { not: existing.id },
        deskId: nextDeskId,
        date: nextDate
      }
    });

    if (conflictingBooking) {
      sendConflict(res, 'Desk is already booked for this date', {
        deskId: nextDeskId,
        date,
        bookingId: conflictingBooking.id
      });
      return;
    }

  }

  const userDateConflict = await prisma.booking.findFirst({
    where: {
      id: { not: existing.id },
      userEmail: nextUserEmail,
      date: nextDate
    },
    include: { desk: { select: { id: true, name: true } } }
  });

  if (userDateConflict) {
    sendConflict(res, 'User already has a booking for this date', {
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
      ...(deskId ? { deskId: nextDeskId } : {})
    }
  });

  res.status(200).json(updated);
});

app.get('/admin/recurring-bookings', requireAdmin, async (req, res) => {
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const recurringBookings = await prisma.recurringBooking.findMany({
    where: floorplanId ? { desk: { floorplanId } } : undefined,
    include: {
      desk: {
        select: {
          id: true,
          name: true,
          floorplanId: true
        }
      }
    },
    orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }]
  });

  res.status(200).json(recurringBookings);
});

app.delete('/admin/recurring-bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    await prisma.recurringBooking.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Recurring booking not found' });
      return;
    }
    throw error;
  }
});

app.patch('/admin/recurring-bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { userEmail, weekday, validFrom, validTo } = req.body as {
    userEmail?: string;
    weekday?: number;
    validFrom?: string;
    validTo?: string | null;
  };

  if (!userEmail && typeof weekday !== 'number' && !validFrom && typeof validTo === 'undefined') {
    res.status(400).json({ error: 'validation', message: 'No fields to update' });
    return;
  }

  const existing = await prisma.recurringBooking.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'not_found', message: 'Recurring booking not found' });
    return;
  }

  if (typeof weekday === 'number' && (weekday < 0 || weekday > 6)) {
    res.status(400).json({ error: 'validation', message: 'weekday must be between 0 and 6' });
    return;
  }

  const parsedValidFromValue = validFrom ? toDateOnly(validFrom) : existing.validFrom;
  const parsedValidTo =
    typeof validTo === 'undefined' ? existing.validTo : validTo === null || validTo === '' ? null : toDateOnly(validTo);

  if ((validFrom && !parsedValidFromValue) || (typeof validTo === 'string' && validTo !== '' && !parsedValidTo)) {
    res.status(400).json({ error: 'validation', message: 'validFrom/validTo must be in YYYY-MM-DD format' });
    return;
  }

  const parsedValidFrom = parsedValidFromValue as Date;

  if (parsedValidTo && parsedValidTo < parsedValidFrom) {
    res.status(400).json({ error: 'validation', message: 'validTo must be on or after validFrom' });
    return;
  }

  const updated = await prisma.recurringBooking.update({
    where: { id },
    data: {
      ...(userEmail ? { userEmail: normalizeEmail(userEmail) } : {}),
      ...(typeof weekday === 'number' ? { weekday } : {}),
      ...(validFrom ? { validFrom: parsedValidFrom } : {}),
      ...(typeof validTo !== 'undefined' ? { validTo: parsedValidTo } : {})
    }
  });

  res.status(200).json(updated);
});

const start = async () => {
  await ensureBreakglassAdmin();
  app.listen(port, '0.0.0.0', () => {
    console.log(`API listening on ${port}`);
  });
};

void start();
