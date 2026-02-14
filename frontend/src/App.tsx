import { useEffect, useState } from 'react';
import { BookingApp } from './BookingApp';
import { AdminRouter } from './admin/AdminRouter';

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

  useEffect(() => {
    const handler = () => setPath(currentPath());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  if (path.startsWith('/admin')) {
    return <AdminRouter path={path} navigate={navigate} />;
  }

  if (path === '/' || path.startsWith('/?')) {
    return <BookingApp onOpenAdmin={() => navigate('/admin')} />;
  }

  return <NotFound />;
}
