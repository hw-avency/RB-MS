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

let discoveryCache: { expiresAt: number; document: DiscoveryDocument } | null = null;
let jwksCache: { expiresAt: number; document: Jwks } | null = null;

const discoveryUrl = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0/.well-known/openid-configuration`;

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

const verifyBreakglassToken = (token: string): BreakglassJwtPayload | null => {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  if (expected !== signature) return null;

  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as BreakglassJwtPayload;
    if (parsed.authProvider !== 'breakglass' || parsed.isAdmin !== true || parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const verifyEntraJwt = async (token: string): Promise<{ email: string; displayName: string } | null> => {
  const [headerBase64, payloadBase64, signatureBase64] = token.split('.');
  if (!headerBase64 || !payloadBase64 || !signatureBase64) return null;

  try {
    const header = JSON.parse(fromBase64Url(headerBase64)) as { kid?: string; alg?: string };
    const claims = JSON.parse(fromBase64Url(payloadBase64)) as Record<string, unknown>;

    if (header.alg !== 'RS256' || !header.kid) return null;

    const discovery = await getDiscoveryDocument();
    const jwks = await getJwksDocument(discovery.jwks_uri);
    const key = jwks.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
    if (!key) return null;

    const publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerBase64}.${payloadBase64}`);
    verifier.end();
    const isValidSignature = verifier.verify(publicKey, Buffer.from(signatureBase64, 'base64url'));
    if (!isValidSignature) return null;

    const now = Math.floor(Date.now() / 1000);
    const exp = typeof claims.exp === 'number' ? claims.exp : 0;
    const nbf = typeof claims.nbf === 'number' ? claims.nbf : 0;
    if (exp <= now || nbf > now) return null;
    if (claims.iss !== discovery.issuer) return null;

    const aud = claims.aud;
    const audienceValid = Array.isArray(aud) ? aud.includes(ENTRA_API_AUDIENCE) : aud === ENTRA_API_AUDIENCE;
    if (!audienceValid) return null;

    const emailClaim =
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      (typeof claims.upn === 'string' && claims.upn) ||
      (typeof claims.email === 'string' && claims.email) ||
      null;
    if (!emailClaim) return null;

    const email = normalizeEmail(emailClaim);
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : email.split('@')[0] || email;

    return { email, displayName: name };
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
    res.status(401).json({ error: 'unauthorized', message: 'Missing bearer token' });
    return;
  }

  const token = authorization.slice(7).trim();
  const breakglassUser = verifyBreakglassToken(token);
  if (breakglassUser) {
    req.user = {
      employeeId: breakglassUser.sub,
      email: normalizeEmail(breakglassUser.email),
      displayName: breakglassUser.displayName,
      isAdmin: true,
      authProvider: 'breakglass'
    };
    next();
    return;
  }

  const entraIdentity = await verifyEntraJwt(token);
  if (!entraIdentity) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    return;
  }

  const isBootstrapAdmin = entraIdentity.email === ADMIN_EMAIL;
  const employee = await prisma.employee.upsert({
    where: { email: entraIdentity.email },
    create: {
      email: entraIdentity.email,
      displayName: entraIdentity.displayName,
      isActive: true,
      isAdmin: isBootstrapAdmin
    },
    update: {
      displayName: entraIdentity.displayName,
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
