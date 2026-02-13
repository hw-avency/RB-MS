const tenantId = import.meta.env.VITE_ENTRA_TENANT_ID;
const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID;
const redirectUri = import.meta.env.VITE_ENTRA_REDIRECT_URI;
export const entraScope = import.meta.env.VITE_ENTRA_SCOPE;

if (!tenantId || !clientId || !redirectUri || !entraScope) {
  throw new Error('Missing Entra frontend environment variables');
}

const CODE_VERIFIER_KEY = 'entraCodeVerifier';
const ENTRA_TOKEN_KEY = 'entraAccessToken';
const ENTRA_TOKEN_EXP_KEY = 'entraAccessTokenExp';

const randomString = (length: number): string => {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values)
    .map((value) => charset[value % charset.length])
    .join('');
};

const toBase64Url = (input: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(input))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const createCodeChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(digest);
};

const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const authorizeEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`;

export const getActiveAccount = () => (localStorage.getItem(ENTRA_TOKEN_KEY) ? { provider: 'entra' } : null);

export const msalInstance = {
  initialize: async () => {},
  handleRedirectPromise: async () => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    if (!code) return null;

    const verifier = sessionStorage.getItem(CODE_VERIFIER_KEY);
    if (!verifier) throw new Error('Missing PKCE verifier');

    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: entraScope
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!response.ok) throw new Error('Token exchange failed');

    const tokenResponse = (await response.json()) as { access_token: string; expires_in: number };
    localStorage.setItem(ENTRA_TOKEN_KEY, tokenResponse.access_token);
    localStorage.setItem(ENTRA_TOKEN_EXP_KEY, String(Date.now() + tokenResponse.expires_in * 1000));

    sessionStorage.removeItem(CODE_VERIFIER_KEY);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    window.history.replaceState({}, '', url.toString());

    return { account: { provider: 'entra' } };
  },
  setActiveAccount: (_account: unknown) => {},
  acquireTokenSilent: async () => {
    const token = localStorage.getItem(ENTRA_TOKEN_KEY);
    const exp = Number(localStorage.getItem(ENTRA_TOKEN_EXP_KEY) ?? 0);
    if (!token || Date.now() >= exp - 60000) {
      throw new Error('No valid cached Entra token');
    }
    return { accessToken: token };
  },
  loginRedirect: async () => {
    const verifier = randomString(64);
    const challenge = await createCodeChallenge(verifier);
    sessionStorage.setItem(CODE_VERIFIER_KEY, verifier);

    const state = randomString(24);
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: entraScope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    });

    window.location.assign(`${authorizeEndpoint}?${query.toString()}`);
  },
  logoutRedirect: async ({ postLogoutRedirectUri }: { postLogoutRedirectUri: string }) => {
    sessionStorage.removeItem(CODE_VERIFIER_KEY);
    localStorage.removeItem(ENTRA_TOKEN_KEY);
    localStorage.removeItem(ENTRA_TOKEN_EXP_KEY);
    window.location.assign(postLogoutRedirectUri);
  }
};
