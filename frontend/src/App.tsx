import { FormEvent, useEffect, useState } from 'react';
import { ApiError } from './api';
import { BookingApp } from './BookingApp';
import { AdminRouter } from './admin/AdminRouter';
import { useAuth } from './auth/AuthProvider';

type Route = '/' | '/admin' | '/login' | string;

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

function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
        setError('Login fehlgeschlagen');
      } else {
        setError('Login fehlgeschlagen');
      }
    } finally {
      setBusy(false);
    }
  };

  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Anmelden</h2><form className="stack-sm" onSubmit={onSubmit}><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-Mail" /><input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Passwort" />{error && <p className="error-banner">{error}</p>}<button className="btn" disabled={busy}>{busy ? 'Anmelden…' : 'Anmelden'}</button></form></section></main>;
}

function LoadingGate() {
  return <main className="app-shell"><section className="card">Lade…</section></main>;
}

function NotFound() {
  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Seite nicht gefunden</h2><button className="btn" onClick={() => navigate('/')}>Zur Startseite</button></section></main>;
}

export function App() {
  const [path, setPath] = useState<Route>(currentPath());
  const { user, loading, isAuthenticated, isAdmin, logout, refreshMe } = useAuth();

  useEffect(() => {
    const handler = () => setPath(currentPath());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  if (loading) return <LoadingGate />;

  if (!isAuthenticated) {
    if (path !== '/login') navigate('/login');
    return <LoginPage />;
  }

  if (path === '/login') {
    navigate('/');
    return <LoadingGate />;
  }

  if (path.startsWith('/admin')) {
    if (!isAdmin) {
      navigate('/');
      return <LoadingGate />;
    }

    return <AdminRouter path={path} navigate={navigate} onRoleStateChanged={refreshMe} onLogout={logout} />;
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
