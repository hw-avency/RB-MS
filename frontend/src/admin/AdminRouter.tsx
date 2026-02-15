import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { del, get, patch, post, resolveApiUrl } from '../api';
import { Avatar } from '../components/Avatar';
import { UserMenu } from '../components/UserMenu';
import { FloorplanCanvas } from '../FloorplanCanvas';

type Floorplan = { id: string; name: string; imageUrl: string; createdAt?: string; updatedAt?: string };
type Desk = { id: string; floorplanId: string; name: string; x: number; y: number; createdAt?: string; updatedAt?: string };
type Employee = { id: string; email: string; displayName: string; role: 'admin' | 'user'; isActive: boolean; photoUrl?: string | null; createdAt?: string; updatedAt?: string };
type Booking = { id: string; deskId: string; userEmail: string; userDisplayName?: string; employeeId?: string; date: string; createdAt?: string; updatedAt?: string };
type DbColumn = { name: string; type: string; required: boolean; id: boolean; hasDefaultValue: boolean };
type DbTable = { name: string; model: string; columns: DbColumn[] };
type Toast = { id: number; tone: 'success' | 'error'; message: string };
type RouteProps = { path: string; navigate: (to: string) => void; onRoleStateChanged: () => Promise<void>; onLogout: () => Promise<void>; currentUser?: AdminSession | null };
type AdminSession = { id?: string; email: string; name?: string; displayName?: string; role: 'admin' | 'user'; isActive?: boolean };
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
  { to: '/admin/desks', label: 'Tische' },
  { to: '/admin/bookings', label: 'Buchungen' },
  { to: '/admin/employees', label: 'Mitarbeiter' },
  { to: '/admin/db-admin', label: 'DB Admin' }
];

const today = new Date().toISOString().slice(0, 10);
const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

function ConfirmDialog({ title, description, onConfirm, onCancel, confirmDisabled = false, confirmLabel = 'Löschen' }: { title: string; description: string; onConfirm: () => void; onCancel: () => void; confirmDisabled?: boolean; confirmLabel?: string }) {
  return (
    <div className="overlay"><section className="card dialog stack-sm" role="dialog" aria-modal="true"><h3>{title}</h3><p className="muted">{description}</p><div className="inline-end"><button className="btn btn-outline" disabled={confirmDisabled} onClick={onCancel}>Abbrechen</button><button className="btn btn-danger" disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button></div></section></div>
  );
}

type RowMenuItem = { label: string; onSelect: () => void; danger?: boolean };

