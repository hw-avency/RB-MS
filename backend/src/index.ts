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
const FRONTEND_ORIGINS = (process.env.CORS_ORIGIN ?? process.env.FRONTEND_ORIGIN ?? process.env.FRONTEND_URL ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const DEFAULT_USER_PASSWORD = process.env.DEFAULT_USER_PASSWORD ?? 'ChangeMe123!';
const PASSWORD_SALT_ROUNDS = Number(process.env.PASSWORD_SALT_ROUNDS ?? 12);
const isProd = process.env.NODE_ENV === 'production';
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

app.use(
  cors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (FRONTEND_ORIGINS.length === 0) {
        callback(null, true);
        return;
      }

      callback(null, FRONTEND_ORIGINS.includes(origin));
    },
    credentials: true
  })
);
app.use(express.json());

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type EmployeeRole = 'admin' | 'user';
type SessionRecord = { id: string; userId: string; csrfToken: string; expiresAt: number };
type AuthUser = { id: string; email: string; displayName: string; role: EmployeeRole; isActive: boolean };

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      authUser?: AuthUser;
      authSession?: SessionRecord;
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
const CSRF_COOKIE_NAME = 'rbms_csrf';
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

  res.cookie(CSRF_COOKIE_NAME, session.csrfToken, {
    httpOnly: false,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
};

const clearSessionCookies = (res: express.Response) => {
  const options = { httpOnly: true, secure: cookieSecure, sameSite: cookieSameSite, path: '/' };
  res.clearCookie(SESSION_COOKIE_NAME, options);
  res.clearCookie(CSRF_COOKIE_NAME, { ...options, httpOnly: false });
};

const createSession = (userId: string): SessionRecord => {
  const now = Date.now();
  const session: SessionRecord = {
    id: crypto.randomUUID(),
    userId,
    csrfToken: crypto.randomUUID(),
    expiresAt: now + SESSION_TTL_MS
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

const requireCsrf: express.RequestHandler = (req, res, next) => {
  const isSafeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (isSafeMethod || req.path === '/auth/login') {
    next();
    return;
  }

  const csrfHeader = req.header('x-csrf-token');
  const csrfCookie = parseCookies(req.headers.cookie)[CSRF_COOKIE_NAME];
  const expected = req.authSession?.csrfToken;
  if (!expected || !csrfHeader || !csrfCookie || expected !== csrfHeader || csrfHeader !== csrfCookie) {
    res.status(403).json({ error: 'forbidden', message: 'Invalid CSRF token' });
    return;
  }

  next();
};

const attachAuthUser: express.RequestHandler = async (req, _res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) {
    next();
    return;
  }

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    destroySession(sessionId);
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

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

const toISODateOnly = (value: Date): string => value.toISOString().slice(0, 10);

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

const isDateWithinRange = (date: Date, start: Date, end?: Date | null): boolean => {
  if (date < start) {
    return false;
  }

  if (end && date > end) {
    return false;
  }

  return true;
};

const getRouteId = (value: string | string[] | undefined): string | null => {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
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

const isValidEmailInput = (value: string): boolean => value.includes('@');

const isValidEmployeeRole = (value: string): value is EmployeeRole => value === 'admin' || value === 'user';

const employeeSelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true
} satisfies Prisma.EmployeeSelect;

const getActiveEmployeesByEmail = async (emails: string[]) => {
  if (emails.length === 0) {
    return new Map<string, { displayName: string }>();
  }

  const uniqueEmails = Array.from(new Set(emails.map((email) => normalizeEmail(email))));
  const employees = await prisma.employee.findMany({
    where: {
      isActive: true,
      email: { in: uniqueEmails }
    },
    select: {
      email: true,
      displayName: true
    }
  });

  return new Map(employees.map((employee) => [employee.email, { displayName: employee.displayName }]));
};

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

    return user;
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
    scope: 'openid profile email',
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
        scope: 'openid profile email'
      })
    });

    if (!tokenResponse.ok) {
      res.status(401).json({ code: 'OIDC_VALIDATION_FAILED', message: 'Token exchange failed' });
      return;
    }

    const tokenPayload = await tokenResponse.json() as { id_token?: string };
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
    const session = createSession(user.id);
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
    console.log('LOGIN_SUCCESS', { requestId, userId: user.id, role: user.role });

    res.status(200).json({
      user: {
        id: user.id,
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
  console.log('ME_CHECK', { requestId, hasSession: Boolean(req.authSession && req.authUser) });

  if (!req.authUser) {
    res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    return;
  }

  applySessionCookies(res, req.authSession as SessionRecord);
  res.status(200).json({
    user: {
      id: req.authUser.id,
      email: req.authUser.email,
      displayName: req.authUser.displayName,
      role: req.authUser.role
    }
  });
});

app.use(requireAuthenticated);
app.use(requireCsrf);

app.get('/admin/employees', requireAdmin, async (_req, res) => {
  const employees = await prisma.employee.findMany({
    select: employeeSelect,
    orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }, { email: 'asc' }]
  });

  res.status(200).json(employees);
});

