import crypto from 'crypto';
import type { RequestHandler } from 'express';
import { prisma } from './prisma';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? 'admin@example.com').trim().toLowerCase();
const JWT_SECRET = process.env.JWT_SECRET;
const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID;
const ENTRA_API_AUDIENCE = process.env.ENTRA_API_AUDIENCE;
const ENTRA_JWKS_CACHE_TTL_SECONDS = Number(process.env.ENTRA_JWKS_CACHE_TTL_SECONDS ?? 3600);

if (!JWT_SECRET) throw new Error('JWT_SECRET env var is required');
if (!ENTRA_TENANT_ID) throw new Error('ENTRA_TENANT_ID env var is required');
if (!ENTRA_API_AUDIENCE) throw new Error('ENTRA_API_AUDIENCE env var is required');

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

type DiscoveryDocument = { issuer: string; jwks_uri: string };
type Jwk = { kty: string; kid: string; n: string; e: string; alg?: string; use?: string };
type Jwks = { keys: Jwk[] };

type AuthUser = {
  employeeId: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  authProvider: 'breakglass' | 'entra';
};

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
  | { ok: true; identity: { email: string; displayName: string } }
  | { ok: false; reason: AuthFailReason; receivedAud?: unknown; expectedAudiences?: string[] };

let discoveryCache: { expiresAt: number; document: DiscoveryDocument } | null = null;
let jwksCache: { expiresAt: number; document: Jwks } | null = null;

const discoveryUrl = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0/.well-known/openid-configuration`;

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

const getDiscoveryDocument = async (): Promise<DiscoveryDocument> => {
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) return discoveryCache.document;
  const response = await fetch(discoveryUrl);
  if (!response.ok) throw new Error('Failed to fetch Entra discovery document');
  const doc = (await response.json()) as DiscoveryDocument;
  if (!doc.issuer || !doc.jwks_uri) throw new Error('Invalid Entra discovery document');
  discoveryCache = { document: doc, expiresAt: Date.now() + ENTRA_JWKS_CACHE_TTL_SECONDS * 1000 };
  return doc;
};

const getJwksDocument = async (jwksUri: string): Promise<Jwks> => {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.document;
  const response = await fetch(jwksUri);
  if (!response.ok) throw new Error('Failed to fetch Entra JWKS');
  const doc = (await response.json()) as Jwks;
  jwksCache = { document: doc, expiresAt: Date.now() + ENTRA_JWKS_CACHE_TTL_SECONDS * 1000 };
  return doc;
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
    // noop: diagnostics snapshot remains null-filled on decode failure
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
    if (parsed.authProvider !== 'breakglass' || parsed.isAdmin !== true) {
      return { ok: false, reason: 'missing_claims' };
    }
    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return { ok: false, reason: 'expired' };
    }
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

    let discovery: DiscoveryDocument;
    let jwks: Jwks;
    try {
      discovery = await getDiscoveryDocument();
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

    const aud = claims.aud;
    const tokenAudiences = Array.isArray(aud) ? aud : [aud];
    const audienceValid = tokenAudiences.some(
      (audience): audience is string => typeof audience === 'string' && ACCEPTED_ENTRA_AUDIENCES.includes(audience)
    );
    if (!audienceValid) {
      return {
        ok: false,
        reason: 'bad_audience',
        receivedAud: aud,
        expectedAudiences: ACCEPTED_ENTRA_AUDIENCES
      };
    }

    const emailClaim =
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      (typeof claims.upn === 'string' && claims.upn) ||
      (typeof claims.email === 'string' && claims.email) ||
      null;
    if (!emailClaim) return { ok: false, reason: 'missing_claims' };

    const email = normalizeEmail(emailClaim);
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : email.split('@')[0] || email;

    return { ok: true, identity: { email, displayName: name } };
  } catch {
    return { ok: false, reason: 'missing_claims' };
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
    req.user = {
      employeeId: breakglassResult.payload.sub,
      email: normalizeEmail(breakglassResult.payload.email),
      displayName: breakglassResult.payload.displayName,
      isAdmin: true,
      authProvider: 'breakglass'
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
    res.status(401).json({ error: 'unauthorized', code: entraResult.reason, message: 'Invalid token' });
    return;
  }

  logAuthValidation(req, { branch: 'entra', result: 'ok', snapshot });

  const isBootstrapAdmin = entraResult.identity.email === ADMIN_EMAIL;
  const employee = await prisma.employee.upsert({
    where: { email: entraResult.identity.email },
    create: {
      email: entraResult.identity.email,
      displayName: entraResult.identity.displayName,
      isActive: true,
      isAdmin: isBootstrapAdmin
    },
    update: {
      displayName: entraResult.identity.displayName,
      isActive: true,
      ...(isBootstrapAdmin ? { isAdmin: true } : {})
    },
    select: { id: true, email: true, displayName: true, isAdmin: true }
  });

  req.user = {
    employeeId: employee.id,
    email: employee.email,
    displayName: employee.displayName,
    isAdmin: employee.isAdmin,
    authProvider: 'entra'
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
