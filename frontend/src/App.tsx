import { useEffect, useState } from 'react';

type Health = { status: string };
type Me = { id: string; email: string; displayName: string; role: string };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'error' }));

    fetch(`${API_BASE_URL}/me`)
      .then((res) => res.json())
      .then(setMe)
      .catch(() =>
        setMe({
          id: 'unavailable',
          email: 'unavailable',
          displayName: 'Unavailable',
          role: 'unknown'
        })
      );
  }, []);

  return (
    <main style={{ fontFamily: 'Arial, sans-serif', margin: '2rem' }}>
      <h1>RB-MS</h1>
      <p>API: {API_BASE_URL}</p>
      <h2>Health</h2>
      <pre>{JSON.stringify(health, null, 2)}</pre>
      <h2>Demo User (/me)</h2>
      <pre>{JSON.stringify(me, null, 2)}</pre>
    </main>
  );
}
