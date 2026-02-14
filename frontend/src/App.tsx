import { useCallback, useEffect, useState } from 'react';
import { get } from './api';
import { BookingApp } from './BookingApp';
import { AdminRouter } from './admin/AdminRouter';

type CurrentUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
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
  if (currentPath() === target) return;
  window.location.hash = target;
};

function NotFound() {
  return (
    <main className="app-shell">
      <section className="card stack-sm down-card">
        <h2>Seite nicht gefunden</h2>
        <button className="btn" onClick={() => navigate('/')}>Zur Startseite</button>
      </section>
    </main>
  );
}

export function App() {
  const [path, setPath] = useState(currentPath());
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);

  const refreshCurrentUser = useCallback(async () => {
    const userEmail = localStorage.getItem('rbms-user-email');
    const headers = userEmail ? { 'x-user-email': userEmail } : undefined;
    const me = await get<CurrentUser>('/me', headers);
    setCurrentUser(me);
  }, []);

  useEffect(() => {
    void refreshCurrentUser();
  }, [refreshCurrentUser]);

  useEffect(() => {
    const handler = () => setPath(currentPath());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  if (path.startsWith('/admin')) {
    return <AdminRouter path={path} navigate={navigate} onRoleStateChanged={refreshCurrentUser} />;
  }

  if (path === '/' || path.startsWith('/?')) {
    return (
      <BookingApp
        canOpenAdmin={currentUser?.role === 'admin'}
        onOpenAdmin={() => navigate('/admin')}
        currentUserEmail={currentUser?.email}
        onUserContextChanged={refreshCurrentUser}
      />
    );
  }

  return <NotFound />;
}
