import { FormEvent, useEffect, useState } from 'react';
import { API_BASE, ApiError } from './api';
import { BookingApp } from './BookingApp';
import { AdminRouter } from './admin/AdminRouter';
import { useAuth } from './auth/AuthProvider';

type Route = '/' | '/admin' | '/login' | '/breakglass' | string;

type LoginDebugInfo = {
  status?: number;
  code?: string;
  requestId?: string;
};

const toRoutePath = (hash: string) => {
  if (!hash || hash === '#') return '/';
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
};

const currentPath = () => toRoutePath(window.location.hash);
const navigate = (to: string) => {
  const target = to.startsWith('/') ? to : `/${to}`;
  if (currentPath() !== target) {
    window.location.hash = target;
  }
};

function MicrosoftLoginPage() {
  const startMicrosoftLogin = () => {
    window.location.href = `${API_BASE}/auth/entra/start`;
  };

  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Anmelden</h2><p className="muted">Bitte mit Ihrem Microsoft-Konto anmelden.</p><button className="btn" onClick={startMicrosoftLogin}>Mit Microsoft anmelden</button></section></main>;
}

function BreakglassLoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [debugInfo, setDebugInfo] = useState<LoginDebugInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const isDev = import.meta.env.DEV;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setDebugInfo(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.kind === 'BACKEND_UNREACHABLE') {
          setError('Backend nicht erreichbar');
        } else if (err.backendCode === 'SESSION_MISSING') {
          setError('Login ok, aber Session fehlt');
        } else if (err.status === 401) {
          setError('Ungültige Zugangsdaten');
        } else if (err.status >= 500) {
          setError('Serverfehler beim Login');
        } else {
          setError('Login fehlgeschlagen');
        }

        setDebugInfo({
          status: err.status || undefined,
          code: err.backendCode ?? err.code,
          requestId: err.requestId
        });
      } else {
        setError('Login fehlgeschlagen');
      }
    } finally {
      setBusy(false);
    }
  };

  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Breakglass Login</h2><form className="stack-sm" onSubmit={onSubmit}><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-Mail" /><input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Passwort" />{error && <p className="error-banner">{error}</p>}{isDev && debugInfo && <p className="muted">debug: status={debugInfo.status ?? '-'} code={debugInfo.code ?? '-'} requestId={debugInfo.requestId ?? '-'}</p>}<button className="btn" disabled={busy}>{busy ? 'Anmelden…' : 'Anmelden'}</button></form></section></main>;
}

function LoadingGate() {
  return <main className="app-shell"><section className="card">Lade…</section></main>;
}

function NotFound() {
  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Seite nicht gefunden</h2><button className="btn" onClick={() => navigate('/')}>Zur Startseite</button></section></main>;
}

export function App() {
  const [path, setPath] = useState<Route>(currentPath());
  const { user, loadingAuth, isAuthenticated, isAdmin, logout, refreshMe } = useAuth();

  useEffect(() => {
    const handler = () => setPath(currentPath());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  if (loadingAuth) return <LoadingGate />;

  if (!isAuthenticated) {
    if (path === '/breakglass') {
      return <BreakglassLoginPage />;
    }

    if (path !== '/login') navigate('/login');
    return <MicrosoftLoginPage />;
  }

  if (path === '/login' || path === '/breakglass') {
    navigate('/');
    return <LoadingGate />;
  }

  if (path.startsWith('/admin')) {
    if (!isAdmin) {
      navigate('/');
      return <LoadingGate />;
    }

    return <AdminRouter path={path} navigate={navigate} onRoleStateChanged={async () => {
      await refreshMe();
    }} onLogout={logout} />;
  }

  if (path === '/' || path.startsWith('/?')) {
    return (
      <BookingApp
        canOpenAdmin={isAdmin}
        onOpenAdmin={() => navigate('/admin')}
        currentUserEmail={user?.email}
        onLogout={logout}
      />
    );
  }

  return <NotFound />;
}