app.get('/employees', async (_req, res) => {
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: {
      id: true,
      email: true,
      displayName: true
    },
    orderBy: [{ displayName: 'asc' }, { email: 'asc' }]
  });

  res.status(200).json(employees);
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
          role: role ?? 'user'
        },
        select: employeeSelect
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

      return createdEmployee;
    });

    res.status(201).json(employee);
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
  const { deskId, userEmail, date } = req.body as { deskId?: string; userEmail?: string; date?: string };

  if (!deskId || !userEmail || !date) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail and date are required' });
    return;
  }

  const parsedDate = toDateOnly(date);
  if (!parsedDate) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const existingBooking = await prisma.booking.findUnique({
    where: {
      deskId_date: {
        deskId,
        date: parsedDate
      }
    }
  });

  if (existingBooking) {
    sendConflict(res, 'Desk is already booked for this date', {
      deskId,
      date,
      bookingId: existingBooking.id
    });
    return;
  }

  const recurringConflict = await prisma.recurringBooking.findFirst({
    where: {
      deskId,
      weekday: parsedDate.getUTCDay(),
      validFrom: { lte: parsedDate },
      OR: [{ validTo: null }, { validTo: { gte: parsedDate } }]
    }
  });

  if (recurringConflict) {
    sendConflict(res, 'Desk has a recurring booking conflict for this date', {
      deskId,
      date,
      recurringBookingId: recurringConflict.id
    });
    return;
  }

  const normalizedUserEmail = normalizeEmail(userEmail);
  const booking = await prisma.booking.create({
    data: {
      deskId,
      userEmail: normalizedUserEmail,
      date: parsedDate
    }
  });

  res.status(201).json(booking);
});

