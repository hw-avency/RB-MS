import { useEffect, useState } from 'react';

type HealthResponse = { status: string };
type MeResponse = {
  id: string;
  email: string;
  name: string;
  role: string;
};

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [healthResponse, meResponse] = await Promise.all([
          fetch('/api/health'),
          fetch('/api/me')
        ]);

        setHealth(await healthResponse.json());
        setMe(await meResponse.json());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    }

    load();
  }, []);

  return (
    <main>
      <h1>RB-MS Demo Frontend</h1>
      {error && <p className="error">Error: {error}</p>}
      <section>
        <h2>/health</h2>
        <pre>{JSON.stringify(health, null, 2)}</pre>
      </section>
      <section>
        <h2>/me</h2>
        <pre>{JSON.stringify(me, null, 2)}</pre>
      </section>
    </main>
  );
}
