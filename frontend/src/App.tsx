import { useEffect, useState } from 'react';
import { BookingApp } from './BookingApp';
import { AdminRouter } from './admin/AdminRouter';

const currentPath = () => `${window.location.pathname}${window.location.search}`;

const navigate = (to: string) => {
  if (window.location.pathname === to) return;
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
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
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  if (path.startsWith('/admin')) {
    return <AdminRouter path={path} navigate={navigate} />;
  }

  if (path === '/' || path.startsWith('/?')) {
    return <BookingApp />;
  }

  return <NotFound />;
}
