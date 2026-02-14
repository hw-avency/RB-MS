import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { del, get, patch, post } from '../api';

type Floorplan = { id: string; name: string; imageUrl: string; createdAt?: string; updatedAt?: string };
type Desk = { id: string; floorplanId: string; name: string; x: number; y: number; createdAt?: string; updatedAt?: string };
type Employee = { id: string; email: string; displayName: string; role: 'admin' | 'user'; isActive: boolean; createdAt?: string; updatedAt?: string };
type Booking = { id: string; deskId: string; userEmail: string; userDisplayName?: string; date: string; createdAt?: string; updatedAt?: string };
type Toast = { id: number; tone: 'success' | 'error'; message: string };
type RouteProps = { path: string; navigate: (to: string) => void; onRoleStateChanged: () => Promise<void> };
type AdminSession = { id?: string; email: string; displayName: string; role: 'admin' | 'user'; isActive?: boolean };
type DataState = { loading: boolean; error: string; ready: boolean };

type DeskFormState = {
  floorplanId: string;
  name: string;
  x: number | null;
  y: number | null;
};

const navItems = [
  { to: '/admin', label: 'Dashboard' },
  { to: '/admin/floorplans', label: 'Floorpläne' },
  { to: '/admin/desks', label: 'Desks' },
  { to: '/admin/bookings', label: 'Buchungen' },
  { to: '/admin/employees', label: 'Mitarbeiter' }
];

