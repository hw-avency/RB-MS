import crypto from 'crypto';
import type { RequestHandler } from 'express';
import { prisma } from './prisma';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? 'admin@example.com').trim().toLowerCase();
const JWT_SECRET = process.env.JWT_SECRET;
const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID;
const ENTRA_API_AUDIENCE = process.env.ENTRA_API_AUDIENCE;
const ENTRA_JWKS_CACHE_TTL_SECONDS = Number(process.env.ENTRA_JWKS_CACHE_TTL_SECONDS ?? 3600);

const GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID;
const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID;
const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const GRAPH_PHOTO_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

if (!JWT_SECRET) throw new Error('JWT_SECRET env var is required');
if (!ENTRA_TENANT_ID) throw new Error('ENTRA_TENANT_ID env var is required');
if (!ENTRA_API_AUDIENCE) throw new Error('ENTRA_API_AUDIENCE env var is required');

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

type DiscoveryDocument = { issuer: string; jwks_uri: string };
type Jwk = { kty: string; kid: string; n: string; e: string; alg?: string; use?: string };
type Jwks = { keys: Jwk[] };

type BreakglassJwtPayload = {
  sub: string;
  email: string;
  displayName: string;
  isAdmin: true;
  authProvider: 'breakglass';
  exp: number;
};

type AuthFailReason = 'bad_signature' | 'bad_issuer' | 'bad_audience' | 'expired' | 'jwks_fetch_failed' | 'missing_claims';

type JwtDiagnosticSnapshot = {
  alg: string | null;
  claims: {
    aud: unknown;
    iss: unknown;
    scp: unknown;
    tid: unknown;
    exp: unknown;
  };
};

type BreakglassVerificationResult =
  | { ok: true; payload: BreakglassJwtPayload }
  | { ok: false; reason: AuthFailReason };

type EntraVerificationResult =
  | { ok: true; identity: { email: string; displayName: string; externalId: string } }
  | { ok: false; reason: AuthFailReason; receivedAud?: unknown; expectedAudiences?: string[] };

const discoveryCache = new Map<string, { expiresAt: number; document: DiscoveryDocument }>();
const jwksCache = new Map<string, { expiresAt: number; document: Jwks }>();
let graphTokenCache: { token: string; expiresAt: number } | null = null;

const ENTRA_V1_ISSUER_PREFIX = 'https://sts.windows.net/';
const v1DiscoveryUrl = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/.well-known/openid-configuration`;
const v2DiscoveryUrl = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0/.well-known/openid-configuration`;

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const buildAcceptedAudiences = (configuredAudience: string): string[] => {
  const trimmed = configuredAudience.trim();
  const audiences = new Set<string>([trimmed]);

  if (GUID_REGEX.test(trimmed)) audiences.add(`api://${trimmed}`);

  if (trimmed.startsWith('api://')) {
    const withoutPrefix = trimmed.slice('api://'.length);
    if (GUID_REGEX.test(withoutPrefix)) audiences.add(withoutPrefix);
  }

  return Array.from(audiences);
};

const ACCEPTED_ENTRA_AUDIENCES = buildAcceptedAudiences(ENTRA_API_AUDIENCE);

const toBase64Url = (value: string) => Buffer.from(value).toString('base64url');
const fromBase64Url = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const getDiscoveryDocument = async (url: string): Promise<DiscoveryDocument> => {
  const cached = discoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.document;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to fetch Entra discovery document');
  const doc = (await response.json()) as DiscoveryDocument;
  if (!doc.issuer || !doc.jwks_uri) throw new Error('Invalid Entra discovery document');
  discoveryCache.set(url, { document: doc, expiresAt: Date.now() + ENTRA_JWKS_CACHE_TTL_SECONDS * 1000 });
  return doc;
};

const getJwksDocument = async (jwksUri: string): Promise<Jwks> => {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > Date.now()) return cached.document;
  const response = await fetch(jwksUri);
  if (!response.ok) throw new Error('Failed to fetch Entra JWKS');
  const doc = (await response.json()) as Jwks;
  jwksCache.set(jwksUri, { document: doc, expiresAt: Date.now() + ENTRA_JWKS_CACHE_TTL_SECONDS * 1000 });
  return doc;
};

const getDiscoveryUrlForIssuer = (issuer: unknown): string => {
  if (typeof issuer === 'string' && issuer.startsWith(ENTRA_V1_ISSUER_PREFIX)) return v1DiscoveryUrl;
  return v2DiscoveryUrl;
};