function RowMenu({ items }: { items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const syncPosition = () => {
    if (!triggerRef.current || !menuRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();
    const padding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const spaceBottom = viewportHeight - triggerRect.bottom;
    const openAbove = spaceBottom < menuRect.height + padding;
    const top = openAbove ? triggerRect.top - menuRect.height - 4 : triggerRect.bottom + 4;
    const unclampedLeft = triggerRect.right - menuRect.width;
    const left = Math.min(Math.max(unclampedLeft, padding), viewportWidth - menuRect.width - padding);
    const clampedTop = Math.min(Math.max(top, padding), viewportHeight - menuRect.height - padding);
    setPosition({ left, top: clampedTop });
  };

  useEffect(() => {
    if (!open) return;
    syncPosition();
    const onWindowUpdate = () => syncPosition();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % items.length);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + items.length) % items.length);
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        items[activeIndex]?.onSelect();
        setOpen(false);
      }
    };
    window.addEventListener('resize', onWindowUpdate);
    window.addEventListener('scroll', onWindowUpdate, true);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onWindowUpdate);
      window.removeEventListener('scroll', onWindowUpdate, true);
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, activeIndex, items]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-outline btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setActiveIndex(0);
        }}
      >
        ⋯
      </button>
      {open && createPortal(
        <div ref={menuRef} className="row-menu-content row-menu-overlay" role="menu" style={{ left: position.left, top: position.top }}>
          {items.map((item, index) => (
            <button
              key={item.label}
              role="menuitem"
              className={`btn btn-ghost row-menu-item ${item.danger ? 'btn-danger-text' : ''} ${activeIndex === index ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                item.onSelect();
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

function AdminLayout({ path, navigate, title, actions, children, onLogout, currentUser }: { path: string; navigate: (to: string) => void; title: string; actions?: ReactNode; children: ReactNode; onLogout: () => Promise<void>; currentUser: AdminSession | null }) {
  const current = basePath(path);
  return (
    <main className="app-shell">
      <div className="admin-shell-v2">
        <aside className="card admin-sidebar-v2 stack-sm">
          <h3>RB-MS Admin</h3>
          {navItems.map((item) => <button key={item.to} className={`btn btn-ghost admin-nav-link ${current === item.to ? 'active' : ''}`} onClick={() => navigate(item.to)}>{item.label}</button>)}
          {currentUser && <UserMenu user={currentUser} onLogout={async () => { await onLogout(); navigate('/login'); }} />}
        </aside>
        <section className="admin-content-v2 stack-sm">
          <header className="card admin-topbar-v2"><div><p className="muted">Admin / {title}</p><strong>{title}</strong></div><div className="inline-end"><button className="btn btn-outline" onClick={() => navigate('/')}>Zurück zur App</button>{actions}</div></header>
          {children}
        </section>
      </div>
    </main>
  );
}

function AdminSplitLayout({
  leftHeader,
  leftContent,
  rightHeader,
  rightContent,
  leftClassName = '',
  rightClassName = ''
}: {
  leftHeader?: ReactNode;
  leftContent: ReactNode;
  rightHeader?: ReactNode;
  rightContent: ReactNode;
  leftClassName?: string;
  rightClassName?: string;
}) {
  return (
    <section className="admin-split-layout">
      <section className={`card stack-sm ${leftClassName}`.trim()}>
        {leftHeader}
        {leftContent}
      </section>
      <aside className={`card stack-sm admin-split-floor-preview ${rightClassName}`.trim()}>
        {rightHeader}
        {rightContent}
      </aside>
    </section>
  );
}

function DashboardPage({ path, navigate, onLogout, currentUser }: RouteProps) {
  const [state, setState] = useState<DataState>({ loading: true, error: '', ready: false });
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [desks, setDesks] = useState<Desk[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const [employeeRows, floorplanRows, bookingRows] = await Promise.all([
        get<Employee[]>('/admin/employees'),
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
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Dashboard" currentUser={currentUser ?? null}>
      {state.error && <ErrorState text={state.error} onRetry={load} />}
      <section className="dashboard-grid">
        {[{ label: 'Aktive Mitarbeiter', value: employees.filter((e) => e.isActive).length, icon: '👥', to: '/admin/employees' }, { label: 'Tische', value: desks.length, icon: '🖱️', to: '/admin/desks' }, { label: 'Floorpläne', value: floorplans.length, icon: '🗺️', to: '/admin/floorplans' }, { label: 'Buchungen (7 Tage)', value: bookingsNextWeek, icon: '📅', to: '/admin/bookings' }].map((card) => (
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
                return <button key={booking.id} className="dashboard-booking-row" onClick={() => navigate('/admin/bookings')}><div><strong>{booking.userDisplayName || booking.userEmail}</strong><p className="muted">{formatDateOnly(booking.date)} · {desk?.name ?? 'Tisch'}</p></div><span className="muted">{floorplan?.name ?? '—'}</span></button>;
              })}
            </div>
          )}
        </article>
        <article className="card stack-sm">
          <h3>Schnellaktionen</h3>
          <div className="quick-actions-grid">
            <button className="btn" onClick={() => navigate('/admin/employees?create=1')}>Mitarbeiter anlegen</button>
            <button className="btn" onClick={() => navigate('/admin/floorplans?create=1')}>Floorplan anlegen</button>
            <button className="btn" onClick={() => navigate('/admin/desks?create=1')}>Tisch anlegen</button>
            <button className="btn" onClick={() => navigate('/admin/bookings?create=1')}>Buchung anlegen</button>
          </div>
        </article>
      </section>
    </AdminLayout>
  );
}

function FloorplansPage({ path, navigate, onLogout, currentUser }: RouteProps) {
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
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Floorpläne" actions={<button className="btn" onClick={() => setShowCreate(true)}>Neu</button>} currentUser={currentUser ?? null}>
      <section className="card stack-sm">
        <div className="crud-toolbar"><div className="inline-between"><h3>Floorpläne</h3><Badge>{filtered.length}</Badge></div><div className="admin-search">🔎<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Floorplan suchen" /></div></div>
        {state.error && <ErrorState text={state.error} onRetry={load} />}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Vorschau</th><th>Name</th><th>Bild URL</th><th>Erstellt</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={5} /> : <tbody>{filtered.map((floorplan) => <tr key={floorplan.id}><td><button className="floor-thumb-btn" onClick={() => setEditing(floorplan)} aria-label={`Floorplan ${floorplan.name} öffnen`}><img className="floor-thumb" src={resolveApiUrl(floorplan.imageUrl)} alt={floorplan.name} loading="lazy" /></button></td><td><button className="btn btn-ghost" onClick={() => setEditing(floorplan)}>{floorplan.name}</button></td><td className="truncate-cell" title={floorplan.imageUrl}>{floorplan.imageUrl}</td><td>{formatDate(floorplan.createdAt)}</td><td className="align-right"><RowMenu items={[{ label: 'Bearbeiten', onSelect: () => setEditing(floorplan) }, { label: 'Löschen', onSelect: () => setPendingDelete(floorplan), danger: true }]} /></td></tr>)}</tbody>}</table></div>
        {!state.loading && filtered.length === 0 && <EmptyState text="Keine Floorpläne vorhanden." action={<button className="btn" onClick={() => setShowCreate(true)}>Neu anlegen</button>} />}
      </section>
      {(showCreate || editing) && <FloorplanEditor floorplan={editing} onClose={() => { setShowCreate(false); setEditing(null); navigate('/admin/floorplans'); }} onSaved={async () => { setShowCreate(false); setEditing(null); toasts.success('Floorplan gespeichert'); await load(); }} onError={toasts.error} />}
      {pendingDelete && <ConfirmDialog title="Floorplan löschen?" description={`"${pendingDelete.name}" wird dauerhaft entfernt.`} onCancel={() => setPendingDelete(null)} onConfirm={async () => { await del(`/admin/floorplans/${pendingDelete.id}`); setPendingDelete(null); toasts.success('Floorplan gelöscht'); await load(); }} />}
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
      if (floorplan) await patch(`/admin/floorplans/${floorplan.id}`, { name, imageUrl });
      else await post('/admin/floorplans', { name, imageUrl });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };
  return <div className="overlay"><section className="card dialog stack-sm"><h3>{floorplan ? 'Floorplan bearbeiten' : 'Floorplan anlegen'}</h3><form className="stack-sm" onSubmit={submit}><input required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /><input required placeholder="Asset URL" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} /><div className="inline-end"><button type="button" className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn">Speichern</button></div></form></section></div>;
}

function PositionPickerDialog({ floorplan, x, y, onClose, onPick }: { floorplan: Floorplan | null; x: number | null; y: number | null; onClose: () => void; onPick: (x: number, y: number) => void }) {
  const [px, setPx] = useState<number>(x ?? 0.5);
  const [py, setPy] = useState<number>(y ?? 0.5);
  const setByClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const nextX = (event.clientX - box.left) / box.width;
    const nextY = (event.clientY - box.top) / box.height;
    setPx(Math.max(0, Math.min(1, nextX)));
    setPy(Math.max(0, Math.min(1, nextY)));
  };
  return (
    <div className="overlay"><section className="card dialog stack-sm"><h3>Position im Plan setzen</h3><p className="muted">Klicke im Plan, um die Tisch-Position zu setzen.</p><div className="position-picker" onClick={setByClick}>{floorplan?.imageUrl ? <img src={floorplan.imageUrl} alt={floorplan.name} className="position-image" /> : <div className="empty-state">Kein Floorplan-Bild</div>}<span className="position-pin" style={{ left: `${px * 100}%`, top: `${py * 100}%` }} /></div><p className="muted">Position: {Math.round(px * 100)}% / {Math.round(py * 100)}%</p><div className="inline-end"><button className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn" onClick={() => onPick(px, py)}>Übernehmen</button></div></section></div>
  );
}

function DeskEditor({ desk, floorplans, defaultFloorplanId, initialPosition, lockFloorplan, onRequestPositionMode, onClose, onSaved, onError }: { desk: Desk | null; floorplans: Floorplan[]; defaultFloorplanId: string; initialPosition?: { x: number; y: number } | null; lockFloorplan?: boolean; onRequestPositionMode?: () => void; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [form, setForm] = useState<DeskFormState>({ floorplanId: desk?.floorplanId ?? defaultFloorplanId, name: desk?.name ?? '', x: initialPosition?.x ?? desk?.x ?? null, y: initialPosition?.y ?? desk?.y ?? null });
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
        await patch(`/admin/desks/${desk.id}`, { name: form.name, x: form.x, y: form.y });
      } else {
        await post(`/admin/floorplans/${form.floorplanId}/desks`, { name: form.name, x: form.x, y: form.y });
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  return (
    <>
      <div className="overlay"><section className="card dialog stack-sm"><h3>{desk ? 'Tisch bearbeiten' : 'Tisch anlegen'}</h3><form className="stack-sm" onSubmit={submit}>{lockFloorplan ? <label className="field"><span>Floorplan</span><input value={floorplans.find((f) => f.id === form.floorplanId)?.name ?? '—'} disabled /></label> : <label className="field"><span>Floorplan</span><select required value={form.floorplanId} onChange={(e) => onFloorplanChange(e.target.value)}><option value="">Floorplan wählen</option>{floorplans.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}<label className="field"><span>Label</span><input required placeholder="Tischname" value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} /></label><div className="field"><span>Position</span><div className="inline-between"><Badge tone={form.x !== null && form.y !== null ? 'ok' : 'warn'}>{form.x !== null && form.y !== null ? `Position gesetzt (${Math.round(form.x * 100)}% / ${Math.round(form.y * 100)}%)` : 'Keine Position gesetzt'}</Badge><div className="admin-toolbar">{onRequestPositionMode && <button type="button" className="btn btn-outline" onClick={() => { onClose(); onRequestPositionMode(); }}>Position im Plan ändern</button>}<button type="button" className="btn btn-outline" disabled={!form.floorplanId} onClick={() => setShowPicker(true)}>{form.x !== null && form.y !== null ? 'Neu positionieren' : 'Position im Plan setzen'}</button></div></div>{!form.floorplanId && <p className="muted">Bitte Floorplan wählen.</p>}</div>{inlineError && <p className="error-banner">{inlineError}</p>}<div className="inline-end"><button type="button" className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn" disabled={!canSave}>Speichern</button></div></form></section></div>
      {showPicker && <PositionPickerDialog floorplan={floorplan} x={form.x} y={form.y} onClose={() => setShowPicker(false)} onPick={(x, y) => { setForm((current) => ({ ...current, x, y })); setShowPicker(false); setInlineError(''); }} />}
    </>
  );
}

function DesksPage({ path, navigate, onLogout, currentUser }: RouteProps) {
  const toasts = useToasts();
  const [state, setState] = useState<DataState>({ loading: true, error: '', ready: false });
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [floorplanId, setFloorplanId] = useState('');
  const [desks, setDesks] = useState<Desk[]>([]);
  const [query, setQuery] = useState('');
  const [editingDesk, setEditingDesk] = useState<Desk | null>(null);
  const [createRequest, setCreateRequest] = useState<{ x: number; y: number } | null>(null);
  const [deleteDesk, setDeleteDesk] = useState<Desk | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [selectedDeskIds, setSelectedDeskIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');
  const [canvasMode, setCanvasMode] = useState<'idle' | 'create' | 'reposition'>('idle');
  const [pendingRepositionDesk, setPendingRepositionDesk] = useState<Desk | null>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const floorplan = floorplans.find((item) => item.id === floorplanId) ?? null;

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
  useEffect(() => { if (hasCreateFlag(path)) setCanvasMode('create'); }, [path]);

  useEffect(() => {
    if (!selectedDeskId) return;
    rowRefs.current[selectedDeskId]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedDeskId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCanvasMode('idle');
        setPendingRepositionDesk(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(() => desks.filter((desk) => desk.name.toLowerCase().includes(query.toLowerCase())), [desks, query]);
  const isAllVisibleSelected = filtered.length > 0 && filtered.every((desk) => selectedDeskIds.has(desk.id));

  const startCreateMode = () => {
    setEditingDesk(null);
    setPendingRepositionDesk(null);
    setCanvasMode('create');
  };

  const cancelModes = () => {
    setCanvasMode('idle');
    setPendingRepositionDesk(null);
  };

  const onCanvasClick = async ({ xPct, yPct }: { xPct: number; yPct: number }) => {
    const x = Math.max(0, Math.min(1, xPct));
    const y = Math.max(0, Math.min(1, yPct));
    if (canvasMode === 'create') {
      setCreateRequest({ x, y });
      setCanvasMode('idle');
      return;
    }
    if (canvasMode === 'reposition' && pendingRepositionDesk) {
      if (!window.confirm('Position speichern?')) return;
      try {
        await patch(`/admin/desks/${pendingRepositionDesk.id}`, { x, y });
        toasts.success('Position aktualisiert');
        cancelModes();
        await loadDesks(floorplanId);
      } catch (err) {
        toasts.error(err instanceof Error ? err.message : 'Position konnte nicht gespeichert werden');
      }
    }
  };

  const clearSelection = () => setSelectedDeskIds(new Set());

  const toggleDeskSelection = (deskId: string) => {
    setSelectedDeskIds((current) => {
      const next = new Set(current);
      if (next.has(deskId)) {
        next.delete(deskId);
      } else {
        next.add(deskId);
      }
      return next;
    });
  };

  const toggleAllVisibleDesks = () => {
    if (isAllVisibleSelected) {
      setSelectedDeskIds((current) => {
        const next = new Set(current);
        filtered.forEach((desk) => next.delete(desk.id));
        return next;
      });
      return;
    }
    setSelectedDeskIds((current) => {
      const next = new Set(current);
      filtered.forEach((desk) => next.add(desk.id));
      return next;
    });
  };

  const runBulkDelete = async () => {
    if (selectedDeskIds.size === 0 || isBulkDeleting) return;
    setIsBulkDeleting(true);
    try {
      const selectedIds = Array.from(selectedDeskIds);
      await del(`/admin/desks?ids=${encodeURIComponent(selectedIds.join(','))}`);
      toasts.success(`${selectedIds.length} Tisch(e) gelöscht`);
      setBulkDeleteOpen(false);
      clearSelection();
      await loadDesks(floorplanId);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Bulk-Delete fehlgeschlagen');
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Tische" currentUser={currentUser ?? null}>
      <AdminSplitLayout
        leftHeader={<div className="crud-toolbar"><div className="inline-between"><h3>Tische</h3><Badge>{filtered.length}</Badge></div><div className="admin-toolbar admin-toolbar-wrap"><select value={floorplanId} onChange={(e) => { setFloorplanId(e.target.value); setSelectedDeskId(''); cancelModes(); }}><option value="">Floorplan wählen</option>{floorplans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select><div className="admin-search">🔎<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tisch suchen" /></div><button className="btn" disabled={!floorplanId} onClick={startCreateMode}>Neuer Tisch</button>{canvasMode !== 'idle' && <button className="btn btn-outline" onClick={cancelModes}>Abbrechen</button>}</div></div>}
        leftContent={<>{state.error && <ErrorState text={state.error} onRetry={() => void loadDesks(floorplanId)} />}{selectedDeskIds.size > 0 && <div className="bulk-actions"><strong>{selectedDeskIds.size} ausgewählt</strong><div className="inline-end"><button className="btn btn-danger" disabled={isBulkDeleting} onClick={() => setBulkDeleteOpen(true)}>{isBulkDeleting ? 'Lösche…' : 'Auswahl löschen'}</button><button className="btn btn-outline" disabled={isBulkDeleting} onClick={clearSelection}>Abbrechen</button></div></div>}<div className="table-wrap"><table className="admin-table"><thead><tr><th><input type="checkbox" checked={isAllVisibleSelected} onChange={toggleAllVisibleDesks} aria-label="Alle sichtbaren Tische auswählen" /></th><th>Label</th><th>Aktualisiert</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={4} /> : <tbody>{filtered.map((desk) => <tr key={desk.id} ref={(row) => { rowRefs.current[desk.id] = row; }} className={selectedDeskId === desk.id ? 'row-selected' : ''} onClick={() => setSelectedDeskId(desk.id)}><td><input type="checkbox" checked={selectedDeskIds.has(desk.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleDeskSelection(desk.id)} aria-label={`${desk.name} auswählen`} /></td><td>{desk.name}</td><td>{formatDate(desk.updatedAt ?? desk.createdAt)}</td><td className="align-right"><RowMenu items={[{ label: 'Position ändern', onSelect: () => { setSelectedDeskId(desk.id); setPendingRepositionDesk(desk); setCanvasMode('reposition'); } }, { label: 'Bearbeiten', onSelect: () => setEditingDesk(desk) }, { label: 'Löschen', onSelect: () => setDeleteDesk(desk), danger: true }]} /></td></tr>)}</tbody>}</table></div>{!state.loading && filtered.length === 0 && <EmptyState text="Keine Tische gefunden." action={<button className="btn" onClick={startCreateMode}>Neuen Tisch platzieren</button>} />}</>}
        rightHeader={<div className="inline-between"><h3>Floorplan</h3>{canvasMode === 'create' && <Badge tone="warn">Klicke auf den Plan, um den Tisch zu platzieren</Badge>}{canvasMode === 'reposition' && pendingRepositionDesk && <Badge tone="warn">Neue Position für {pendingRepositionDesk.name} wählen</Badge>}</div>}
        rightContent={<>{!floorplan && <EmptyState text="Bitte Floorplan wählen." />}{floorplan && <div className={`canvas-body admin-floor-canvas ${canvasMode !== 'idle' ? 'is-active-mode' : ''}`}><FloorplanCanvas imageUrl={floorplan.imageUrl} imageAlt={floorplan.name} desks={desks.map((desk) => ({ id: desk.id, name: desk.name, x: desk.x, y: desk.y, status: 'free', booking: null, isSelected: selectedDeskIds.has(desk.id) }))} selectedDeskId={selectedDeskId} hoveredDeskId={hoveredDeskId} onHoverDesk={setHoveredDeskId} onSelectDesk={(deskId) => { setSelectedDeskId(deskId); toggleDeskSelection(deskId); }} onCanvasClick={onCanvasClick} onDeskDoubleClick={(deskId) => { const target = desks.find((desk) => desk.id === deskId); if (target) setEditingDesk(target); }} /></div>}</>}
      />
      {(createRequest || editingDesk) && <DeskEditor desk={editingDesk} floorplans={floorplans} defaultFloorplanId={floorplanId} initialPosition={createRequest} lockFloorplan={Boolean(createRequest)} onRequestPositionMode={editingDesk ? () => { setPendingRepositionDesk(editingDesk); setCanvasMode('reposition'); } : undefined} onClose={() => { setCreateRequest(null); setEditingDesk(null); navigate('/admin/desks'); }} onSaved={async () => { setCreateRequest(null); setEditingDesk(null); toasts.success('Tisch gespeichert'); await loadDesks(floorplanId); }} onError={toasts.error} />}
      {deleteDesk && <ConfirmDialog title="Tisch löschen?" description={`Tisch "${deleteDesk.name}" wird entfernt.`} onCancel={() => setDeleteDesk(null)} onConfirm={async () => { await del(`/admin/desks/${deleteDesk.id}`); setDeleteDesk(null); toasts.success('Tisch gelöscht'); await loadDesks(floorplanId); }} />}
      {bulkDeleteOpen && <ConfirmDialog title={`${selectedDeskIds.size} Einträge löschen?`} description="Dieser Vorgang ist irreversibel." onCancel={() => setBulkDeleteOpen(false)} onConfirm={() => void runBulkDelete()} confirmDisabled={isBulkDeleting} confirmLabel={isBulkDeleting ? 'Lösche…' : 'Löschen'} />}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}

function BookingsPage({ path, navigate, onLogout, currentUser }: RouteProps) {
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
  const [selectedBookingIds, setSelectedBookingIds] = useState<string[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [focusedBookingId, setFocusedBookingId] = useState<string>('');

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const floorplanRows = await get<Floorplan[]>('/floorplans');
      const deskRows = (await Promise.all(floorplanRows.map((plan) => get<Desk[]>(`/floorplans/${plan.id}/desks`)))).flat();
      const [employeeRows, bookingRows] = await Promise.all([get<Employee[]>('/admin/employees'), get<Booking[]>(`/admin/bookings?from=${from}&to=${to}`)]);
      setFloorplans(floorplanRows);
      setDesks(deskRows);
      setEmployees(employeeRows);
      setBookings(bookingRows);
      setFocusedBookingId((current) => current || bookingRows[0]?.id || '');
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
  const isAllVisibleSelected = filtered.length > 0 && filtered.every((booking) => selectedBookingIds.includes(booking.id));

  const focusedBooking = filtered.find((booking) => booking.id === focusedBookingId) ?? filtered[0] ?? null;
  const focusedDesk = desks.find((desk) => desk.id === focusedBooking?.deskId);
  const focusedFloor = floorplans.find((plan) => plan.id === focusedDesk?.floorplanId);
  const focusedDesks = focusedFloor ? desks.filter((desk) => desk.floorplanId === focusedFloor.id).map((desk) => ({ id: desk.id, name: desk.name, x: desk.x, y: desk.y, status: 'free' as const, booking: null, isSelected: desk.id === focusedDesk?.id, isHighlighted: desk.id === focusedDesk?.id })) : [];

  const toggleBookingSelection = (bookingId: string) => {
    setSelectedBookingIds((current) => current.includes(bookingId) ? current.filter((id) => id !== bookingId) : [...current, bookingId]);
  };
  const toggleAllVisibleBookings = () => {
    if (isAllVisibleSelected) {
      setSelectedBookingIds((current) => current.filter((id) => !filtered.some((booking) => booking.id === id)));
      return;
    }
    setSelectedBookingIds((current) => Array.from(new Set([...current, ...filtered.map((booking) => booking.id)])));
  };
  const runBulkDelete = async () => {
    if (selectedBookingIds.length === 0 || isBulkDeleting) return;
    setIsBulkDeleting(true);
    try {
      await del(`/admin/bookings?ids=${encodeURIComponent(selectedBookingIds.join(','))}`);
      toasts.success(`${selectedBookingIds.length} Buchung(en) gelöscht`);
      setBulkDeleteOpen(false);
      setSelectedBookingIds([]);
      await load();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Bulk-Delete fehlgeschlagen');
    } finally {
      setIsBulkDeleting(false);
    }
  };
  const resetFilters = () => { setFloorplanId(''); setDeskId(''); setPersonQuery(''); setSelectedBookingIds([]); };

  return <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Buchungen" actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>} currentUser={currentUser ?? null}>
    <AdminSplitLayout
      leftHeader={<div className="crud-toolbar"><div className="inline-between"><h3>Buchungen</h3><Badge>{filtered.length}</Badge></div><div className="admin-toolbar admin-toolbar-wrap"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /><select value={floorplanId} onChange={(e) => setFloorplanId(e.target.value)}><option value="">Alle Floorpläne</option>{floorplans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select><select value={deskId} onChange={(e) => setDeskId(e.target.value)}><option value="">Alle Tische</option>{desks.filter((desk) => (floorplanId ? desk.floorplanId === floorplanId : true)).map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}</select><div className="admin-search">🔎<input value={personQuery} onChange={(e) => setPersonQuery(e.target.value)} placeholder="Person suchen" /></div><button className="btn btn-outline" onClick={resetFilters}>Filter zurücksetzen</button></div></div>}
      leftContent={<>{state.error && <ErrorState text={state.error} onRetry={load} />}{selectedBookingIds.length > 0 && <div className="bulk-actions"><strong>{selectedBookingIds.length} ausgewählt</strong><div className="inline-end"><button className="btn btn-danger" disabled={isBulkDeleting} onClick={() => setBulkDeleteOpen(true)}>{isBulkDeleting ? 'Lösche…' : 'Auswahl löschen'}</button><button className="btn btn-outline" disabled={isBulkDeleting} onClick={() => setSelectedBookingIds([])}>Abbrechen</button></div></div>}<div className="table-wrap"><table className="admin-table"><thead><tr><th><input type="checkbox" checked={isAllVisibleSelected} onChange={toggleAllVisibleBookings} aria-label="Alle sichtbaren Buchungen auswählen" /></th><th>Datum</th><th>Person</th><th>Tisch</th><th>Floorplan</th><th>Erstellt</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={7} /> : <tbody>{filtered.map((booking) => { const desk = desks.find((item) => item.id === booking.deskId); const floorplan = floorplans.find((plan) => plan.id === desk?.floorplanId); return <tr key={booking.id} className={focusedBooking?.id === booking.id ? 'row-selected' : ''} onClick={() => setFocusedBookingId(booking.id)}><td><input type="checkbox" checked={selectedBookingIds.includes(booking.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleBookingSelection(booking.id)} aria-label={`Buchung ${booking.id} auswählen`} /></td><td>{formatDateOnly(booking.date)}</td><td>{booking.userDisplayName || booking.userEmail}</td><td>{desk?.name ?? booking.deskId}</td><td>{floorplan?.name ?? '—'}</td><td>{formatDate(booking.createdAt)}</td><td className="align-right"><RowMenu items={[{ label: 'Bearbeiten', onSelect: () => setEditing(booking) }, { label: 'Löschen', onSelect: () => setDeleteBooking(booking), danger: true }]} /></td></tr>; })}</tbody>}</table></div></>}
      rightHeader={<div className="inline-between"><h3>Floorplan</h3>{focusedDesk && <Badge tone="ok">Tisch: {focusedDesk.name}</Badge>}</div>}
      rightContent={focusedFloor ? <div className="canvas-body"><FloorplanCanvas imageUrl={resolveApiUrl(focusedFloor.imageUrl) ?? focusedFloor.imageUrl} imageAlt={focusedFloor.name} desks={focusedDesks} selectedDeskId={focusedDesk?.id ?? ''} hoveredDeskId="" onHoverDesk={() => undefined} onSelectDesk={() => undefined} /></div> : <EmptyState text="Buchung auswählen, um den Tisch im Floorplan zu sehen." />}
    />
    {(creating || editing) && <BookingEditor booking={editing} desks={desks} employees={employees} floorplans={floorplans} onClose={() => { setCreating(false); setEditing(null); navigate('/admin/bookings'); }} onSaved={async (m) => { toasts.success(m); setCreating(false); setEditing(null); await load(); }} onError={toasts.error} />}
    {deleteBooking && <ConfirmDialog title="Buchung löschen?" description="Die ausgewählte Buchung wird entfernt." onCancel={() => setDeleteBooking(null)} onConfirm={async () => { await del(`/admin/bookings/${deleteBooking.id}`); setDeleteBooking(null); toasts.success('Buchung gelöscht'); await load(); }} />}
    {bulkDeleteOpen && <ConfirmDialog title={`${selectedBookingIds.length} Einträge löschen?`} description="Dieser Vorgang ist irreversibel." onCancel={() => setBulkDeleteOpen(false)} onConfirm={() => void runBulkDelete()} confirmDisabled={isBulkDeleting} confirmLabel={isBulkDeleting ? 'Lösche…' : 'Löschen'} />}
    <ToastViewport toasts={toasts.toasts} />
  </AdminLayout>;
}

function BookingEditor({ booking, desks, employees, floorplans, onClose, onSaved, onError }: { booking: Booking | null; desks: Desk[]; employees: Employee[]; floorplans: Floorplan[]; onClose: () => void; onSaved: (m: string) => Promise<void>; onError: (m: string) => void }) {
  const initialDesk = desks.find((desk) => desk.id === booking?.deskId) ?? desks[0] ?? null;
  const [floorplanId, setFloorplanId] = useState(initialDesk?.floorplanId ?? floorplans[0]?.id ?? '');
  const [deskId, setDeskId] = useState(booking?.deskId ?? initialDesk?.id ?? '');
  const [date, setDate] = useState(booking?.date?.slice(0, 10) ?? today);
  const [userEmail, setUserEmail] = useState(booking?.userEmail ?? employees[0]?.email ?? '');
  const floorDesks = desks.filter((desk) => desk.floorplanId === floorplanId);
  const selectedFloor = floorplans.find((floor) => floor.id === floorplanId) ?? null;

  useEffect(() => {
    if (deskId && floorDesks.some((desk) => desk.id === deskId)) return;
    setDeskId(floorDesks[0]?.id ?? '');
  }, [deskId, floorDesks]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (booking) {
        await patch(`/admin/bookings/${booking.id}`, { deskId, date, userEmail });
        await onSaved('Buchung aktualisiert');
      } else {
        await post('/bookings', { deskId, date, userEmail });
        await onSaved('Buchung angelegt');
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  return <div className="overlay"><section className="card dialog stack-sm booking-editor-dialog"><h3>{booking ? 'Buchung bearbeiten' : 'Buchung anlegen'}</h3><div className="booking-editor-layout"><form className="stack-sm" onSubmit={submit}><label className="field"><span>Floorplan</span><select required value={floorplanId} onChange={(e) => setFloorplanId(e.target.value)}>{floorplans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label><label className="field"><span>Tisch</span><select required value={deskId} onChange={(e) => setDeskId(e.target.value)}>{floorDesks.map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}</select></label><input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /><select required value={userEmail} onChange={(e) => setUserEmail(e.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.email}>{employee.displayName} ({employee.email})</option>)}</select><div className="inline-end"><button className="btn btn-outline" type="button" onClick={onClose}>Abbrechen</button><button className="btn">Speichern</button></div></form><div className="booking-editor-plan">{selectedFloor ? <div className="canvas-body"><FloorplanCanvas imageUrl={resolveApiUrl(selectedFloor.imageUrl) ?? selectedFloor.imageUrl} imageAlt={selectedFloor.name} desks={floorDesks.map((desk) => ({ id: desk.id, name: desk.name, x: desk.x, y: desk.y, status: 'free' as const, booking: null, isSelected: desk.id === deskId, isHighlighted: desk.id === deskId }))} selectedDeskId={deskId} hoveredDeskId="" onHoverDesk={() => undefined} onSelectDesk={setDeskId} /></div> : <EmptyState text="Kein Floorplan ausgewählt." />}</div></div></section></div>;
}

function EmployeesPage({ path, navigate, onRoleStateChanged, onLogout, currentAdminEmail, currentUser }: RouteProps & { currentAdminEmail: string }) {
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
      const rows = await get<Employee[]>('/admin/employees');
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
      const updated = await patch<Employee>(`/admin/employees/${employee.id}`, { role });
      setEmployees((current) => current.map((row) => (row.id === employee.id ? updated : row)));
      toasts.success('Rolle aktualisiert');

      if (employee.email === currentAdminEmail && updated.role !== 'admin') {
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
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Mitarbeiter" actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>} currentUser={currentUser ?? null}>
      <section className="card stack-sm">
        <div className="crud-toolbar"><div className="inline-between"><h3>Mitarbeiter</h3><Badge>{filtered.length}</Badge></div><div className="admin-search">🔎<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name oder E-Mail" /></div></div>
        {state.error && <ErrorState text={state.error} onRetry={load} />}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th className="avatar-col">Avatar</th><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={6} /> : <tbody>{filtered.map((employee) => <tr key={employee.id}><td className="avatar-col"><Avatar displayName={employee.displayName} email={employee.email} photoUrl={employee.photoUrl ?? undefined} size={24} /></td><td>{employee.displayName}</td><td className="truncate-cell" title={employee.email}>{employee.email}</td><td><select value={employee.role} disabled={updatingRoleId === employee.id} onChange={(event) => { const nextRole = event.target.value as 'admin' | 'user'; if (nextRole !== employee.role) void updateRole(employee, nextRole); }}><option value="user">User</option><option value="admin">Admin</option></select>{updatingRoleId === employee.id && <span className="muted"> ⏳</span>}</td><td>{employee.isActive ? <Badge tone="ok">aktiv</Badge> : <Badge tone="warn">deaktiviert</Badge>}</td><td className="align-right"><RowMenu items={[{ label: 'Bearbeiten', onSelect: () => setEditing(employee) }, { label: 'Löschen', onSelect: () => setPendingDeactivate(employee), danger: true }]} /></td></tr>)}</tbody>}</table></div>
        {!state.loading && filtered.length === 0 && <EmptyState text="Keine Mitarbeitenden vorhanden." action={<button className="btn" onClick={() => setCreating(true)}>Neu anlegen</button>} />}
      </section>
      {(creating || editing) && <EmployeeEditor employee={editing} onClose={() => { setCreating(false); setEditing(null); navigate('/admin/employees'); }} onSaved={async () => { setCreating(false); setEditing(null); toasts.success('Mitarbeiter gespeichert'); await load(); await onRoleStateChanged(); }} onError={toasts.error} />}
      {pendingDeactivate && <ConfirmDialog title="Mitarbeiter deaktivieren?" description={`${pendingDeactivate.displayName} wird auf inaktiv gesetzt.`} onCancel={() => setPendingDeactivate(null)} onConfirm={async () => { await patch(`/admin/employees/${pendingDeactivate.id}`, { isActive: false }); setPendingDeactivate(null); toasts.success('Mitarbeiter deaktiviert'); await load(); }} />}
      <ToastViewport toasts={toasts.toasts} />
    </AdminLayout>
  );
}


function DbAdminPage({ path, navigate, onLogout, currentUser }: RouteProps) {
  const toasts = useToasts();
  const [tables, setTables] = useState<DbTable[]>([]);
  const [tableName, setTableName] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowLoading, setRowLoading] = useState(false);
  const [error, setError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState('{}');
  const [clearTableOpen, setClearTableOpen] = useState(false);
  const [clearingTable, setClearingTable] = useState(false);

  const selectedTable = useMemo(() => tables.find((item) => item.name === tableName) ?? null, [tables, tableName]);

  const loadTables = async () => {
    setLoading(true);
    setError('');
    try {
      const list = await get<DbTable[]>('/admin/db/tables');
      setTables(list);
      setTableName((current) => current || list[0]?.name || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tabellen konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  };

  const loadRows = async (name: string) => {
    if (!name) return;
    setRowLoading(true);
    setError('');
    try {
      const response = await get<{ rows: Record<string, unknown>[] }>(`/admin/db/${name}/rows?limit=100`);
      setRows(response.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Zeilen konnten nicht geladen werden');
    } finally {
      setRowLoading(false);
    }
  };

  useEffect(() => { void loadTables(); }, []);
  useEffect(() => { if (tableName) void loadRows(tableName); }, [tableName]);

  const openCreate = () => {
    if (!selectedTable) return;
    const initial = selectedTable.columns
      .filter((column) => !column.id)
      .reduce<Record<string, unknown>>((acc, column) => {
        if (!column.required || column.hasDefaultValue) return acc;
        acc[column.name] = column.type === 'Boolean' ? false : '';
        return acc;
      }, {});
    setEditingRowId(null);
    setEditorValue(JSON.stringify(initial, null, 2));
    setEditorOpen(true);
  };

  const openEdit = (row: Record<string, unknown>) => {
    if (!selectedTable) return;
    const data = selectedTable.columns
      .filter((column) => !column.id)
      .reduce<Record<string, unknown>>((acc, column) => {
        const value = row[column.name];
        if (value instanceof Date) acc[column.name] = value.toISOString();
        else acc[column.name] = value ?? null;
        return acc;
      }, {});
    setEditingRowId(typeof row.id === 'string' ? row.id : null);
    setEditorValue(JSON.stringify(data, null, 2));
    setEditorOpen(true);
  };

  const submitEditor = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedTable) return;

    try {
      const data = JSON.parse(editorValue) as Record<string, unknown>;
      if (editingRowId) await patch(`/admin/db/${selectedTable.name}/rows/${editingRowId}`, { data });
      else await post(`/admin/db/${selectedTable.name}/rows`, { data });
      setEditorOpen(false);
      toasts.success(editingRowId ? 'Datensatz aktualisiert' : 'Datensatz angelegt');
      await loadRows(selectedTable.name);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  const removeRow = async (rowId: string) => {
    if (!selectedTable) return;
    if (!window.confirm('Datensatz wirklich löschen?')) return;
    try {
      await del(`/admin/db/${selectedTable.name}/rows/${rowId}`);
      toasts.success('Datensatz gelöscht');
      await loadRows(selectedTable.name);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Löschen fehlgeschlagen');
    }
  };

  const clearTable = async () => {
    if (!selectedTable) return;

    setClearingTable(true);
    try {
      const response = await del<{ deleted?: number }>(`/admin/db/${selectedTable.name}/rows`);
      setClearTableOpen(false);
      const deletedCount = typeof response?.deleted === 'number' ? response.deleted : rows.length;
      toasts.success(`Tabelle geleert (${deletedCount} Datensätze gelöscht)`);
      await loadRows(selectedTable.name);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Tabelle leeren fehlgeschlagen');
    } finally {
      setClearingTable(false);
    }
  };

  return (
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="DB Admin" actions={<div className="inline-end"><button className="btn btn-danger-text" onClick={() => setClearTableOpen(true)} disabled={!selectedTable || rows.length === 0}>Tabelle leeren</button><button className="btn" onClick={openCreate} disabled={!selectedTable}>Neu</button></div>} currentUser={currentUser ?? null}>
      <section className="card stack-sm">
        <div className="crud-toolbar">
          <div className="inline-between"><h3>Datenbank Editor</h3><Badge>{selectedTable?.model ?? '—'}</Badge></div>
          <label className="field"><span>Tabelle</span><select value={tableName} onChange={(event) => setTableName(event.target.value)}>{tables.map((table) => <option key={table.name} value={table.name}>{table.model}</option>)}</select></label>
        </div>
        {(loading || rowLoading) && <p className="muted">Lade Daten…</p>}
        {error && <ErrorState text={error} onRetry={() => { if (tableName) void loadRows(tableName); else void loadTables(); }} />}
        {selectedTable && !rowLoading && <div className="table-wrap"><table className="admin-table"><thead><tr>{selectedTable.columns.map((column) => <th key={column.name}>{column.name}</th>)}<th className="align-right">Aktionen</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${String(row.id ?? 'row')}-${index}`}>{selectedTable.columns.map((column) => <td key={column.name} className="truncate-cell" title={String(row[column.name] ?? '')}>{typeof row[column.name] === 'object' ? JSON.stringify(row[column.name]) : String(row[column.name] ?? '—')}</td>)}<td className="align-right"><div className="admin-row-actions"><button className="btn btn-outline" onClick={() => openEdit(row)}>Bearbeiten</button>{typeof row.id === 'string' && <button className="btn btn-danger-text" onClick={() => void removeRow(row.id as string)}>Löschen</button>}</div></td></tr>)}</tbody></table></div>}
      </section>
      {editorOpen && <div className="overlay"><section className="card dialog stack-sm"><h3>{editingRowId ? 'Datensatz bearbeiten' : 'Datensatz erstellen'}</h3><form className="stack-sm" onSubmit={submitEditor}><textarea className="db-editor-textarea" rows={16} value={editorValue} onChange={(event) => setEditorValue(event.target.value)} /><p className="muted">JSON Objekt mit Feldwerten eingeben.</p><div className="inline-end"><button className="btn btn-outline" type="button" onClick={() => setEditorOpen(false)}>Abbrechen</button><button className="btn">Speichern</button></div></form></section></div>}
      {clearTableOpen && selectedTable && <ConfirmDialog title="Tabelle wirklich leeren?" description={`Alle Datensätze in "${selectedTable.model}" werden dauerhaft gelöscht.`} onCancel={() => setClearTableOpen(false)} onConfirm={() => void clearTable()} confirmDisabled={clearingTable} confirmLabel={clearingTable ? 'Lösche…' : 'Tabelle leeren'} />}
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
      if (employee) await patch(`/admin/employees/${employee.id}`, { displayName, isActive, role });
      else await post('/admin/employees', { displayName, email, role });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };
  return <div className="overlay"><section className="card dialog stack-sm"><h3>{employee ? 'Mitarbeiter bearbeiten' : 'Mitarbeiter anlegen'}</h3><form className="stack-sm" onSubmit={submit}><input required value={displayName} placeholder="Name" onChange={(e) => setDisplayName(e.target.value)} />{!employee && <input required type="email" value={email} placeholder="E-Mail" onChange={(e) => setEmail(e.target.value)} />}<label className="field"><span>Rolle</span><select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'user')}><option value="user">User</option><option value="admin">Admin</option></select></label>{employee && <label className="toggle"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />Aktiv</label>}<div className="inline-end"><button className="btn btn-outline" type="button" onClick={onClose}>Abbrechen</button><button className="btn">Speichern</button></div></form></section></div>;
}

export function AdminRouter({ path, navigate, onRoleStateChanged, onLogout }: RouteProps) {
  const [adminSession, setAdminSession] = useState<AdminSession | null>(null);
  const route = basePath(path);

  useEffect(() => {
    void (async () => {
      try {
        const session = await get<{ user: AdminSession }>('/auth/me');
        setAdminSession(session.user);
      } catch {
        setAdminSession(null);
      }
    })();
  }, []);

  if (route === '/admin') return <DashboardPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;
  if (route === '/admin/floorplans') return <FloorplansPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;
  if (route === '/admin/desks') return <DesksPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;
  if (route === '/admin/bookings') return <BookingsPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;
  if (route === '/admin/employees') return <EmployeesPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentAdminEmail={adminSession?.email ?? ''} currentUser={adminSession} />;
  if (route === '/admin/db-admin') return <DbAdminPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;

  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Admin-Seite nicht gefunden</h2><button className="btn" onClick={() => navigate('/admin')}>Zum Dashboard</button></section></main>;
}