const today = new Date().toISOString().slice(0, 10);
const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('rbms-admin-token') ?? ''}` });
const formatDate = (value?: string) => (value ? new Date(value).toLocaleString('de-DE') : '—');
const formatDateOnly = (value?: string) => (value ? new Date(value).toLocaleDateString('de-DE') : '—');
const basePath = (path: string) => path.split('?')[0];
const hasCreateFlag = (path: string) => path.includes('create=1');

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3200);
  };
  return { toasts, success: (message: string) => push('success', message), error: (message: string) => push('error', message) };
}

function ToastViewport({ toasts }: { toasts: Toast[] }) {
  return <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.message}</div>)}</div>;
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' }) {
  return <span className={`admin-badge admin-badge-${tone}`}>{children}</span>;
}

function SkeletonRows({ columns = 5 }: { columns?: number }) {
  return <tbody>{Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={columns}><div className="skeleton admin-table-skeleton" /></td></tr>)}</tbody>;
}

function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return <div className="empty-state stack-sm"><p>{text}</p>{action}</div>;
}

function ErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  return <div className="error-banner stack-sm"><span>{text}</span><button className="btn btn-outline" onClick={onRetry}>Retry</button></div>;
}

function ConfirmDialog({ title, description, onConfirm, onCancel }: { title: string; description: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="overlay"><section className="card dialog stack-sm" role="dialog" aria-modal="true"><h3>{title}</h3><p className="muted">{description}</p><div className="inline-end"><button className="btn btn-outline" onClick={onCancel}>Abbrechen</button><button className="btn btn-danger" onClick={onConfirm}>Löschen</button></div></section></div>
  );
}

function RowMenu({ onEdit, onDelete, onExtra, extraLabel }: { onEdit: () => void; onDelete: () => void; onExtra?: () => void; extraLabel?: string }) {
  return (
    <details className="row-menu">
      <summary className="btn btn-outline btn-icon">⋯</summary>
      <div className="row-menu-content">
        {onExtra && extraLabel && <button className="btn btn-ghost" onClick={onExtra}>{extraLabel}</button>}
        <button className="btn btn-ghost" onClick={onEdit}>Bearbeiten</button>
        <button className="btn btn-ghost btn-danger-text" onClick={onDelete}>Löschen</button>
      </div>
    </details>
  );
}

function AdminLayout({ path, navigate, title, actions, children }: { path: string; navigate: (to: string) => void; title: string; actions?: ReactNode; children: ReactNode }) {
  const current = basePath(path);
  return (
    <main className="app-shell">
      <div className="admin-shell-v2">
        <aside className="card admin-sidebar-v2 stack-sm">
          <h3>RB-MS Admin</h3>
          {navItems.map((item) => <button key={item.to} className={`btn btn-ghost admin-nav-link ${current === item.to ? 'active' : ''}`} onClick={() => navigate(item.to)}>{item.label}</button>)}
          <button className="btn btn-outline" onClick={() => { localStorage.removeItem('rbms-admin-token'); navigate('/admin/login'); }}>Logout</button>
        </aside>
        <section className="admin-content-v2 stack-sm">
          <header className="card admin-topbar-v2"><div><p className="muted">Admin / {title}</p><strong>{title}</strong></div><div className="inline-end"><button className="btn btn-outline" onClick={() => navigate('/')}>Zurück zur App</button>{actions}</div></header>
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
  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Admin Login</h2><form className="stack-sm" onSubmit={submit}><input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="E-Mail" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Passwort" />{error && <p className="error-banner">{error}</p>}<button className="btn">Einloggen</button></form></section></main>;
}

function DashboardPage({ path, navigate }: RouteProps) {
  const [state, setState] = useState<DataState>({ loading: true, error: '', ready: false });
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [desks, setDesks] = useState<Desk[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const [employeeRows, floorplanRows, bookingRows] = await Promise.all([
        get<Employee[]>('/admin/employees', authHeaders()),
        get<Floorplan[]>('/floorplans'),
        get<Booking[]>(`/bookings?from=${today}&to=${in14Days}`)
      ]);
      const deskRows = (await Promise.all(floorplanRows.map((plan) => get<Desk[]>(`/floorplans/${plan.id}/desks`)))).flat();
      setEmployees(employeeRows);
      setFloorplans(floorplanRows);
      setDesks(deskRows);
      setBookings(bookingRows);
      setState({ loading: false, error: '', ready: true });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden', ready: true });
    }
  };

  useEffect(() => { void load(); }, []);

  const bookingsNextWeek = bookings.filter((item) => item.date >= today && item.date <= in7Days).length;
  const recent = [...bookings].sort((a, b) => new Date(b.createdAt ?? b.date).getTime() - new Date(a.createdAt ?? a.date).getTime()).slice(0, 12);

  return (
    <AdminLayout path={path} navigate={navigate} title="Dashboard">
      {state.error && <ErrorState text={state.error} onRetry={load} />}
      <section className="dashboard-grid">
        {[{ label: 'Aktive Mitarbeiter', value: employees.filter((e) => e.isActive).length, icon: '👥', to: '/admin/employees' }, { label: 'Desks', value: desks.length, icon: '🖱️', to: '/admin/desks' }, { label: 'Floorpläne', value: floorplans.length, icon: '🗺️', to: '/admin/floorplans' }, { label: 'Buchungen (7 Tage)', value: bookingsNextWeek, icon: '📅', to: '/admin/bookings' }].map((card) => (
          <button className="card dashboard-kpi" key={card.label} onClick={() => navigate(card.to)}><span className="dashboard-kpi-icon">{card.icon}</span><strong>{card.value}</strong><p>{card.label}</p></button>
        ))}
      </section>
      <section className="dashboard-panels">
        <article className="card stack-sm">
          <div className="inline-between"><h3>Letzte Buchungen</h3><button className="btn btn-outline" onClick={() => navigate('/admin/bookings')}>Alle öffnen</button></div>
          {!state.ready || state.loading ? <div className="stack-sm">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton admin-table-skeleton" />)}</div> : recent.length === 0 ? <EmptyState text="Noch keine Buchungen vorhanden." /> : (
            <div className="stack-sm">
              {recent.map((booking) => {
                const desk = desks.find((item) => item.id === booking.deskId);
                const floorplan = floorplans.find((plan) => plan.id === desk?.floorplanId);
                return <button key={booking.id} className="dashboard-booking-row" onClick={() => navigate('/admin/bookings')}><div><strong>{booking.userDisplayName || booking.userEmail}</strong><p className="muted">{formatDateOnly(booking.date)} · {desk?.name ?? 'Desk'}</p></div><span className="muted">{floorplan?.name ?? '—'}</span></button>;
              })}
            </div>
          )}
        </article>
        <article className="card stack-sm">
          <h3>Schnellaktionen</h3>
          <div className="quick-actions-grid">
            <button className="btn" onClick={() => navigate('/admin/employees?create=1')}>Mitarbeiter anlegen</button>
            <button className="btn" onClick={() => navigate('/admin/floorplans?create=1')}>Floorplan anlegen</button>
            <button className="btn" onClick={() => navigate('/admin/desks?create=1')}>Desk anlegen</button>
            <button className="btn" onClick={() => navigate('/admin/bookings?create=1')}>Buchung anlegen</button>
          </div>
        </article>
      </section>
    </AdminLayout>
  );
}

function FloorplansPage({ path, navigate }: RouteProps) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '', ready: false });
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Floorplan | null>(null);
  const [showCreate, setShowCreate] = useState(hasCreateFlag(path));
  const [pendingDelete, setPendingDelete] = useState<Floorplan | null>(null);

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const rows = await get<Floorplan[]>('/floorplans');
      setFloorplans(rows);
      setState({ loading: false, error: '', ready: true });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden', ready: true });
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => { if (hasCreateFlag(path)) setShowCreate(true); }, [path]);

  const filtered = useMemo(() => floorplans.filter((plan) => plan.name.toLowerCase().includes(query.toLowerCase())), [floorplans, query]);

  return (
    <AdminLayout path={path} navigate={navigate} title="Floorpläne" actions={<button className="btn" onClick={() => setShowCreate(true)}>Neu</button>}>
      <section className="card stack-sm">
        <div className="crud-toolbar"><div className="inline-between"><h3>Floorpläne</h3><Badge>{filtered.length}</Badge></div><div className="admin-search">🔎<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Floorplan suchen" /></div></div>
        {state.error && <ErrorState text={state.error} onRetry={load} />}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>Bild URL</th><th>Erstellt</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={4} /> : <tbody>{filtered.map((floorplan) => <tr key={floorplan.id}><td>{floorplan.name}</td><td className="truncate-cell" title={floorplan.imageUrl}>{floorplan.imageUrl}</td><td>{formatDate(floorplan.createdAt)}</td><td className="align-right"><RowMenu onEdit={() => setEditing(floorplan)} onDelete={() => setPendingDelete(floorplan)} /></td></tr>)}</tbody>}</table></div>
        {!state.loading && filtered.length === 0 && <EmptyState text="Keine Floorpläne vorhanden." action={<button className="btn" onClick={() => setShowCreate(true)}>Neu anlegen</button>} />}
      </section>
      {(showCreate || editing) && <FloorplanEditor floorplan={editing} onClose={() => { setShowCreate(false); setEditing(null); navigate('/admin/floorplans'); }} onSaved={async () => { setShowCreate(false); setEditing(null); toasts.success('Floorplan gespeichert'); await load(); }} onError={toasts.error} />}
      {pendingDelete && <ConfirmDialog title="Floorplan löschen?" description={`"${pendingDelete.name}" wird dauerhaft entfernt.`} onCancel={() => setPendingDelete(null)} onConfirm={async () => { await del(`/admin/floorplans/${pendingDelete.id}`, authHeaders()); setPendingDelete(null); toasts.success('Floorplan gelöscht'); await load(); }} />}
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
      if (floorplan) await patch(`/admin/floorplans/${floorplan.id}`, { name, imageUrl }, authHeaders());
      else await post('/admin/floorplans', { name, imageUrl }, authHeaders());
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };
  return <div className="overlay"><section className="card dialog stack-sm"><h3>{floorplan ? 'Floorplan bearbeiten' : 'Floorplan anlegen'}</h3><form className="stack-sm" onSubmit={submit}><input required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /><input required placeholder="Asset URL" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} /><div className="inline-end"><button type="button" className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn">Speichern</button></div></form></section></div>;
}

function PositionPickerDialog({ floorplan, x, y, onClose, onPick }: { floorplan: Floorplan | null; x: number | null; y: number | null; onClose: () => void; onPick: (x: number, y: number) => void }) {
  const [px, setPx] = useState<number>(x ?? 50);
  const [py, setPy] = useState<number>(y ?? 50);
  const setByClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const nextX = ((event.clientX - box.left) / box.width) * 100;
    const nextY = ((event.clientY - box.top) / box.height) * 100;
    setPx(Math.max(0, Math.min(100, nextX)));
    setPy(Math.max(0, Math.min(100, nextY)));
  };
  return (
    <div className="overlay"><section className="card dialog stack-sm"><h3>Position im Plan setzen</h3><p className="muted">Klicke im Plan, um x/y für den Desk zu setzen.</p><div className="position-picker" onClick={setByClick}>{floorplan?.imageUrl ? <img src={floorplan.imageUrl} alt={floorplan.name} className="position-image" /> : <div className="empty-state">Kein Floorplan-Bild</div>}<span className="position-pin" style={{ left: `${px}%`, top: `${py}%` }} /></div><p className="muted">Position: {Math.round(px)} / {Math.round(py)}</p><div className="inline-end"><button className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn" onClick={() => onPick(px, py)}>Übernehmen</button></div></section></div>
  );
}

function DeskEditor({ desk, floorplans, defaultFloorplanId, onClose, onSaved, onError }: { desk: Desk | null; floorplans: Floorplan[]; defaultFloorplanId: string; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [form, setForm] = useState<DeskFormState>({ floorplanId: desk?.floorplanId ?? defaultFloorplanId, name: desk?.name ?? '', x: desk?.x ?? null, y: desk?.y ?? null });
  const [showPicker, setShowPicker] = useState(false);
  const [inlineError, setInlineError] = useState('');

  const canSave = form.floorplanId && form.name.trim().length > 0 && form.x !== null && form.y !== null;
  const floorplan = floorplans.find((item) => item.id === form.floorplanId) ?? null;

  const onFloorplanChange = (nextFloorplanId: string) => {
    setForm((current) => ({ ...current, floorplanId: nextFloorplanId, x: current.floorplanId === nextFloorplanId ? current.x : null, y: current.floorplanId === nextFloorplanId ? current.y : null }));
    setInlineError('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.x === null || form.y === null) {
      setInlineError('Bitte Position im Plan setzen.');
      return;
    }
    try {
      if (desk) {
        await patch(`/admin/desks/${desk.id}`, { name: form.name, x: form.x, y: form.y }, authHeaders());
      } else {
        await post(`/admin/floorplans/${form.floorplanId}/desks`, { name: form.name, x: form.x, y: form.y }, authHeaders());
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  return (
    <>
      <div className="overlay"><section className="card dialog stack-sm"><h3>{desk ? 'Desk bearbeiten' : 'Desk anlegen'}</h3><form className="stack-sm" onSubmit={submit}><label className="field"><span>Floorplan</span><select required value={form.floorplanId} onChange={(e) => onFloorplanChange(e.target.value)}><option value="">Floorplan wählen</option>{floorplans.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label><label className="field"><span>Label</span><input required placeholder="Desk Name" value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} /></label><div className="field"><span>Position</span><div className="inline-between"><Badge tone={form.x !== null && form.y !== null ? 'ok' : 'warn'}>{form.x !== null && form.y !== null ? `Position gesetzt (${Math.round(form.x)} / ${Math.round(form.y)})` : 'Keine Position gesetzt'}</Badge><button type="button" className="btn btn-outline" disabled={!form.floorplanId} onClick={() => setShowPicker(true)}>{form.x !== null && form.y !== null ? 'Neu positionieren' : 'Position im Plan setzen'}</button></div>{!form.floorplanId && <p className="muted">Bitte Floorplan wählen.</p>}</div>{inlineError && <p className="error-banner">{inlineError}</p>}<div className="inline-end"><button type="button" className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn" disabled={!canSave}>Speichern</button></div></form></section></div>
      {showPicker && <PositionPickerDialog floorplan={floorplan} x={form.x} y={form.y} onClose={() => setShowPicker(false)} onPick={(x, y) => { setForm((current) => ({ ...current, x, y })); setShowPicker(false); setInlineError(''); }} />}
    </>
  );
}

function DesksPage({ path, navigate }: RouteProps) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '', ready: false });
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [floorplanId, setFloorplanId] = useState('');
  const [desks, setDesks] = useState<Desk[]>([]);
  const [query, setQuery] = useState('');
  const [editingDesk, setEditingDesk] = useState<Desk | null>(null);
  const [creating, setCreating] = useState(hasCreateFlag(path));
  const [deleteDesk, setDeleteDesk] = useState<Desk | null>(null);

  const loadFloorplans = async () => {
    try {
      const rows = await get<Floorplan[]>('/floorplans');
      setFloorplans(rows);
      setFloorplanId((current) => current || rows[0]?.id || '');
    } catch (err) {
      setState((current) => ({ ...current, error: err instanceof Error ? err.message : 'Fehler beim Laden', loading: false, ready: true }));
    }
  };

  const loadDesks = async (targetFloorplanId: string) => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    if (!targetFloorplanId) {
      setDesks([]);
      setState({ loading: false, error: '', ready: true });
      return;
    }
    try {
      const rows = await get<Desk[]>(`/floorplans/${targetFloorplanId}/desks`);
      setDesks(rows);
      setState({ loading: false, error: '', ready: true });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden', ready: true });
    }
  };

  useEffect(() => { void loadFloorplans(); }, []);
  useEffect(() => { if (floorplanId) void loadDesks(floorplanId); }, [floorplanId]);
  useEffect(() => { if (hasCreateFlag(path)) setCreating(true); }, [path]);

  const filtered = useMemo(() => desks.filter((desk) => desk.name.toLowerCase().includes(query.toLowerCase())), [desks, query]);

  return (
    <AdminLayout path={path} navigate={navigate} title="Desks" actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>}>
      <section className="card stack-sm">
        <div className="crud-toolbar"><div className="inline-between"><h3>Desks</h3><Badge>{filtered.length}</Badge></div><div className="admin-toolbar admin-toolbar-wrap"><select value={floorplanId} onChange={(e) => setFloorplanId(e.target.value)}>{floorplans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select><div className="admin-search">🔎<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Desk suchen" /></div></div></div>
        {state.error && <ErrorState text={state.error} onRetry={() => void loadDesks(floorplanId)} />}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Label</th><th>Floorplan</th><th className="align-right">X</th><th className="align-right">Y</th><th>Aktualisiert</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={6} /> : <tbody>{filtered.map((desk) => <tr key={desk.id}><td>{desk.name}</td><td>{floorplans.find((plan) => plan.id === desk.floorplanId)?.name ?? '—'}</td><td className="align-right">{Math.round(desk.x)}</td><td className="align-right">{Math.round(desk.y)}</td><td>{formatDate(desk.updatedAt ?? desk.createdAt)}</td><td className="align-right"><RowMenu onEdit={() => setEditingDesk(desk)} onDelete={() => setDeleteDesk(desk)} /></td></tr>)}</tbody>}</table></div>
        {!state.loading && filtered.length === 0 && <EmptyState text="Keine Desks gefunden." action={<button className="btn" onClick={() => setCreating(true)}>Neu anlegen</button>} />}
      </section>
      {(creating || editingDesk) && <DeskEditor desk={editingDesk} floorplans={floorplans} defaultFloorplanId={floorplanId} onClose={() => { setCreating(false); setEditingDesk(null); navigate('/admin/desks'); }} onSaved={async () => { setCreating(false); setEditingDesk(null); toasts.success('Desk gespeichert'); await loadDesks(floorplanId); }} onError={toasts.error} />}
      {deleteDesk && <ConfirmDialog title="Desk löschen?" description={`Desk "${deleteDesk.name}" wird entfernt.`} onCancel={() => setDeleteDesk(null)} onConfirm={async () => { await del(`/admin/desks/${deleteDesk.id}`, authHeaders()); setDeleteDesk(null); toasts.success('Desk gelöscht'); await loadDesks(floorplanId); }} />}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}

function BookingsPage({ path, navigate }: RouteProps) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '', ready: false });
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
  const [creating, setCreating] = useState(hasCreateFlag(path));
  const [deleteBooking, setDeleteBooking] = useState<Booking | null>(null);

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const floorplanRows = await get<Floorplan[]>('/floorplans');
      const deskRows = (await Promise.all(floorplanRows.map((plan) => get<Desk[]>(`/floorplans/${plan.id}/desks`)))).flat();
      const [employeeRows, bookingRows] = await Promise.all([get<Employee[]>('/admin/employees', authHeaders()), get<Booking[]>(`/bookings?from=${from}&to=${to}`)]);
      setFloorplans(floorplanRows);
      setDesks(deskRows);
      setEmployees(employeeRows);
      setBookings(bookingRows);
      setState({ loading: false, error: '', ready: true });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden', ready: true });
    }
  };

  useEffect(() => { void load(); }, [from, to]);
  useEffect(() => { if (hasCreateFlag(path)) setCreating(true); }, [path]);

  const filtered = useMemo(() => bookings.filter((booking) => {
    const person = `${booking.userDisplayName ?? ''} ${booking.userEmail}`.toLowerCase();
    const desk = desks.find((item) => item.id === booking.deskId);
    return person.includes(personQuery.toLowerCase()) && (!deskId || booking.deskId === deskId) && (!floorplanId || desk?.floorplanId === floorplanId);
  }), [bookings, desks, deskId, floorplanId, personQuery]);

  return (
    <AdminLayout path={path} navigate={navigate} title="Buchungen" actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>}>
      <section className="card stack-sm">
        <div className="crud-toolbar"><div className="inline-between"><h3>Buchungen</h3><Badge>{filtered.length}</Badge></div><div className="admin-toolbar admin-toolbar-wrap"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /><select value={floorplanId} onChange={(e) => setFloorplanId(e.target.value)}><option value="">Alle Floorpläne</option>{floorplans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select><select value={deskId} onChange={(e) => setDeskId(e.target.value)}><option value="">Alle Desks</option>{desks.filter((desk) => (floorplanId ? desk.floorplanId === floorplanId : true)).map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}</select><div className="admin-search">🔎<input value={personQuery} onChange={(e) => setPersonQuery(e.target.value)} placeholder="Person suchen" /></div></div></div>
        {state.error && <ErrorState text={state.error} onRetry={load} />}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Datum</th><th>Person</th><th>Desk</th><th>Floorplan</th><th>Erstellt</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={6} /> : <tbody>{filtered.map((booking) => { const desk = desks.find((item) => item.id === booking.deskId); const floorplan = floorplans.find((plan) => plan.id === desk?.floorplanId); return <tr key={booking.id}><td>{formatDateOnly(booking.date)}</td><td>{booking.userDisplayName || booking.userEmail}</td><td>{desk?.name ?? booking.deskId}</td><td>{floorplan?.name ?? '—'}</td><td>{formatDate(booking.createdAt)}</td><td className="align-right"><RowMenu onEdit={() => setEditing(booking)} onDelete={() => setDeleteBooking(booking)} /></td></tr>; })}</tbody>}</table></div>
        {!state.loading && filtered.length === 0 && <EmptyState text="Keine Buchungen im Zeitraum gefunden." action={<button className="btn" onClick={() => setCreating(true)}>Neu anlegen</button>} />}
      </section>
      {(creating || editing) && <BookingEditor booking={editing} desks={desks} employees={employees} onClose={() => { setCreating(false); setEditing(null); navigate('/admin/bookings'); }} onSaved={async (m) => { toasts.success(m); setCreating(false); setEditing(null); await load(); }} onError={toasts.error} />}
      {deleteBooking && <ConfirmDialog title="Buchung löschen?" description="Die ausgewählte Buchung wird entfernt." onCancel={() => setDeleteBooking(null)} onConfirm={async () => { await del(`/admin/bookings/${deleteBooking.id}`, authHeaders()); setDeleteBooking(null); toasts.success('Buchung gelöscht'); await load(); }} />}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}

function BookingEditor({ booking, desks, employees, onClose, onSaved, onError }: { booking: Booking | null; desks: Desk[]; employees: Employee[]; onClose: () => void; onSaved: (m: string) => Promise<void>; onError: (m: string) => void }) {
  const [deskId, setDeskId] = useState(booking?.deskId ?? desks[0]?.id ?? '');
  const [date, setDate] = useState(booking?.date?.slice(0, 10) ?? today);
  const [userEmail, setUserEmail] = useState(booking?.userEmail ?? employees[0]?.email ?? '');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (booking) {
        await patch(`/admin/bookings/${booking.id}`, { deskId, date, userEmail }, authHeaders());
        await onSaved('Buchung aktualisiert');
      } else {
        await post('/bookings', { deskId, date, userEmail }, authHeaders());
        await onSaved('Buchung angelegt');
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };
  return <div className="overlay"><section className="card dialog stack-sm"><h3>{booking ? 'Buchung bearbeiten' : 'Buchung anlegen'}</h3><form className="stack-sm" onSubmit={submit}><select required value={deskId} onChange={(e) => setDeskId(e.target.value)}>{desks.map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}</select><input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /><select required value={userEmail} onChange={(e) => setUserEmail(e.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.email}>{employee.displayName} ({employee.email})</option>)}</select><div className="inline-end"><button className="btn btn-outline" type="button" onClick={onClose}>Abbrechen</button><button className="btn">Speichern</button></div></form></section></div>;
}

function EmployeesPage({ path, navigate, onRoleStateChanged, currentAdminEmail }: RouteProps & { currentAdminEmail: string }) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '', ready: false });
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Employee | null>(null);
  const [creating, setCreating] = useState(hasCreateFlag(path));
  const [pendingDeactivate, setPendingDeactivate] = useState<Employee | null>(null);
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null);

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const rows = await get<Employee[]>('/admin/employees', authHeaders());
      setEmployees(rows);
      setState({ loading: false, error: '', ready: true });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'Fehler beim Laden', ready: true });
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => { if (hasCreateFlag(path)) setCreating(true); }, [path]);

  const filtered = useMemo(() => employees.filter((employee) => `${employee.displayName} ${employee.email}`.toLowerCase().includes(query.toLowerCase())), [employees, query]);

  const updateRole = async (employee: Employee, role: 'admin' | 'user') => {
    setUpdatingRoleId(employee.id);
    try {
      const updated = await patch<Employee>(`/admin/employees/${employee.id}`, { role }, authHeaders());
      setEmployees((current) => current.map((row) => (row.id === employee.id ? updated : row)));
      toasts.success('Rolle aktualisiert');

      if (employee.email === currentAdminEmail && updated.role !== 'admin') {
        localStorage.removeItem('rbms-admin-token');
        await onRoleStateChanged();
        navigate('/');
        return;
      }

      await onRoleStateChanged();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Rolle konnte nicht aktualisiert werden');
    } finally {
      setUpdatingRoleId(null);
    }
  };


  return (
    <AdminLayout path={path} navigate={navigate} title="Mitarbeiter" actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>}>
      <section className="card stack-sm">
        <div className="crud-toolbar"><div className="inline-between"><h3>Mitarbeiter</h3><Badge>{filtered.length}</Badge></div><div className="admin-search">🔎<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name oder E-Mail" /></div></div>
        {state.error && <ErrorState text={state.error} onRetry={load} />}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={5} /> : <tbody>{filtered.map((employee) => <tr key={employee.id}><td>{employee.displayName}</td><td className="truncate-cell" title={employee.email}>{employee.email}</td><td><select value={employee.role} disabled={updatingRoleId === employee.id} onChange={(event) => { const nextRole = event.target.value as 'admin' | 'user'; if (nextRole !== employee.role) void updateRole(employee, nextRole); }}><option value="user">User</option><option value="admin">Admin</option></select>{updatingRoleId === employee.id && <span className="muted"> ⏳</span>}</td><td>{employee.isActive ? <Badge tone="ok">aktiv</Badge> : <Badge tone="warn">deaktiviert</Badge>}</td><td className="align-right"><RowMenu onEdit={() => setEditing(employee)} onDelete={() => setPendingDeactivate(employee)} /></td></tr>)}</tbody>}</table></div>
        {!state.loading && filtered.length === 0 && <EmptyState text="Keine Mitarbeitenden vorhanden." action={<button className="btn" onClick={() => setCreating(true)}>Neu anlegen</button>} />}
      </section>
      {(creating || editing) && <EmployeeEditor employee={editing} onClose={() => { setCreating(false); setEditing(null); navigate('/admin/employees'); }} onSaved={async () => { setCreating(false); setEditing(null); toasts.success('Mitarbeiter gespeichert'); await load(); await onRoleStateChanged(); }} onError={toasts.error} />}
      {pendingDeactivate && <ConfirmDialog title="Mitarbeiter deaktivieren?" description={`${pendingDeactivate.displayName} wird auf inaktiv gesetzt.`} onCancel={() => setPendingDeactivate(null)} onConfirm={async () => { await patch(`/admin/employees/${pendingDeactivate.id}`, { isActive: false }, authHeaders()); setPendingDeactivate(null); toasts.success('Mitarbeiter deaktiviert'); await load(); }} />}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}

function EmployeeEditor({ employee, onClose, onSaved, onError }: { employee: Employee | null; onClose: () => void; onSaved: () => Promise<void>; onError: (m: string) => void }) {
  const [displayName, setDisplayName] = useState(employee?.displayName ?? '');
  const [email, setEmail] = useState(employee?.email ?? '');
  const [isActive, setIsActive] = useState(employee?.isActive ?? true);
  const [role, setRole] = useState<'admin' | 'user'>(employee?.role ?? 'user');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (employee) await patch(`/admin/employees/${employee.id}`, { displayName, isActive, role }, authHeaders());
      else await post('/admin/employees', { displayName, email, role }, authHeaders());
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };
  return <div className="overlay"><section className="card dialog stack-sm"><h3>{employee ? 'Mitarbeiter bearbeiten' : 'Mitarbeiter anlegen'}</h3><form className="stack-sm" onSubmit={submit}><input required value={displayName} placeholder="Name" onChange={(e) => setDisplayName(e.target.value)} />{!employee && <input required type="email" value={email} placeholder="E-Mail" onChange={(e) => setEmail(e.target.value)} />}<label className="field"><span>Rolle</span><select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'user')}><option value="user">User</option><option value="admin">Admin</option></select></label>{employee && <label className="toggle"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />Aktiv</label>}<div className="inline-end"><button className="btn btn-outline" type="button" onClick={onClose}>Abbrechen</button><button className="btn">Speichern</button></div></form></section></div>;
}

export function AdminRouter({ path, navigate, onRoleStateChanged }: RouteProps) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [adminSession, setAdminSession] = useState<AdminSession | null>(null);
  const route = basePath(path);

  useEffect(() => {
    (async () => {
      if (route === '/admin/login') { setAllowed(false); return; }
      const token = localStorage.getItem('rbms-admin-token');
      if (!token) { setAllowed(false); return; }
      try {
        const session = await get<AdminSession>('/admin/me', authHeaders());
        if (session.role !== 'admin') {
          localStorage.removeItem('rbms-admin-token');
          setAllowed(false);
          return;
        }

        setAdminSession(session);
        setAllowed(true);
      } catch {
        localStorage.removeItem('rbms-admin-token');
        setAllowed(false);
      }
    })();
  }, [route]);

  if (route === '/admin/login') return <AdminLogin navigate={navigate} />;
  if (allowed === null) return <main className="app-shell"><section className="card">Prüfe Berechtigung…</section></main>;
  if (!allowed) return <main className="app-shell"><section className="card stack-sm down-card"><h2>Keine Berechtigung</h2><button className="btn" onClick={() => navigate('/')}>Zurück zur App</button></section></main>;

  if (route === '/admin') return <DashboardPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} />;
  if (route === '/admin/floorplans') return <FloorplansPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} />;
  if (route === '/admin/desks') return <DesksPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} />;
  if (route === '/admin/bookings') return <BookingsPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} />;
  if (route === '/admin/employees') return <EmployeesPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} currentAdminEmail={adminSession?.email ?? ''} />;

  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Admin-Seite nicht gefunden</h2><button className="btn" onClick={() => navigate('/admin')}>Zum Dashboard</button></section></main>;
}