const decodeJwtSnapshot = (token: string): JwtDiagnosticSnapshot => {
  const [headerBase64, payloadBase64] = token.split('.');
  let alg: string | null = null;
  const claims: JwtDiagnosticSnapshot['claims'] = { aud: null, iss: null, scp: null, tid: null, exp: null };

  try {
    if (headerBase64) {
      const header = JSON.parse(fromBase64Url(headerBase64)) as { alg?: string };
      alg = typeof header.alg === 'string' ? header.alg : null;
    }
  } catch {
    alg = null;
  }

  try {
    if (payloadBase64) {
      const payload = JSON.parse(fromBase64Url(payloadBase64)) as Record<string, unknown>;
      claims.aud = payload.aud ?? null;
      claims.iss = payload.iss ?? null;
      claims.scp = payload.scp ?? null;
      claims.tid = payload.tid ?? null;
      claims.exp = payload.exp ?? null;
    }
  } catch {
    // noop
  }

  return { alg, claims };
};

const logAuthValidation = (req: Parameters<RequestHandler>[0], payload: {
  branch: 'breakglass' | 'entra';
  result: 'ok' | 'fail';
  reason?: AuthFailReason;
  snapshot: JwtDiagnosticSnapshot;
}) => {
  console.info(
    JSON.stringify({
      event: 'auth_validation',
      path: req.path,
      method: req.method,
      branch: payload.branch,
      result: payload.result,
      ...(payload.reason ? { reason: payload.reason } : {}),
      alg: payload.snapshot.alg,
      claims: payload.snapshot.claims
    })
  );
};

const verifyBreakglassToken = (token: string): BreakglassVerificationResult => {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return { ok: false, reason: 'missing_claims' };
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  if (expected !== signature) return { ok: false, reason: 'bad_signature' };

  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as BreakglassJwtPayload;
    if (parsed.authProvider !== 'breakglass' || parsed.isAdmin !== true) return { ok: false, reason: 'missing_claims' };
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
    return { ok: true, payload: parsed };
  } catch {
    return { ok: false, reason: 'missing_claims' };
  }
};

const verifyEntraJwt = async (token: string): Promise<EntraVerificationResult> => {
  const [headerBase64, payloadBase64, signatureBase64] = token.split('.');
  if (!headerBase64 || !payloadBase64 || !signatureBase64) return { ok: false, reason: 'missing_claims' };

  try {
    const header = JSON.parse(fromBase64Url(headerBase64)) as { kid?: string; alg?: string };
    const claims = JSON.parse(fromBase64Url(payloadBase64)) as Record<string, unknown>;

    if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'missing_claims' };

    const discoveryUrl = getDiscoveryUrlForIssuer(claims.iss);
    let discovery: DiscoveryDocument;
    let jwks: Jwks;
    try {
      discovery = await getDiscoveryDocument(discoveryUrl);
      jwks = await getJwksDocument(discovery.jwks_uri);
    } catch {
      return { ok: false, reason: 'jwks_fetch_failed' };
    }

    const key = jwks.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
    if (!key) return { ok: false, reason: 'bad_signature' };

    const publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerBase64}.${payloadBase64}`);
    verifier.end();
    const isValidSignature = verifier.verify(publicKey, Buffer.from(signatureBase64, 'base64url'));
    if (!isValidSignature) return { ok: false, reason: 'bad_signature' };

    const now = Math.floor(Date.now() / 1000);
    const exp = typeof claims.exp === 'number' ? claims.exp : 0;
    const nbf = typeof claims.nbf === 'number' ? claims.nbf : 0;
    if (exp <= now || nbf > now) return { ok: false, reason: 'expired' };
    if (claims.iss !== discovery.issuer) return { ok: false, reason: 'bad_issuer' };
    if (claims.tid !== ENTRA_TENANT_ID) return { ok: false, reason: 'bad_issuer' };

    const aud = claims.aud;
    const tokenAudiences = Array.isArray(aud) ? aud : [aud];
    const audienceValid = tokenAudiences.some(
      (audience): audience is string => typeof audience === 'string' && ACCEPTED_ENTRA_AUDIENCES.includes(audience)
    );
    if (!audienceValid) {
      return { ok: false, reason: 'bad_audience', receivedAud: aud, expectedAudiences: ACCEPTED_ENTRA_AUDIENCES };
    }

    const emailClaim =
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      (typeof claims.upn === 'string' && claims.upn) ||
      (typeof claims.email === 'string' && claims.email) ||
      null;
    const oid = typeof claims.oid === 'string' ? claims.oid : null;
    if (!emailClaim || !oid) return { ok: false, reason: 'missing_claims' };

    const email = normalizeEmail(emailClaim);
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : email.split('@')[0] || email;
    return { ok: true, identity: { email, displayName: name, externalId: oid } };
  } catch {
    return { ok: false, reason: 'missing_claims' };
  }
};

const graphEnabled = (): boolean => Boolean(GRAPH_TENANT_ID && GRAPH_CLIENT_ID && GRAPH_CLIENT_SECRET);

const getGraphAppToken = async (): Promise<string | null> => {
  if (!graphEnabled()) return null;
  if (graphTokenCache && graphTokenCache.expiresAt > Date.now() + 60_000) return graphTokenCache.token;

  const tokenUrl = `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: GRAPH_CLIENT_ID!,
    client_secret: GRAPH_CLIENT_SECRET!,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { access_token: string; expires_in: number };
  graphTokenCache = { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
  return payload.access_token;
};