app.post('/bookings/range', async (req, res) => {
  const { deskId, userEmail, from, to, weekdaysOnly } = req.body as {
    deskId?: string;
    userEmail?: string;
    from?: string;
    to?: string;
    weekdaysOnly?: boolean;
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

  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const includeWeekdaysOnly = weekdaysOnly !== false;
  const targetDates = datesInRange(parsedFrom, parsedTo).filter((date) => {
    if (!includeWeekdaysOnly) {
      return true;
    }

    const day = date.getUTCDay();
    return day >= 1 && day <= 5;
  });

  if (targetDates.length === 0) {
    res.status(201).json({ createdCount: 0, dates: [] });
    return;
  }

  const [singleConflicts, recurringRules] = await Promise.all([
    prisma.booking.findMany({
      where: {
        deskId,
        date: { in: targetDates }
      },
      orderBy: { date: 'asc' }
    }),
    prisma.recurringBooking.findMany({
      where: {
        deskId,
        validFrom: { lte: parsedTo },
        OR: [{ validTo: null }, { validTo: { gte: parsedFrom } }]
      }
    })
  ]);

  const conflictDates = new Set(singleConflicts.map((booking) => toISODateOnly(booking.date)));
  for (const date of targetDates) {
    if (conflictDates.has(toISODateOnly(date))) {
      continue;
    }

    const recurringConflict = recurringRules.find(
      (rule) => rule.weekday === date.getUTCDay() && isDateWithinRange(date, rule.validFrom, rule.validTo)
    );
    if (recurringConflict) {
      conflictDates.add(toISODateOnly(date));
    }
  }

  if (conflictDates.size > 0) {
    const sortedConflicts = Array.from(conflictDates).sort();
    sendConflict(res, 'Range booking has conflicting dates', {
      deskId,
      from,
      to,
      weekdaysOnly: includeWeekdaysOnly,
      conflictingDates: sortedConflicts,
      conflictingDatesPreview: sortedConflicts.slice(0, 10)
    });
    return;
  }

  const normalizedUserEmail = normalizeEmail(userEmail);
  const created = await prisma.$transaction(async (tx) => {
    await tx.booking.createMany({
      data: targetDates.map((date) => ({ deskId, userEmail: normalizedUserEmail, date }))
    });

    return targetDates.map((date) => toISODateOnly(date));
  });

  res.status(201).json({ createdCount: created.length, dates: created });
});

app.get('/bookings', async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const where: Prisma.BookingWhereInput = {};

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

  const employeesByEmail = await getActiveEmployeesByEmail(bookings.map((booking) => booking.userEmail));
  const enrichedBookings = bookings.map((booking) => ({
    ...booking,
    userDisplayName: employeesByEmail.get(normalizeEmail(booking.userEmail))?.displayName
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
  const weekday = parsedDate.getUTCDay();

  const [singleBookings, recurringBookings] = await Promise.all([
    prisma.booking.findMany({
      where: {
        date: parsedDate,
        deskId: { in: deskIds }
      }
    }),
    prisma.recurringBooking.findMany({
      where: {
        deskId: { in: deskIds },
        weekday,
        validFrom: { lte: parsedDate },
        OR: [{ validTo: null }, { validTo: { gte: parsedDate } }]
      },
      orderBy: { createdAt: 'asc' }
    })
  ]);

  const employeesByEmail = await getActiveEmployeesByEmail([
    ...singleBookings.map((booking) => booking.userEmail),
    ...recurringBookings.map((booking) => booking.userEmail)
  ]);

  const singleByDeskId = new Map(singleBookings.map((booking) => [booking.deskId, booking]));
  const recurringByDeskId = new Map(recurringBookings.map((booking) => [booking.deskId, booking]));

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
          userDisplayName: employeesByEmail.get(normalizeEmail(single.userEmail))?.displayName,
          deskName: desk.name,
        deskId: desk.id,
          type: 'single' as const
        }
      };
    }

    const recurring = recurringByDeskId.get(desk.id);
    if (recurring) {
      return {
        id: desk.id,
        name: desk.name,
        x: desk.x,
        y: desk.y,
        status: 'booked' as const,
        booking: {
          id: recurring.id,
          userEmail: recurring.userEmail,
          userDisplayName: employeesByEmail.get(normalizeEmail(recurring.userEmail))?.displayName,
          deskName: desk.name,
        deskId: desk.id,
          type: 'recurring' as const
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

  const uniquePeopleByEmail = new Map<string, { email: string; userEmail: string; displayName?: string; deskName?: string; deskId?: string }>();
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

  const existingBookings = await prisma.booking.findMany({
    where: {
      deskId,
      date: {
        gte: parsedValidFrom,
        ...(parsedValidTo ? { lte: parsedValidTo } : {})
      }
    },
    orderBy: { date: 'asc' }
  });

  const conflictingBooking = existingBookings.find((booking) => {
    return booking.date.getUTCDay() === weekday && isDateWithinRange(booking.date, parsedValidFrom, parsedValidTo);
  });

  if (conflictingBooking) {
    sendConflict(res, 'Recurring booking conflicts with an existing single-day booking', {
      deskId,
      weekday,
      validFrom,
      validTo: validTo ?? null,
      bookingId: conflictingBooking.id,
      bookingDate: conflictingBooking.date.toISOString().slice(0, 10)
    });
    return;
  }

  const normalizedUserEmail = normalizeEmail(userEmail);

  const recurringBooking = await prisma.recurringBooking.create({
    data: {
      deskId,
      userEmail: normalizedUserEmail,
      weekday,
      validFrom: parsedValidFrom,
      validTo: parsedValidTo
    }
  });

  res.status(201).json(recurringBooking);
});

app.post('/recurring-bookings/bulk', async (req, res) => {
  const { deskId, userEmail, weekdays, validFrom, validTo } = req.body as {
    deskId?: string;
    userEmail?: string;
    weekdays?: number[];
    validFrom?: string;
    validTo?: string;
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

  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const overlappingRecurring = await prisma.recurringBooking.findMany({
    where: {
      deskId,
      weekday: { in: uniqueWeekdays },
      validFrom: { lte: parsedValidTo },
      OR: [{ validTo: null }, { validTo: { gte: parsedValidFrom } }]
    },
    orderBy: [{ weekday: 'asc' }, { validFrom: 'asc' }]
  });

  if (overlappingRecurring.length > 0) {
    sendConflict(res, 'Recurring series conflicts with existing recurring booking', {
      deskId,
      weekdays: uniqueWeekdays,
      validFrom,
      validTo: toISODateOnly(parsedValidTo),
      conflicts: overlappingRecurring.slice(0, 10).map((conflict) => ({
        id: conflict.id,
        weekday: conflict.weekday,
        validFrom: toISODateOnly(conflict.validFrom),
        validTo: conflict.validTo ? toISODateOnly(conflict.validTo) : null
      }))
    });
    return;
  }

  const targetDates = datesInRange(parsedValidFrom, parsedValidTo).filter((date) => uniqueWeekdays.includes(date.getUTCDay()));
  const conflictingSingles = await prisma.booking.findMany({
    where: {
      deskId,
      date: { in: targetDates }
    },
    orderBy: { date: 'asc' }
  });

  if (conflictingSingles.length > 0) {
    const conflictingDates = conflictingSingles.map((booking) => toISODateOnly(booking.date));
    sendConflict(res, 'Recurring series conflicts with existing single-day bookings', {
      deskId,
      weekdays: uniqueWeekdays,
      validFrom,
      validTo: toISODateOnly(parsedValidTo),
      conflictingDates,
      conflictingDatesPreview: conflictingDates.slice(0, 10)
    });
    return;
  }

  const normalizedUserEmail = normalizeEmail(userEmail);
  const recurringBookings = await prisma.$transaction(
    uniqueWeekdays.map((weekday) =>
      prisma.recurringBooking.create({
        data: {
          deskId,
          userEmail: normalizedUserEmail,
          weekday,
          validFrom: parsedValidFrom,
          validTo: parsedValidTo
        }
      })
    )
  );

  res.status(201).json(recurringBookings);
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
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  if (!date) {
    res.status(400).json({ error: 'validation', message: 'date is required' });
    return;
  }

  const parsedDate = toDateOnly(date);
  if (!parsedDate) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const bookings = await prisma.booking.findMany({
    where: {
      date: parsedDate,
      ...(floorplanId ? { desk: { floorplanId } } : {})
    },
    include: {
      desk: {
        select: {
          id: true,
          name: true,
          floorplanId: true
        }
      }
    },
    orderBy: [{ createdAt: 'asc' }]
  });

  res.status(200).json(bookings);
});

app.delete('/admin/bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    await prisma.booking.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Booking not found' });
      return;
    }
    throw error;
  }
});

