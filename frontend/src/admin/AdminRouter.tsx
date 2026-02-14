import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { ApiError, del, get, patch, post } from '../api';

type Floorplan = { id: string; name: string; imageUrl: string; createdAt?: string };
type Desk = { id: string; floorplanId: string; name: string; x: number; y: number; createdAt?: string };
type Employee = { id: string; email: string; displayName: string; isActive: boolean };
type Booking = { id: string; deskId: string; userEmail: string; userDisplayName?: string; date: string; createdAt?: string };
type RecurringBooking = { id: string; deskId: string; userEmail: string; weekday: number; validFrom: string; validTo?: string | null };
type Toast = { id: number; tone: 'success' | 'error'; message: string };

type RouteProps = { path: string; navigate: (to: string) => void };

type DataState = { loading: boolean; error: string };

const navItems = [
  { to: '/admin', label: 'Dashboard' },
  { to: '/admin/floorplans', label: 'Floorpläne' },
  { to: '/admin/desks', label: 'Desks' },
  { to: '/admin/bookings', label: 'Buchungen' },
  { to: '/admin/employees', label: 'Mitarbeiter' }
];

const today = new Date().toISOString().slice(0, 10);
const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('rbms-admin-token') ?? ''}` });
const formatDate = (value?: string) => (value ? new Date(value).toLocaleString('de-DE') : '—');
const formatDateOnly = (value?: string) => (value ? new Date(value).toLocaleDateString('de-DE') : '—');

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = (tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3000);
  };

  return {
    toasts,
    success: (message: string) => push('success', message),
    error: (message: string) => push('error', message)
  };
}

function ToastViewport({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' }) {
  return <span className={`admin-badge admin-badge-${tone}`}>{children}</span>;
}

function SkeletonRows({ columns = 5 }: { columns?: number }) {
  return (
    <tbody>
      {Array.from({ length: 5 }).map((_, index) => (
        <tr key={index}>
          <td colSpan={columns}>
            <div className="skeleton admin-table-skeleton" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty-state stack-sm">
      <p>{text}</p>
      {action}
    </div>
  );
}

function ErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="error-banner stack-sm">
      <span>{text}</span>
      <button className="btn btn-outline" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function ConfirmDialog({
  title,
  description,
  onConfirm,
  onCancel
}: {
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="overlay">
      <section className="card dialog stack-sm" role="dialog" aria-modal="true">
        <h3>{title}</h3>
        <p className="muted">{description}</p>
        <div className="inline-end">
          <button className="btn btn-outline" onClick={onCancel}>
            Abbrechen
          </button>
          <button className="btn" onClick={onConfirm}>
            Löschen
          </button>
        </div>
      </section>
    </div>
  );
}

function AdminLayout({ path, navigate, title, actions, children }: { path: string; navigate: (to: string) => void; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="app-shell">
      <div className="admin-shell-v2">
        <aside className="card admin-sidebar-v2 stack-sm">
          <h3>RB-MS Admin</h3>
          {navItems.map((item) => (
            <button key={item.to} className={`btn btn-ghost admin-nav-link ${path === item.to ? 'active' : ''}`} onClick={() => navigate(item.to)}>
              {item.label}
            </button>
          ))}
          <button
            className="btn btn-outline"
            onClick={() => {
              localStorage.removeItem('rbms-admin-token');
              navigate('/admin/login');
            }}
          >
            Logout
          </button>
        </aside>
        <section className="admin-content-v2 stack-sm">
          <header className="card admin-topbar-v2">
            <div>
              <p className="muted">Admin / {title}</p>
              <strong>{title}</strong>
            </div>
            {actions}
          </header>
          {children}
        </section>
      </div>
    </main>
  );
}

function AdminLogin({ navigate }: { navigate: (to: string) => void }) {
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const response = await post<{ token: string }>('/admin/login', { email, password });
      localStorage.setItem('rbms-admin-token', response.token);
      navigate('/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login fehlgeschlagen');
    }
  };

  return (
    <main className="app-shell">
      <section className="card stack-sm down-card">
        <h2>Admin Login</h2>
        <form className="stack-sm" onSubmit={submit}>
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="E-Mail" />
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Passwort" />
          {error && <p className="error-banner">{error}</p>}
          <button className="btn">Einloggen</button>
        </form>
      </section>
    </main>
  );
}

function DashboardPage({ path, navigate }: RouteProps) {
  return (
    <AdminLayout path={path} navigate={navigate} title="Dashboard">
      <section className="card stack-sm">
        <h2>Admin Bereich</h2>
        <p className="muted">Verwalte Floorpläne, Desks, Buchungen und Mitarbeitende in einem zentralen CRUD-Interface.</p>
      </section>
    </AdminLayout>
  );
}

function FloorplansPage({ path, navigate }: RouteProps) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '' });
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [desksByFloorplan, setDesksByFloorplan] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Floorplan | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Floorplan | null>(null);

  const load = async () => {
    setState({ loading: true, error: '' });
    try {
      const rows = await get<Floorplan[]>('/floorplans');
      setFloorplans(rows);
      const deskCounts = await Promise.all(rows.map((floorplan) => get<Desk[]>(`/floorplans/${floorplan.id}/desks`)));
      const byId: Record<string, number> = {};
      rows.forEach((floorplan, index) => {
        byId[floorplan.id] = deskCounts[index].length;
      });
      setDesksByFloorplan(byId);
      setState({ loading: false, error: '' });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden' });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => floorplans.filter((plan) => plan.name.toLowerCase().includes(query.toLowerCase())), [floorplans, query]);

  const remove = async (floorplan: Floorplan) => {
    try {
      await del(`/admin/floorplans/${floorplan.id}`, authHeaders());
      toasts.success('Floorplan gelöscht');
      setPendingDelete(null);
      await load();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Löschen fehlgeschlagen');
    }
  };

  return (
    <AdminLayout
      path={path}
      navigate={navigate}
      title="Floorpläne"
      actions={<button className="btn" onClick={() => setShowCreate(true)}>Neu</button>}
    >
      <section className="card stack-sm">
        <div className="admin-toolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Suche Name" />
        </div>

        {state.error && <ErrorState text={state.error} onRetry={load} />}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Standort</th>
                <th>#Desks</th>
                <th>Updated</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            {state.loading ? (
              <SkeletonRows columns={6} />
            ) : (
              <tbody>
                {filtered.map((floorplan) => (
                  <tr key={floorplan.id}>
                    <td>{floorplan.name}</td>
                    <td>—</td>
                    <td>{desksByFloorplan[floorplan.id] ?? 0}</td>
                    <td>{formatDate(floorplan.createdAt)}</td>
                    <td>
                      <Badge tone="ok">aktiv</Badge>
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button className="btn btn-ghost" onClick={() => setEditing(floorplan)}>
                          Bearbeiten
                        </button>
                        <button className="btn btn-ghost" onClick={() => setPendingDelete(floorplan)}>
                          Löschen
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>

        {!state.loading && !state.error && filtered.length === 0 && <EmptyState text="Keine Floorpläne vorhanden." action={<button className="btn" onClick={() => setShowCreate(true)}>Neu anlegen</button>} />}
      </section>

      {(showCreate || editing) && (
        <FloorplanEditor
          floorplan={editing}
          onClose={() => {
            setShowCreate(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setShowCreate(false);
            setEditing(null);
            toasts.success('Floorplan gespeichert');
            await load();
          }}
          onError={toasts.error}
        />
      )}

      {pendingDelete && <ConfirmDialog title="Floorplan löschen?" description={`"${pendingDelete.name}" wird dauerhaft entfernt.`} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete)} />}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}

function FloorplanEditor({ floorplan, onClose, onSaved, onError }: { floorplan: Floorplan | null; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState(floorplan?.name ?? '');
  const [imageUrl, setImageUrl] = useState(floorplan?.imageUrl ?? '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (floorplan) {
        await patch(`/admin/floorplans/${floorplan.id}`, { name, imageUrl }, authHeaders());
      } else {
        await post('/admin/floorplans', { name, imageUrl }, authHeaders());
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  return (
    <div className="overlay">
      <section className="card dialog stack-sm">
        <h3>{floorplan ? 'Floorplan bearbeiten' : 'Floorplan anlegen'}</h3>
        <form className="stack-sm" onSubmit={submit}>
          <input required placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <input required placeholder="Asset URL" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} />
          <div className="inline-end">
            <button type="button" className="btn btn-outline" onClick={onClose}>
              Abbrechen
            </button>
            <button className="btn">Speichern</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DesksPage({ path, navigate }: RouteProps) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '' });
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [floorplanId, setFloorplanId] = useState('');
  const [desks, setDesks] = useState<Desk[]>([]);
  const [query, setQuery] = useState('');
  const [editingDesk, setEditingDesk] = useState<Desk | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteDesk, setDeleteDesk] = useState<Desk | null>(null);
  const [positionDesk, setPositionDesk] = useState<Desk | null>(null);

  const loadFloorplans = async () => {
    setState({ loading: true, error: '' });
    try {
      const rows = await get<Floorplan[]>('/floorplans');
      setFloorplans(rows);
      const nextFloorplan = floorplanId || rows[0]?.id || '';
      setFloorplanId(nextFloorplan);
      setState({ loading: false, error: '' });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden' });
    }
  };

  const loadDesks = async (targetFloorplanId: string) => {
    if (!targetFloorplanId) {
      setDesks([]);
      return;
    }
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const rows = await get<Desk[]>(`/floorplans/${targetFloorplanId}/desks`);
      setDesks(rows);
      setState({ loading: false, error: '' });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden' });
    }
  };

  useEffect(() => {
    void loadFloorplans();
  }, []);

  useEffect(() => {
    if (floorplanId) {
      void loadDesks(floorplanId);
    }
  }, [floorplanId]);

  const filtered = useMemo(() => desks.filter((desk) => desk.name.toLowerCase().includes(query.toLowerCase())), [desks, query]);

  const remove = async (desk: Desk) => {
    try {
      await del(`/admin/desks/${desk.id}`, authHeaders());
      toasts.success('Desk gelöscht');
      setDeleteDesk(null);
      await loadDesks(floorplanId);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Löschen fehlgeschlagen');
    }
  };

  return (
    <AdminLayout path={path} navigate={navigate} title="Desks" actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>}>
      <section className="card stack-sm">
        <div className="admin-toolbar">
          <select value={floorplanId} onChange={(event) => setFloorplanId(event.target.value)}>
            {floorplans.map((floorplan) => (
              <option key={floorplan.id} value={floorplan.id}>
                {floorplan.name}
              </option>
            ))}
          </select>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Desk suchen" />
        </div>

        {state.error && <ErrorState text={state.error} onRetry={() => void loadDesks(floorplanId)} />}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Floorplan</th>
                <th>Ausstattung</th>
                <th>Position</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            {state.loading ? (
              <SkeletonRows columns={6} />
            ) : (
              <tbody>
                {filtered.map((desk) => (
                  <tr key={desk.id}>
                    <td>{desk.name}</td>
                    <td>{floorplans.find((plan) => plan.id === desk.floorplanId)?.name ?? '—'}</td>
                    <td>Standard</td>
                    <td>{Number.isFinite(desk.x) && Number.isFinite(desk.y) ? `${Math.round(desk.x)} / ${Math.round(desk.y)}` : 'fehlt'}</td>
                    <td>
                      <Badge tone="ok">aktiv</Badge>
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button className="btn btn-ghost" onClick={() => setEditingDesk(desk)}>Bearbeiten</button>
                        <button className="btn btn-ghost" onClick={() => setPositionDesk(desk)}>Position setzen</button>
                        <button className="btn btn-ghost" onClick={() => setDeleteDesk(desk)}>Löschen</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>

        {!state.loading && !state.error && filtered.length === 0 && <EmptyState text="Keine Desks gefunden." action={<button className="btn" onClick={() => setCreating(true)}>Neu anlegen</button>} />}
      </section>

      {(creating || editingDesk) && (
        <DeskEditor
          desk={editingDesk}
          floorplans={floorplans}
          defaultFloorplanId={floorplanId}
          onClose={() => {
            setCreating(false);
            setEditingDesk(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditingDesk(null);
            toasts.success('Desk gespeichert');
            await loadDesks(floorplanId);
          }}
          onError={toasts.error}
        />
      )}

      {positionDesk && (
        <PositionDialog
          desk={positionDesk}
          floorplan={floorplans.find((plan) => plan.id === positionDesk.floorplanId) ?? null}
          onClose={() => setPositionDesk(null)}
          onSaved={async () => {
            toasts.success('Position gespeichert');
            setPositionDesk(null);
            await loadDesks(floorplanId);
          }}
          onError={toasts.error}
        />
      )}

      {deleteDesk && <ConfirmDialog title="Desk löschen?" description={`Desk "${deleteDesk.name}" wird entfernt.`} onCancel={() => setDeleteDesk(null)} onConfirm={() => void remove(deleteDesk)} />}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}

function DeskEditor({ desk, floorplans, defaultFloorplanId, onClose, onSaved, onError }: { desk: Desk | null; floorplans: Floorplan[]; defaultFloorplanId: string; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [floorplanId, setFloorplanId] = useState(desk?.floorplanId ?? defaultFloorplanId);
  const [name, setName] = useState(desk?.name ?? '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (desk) {
        await patch(`/admin/desks/${desk.id}`, { floorplanId, name }, authHeaders());
      } else {
        await post(`/admin/floorplans/${floorplanId}/desks`, { name }, authHeaders());
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  return (
    <div className="overlay">
      <section className="card dialog stack-sm">
        <h3>{desk ? 'Desk bearbeiten' : 'Desk anlegen'}</h3>
        <form className="stack-sm" onSubmit={submit}>
          <select required value={floorplanId} onChange={(event) => setFloorplanId(event.target.value)}>
            {floorplans.map((floorplan) => (
              <option key={floorplan.id} value={floorplan.id}>
                {floorplan.name}
              </option>
            ))}
          </select>
          <input required placeholder="Label" value={name} onChange={(event) => setName(event.target.value)} />
          <div className="inline-end">
            <button type="button" className="btn btn-outline" onClick={onClose}>Abbrechen</button>
            <button className="btn">Speichern</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function PositionDialog({ desk, floorplan, onClose, onSaved, onError }: { desk: Desk; floorplan: Floorplan | null; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [x, setX] = useState(desk.x);
  const [y, setY] = useState(desk.y);

  const setByClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const nextX = ((event.clientX - box.left) / box.width) * 100;
    const nextY = ((event.clientY - box.top) / box.height) * 100;
    setX(Math.max(0, Math.min(100, nextX)));
    setY(Math.max(0, Math.min(100, nextY)));
  };

  const save = async () => {
    try {
      await patch(`/admin/desks/${desk.id}`, { x, y }, authHeaders());
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Position konnte nicht gespeichert werden');
    }
  };

  return (
    <div className="overlay">
      <section className="card dialog stack-sm">
        <h3>Position setzen: {desk.name}</h3>
        <p className="muted">Klicke im Preview auf die gewünschte Position.</p>
        <div className="position-picker" onClick={setByClick}>
          {floorplan?.imageUrl ? <img src={floorplan.imageUrl} alt={floorplan.name} className="position-image" /> : <div className="empty-state">Kein Floorplan-Bild</div>}
          <span className="position-pin" style={{ left: `${x}%`, top: `${y}%` }} />
        </div>
        <p className="muted">Position: {Math.round(x)} / {Math.round(y)}</p>
        <div className="inline-end">
          <button className="btn btn-outline" onClick={onClose}>Abbrechen</button>
          <button className="btn" onClick={save}>Speichern</button>
        </div>
      </section>
    </div>
  );
}

function BookingsPage({ path, navigate }: RouteProps) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '' });
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [desks, setDesks] = useState<Desk[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(in14Days);
  const [floorplanId, setFloorplanId] = useState('');
  const [deskId, setDeskId] = useState('');
  const [personQuery, setPersonQuery] = useState('');
  const [editing, setEditing] = useState<Booking | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteBooking, setDeleteBooking] = useState<Booking | null>(null);

  const load = async () => {
    setState({ loading: true, error: '' });
    try {
      const floorplanRows = await get<Floorplan[]>('/floorplans');
      const floorplanForFilter = floorplanId || floorplanRows[0]?.id || '';
      setFloorplans(floorplanRows);
      const deskRows = (await Promise.all(floorplanRows.map((plan) => get<Desk[]>(`/floorplans/${plan.id}/desks`)))).flat();
      setDesks(deskRows);
      const employeeRows = await get<Employee[]>('/admin/employees', authHeaders());
      setEmployees(employeeRows);
      const bookingRows = await get<Booking[]>(`/bookings?from=${from}&to=${to}${floorplanForFilter ? `&floorplanId=${floorplanForFilter}` : ''}`);
      setBookings(bookingRows);
      if (!floorplanId) setFloorplanId(floorplanForFilter);
      setState({ loading: false, error: '' });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden' });
    }
  };

  useEffect(() => {
    void load();
  }, [from, to]);

  const filtered = useMemo(
    () =>
      bookings.filter((booking) => {
        const person = `${booking.userDisplayName ?? ''} ${booking.userEmail}`.toLowerCase();
        const desk = desks.find((item) => item.id === booking.deskId);
        const matchesPerson = person.includes(personQuery.toLowerCase());
        const matchesDesk = deskId ? booking.deskId === deskId : true;
        const matchesFloorplan = floorplanId ? desk?.floorplanId === floorplanId : true;
        return matchesPerson && matchesDesk && matchesFloorplan;
      }),
    [bookings, desks, deskId, floorplanId, personQuery]
  );

  const remove = async (booking: Booking) => {
    try {
      await del(`/admin/bookings/${booking.id}`, authHeaders());
      toasts.success('Buchung gelöscht');
      setDeleteBooking(null);
      await load();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Löschen fehlgeschlagen');
    }
  };

  return (
    <AdminLayout path={path} navigate={navigate} title="Buchungen" actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>}>
      <section className="card stack-sm">
        <div className="admin-toolbar admin-toolbar-wrap">
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          <select value={floorplanId} onChange={(event) => setFloorplanId(event.target.value)}>
            <option value="">Alle Floorpläne</option>
            {floorplans.map((floorplan) => (
              <option key={floorplan.id} value={floorplan.id}>{floorplan.name}</option>
            ))}
          </select>
          <select value={deskId} onChange={(event) => setDeskId(event.target.value)}>
            <option value="">Alle Desks</option>
            {desks
              .filter((desk) => (floorplanId ? desk.floorplanId === floorplanId : true))
              .map((desk) => (
                <option key={desk.id} value={desk.id}>{desk.name}</option>
              ))}
          </select>
          <input value={personQuery} onChange={(event) => setPersonQuery(event.target.value)} placeholder="Person suchen" />
        </div>

        {state.error && <ErrorState text={state.error} onRetry={load} />}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Person</th>
                <th>Desk</th>
                <th>Typ</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            {state.loading ? (
              <SkeletonRows columns={6} />
            ) : (
              <tbody>
                {filtered.map((booking) => {
                  const desk = desks.find((item) => item.id === booking.deskId);
                  return (
                    <tr key={booking.id}>
                      <td>{formatDateOnly(booking.date)}</td>
                      <td>{booking.userDisplayName || booking.userEmail}</td>
                      <td>{desk?.name ?? booking.deskId}</td>
                      <td>Einzeln</td>
                      <td>{formatDate(booking.createdAt)}</td>
                      <td>
                        <div className="admin-row-actions">
                          <button className="btn btn-ghost" onClick={() => setEditing(booking)}>Bearbeiten</button>
                          <button className="btn btn-ghost" onClick={() => setDeleteBooking(booking)}>Löschen</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>

        {!state.loading && !state.error && filtered.length === 0 && <EmptyState text="Keine Buchungen im Zeitraum gefunden." action={<button className="btn" onClick={() => setCreating(true)}>Neu anlegen</button>} />}
      </section>

      {(creating || editing) && (
        <BookingEditor
          booking={editing}
          desks={desks}
          employees={employees}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async (message) => {
            toasts.success(message);
            setCreating(false);
            setEditing(null);
            await load();
          }}
          onError={toasts.error}
        />
      )}

      {deleteBooking && <ConfirmDialog title="Buchung löschen?" description="Die ausgewählte Buchung wird entfernt." onCancel={() => setDeleteBooking(null)} onConfirm={() => void remove(deleteBooking)} />}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}

function BookingEditor({ booking, desks, employees, onClose, onSaved, onError }: { booking: Booking | null; desks: Desk[]; employees: Employee[]; onClose: () => void; onSaved: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [mode, setMode] = useState<'single' | 'range' | 'series'>('single');
  const [deskId, setDeskId] = useState(booking?.deskId ?? desks[0]?.id ?? '');
  const [userEmail, setUserEmail] = useState(booking?.userEmail ?? employees[0]?.email ?? '');
  const [date, setDate] = useState(booking?.date?.slice(0, 10) ?? today);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(in14Days);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [conflictSummary, setConflictSummary] = useState('');

  const toggleWeekday = (weekday: number) => {
    setWeekdays((current) => (current.includes(weekday) ? current.filter((item) => item !== weekday) : [...current, weekday].sort()));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (booking) {
        await patch(`/admin/bookings/${booking.id}`, { deskId, userEmail, date }, authHeaders());
        await onSaved('Buchung aktualisiert');
        return;
      }

      if (mode === 'single') {
        await post('/bookings', { deskId, userEmail, date }, authHeaders());
        await onSaved('Buchung erstellt');
        return;
      }

      if (mode === 'range') {
        const result = await post<{ created: Booking[]; skipped: string[] }>('/bookings/range', { deskId, userEmail, from, to, weekdaysOnly: true }, authHeaders());
        await onSaved(`${result.created.length} erstellt, ${result.skipped.length} Konflikte`);
        return;
      }

      const series = await post<RecurringBooking[]>('/recurring-bookings/bulk', { deskId, userEmail, weekdays, validFrom: from, validTo: to }, authHeaders());
      await onSaved(`${series.length} Serienregeln erstellt`);
    } catch (err) {
      const message = err instanceof ApiError && typeof err.details === 'object' && err.details ? JSON.stringify(err.details) : err instanceof Error ? err.message : 'Speichern fehlgeschlagen';
      setConflictSummary(message);
      onError('Konflikt oder Validierungsfehler. Details im Dialog.');
    }
  };

  return (
    <div className="overlay">
      <section className="card dialog stack-sm">
        <h3>{booking ? 'Buchung bearbeiten' : 'Buchung anlegen'}</h3>
        {!booking && (
          <div className="tabs">
            <button className={`tab-btn ${mode === 'single' ? 'active' : ''}`} type="button" onClick={() => setMode('single')}>Einzeln</button>
            <button className={`tab-btn ${mode === 'range' ? 'active' : ''}`} type="button" onClick={() => setMode('range')}>Zeitraum</button>
            <button className={`tab-btn ${mode === 'series' ? 'active' : ''}`} type="button" onClick={() => setMode('series')}>Serie</button>
          </div>
        )}
        <form className="stack-sm" onSubmit={submit}>
          <select required value={deskId} onChange={(event) => setDeskId(event.target.value)}>
            {desks.map((desk) => (
              <option key={desk.id} value={desk.id}>{desk.name}</option>
            ))}
          </select>
          <input list="employee-email-list" required value={userEmail} onChange={(event) => setUserEmail(event.target.value)} placeholder="person@firma.de" />
          <datalist id="employee-email-list">
            {employees.map((employee) => (
              <option key={employee.id} value={employee.email} />
            ))}
          </datalist>

          {(booking || mode === 'single') && <input type="date" required value={date} onChange={(event) => setDate(event.target.value)} />}

          {!booking && mode !== 'single' && (
            <>
              <input type="date" required value={from} onChange={(event) => setFrom(event.target.value)} />
              <input type="date" required value={to} onChange={(event) => setTo(event.target.value)} />
            </>
          )}

          {!booking && mode === 'series' && (
            <div className="weekday-toggle-group">
              {['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'].map((label, index) => (
                <button key={label} type="button" className={`weekday-toggle ${weekdays.includes(index) ? 'active' : ''}`} onClick={() => toggleWeekday(index)}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {conflictSummary && <p className="muted">Konflikt-Details: {conflictSummary}</p>}

          <div className="inline-end">
            <button type="button" className="btn btn-outline" onClick={onClose}>Abbrechen</button>
            <button className="btn">Speichern</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function EmployeesPage({ path, navigate }: RouteProps) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '' });
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [pendingDeactivate, setPendingDeactivate] = useState<Employee | null>(null);

  const load = async () => {
    setState({ loading: true, error: '' });
    try {
      const rows = await get<Employee[]>('/admin/employees', authHeaders());
      setEmployees(rows);
      setState({ loading: false, error: '' });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden' });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => employees.filter((employee) => `${employee.displayName} ${employee.email}`.toLowerCase().includes(query.toLowerCase())), [employees, query]);

  const deactivate = async (employee: Employee) => {
    try {
      await patch(`/admin/employees/${employee.id}`, { isActive: false }, authHeaders());
      toasts.success('Mitarbeiter deaktiviert');
      setPendingDeactivate(null);
      await load();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Aktion fehlgeschlagen');
    }
  };

  return (
    <AdminLayout path={path} navigate={navigate} title="Mitarbeiter" actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>}>
      <section className="card stack-sm">
        <div className="admin-toolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name oder E-Mail" />
        </div>

        {state.error && <ErrorState text={state.error} onRetry={load} />}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Rolle</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            {state.loading ? (
              <SkeletonRows columns={5} />
            ) : (
              <tbody>
                {filtered.map((employee) => (
                  <tr key={employee.id}>
                    <td>{employee.displayName}</td>
                    <td>{employee.email}</td>
                    <td><Badge>User</Badge></td>
                    <td>{employee.isActive ? <Badge tone="ok">aktiv</Badge> : <Badge tone="warn">deaktiviert</Badge>}</td>
                    <td>
                      <div className="admin-row-actions">
                        <button className="btn btn-ghost" onClick={() => setEditing(employee)}>Bearbeiten</button>
                        {employee.isActive && <button className="btn btn-ghost" onClick={() => setPendingDeactivate(employee)}>Deaktivieren</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>

        {!state.loading && !state.error && filtered.length === 0 && <EmptyState text="Keine Mitarbeitenden vorhanden." action={<button className="btn" onClick={() => setCreating(true)}>Neu anlegen</button>} />}
      </section>

      {(creating || editing) && (
        <EmployeeEditor
          employee={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            toasts.success('Mitarbeiter gespeichert');
            setCreating(false);
            setEditing(null);
            await load();
          }}
          onError={toasts.error}
        />
      )}

      {pendingDeactivate && (
        <ConfirmDialog
          title="Mitarbeiter deaktivieren?"
          description={`${pendingDeactivate.displayName} wird auf inaktiv gesetzt.`}
          onCancel={() => setPendingDeactivate(null)}
          onConfirm={() => void deactivate(pendingDeactivate)}
        />
      )}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}

function EmployeeEditor({ employee, onClose, onSaved, onError }: { employee: Employee | null; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [displayName, setDisplayName] = useState(employee?.displayName ?? '');
  const [email, setEmail] = useState(employee?.email ?? '');
  const [isActive, setIsActive] = useState(employee?.isActive ?? true);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (employee) {
        await patch(`/admin/employees/${employee.id}`, { displayName, isActive }, authHeaders());
      } else {
        await post('/admin/employees', { displayName, email }, authHeaders());
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  return (
    <div className="overlay">
      <section className="card dialog stack-sm">
        <h3>{employee ? 'Mitarbeiter bearbeiten' : 'Mitarbeiter anlegen'}</h3>
        <form className="stack-sm" onSubmit={submit}>
          <input required value={displayName} placeholder="Name" onChange={(event) => setDisplayName(event.target.value)} />
          {!employee && <input required type="email" value={email} placeholder="E-Mail" onChange={(event) => setEmail(event.target.value)} />}
          {employee && (
            <label className="toggle">
              <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
              Aktiv
            </label>
          )}
          <div className="inline-end">
            <button className="btn btn-outline" type="button" onClick={onClose}>Abbrechen</button>
            <button className="btn">Speichern</button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function AdminRouter({ path, navigate }: RouteProps) {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      if (path === '/admin/login') {
        setAllowed(false);
        return;
      }
      const token = localStorage.getItem('rbms-admin-token');
      if (!token) {
        setAllowed(false);
        return;
      }
      try {
        await get('/admin/employees', authHeaders());
        setAllowed(true);
      } catch {
        setAllowed(false);
      }
    })();
  }, [path]);

  if (path === '/admin/login') return <AdminLogin navigate={navigate} />;
  if (allowed === null) return <main className="app-shell"><section className="card">Prüfe Berechtigung…</section></main>;
  if (!allowed) return <main className="app-shell"><section className="card stack-sm down-card"><h2>Keine Berechtigung</h2><button className="btn" onClick={() => navigate('/admin/login')}>Zum Login</button></section></main>;

  if (path === '/admin') return <DashboardPage path={path} navigate={navigate} />;
  if (path === '/admin/floorplans') return <FloorplansPage path={path} navigate={navigate} />;
  if (path === '/admin/desks') return <DesksPage path={path} navigate={navigate} />;
  if (path === '/admin/bookings') return <BookingsPage path={path} navigate={navigate} />;
  if (path === '/admin/employees') return <EmployeesPage path={path} navigate={navigate} />;

  return (
    <main className="app-shell">
      <section className="card stack-sm down-card">
        <h2>Admin-Seite nicht gefunden</h2>
        <button className="btn" onClick={() => navigate('/admin')}>Zum Dashboard</button>
      </section>
    </main>
  );
}