const fetchGraphPhoto = async (externalId: string): Promise<string | null> => {
  try {
    const token = await getGraphAppToken();
    if (!token) return null;

    const response = await fetch(`https://graph.microsoft.com/v1.0/users/${externalId}/photo/$value`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const bytes = await response.arrayBuffer();
    return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  }
};

export const issueBreakglassToken = (user: { employeeId: string; email: string; displayName: string }): string => {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({
      sub: user.employeeId,
      email: user.email,
      displayName: user.displayName,
      isAdmin: true,
      authProvider: 'breakglass',
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8
    })
  );
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
};

export const ensureBreakglassEmployee = async (email: string): Promise<{ id: string; email: string; displayName: string }> => {
  const normalizedEmail = normalizeEmail(email);
  const displayName = normalizedEmail.split('@')[0] || normalizedEmail;

  return prisma.employee.upsert({
    where: { email: normalizedEmail },
    create: { email: normalizedEmail, displayName, isActive: true, isAdmin: true },
    update: { isActive: true, isAdmin: true },
    select: { id: true, email: true, displayName: true }
  });
};

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', code: 'missing_claims', message: 'Missing bearer token' });
    return;
  }

  const token = authorization.slice(7).trim();
  const snapshot = decodeJwtSnapshot(token);
  const breakglassResult = verifyBreakglassToken(token);
  if (breakglassResult.ok) {
    logAuthValidation(req, { branch: 'breakglass', result: 'ok', snapshot });
    const employee = await ensureBreakglassEmployee(breakglassResult.payload.email);
    req.user = {
      employeeId: employee.id,
      email: normalizeEmail(breakglassResult.payload.email),
      displayName: breakglassResult.payload.displayName,
      isAdmin: true,
      authProvider: 'breakglass',
      isActive: true,
      created: false,
      photoBase64: null
    };
    next();
    return;
  }

  const entraResult = await verifyEntraJwt(token);
  if (!entraResult.ok) {
    if (entraResult.reason === 'bad_audience') {
      console.info(
        JSON.stringify({
          event: 'auth_bad_audience',
          path: req.path,
          method: req.method,
          receivedAud: entraResult.receivedAud ?? null,
          expectedAudiences: entraResult.expectedAudiences ?? ACCEPTED_ENTRA_AUDIENCES
        })
      );
    }
    logAuthValidation(req, { branch: 'entra', result: 'fail', reason: entraResult.reason, snapshot });

    const diagnostics = {
      aud: snapshot.claims.aud,
      iss: snapshot.claims.iss,
      tid: snapshot.claims.tid,
      scp: snapshot.claims.scp
    };

    res.status(401).json({ error: 'unauthorized', code: entraResult.reason, message: 'Invalid token', diagnostics });
    return;
  }

  logAuthValidation(req, { branch: 'entra', result: 'ok', snapshot });

  const existing = await prisma.employee.findFirst({
    where: {
      OR: [
        { externalId: entraResult.identity.externalId },
        { email: { equals: entraResult.identity.email, mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      isAdmin: true,
      isActive: true,
      photoBase64: true,
      photoFetchedAt: true
    }
  });

  const shouldRefreshPhoto = graphEnabled() && (
    !existing
    || !existing.photoBase64
    || !existing.photoFetchedAt
    || Date.now() - existing.photoFetchedAt.getTime() > GRAPH_PHOTO_REFRESH_MS
  );

  const nextPhoto = shouldRefreshPhoto ? await fetchGraphPhoto(entraResult.identity.externalId) : null;

  const employee = existing
    ? await prisma.employee.update({
      where: { id: existing.id },
      data: {
        email: entraResult.identity.email,
        displayName: entraResult.identity.displayName,
        externalId: entraResult.identity.externalId,
        isActive: true,
        ...(nextPhoto ? { photoBase64: nextPhoto, photoFetchedAt: new Date() } : {})
      },
      select: { id: true, email: true, displayName: true, isAdmin: true, isActive: true, photoBase64: true }
    })
    : await prisma.employee.create({
      data: {
        email: entraResult.identity.email,
        displayName: entraResult.identity.displayName,
        externalId: entraResult.identity.externalId,
        isActive: true,
        isAdmin: false,
        ...(nextPhoto ? { photoBase64: nextPhoto, photoFetchedAt: new Date() } : {})
      },
      select: { id: true, email: true, displayName: true, isAdmin: true, isActive: true, photoBase64: true }
    });

  req.user = {
    employeeId: employee.id,
    email: employee.email,
    displayName: employee.displayName,
    isAdmin: employee.isAdmin,
    authProvider: 'entra',
    isActive: employee.isActive,
    created: !existing,
    photoBase64: employee.photoBase64
  };
  next();
};

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
    return;
  }
  next();
};

export const bootstrapBreakglassAdmin = async (): Promise<void> => {
  await ensureBreakglassEmployee(ADMIN_EMAIL);
};