app.patch('/admin/bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { userEmail, date } = req.body as { userEmail?: string; date?: string };

  if (!userEmail && !date) {
    res.status(400).json({ error: 'validation', message: 'userEmail or date must be provided' });
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

  if (nextDate.getTime() !== existing.date.getTime()) {
    const conflictingBooking = await prisma.booking.findFirst({
      where: {
        id: { not: existing.id },
        deskId: existing.deskId,
        date: nextDate
      }
    });

    if (conflictingBooking) {
      sendConflict(res, 'Desk is already booked for this date', {
        deskId: existing.deskId,
        date,
        bookingId: conflictingBooking.id
      });
      return;
    }

    const recurringConflict = await prisma.recurringBooking.findFirst({
      where: {
        deskId: existing.deskId,
        weekday: nextDate.getUTCDay(),
        validFrom: { lte: nextDate },
        OR: [{ validTo: null }, { validTo: { gte: nextDate } }]
      }
    });

    if (recurringConflict) {
      sendConflict(res, 'Desk has a recurring booking conflict for this date', {
        deskId: existing.deskId,
        date,
        recurringBookingId: recurringConflict.id
      });
      return;
    }
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: {
      ...(userEmail ? { userEmail: normalizeEmail(userEmail) } : {}),
      ...(date ? { date: nextDate } : {})
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
