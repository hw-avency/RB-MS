import { FormEvent, MouseEvent as ReactMouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { del, get, patch, post, resolveApiUrl } from '../api';
import { cancelBooking } from '../api/bookings';
import { Avatar } from '../components/Avatar';
import { UserMenu } from '../components/UserMenu';
import { FloorplanCanvas } from '../FloorplanCanvas';
import { useToast } from '../components/toast';
import { Popover } from '../components/ui/Popover';
import { RESOURCE_KIND_OPTIONS, resourceKindLabel, type ResourceKind } from '../resourceKinds';

type SeriesPolicy = 'DEFAULT' | 'ALLOW' | 'DISALLOW';
type Floorplan = { id: string; name: string; imageUrl: string; isDefault?: boolean; defaultResourceKind?: ResourceKind; defaultAllowSeries?: boolean; createdAt?: string; updatedAt?: string };
type Desk = { id: string; floorplanId: string; name: string; kind?: ResourceKind; allowSeriesOverride?: boolean | null; effectiveAllowSeries?: boolean; x: number | null; y: number | null; position?: { x: number; y: number } | null; createdAt?: string; updatedAt?: string };
type Employee = { id: string; email: string; displayName: string; role: 'admin' | 'user'; isActive: boolean; photoUrl?: string | null; createdAt?: string; updatedAt?: string };
type Booking = { id: string; deskId: string; userEmail: string; userDisplayName?: string; employeeId?: string; date: string; slot?: 'FULL_DAY' | 'MORNING' | 'AFTERNOON' | 'CUSTOM'; startTime?: string; endTime?: string; createdAt?: string; updatedAt?: string; bookedFor?: 'SELF' | 'GUEST'; guestName?: string | null; createdByUserId?: string; createdBy?: { id: string; displayName?: string | null; email: string }; user?: { id: string; displayName?: string | null; email: string } | null };
type DbColumn = { name: string; type: string; required: boolean; id: boolean; hasDefaultValue: boolean };
type DbTable = { name: string; model: string; columns: DbColumn[] };
type RouteProps = { path: string; navigate: (to: string) => void; onRoleStateChanged: () => Promise<void>; onLogout: () => Promise<void>; currentUser?: AdminSession | null };
type AdminSession = { id?: string; email: string; name?: string; displayName?: string; role: 'admin' | 'user'; isActive?: boolean };
type DataState = { loading: boolean; error: string; ready: boolean };

type DeskFormState = {
  floorplanId: string;
  name: string;
  kind: ResourceKind;
  seriesPolicy: SeriesPolicy;
  x: number | null;
  y: number | null;
};

const navItems = [
  { to: '/admin', label: 'Dashboard' },
  { to: '/admin/floorplans', label: 'Floorpläne' },
  { to: '/admin/desks', label: 'Ressourcen' },
  { to: '/admin/bookings', label: 'Buchungen' },
  { to: '/admin/employees', label: 'Mitarbeiter' },
  { to: '/admin/db-admin', label: 'DB Admin' }
];

const today = new Date().toISOString().slice(0, 10);
const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const formatDate = (value?: string) => (value ? new Date(value).toLocaleString('de-DE') : '—');
const formatDateOnly = (value?: string) => (value ? new Date(value).toLocaleDateString('de-DE') : '—');
const getCreatorDisplay = (booking: Booking): string => booking.createdBy?.displayName?.trim() || booking.createdBy?.email || booking.userDisplayName || booking.userEmail;
const getCreatorEmail = (booking: Booking): string => booking.createdBy?.email || booking.userEmail;
const basePath = (path: string) => path.split('?')[0];
const hasCreateFlag = (path: string) => path.includes('create=1');

const isLikelyDateColumn = (columnName: string) => ['date', 'createdat', 'updatedat'].includes(columnName.toLowerCase());
const isIdColumn = (columnName: string) => ['id', 'deskid'].includes(columnName.toLowerCase());
const dbTableLabel = (table: DbTable): string => (table.model === 'Desk' ? 'Ressourcen' : table.model);

const toSeriesPolicy = (allowSeriesOverride?: boolean | null): SeriesPolicy => {
  if (allowSeriesOverride === true) return 'ALLOW';
  if (allowSeriesOverride === false) return 'DISALLOW';
  return 'DEFAULT';
};

const fromSeriesPolicy = (seriesPolicy: SeriesPolicy): boolean | null => {
  if (seriesPolicy === 'ALLOW') return true;
  if (seriesPolicy === 'DISALLOW') return false;
  return null;
};
const formatCellValue = (columnName: string, value: unknown) => {
  if (value === null || typeof value === 'undefined') return '—';
  if (isLikelyDateColumn(columnName) && typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString('de-DE');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' }) {
  return <span className={`admin-badge admin-badge-${tone}`}>{children}</span>;
}

function SkeletonRows({ columns = 5 }: { columns?: number }) {
  return <tbody>{Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={columns}><div className="skeleton admin-table-skeleton" /></td></tr>)}</tbody>;
}

function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return <div className="empty-state stack-sm"><p>{text}</p>{action}</div>;
}

function ListToolbar({ title, count, filters, actions }: { title: string; count?: number | string; filters?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="list-toolbar">
      <div className="inline-between">
        <h3>{title}</h3>
        {typeof count !== 'undefined' && <Badge>{count}</Badge>}
      </div>
      <div className="list-toolbar-controls">
        {filters}
        {actions}
      </div>
    </div>
  );
}

function ErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  return <div className="error-banner stack-sm"><span>{text}</span><button className="btn btn-outline" onClick={onRetry}>Retry</button></div>;
}

function ConfirmDialog({
  title,
  description,
  onConfirm,
  onCancel,
  confirmDisabled = false,
  cancelDisabled = false,
  confirmLabel = 'Löschen',
  confirmVariant = 'danger'
}: {
  title: string;
  description: ReactNode;
  onConfirm: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  confirmLabel?: ReactNode;
  confirmVariant?: 'danger' | 'primary';
}) {
  const confirmClassName = confirmVariant === 'danger' ? 'btn btn-danger' : 'btn';
  return (
    <div className="overlay"><section className="card dialog stack-sm" role="dialog" aria-modal="true"><h3>{title}</h3>{typeof description === "string" ? <p className="muted">{description}</p> : description}<div className="inline-end"><button className="btn btn-outline" disabled={cancelDisabled} onClick={onCancel}>Abbrechen</button><button className={confirmClassName} disabled={confirmDisabled} onClick={(event) => onConfirm(event)}>{confirmLabel}</button></div></section></div>
  );
}

type RowMenuItem = { label: string; onSelect: () => void; danger?: boolean };

function RowMenu({ items }: { items: RowMenuItem[] }) {
  return (
    <Popover
      trigger={<button type="button" className="btn btn-outline btn-icon" aria-label="Zeilenaktionen öffnen">⋯</button>}
      className="row-menu-content row-menu-overlay"
      placement="bottom-end"
      zIndex={2000}
    >
      {({ close }) => (
        <div role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`btn btn-ghost row-menu-item ${item.danger ? 'btn-danger-text' : ''}`}
              onClick={() => {
                item.onSelect();
                close();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function AdminLayout({ path, navigate, title, children, onLogout, currentUser }: { path: string; navigate: (to: string) => void; title: string; children: ReactNode; onLogout: () => Promise<void>; currentUser: AdminSession | null }) {
  const current = basePath(path);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <main className="app-shell">
      <div className="admin-shell-v2">
        <aside className="card admin-sidebar-v2 stack-sm">
          <h3>RB-MS Admin</h3>
          {navItems.map((item) => <button key={item.to} className={`btn btn-ghost admin-nav-link ${current === item.to ? 'active' : ''}`} onClick={() => navigate(item.to)}>{item.label}</button>)}
        </aside>
        <section className="admin-content-v2 stack-sm">
          <header className="card app-header simplified-header">
            <div className="header-left">
              <button className="btn btn-outline admin-mobile-nav-toggle" onClick={() => setMobileNavOpen(true)}>☰ Menü</button>
              <div>
                <p className="muted">Admin / {title}</p>
                <strong>{title}</strong>
              </div>
            </div>
            <div className="header-right">
              <button className="btn btn-outline" onClick={() => navigate('/')}>Zurück zur App</button>
              {currentUser && <UserMenu user={currentUser} onLogout={async () => { await onLogout(); navigate('/login'); }} />}
            </div>
          </header>
          {children}
        </section>
      </div>
      {mobileNavOpen && createPortal(
        <div className="overlay" onClick={() => setMobileNavOpen(false)}>
          <section className="card mobile-admin-drawer stack-sm" onClick={(event) => event.stopPropagation()}>
            <div className="inline-between"><strong>Navigation</strong><button className="btn btn-outline" onClick={() => setMobileNavOpen(false)}>Schließen</button></div>
            {navItems.map((item) => (
              <button key={item.to} className={`btn btn-ghost admin-nav-link ${current === item.to ? 'active' : ''}`} onClick={() => { navigate(item.to); setMobileNavOpen(false); }}>{item.label}</button>
            ))}
          </section>
        </div>,
        document.body
      )}
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
  const activeEmployees = employees.filter((employee) => employee.isActive).length;
  const dashboardKpis = [
    { label: 'Aktive Mitarbeiter', value: activeEmployees, icon: '👥', to: '/admin/employees' },
    { label: 'Ressourcen', value: desks.length, icon: '🖥️', to: '/admin/desks' },
    { label: 'Floorpläne', value: floorplans.length, icon: '🗺️', to: '/admin/floorplans' },
    { label: 'Buchungen (7 Tage)', value: bookingsNextWeek, icon: '📅', to: '/admin/bookings' }
  ];

  return (
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Dashboard" currentUser={currentUser ?? null}>
      {state.error && <ErrorState text={state.error} onRetry={load} />}
      <section className="dashboard-grid">
        {!state.ready || state.loading
          ? Array.from({ length: 4 }).map((_, index) => <div key={index} className="card dashboard-kpi-skeleton"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>)
          : dashboardKpis.map((card) => (
            <button className="card dashboard-kpi" key={card.label} onClick={() => navigate(card.to)}>
              <span className="dashboard-kpi-icon" aria-hidden>{card.icon}</span>
              <div className="stack-xs">
                <strong>{card.value}</strong>
                <p>{card.label}</p>
              </div>
            </button>
          ))}
      </section>
      <section className="dashboard-panels">
        <article className="card stack-sm dashboard-main-card">
          <div className="inline-between"><h3>Letzte Buchungen</h3><button className="btn btn-outline" onClick={() => navigate('/admin/bookings')}>Alle anzeigen</button></div>
          {!state.ready || state.loading ? <div className="stack-xs">{Array.from({ length: 7 }).map((_, i) => <div key={i} className="skeleton admin-table-skeleton" />)}</div> : recent.length === 0 ? <EmptyState text="Noch keine Buchungen vorhanden" action={<button className="btn" onClick={() => navigate('/admin/bookings?create=1')}>Buchung anlegen</button>} /> : (
            <div className="table-wrap dashboard-table-wrap">
              <table className="admin-table dashboard-bookings-table">
                <thead>
                  <tr>
                    <th>Mitarbeiter</th>
                    <th>Datum</th>
                    <th>Ressource</th>
                    <th>Standort</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((booking) => {
                    const desk = desks.find((item) => item.id === booking.deskId);
                    const floorplan = floorplans.find((plan) => plan.id === desk?.floorplanId);
                    const creatorName = getCreatorDisplay(booking);
                    const creatorEmail = getCreatorEmail(booking);
                    const guestName = booking.guestName?.trim() || 'Unbekannt';
                    return (
                      <tr
                        key={booking.id}
                        className="dashboard-booking-table-row"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate('/admin/bookings')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            navigate('/admin/bookings');
                          }
                        }}
                      >
                        <td>
                          <div className="stack-xs">
                            <div className="occupant-person-cell">
                              <Avatar displayName={creatorName} email={creatorEmail} size={28} />
                              <strong>{creatorName}</strong>
                            </div>
                            {booking.bookedFor === 'GUEST' && <span className="muted">Gast: {guestName}</span>}
                          </div>
                        </td>
                        <td>{formatDateOnly(booking.date)}</td>
                        <td>{desk?.name ?? 'Ressource'}</td>
                        <td>{floorplan?.name ? <Badge>{floorplan.name}</Badge> : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>
        <article className="card stack-sm dashboard-actions-card">
          <h3>Schnellaktionen</h3>
          {!state.ready || state.loading ? <div className="stack-xs">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton quick-action-skeleton" />)}</div> : (
            <div className="quick-actions-list">
              <button className="btn quick-action-btn" onClick={() => navigate('/admin/bookings?create=1')}><span aria-hidden>📅</span>Buchung anlegen</button>
              <button className="btn btn-outline quick-action-btn" onClick={() => navigate('/admin/desks?create=1')}><span aria-hidden>🖥️</span>Ressource anlegen</button>
              <button className="btn btn-outline quick-action-btn" onClick={() => navigate('/admin/employees?create=1')}><span aria-hidden>👤</span>Mitarbeiter anlegen</button>
              <button className="btn btn-outline quick-action-btn" onClick={() => navigate('/admin/floorplans?create=1')}><span aria-hidden>🗺️</span>Floorplan anlegen</button>
            </div>
          )}
        </article>
      </section>
    </AdminLayout>
  );
}

function FloorplansPage({ path, navigate, onLogout, currentUser }: RouteProps) {
  const toasts = useToast();
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
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Floorpläne" currentUser={currentUser ?? null}>
      <section className="card stack-sm">
        <ListToolbar
          title="Floorpläne"
          count={filtered.length}
          filters={<div className="admin-search">🔎<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Floorplan suchen" /></div>}
          actions={<button className="btn" onClick={() => setShowCreate(true)}>Neu</button>}
        />
        {state.error && <ErrorState text={state.error} onRetry={load} />}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Vorschau</th><th>Name</th><th>Bild URL</th><th>Erstellt</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={5} /> : <tbody>{filtered.map((floorplan) => <tr key={floorplan.id}><td><button className="floor-thumb-btn" onClick={() => setEditing(floorplan)} aria-label={`Floorplan ${floorplan.name} öffnen`}><img className="floor-thumb" src={resolveApiUrl(floorplan.imageUrl)} alt={floorplan.name} loading="lazy" /></button></td><td><div className="stack-xs"><button className="btn btn-ghost" onClick={() => setEditing(floorplan)}>{floorplan.name}</button>{floorplan.isDefault && <Badge tone="ok">Standard</Badge>}</div></td><td className="truncate-cell" title={floorplan.imageUrl}>{floorplan.imageUrl}</td><td>{formatDate(floorplan.createdAt)}</td><td className="align-right"><RowMenu items={[{ label: 'Bearbeiten', onSelect: () => setEditing(floorplan) }, { label: 'Löschen', onSelect: () => setPendingDelete(floorplan), danger: true }]} /></td></tr>)}</tbody>}</table></div>
        {!state.loading && filtered.length === 0 && <EmptyState text="Keine Floorpläne vorhanden." action={<button className="btn" onClick={() => setShowCreate(true)}>Neu anlegen</button>} />}
      </section>
      {(showCreate || editing) && <FloorplanEditor floorplan={editing} onClose={() => { setShowCreate(false); setEditing(null); navigate('/admin/floorplans'); }} onSaved={async () => { setShowCreate(false); setEditing(null); toasts.success('Floorplan gespeichert'); await load(); }} onError={toasts.error} />}
      {pendingDelete && <ConfirmDialog title="Floorplan löschen?" description={`"${pendingDelete.name}" wird dauerhaft entfernt.`} onCancel={() => setPendingDelete(null)} onConfirm={async (event) => { const anchorRect = event.currentTarget.getBoundingClientRect(); await del(`/admin/floorplans/${pendingDelete.id}`); setPendingDelete(null); toasts.success('Floorplan gelöscht', { anchorRect }); await load(); }} />}
    </AdminLayout>
  );
}

function FloorplanEditor({ floorplan, onClose, onSaved, onError }: { floorplan: Floorplan | null; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState(floorplan?.name ?? '');
  const [imageUrl, setImageUrl] = useState(floorplan?.imageUrl ?? '');
  const [defaultResourceKind, setDefaultResourceKind] = useState<ResourceKind>(floorplan?.defaultResourceKind ?? 'TISCH');
  const [defaultAllowSeries, setDefaultAllowSeries] = useState<boolean>(floorplan?.defaultAllowSeries ?? true);
  const [isDefault, setIsDefault] = useState<boolean>(floorplan?.isDefault ?? false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (floorplan) await patch(`/admin/floorplans/${floorplan.id}`, { name, imageUrl, defaultResourceKind, defaultAllowSeries, isDefault });
      else await post('/admin/floorplans', { name, imageUrl, defaultResourceKind, defaultAllowSeries, isDefault });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };
  return <div className="overlay"><section className="card dialog stack-sm"><h3>{floorplan ? 'Floorplan bearbeiten' : 'Floorplan anlegen'}</h3><form className="stack-sm" onSubmit={submit}><input required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /><input required placeholder="Asset URL" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} /><div className="stack-xs"><strong>Defaults</strong><label className="field"><span>Standard-Ressourcenart</span><select value={defaultResourceKind} onChange={(event) => setDefaultResourceKind(event.target.value as ResourceKind)}>{RESOURCE_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label className="field"><span>Serientermine standardmäßig erlauben</span><input type="checkbox" checked={defaultAllowSeries} onChange={(event) => setDefaultAllowSeries(event.target.checked)} /></label><label className="field"><span>Beim Login als Standard-Floorplan nutzen</span><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} /></label></div><div className="inline-end"><button type="button" className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn">Speichern</button></div></form></section></div>;
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
    <div className="overlay"><section className="card dialog stack-sm"><h3>Position im Plan setzen</h3><p className="muted">Klicke im Plan, um die Ressource-Position zu setzen.</p><div className="position-picker" onClick={setByClick}>{floorplan?.imageUrl ? <img src={floorplan.imageUrl} alt={floorplan.name} className="position-image" /> : <div className="empty-state">Kein Floorplan-Bild</div>}<span className="position-pin" style={{ left: `${px * 100}%`, top: `${py * 100}%` }} /></div><p className="muted">Position: {Math.round(px * 100)}% / {Math.round(py * 100)}%</p><div className="inline-end"><button className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn" onClick={() => onPick(px, py)}>Übernehmen</button></div></section></div>
  );
}

function DeskEditor({ desk, floorplans, defaultFloorplanId, initialPosition, lockFloorplan, onRequestPositionMode, onClose, onSaved, onError }: { desk: Desk | null; floorplans: Floorplan[]; defaultFloorplanId: string; initialPosition?: { x: number; y: number } | null; lockFloorplan?: boolean; onRequestPositionMode?: () => void; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [form, setForm] = useState<DeskFormState>({ floorplanId: desk?.floorplanId ?? defaultFloorplanId, name: desk?.name ?? '', kind: desk?.kind ?? floorplans.find((item) => item.id === (desk?.floorplanId ?? defaultFloorplanId))?.defaultResourceKind ?? 'TISCH', seriesPolicy: toSeriesPolicy(desk?.allowSeriesOverride), x: initialPosition?.x ?? desk?.x ?? null, y: initialPosition?.y ?? desk?.y ?? null });
  const [showPicker, setShowPicker] = useState(false);
  const [inlineError, setInlineError] = useState('');

  const canSave = form.floorplanId && form.name.trim().length > 0 && form.x !== null && form.y !== null;
  const floorplan = floorplans.find((item) => item.id === form.floorplanId) ?? null;

  const onFloorplanChange = (nextFloorplanId: string) => {
    setForm((current) => ({ ...current, floorplanId: nextFloorplanId, kind: desk ? current.kind : (floorplans.find((item) => item.id === nextFloorplanId)?.defaultResourceKind ?? current.kind), x: current.floorplanId === nextFloorplanId ? current.x : null, y: current.floorplanId === nextFloorplanId ? current.y : null }));
    setInlineError('');
  };


  useEffect(() => {
    if (desk) return;
    const selectedFloorplan = floorplans.find((item) => item.id === form.floorplanId);
    if (!selectedFloorplan?.defaultResourceKind) return;
    setForm((current) => current.kind === selectedFloorplan.defaultResourceKind
      ? current
      : { ...current, kind: selectedFloorplan.defaultResourceKind as ResourceKind });
  }, [desk, floorplans, form.floorplanId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.x === null || form.y === null) {
      setInlineError('Bitte Position im Plan setzen.');
      return;
    }
    try {
      if (desk) {
        await patch(`/admin/desks/${desk.id}`, { name: form.name, kind: form.kind, allowSeriesOverride: fromSeriesPolicy(form.seriesPolicy), x: form.x, y: form.y });
      } else {
        await post(`/admin/floorplans/${form.floorplanId}/desks`, { name: form.name, kind: form.kind, allowSeriesOverride: fromSeriesPolicy(form.seriesPolicy), x: form.x, y: form.y });
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  return (
    <>
      <div className="overlay"><section className="card dialog stack-sm"><h3>{desk ? 'Ressource bearbeiten' : 'Ressource anlegen'}</h3><form className="stack-sm" onSubmit={submit}>{lockFloorplan ? <label className="field"><span>Floorplan</span><input value={floorplans.find((f) => f.id === form.floorplanId)?.name ?? '—'} disabled /></label> : <label className="field"><span>Floorplan</span><select required value={form.floorplanId} onChange={(e) => onFloorplanChange(e.target.value)}><option value="">Floorplan wählen</option>{floorplans.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}<label className="field"><span>Art</span><select value={form.kind} onChange={(e) => setForm((current) => ({ ...current, kind: e.target.value as ResourceKind }))}>{RESOURCE_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label className="field"><span>Serientermine</span><select value={form.seriesPolicy} onChange={(e) => setForm((current) => ({ ...current, seriesPolicy: e.target.value as SeriesPolicy }))}><option value="DEFAULT">Floor-Default verwenden</option><option value="ALLOW">Erlauben</option><option value="DISALLOW">Nicht erlauben</option></select><p className="muted">Default = Einstellung aus Floorplan.</p></label><label className="field"><span>Name</span><input required placeholder="z. B. H4" value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} /></label><div className="field"><span>Position</span><div className="inline-between"><Badge tone={form.x !== null && form.y !== null ? 'ok' : 'warn'}>{form.x !== null && form.y !== null ? `Position gesetzt (${Math.round(form.x * 100)}% / ${Math.round(form.y * 100)}%)` : 'Keine Position gesetzt'}</Badge><div className="admin-toolbar">{onRequestPositionMode && <button type="button" className="btn btn-outline" onClick={() => { onClose(); onRequestPositionMode(); }}>Position im Plan ändern</button>}<button type="button" className="btn btn-outline" disabled={!form.floorplanId} onClick={() => setShowPicker(true)}>{form.x !== null && form.y !== null ? 'Neu positionieren' : 'Position im Plan setzen'}</button></div></div>{!form.floorplanId && <p className="muted">Bitte Floorplan wählen.</p>}</div>{inlineError && <p className="error-banner">{inlineError}</p>}<div className="inline-end"><button type="button" className="btn btn-outline" onClick={onClose}>Abbrechen</button><button className="btn" disabled={!canSave}>Speichern</button></div></form></section></div>
      {showPicker && <PositionPickerDialog floorplan={floorplan} x={form.x} y={form.y} onClose={() => setShowPicker(false)} onPick={(x, y) => { setForm((current) => ({ ...current, x, y })); setShowPicker(false); setInlineError(''); }} />}
    </>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

type DeskFilterMode = 'all' | 'assigned' | 'missing-position';

function DeskTableToolbar({
  floorplanId,
  floorplans,
  searchValue,
  onSearchChange,
  onSearchClear,
  filterMode,
  onFilterModeChange,
  showFilter,
  disableCreate,
  onFloorplanChange,
  onCreate,
  modeActive,
  onCancelMode
}: {
  floorplanId: string;
  floorplans: Floorplan[];
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
  filterMode: DeskFilterMode;
  onFilterModeChange: (value: DeskFilterMode) => void;
  showFilter: boolean;
  disableCreate: boolean;
  onFloorplanChange: (value: string) => void;
  onCreate: () => void;
  modeActive: boolean;
  onCancelMode: () => void;
}) {
  return (
    <section className="card stack-sm">
      <div className="desks-toolbar">
        <select value={floorplanId} onChange={(event) => onFloorplanChange(event.target.value)} aria-label="Standort auswählen">
          <option value="">Floorplan wählen</option>
          {floorplans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
        </select>
        <div className="admin-search">
          <span aria-hidden="true">🔎</span>
          <input
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Ressource suchen"
            aria-label="Ressource suchen"
          />
          {searchValue && <button type="button" className="btn btn-ghost btn-icon" onClick={onSearchClear} aria-label="Suche zurücksetzen">✕</button>}
        </div>
        {showFilter && (
          <select value={filterMode} onChange={(event) => onFilterModeChange(event.target.value as DeskFilterMode)} aria-label="Filter">
            <option value="all">Alle</option>
            <option value="assigned">Zugewiesen</option>
            <option value="missing-position">Ohne Koordinaten</option>
          </select>
        )}
        <div className="inline-end">
          <button className="btn" disabled={disableCreate} onClick={onCreate}>Neue Ressource</button>
          {modeActive && <button className="btn btn-outline" onClick={onCancelMode}>Abbrechen</button>}
        </div>
      </div>
    </section>
  );
}

const hasDeskPosition = (desk: Desk) => Number.isFinite(desk.x) && Number.isFinite(desk.y);

const normalizeDeskPosition = (desk: Desk, imageSize: { width: number; height: number } | null): { x: number; y: number } | null => {
  if (!Number.isFinite(desk.x) || !Number.isFinite(desk.y)) return null;
  const raw = { x: Number(desk.x), y: Number(desk.y) };
  const isLegacyPercent = raw.x >= 0 && raw.x <= 1 && raw.y >= 0 && raw.y <= 1;
  if (isLegacyPercent && imageSize) return { x: raw.x * imageSize.width, y: raw.y * imageSize.height };
  return raw;
};


const toDeskPercentPosition = (desk: Desk, imageSize: { width: number; height: number } | null): { xPct: number; yPct: number } | null => {
  const normalized = normalizeDeskPosition(desk, imageSize);
  if (!normalized || !imageSize || imageSize.width <= 0 || imageSize.height <= 0) return null;
  return {
    xPct: Math.max(0, Math.min(100, (normalized.x / imageSize.width) * 100)),
    yPct: Math.max(0, Math.min(100, (normalized.y / imageSize.height) * 100)),
  };
};

const formatDateTimeShort = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const datePart = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timePart = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
};

function DesksPage({ path, navigate, onLogout, currentUser }: RouteProps) {
  const toasts = useToast();
  const [state, setState] = useState<DataState>({ loading: true, error: '', ready: false });
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [floorplanId, setFloorplanId] = useState('');
  const [desks, setDesks] = useState<Desk[]>([]);
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<DeskFilterMode>('all');
  const [editingDesk, setEditingDesk] = useState<Desk | null>(null);
  const [createRequest, setCreateRequest] = useState<{ x: number; y: number } | null>(null);
  const [deleteDesk, setDeleteDesk] = useState<Desk | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [selectedDeskIds, setSelectedDeskIds] = useState<Set<string>>(new Set());
  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');
  const [canvasMode, setCanvasMode] = useState<'idle' | 'create' | 'reposition' | 'CONFIRM_SAVE_POSITION'>('idle');
  const [pendingRepositionDesk, setPendingRepositionDesk] = useState<Desk | null>(null);
  const [pendingRepositionCoords, setPendingRepositionCoords] = useState<{ x: number; y: number } | null>(null);
  const [savePositionError, setSavePositionError] = useState('');
  const [isSavingPosition, setIsSavingPosition] = useState(false);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [renderSize, setRenderSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [displayedRect, setDisplayedRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [isRepairingPositions, setIsRepairingPositions] = useState(false);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const floorplan = floorplans.find((item) => item.id === floorplanId) ?? null;
  const debouncedQuery = useDebouncedValue(query, 300);

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
        setPendingRepositionCoords(null);
        setSavePositionError('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(() => {
    const search = debouncedQuery.trim().toLowerCase();
    return desks.filter((desk) => {
      const nameMatch = !search || desk.name.toLowerCase().includes(search) || resourceKindLabel(desk.kind).toLowerCase().includes(search);
      const filterMatch = filterMode === 'all'
        ? true
        : filterMode === 'assigned'
          ? hasDeskPosition(desk)
          : !hasDeskPosition(desk);
      return nameMatch && filterMatch;
    });
  }, [desks, debouncedQuery, filterMode]);

  const selectedDesk = desks.find((desk) => desk.id === selectedDeskId) ?? null;
  const isAllVisibleSelected = filtered.length > 0 && filtered.every((desk) => selectedDeskIds.has(desk.id));
  const hasMissingPositions = desks.some((desk) => !hasDeskPosition(desk));

  const startCreateMode = () => {
    setEditingDesk(null);
    setPendingRepositionDesk(null);
    setPendingRepositionCoords(null);
    setSavePositionError('');
    setCanvasMode('create');
  };

  const cancelModes = () => {
    setCanvasMode('idle');
    setPendingRepositionDesk(null);
    setPendingRepositionCoords(null);
    setSavePositionError('');
  };

  const onCanvasClick = async ({ x, y, imageWidth, imageHeight }: { xPct: number; yPct: number; x: number; y: number; imageWidth: number; imageHeight: number }) => {
    const clampedX = Math.max(0, Math.min(imageWidth, x));
    const clampedY = Math.max(0, Math.min(imageHeight, y));
    if (canvasMode === 'create') {
      setCreateRequest({ x: clampedX, y: clampedY });
      setCanvasMode('idle');
      return;
    }
    if (canvasMode === 'reposition' && pendingRepositionDesk) {
      setPendingRepositionCoords({ x: clampedX, y: clampedY });
      setSavePositionError('');
      setCanvasMode('CONFIRM_SAVE_POSITION');
    }
  };

  const debugEnabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';

  const runMissingPositionRepair = async () => {
    if (isRepairingPositions) return;
    setIsRepairingPositions(true);
    try {
      const response = await post<{ updatedCount: number }>('/admin/desks/positions/mark-missing', { floorplanId });
      toasts.success(`${response.updatedCount} Ressourcen auf "ohne Position" gesetzt`);
      await loadDesks(floorplanId);
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : 'Positionen konnten nicht repariert werden');
    } finally {
      setIsRepairingPositions(false);
    }
  };

  const confirmSavePosition = async (anchorRect?: DOMRect) => {
    if (!pendingRepositionDesk || !pendingRepositionCoords || isSavingPosition) return;
    setIsSavingPosition(true);
    setSavePositionError('');
    try {
      await patch(`/admin/desks/${pendingRepositionDesk.id}`, pendingRepositionCoords);
      toasts.success('Position gespeichert', { anchorRect });
      cancelModes();
      await loadDesks(floorplanId);
    } catch (err) {
      setSavePositionError(err instanceof Error ? err.message : 'Position konnte nicht gespeichert werden');
      setCanvasMode('CONFIRM_SAVE_POSITION');
    } finally {
      setIsSavingPosition(false);
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

  const runBulkDelete = async (anchorRect?: DOMRect) => {
    if (selectedDeskIds.size === 0 || isBulkDeleting) return;
    setIsBulkDeleting(true);
    try {
      const selectedIds = Array.from(selectedDeskIds);
      await del(`/admin/desks?ids=${encodeURIComponent(selectedIds.join(','))}`);
      toasts.success(`${selectedIds.length} Ressource(e) gelöscht`, { anchorRect });
      setBulkDeleteOpen(false);
      clearSelection();
      await loadDesks(floorplanId);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Bulk-Delete fehlgeschlagen');
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const isSavePositionDialogOpen = canvasMode === 'CONFIRM_SAVE_POSITION' && Boolean(pendingRepositionDesk && pendingRepositionCoords);

  const tableBody = state.loading && !state.ready
    ? <SkeletonRows columns={5} />
    : (
      <tbody>
        {filtered.map((desk) => (
          <tr
            key={desk.id}
            ref={(row) => { rowRefs.current[desk.id] = row; }}
            className={`${selectedDeskId === desk.id ? 'row-selected' : ''} ${hoveredDeskId === desk.id ? 'row-hovered' : ''}`.trim()}
            onMouseEnter={() => setHoveredDeskId(desk.id)}
            onMouseLeave={() => setHoveredDeskId('')}
            onClick={() => setSelectedDeskId(desk.id)}
          >
            <td>
              <input
                type="checkbox"
                checked={selectedDeskIds.has(desk.id)}
                onClick={(event) => event.stopPropagation()}
                onChange={() => toggleDeskSelection(desk.id)}
                aria-label={`${desk.name} auswählen`}
              />
            </td>
            <td className="truncate-cell">{desk.name}</td>
            <td>{resourceKindLabel(desk.kind)}</td>
            <td>{formatDateTimeShort(desk.updatedAt ?? desk.createdAt)}</td>
            <td className="align-right">
              <RowMenu items={[
                { label: 'Bearbeiten', onSelect: () => setEditingDesk(desk) },
                { label: 'Auf Floorplan anzeigen', onSelect: () => setSelectedDeskId(desk.id) },
                { label: 'Position ändern', onSelect: () => { setSelectedDeskId(desk.id); setPendingRepositionDesk(desk); setPendingRepositionCoords(null); setSavePositionError(''); setCanvasMode('reposition'); } },
                { label: 'Löschen', onSelect: () => setDeleteDesk(desk), danger: true }
              ]}
              />
            </td>
          </tr>
        ))}
      </tbody>
    );

  return (
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Ressourcen" currentUser={currentUser ?? null}>
      <section className="card desks-page-header">
        <div>
          <p className="muted">Admin / Ressourcen / Ressourcen</p>
          <div className="inline-start">
            <h2>Ressourcen</h2>
            <Badge>{desks.length}</Badge>
          </div>
        </div>
      </section>

      <DeskTableToolbar
        floorplanId={floorplanId}
        floorplans={floorplans}
        searchValue={query}
        onSearchChange={setQuery}
        onSearchClear={() => setQuery('')}
        filterMode={filterMode}
        onFilterModeChange={setFilterMode}
        showFilter={desks.length > 0 && hasMissingPositions}
        disableCreate={!floorplanId}
        onFloorplanChange={(value) => {
          setFloorplanId(value);
          setSelectedDeskId('');
          cancelModes();
        }}
        onCreate={startCreateMode}
        modeActive={canvasMode !== 'idle'}
        onCancelMode={cancelModes}
      />

      <section className="admin-split-layout desks-split-view">
        <section className="card stack-sm desks-list-panel">
          {state.error && <ErrorState text={state.error} onRetry={() => void loadDesks(floorplanId)} />}
          {selectedDeskIds.size > 0 && (
            <div className="bulk-actions">
              <strong>{selectedDeskIds.size} ausgewählt</strong>
              <div className="inline-end">
                <button className="btn btn-danger" disabled={isBulkDeleting} onClick={() => setBulkDeleteOpen(true)}>{isBulkDeleting ? 'Lösche…' : 'Auswahl löschen'}</button>
                <button className="btn btn-outline" disabled={isBulkDeleting} onClick={clearSelection}>Abbrechen</button>
              </div>
            </div>
          )}
          <div className="table-wrap table-scroll-area">
            <table className="admin-table desks-table">
              <thead>
                <tr>
                  <th><input type="checkbox" checked={isAllVisibleSelected} onChange={toggleAllVisibleDesks} aria-label="Alle sichtbaren Ressourcen auswählen" /></th>
                  <th>Label</th>
                  <th>Art</th>
                  <th>Aktualisiert</th>
                  <th className="align-right">Aktionen</th>
                </tr>
              </thead>
              {tableBody}
            </table>
          </div>
          {!state.loading && filtered.length === 0 && (
            <EmptyState
              text={desks.length === 0 ? 'Noch keine Ressourcen angelegt.' : 'Keine Ergebnisse für deine Suche.'}
              action={<button className="btn" onClick={startCreateMode}>Neue Ressource</button>}
            />
          )}
          {state.loading && state.ready && <div className="skeleton admin-table-skeleton" aria-hidden="true" />}
        </section>

        <aside className="card stack-sm admin-split-floor-preview">
          <div className="inline-between floorplan-headline">
            <div>
              <h3>Floorplan</h3>
              <p className="muted">Klicke Marker für Details</p>
            </div>
            <div className="admin-toolbar" />
          </div>
          {(canvasMode === 'create' || ((canvasMode === 'reposition' || canvasMode === 'CONFIRM_SAVE_POSITION') && pendingRepositionDesk)) && (
            <Badge tone="warn">{canvasMode === 'create' ? 'Klicke auf den Plan, um die Ressource zu platzieren' : `Neue Position für ${pendingRepositionDesk?.name ?? ''} wählen`}</Badge>
          )}
          {state.loading && !state.ready && <div className="skeleton admin-floor-skeleton" aria-hidden="true" />}
          {!state.loading && !floorplan && <EmptyState text="Bitte Floorplan wählen." />}
          {floorplan && (
            <>
              <div className={`canvas-body admin-floor-canvas ${canvasMode !== 'idle' ? 'is-active-mode' : ''}`}>
                <FloorplanCanvas
                    imageUrl={floorplan.imageUrl}
                    imageAlt={floorplan.name}
                    desks={desks.filter(hasDeskPosition).map((desk) => {
                      const mapped = normalizeDeskPosition(desk, imageSize) ?? { x: null, y: null };
                      const mappedPct = toDeskPercentPosition(desk, imageSize);
                      return {
                        ...mapped,
                        xPct: mappedPct?.xPct,
                        yPct: mappedPct?.yPct,
                        id: desk.id,
                        name: desk.name,
                        kind: desk.kind,
                        status: 'free',
                        booking: null,
                        isSelected: selectedDeskIds.has(desk.id),
                        isHighlighted: selectedDeskId === desk.id || hoveredDeskId === desk.id
                      };
                    })}
                    selectedDeskId={selectedDeskId}
                    hoveredDeskId={hoveredDeskId}
                    onHoverDesk={setHoveredDeskId}
                    onSelectDesk={(deskId) => setSelectedDeskId(deskId)}
                    disablePulseAnimation={canvasMode !== 'idle'}
                    onCanvasClick={onCanvasClick}
                    onDeskDoubleClick={(deskId) => {
                      const target = desks.find((desk) => desk.id === deskId);
                      if (target) setEditingDesk(target);
                    }}
                    onImageLoad={({ width, height }) => setImageSize({ width, height })}
                    onImageRenderSizeChange={setRenderSize}
                    onDisplayedRectChange={setDisplayedRect}
                    debugEnabled={debugEnabled}
                  />
              </div>
              <div className="desks-legend">
                <Badge>Normal</Badge>
                <Badge tone="ok">Ausgewählt</Badge>
                <Badge tone="warn">Ohne Position: {desks.filter((desk) => !hasDeskPosition(desk)).length}</Badge>
                <button className="btn btn-outline" type="button" disabled={isRepairingPositions} onClick={() => void runMissingPositionRepair()}>Top-left als fehlend markieren</button>
              </div>
              {debugEnabled && (
                <section className="card stack-xs">
                  <strong>Floorplan Debug</strong>
                  <p className="muted">containerRect(left/top/width/height): 0 / 0 / {Math.round(renderSize.width)} / {Math.round(renderSize.height)}</p>
                  <p className="muted">imageNatural(width/height): {Math.round(imageSize?.width ?? 0)} / {Math.round(imageSize?.height ?? 0)}</p>
                  <p className="muted">drawnRect(left/top/width/height): {Math.round(displayedRect?.left ?? 0)} / {Math.round(displayedRect?.top ?? 0)} / {Math.round(displayedRect?.width ?? 0)} / {Math.round(displayedRect?.height ?? 0)}</p>
                  {(() => {
                    const firstDesk = desks.find(hasDeskPosition);
                    if (!firstDesk || !displayedRect) return <p className="muted">firstMarker(left/top): —</p>;
                    const pct = toDeskPercentPosition(firstDesk, imageSize);
                    if (!pct) return <p className="muted">firstMarker(left/top): —</p>;
                    const left = displayedRect.left + (pct.xPct / 100) * displayedRect.width;
                    const top = displayedRect.top + (pct.yPct / 100) * displayedRect.height;
                    return <p className="muted">firstMarker(left/top): {Math.round(left)} / {Math.round(top)} (deskId={firstDesk.id})</p>;
                  })()}
                  <p className="muted">null positions: {desks.filter((desk) => !hasDeskPosition(desk)).length}</p>
                </section>
              )}
              {selectedDesk && (
                <section className="card stack-xs desk-details-card">
                  <strong>{selectedDesk.name}</strong>
                  <p className="muted">Ressourcen-ID: {selectedDesk.id}</p>
                  <p className="muted">Art: {resourceKindLabel(selectedDesk.kind)}</p>
                  <p className="muted">Koordinaten: {hasDeskPosition(selectedDesk) ? `${Math.round(selectedDesk.x ?? 0)}px / ${Math.round(selectedDesk.y ?? 0)}px` : 'Nicht gesetzt'}</p>
                  <p className="muted">Zuletzt aktualisiert: {formatDateTimeShort(selectedDesk.updatedAt ?? selectedDesk.createdAt)}</p>
                  <div className="inline-end">
                    <button className="btn btn-outline" onClick={() => setEditingDesk(selectedDesk)}>Bearbeiten</button>
                    <button className="btn btn-outline" onClick={() => { setPendingRepositionDesk(selectedDesk); setPendingRepositionCoords(null); setSavePositionError(''); setCanvasMode('reposition'); }}>Position ändern</button>
                    <button className="btn btn-danger" onClick={() => setDeleteDesk(selectedDesk)}>Löschen</button>
                  </div>
                </section>
              )}
            </>
          )}
        </aside>
      </section>

      {(createRequest || editingDesk) && <DeskEditor desk={editingDesk} floorplans={floorplans} defaultFloorplanId={floorplanId} initialPosition={createRequest} lockFloorplan={Boolean(createRequest)} onRequestPositionMode={editingDesk ? () => { setPendingRepositionDesk(editingDesk); setPendingRepositionCoords(null); setSavePositionError(''); setCanvasMode('reposition'); } : undefined} onClose={() => { setCreateRequest(null); setEditingDesk(null); navigate('/admin/desks'); }} onSaved={async () => { setCreateRequest(null); setEditingDesk(null); toasts.success('Ressource gespeichert'); await loadDesks(floorplanId); }} onError={toasts.error} />}
      {!isSavePositionDialogOpen && deleteDesk && <ConfirmDialog title="Ressource löschen?" description={`Ressource "${deleteDesk.name}" wird entfernt.`} onCancel={() => setDeleteDesk(null)} onConfirm={async (event) => { const anchorRect = event.currentTarget.getBoundingClientRect(); await del(`/admin/desks/${deleteDesk.id}`); setDeleteDesk(null); toasts.success('Ressource gelöscht', { anchorRect }); await loadDesks(floorplanId); }} />}
      {!isSavePositionDialogOpen && bulkDeleteOpen && <ConfirmDialog title={`${selectedDeskIds.size} Einträge löschen?`} description="Dieser Vorgang ist irreversibel." onCancel={() => setBulkDeleteOpen(false)} onConfirm={(event) => void runBulkDelete(event.currentTarget.getBoundingClientRect())} confirmDisabled={isBulkDeleting} confirmLabel={isBulkDeleting ? 'Lösche…' : 'Löschen'} />}
      {isSavePositionDialogOpen && pendingRepositionDesk && pendingRepositionCoords && (
        <ConfirmDialog
          title="Position speichern?"
          description={<><p>Möchtest du die neue Position für diese Ressource speichern?</p><p>Die bisherige Position wird überschrieben.</p>{savePositionError && <p className="error-banner">{savePositionError}</p>}</>}
          onCancel={() => { setCanvasMode('reposition'); setSavePositionError(''); }}
          onConfirm={(event) => void confirmSavePosition(event.currentTarget.getBoundingClientRect())}
          confirmDisabled={isSavingPosition}
          cancelDisabled={isSavingPosition}
          confirmLabel={isSavingPosition ? <><span className="btn-spinner" aria-hidden />Speichern…</> : 'Speichern'}
          confirmVariant="primary"
        />
      )}
    </AdminLayout>
  );
}

function BookingsPage({ path, navigate, onLogout, currentUser }: RouteProps) {
  const toasts = useToast();
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
    const person = `${getCreatorDisplay(booking)} ${getCreatorEmail(booking)} ${booking.guestName ?? ''}`.toLowerCase();
    const desk = desks.find((item) => item.id === booking.deskId);
    return person.includes(personQuery.toLowerCase()) && (!deskId || booking.deskId === deskId) && (!floorplanId || desk?.floorplanId === floorplanId);
  }), [bookings, desks, deskId, floorplanId, personQuery]);
  const isAllVisibleSelected = filtered.length > 0 && filtered.every((booking) => selectedBookingIds.includes(booking.id));

  const focusedBooking = filtered.find((booking) => booking.id === focusedBookingId) ?? filtered[0] ?? null;
  const focusedDesk = desks.find((desk) => desk.id === focusedBooking?.deskId);
  const focusedFloor = floorplans.find((plan) => plan.id === focusedDesk?.floorplanId);
  const focusedDesks = focusedFloor ? desks.filter((desk) => desk.floorplanId === focusedFloor.id).map((desk) => ({ id: desk.id, name: desk.name, kind: desk.kind, x: desk.x, y: desk.y, status: 'free' as const, booking: null, isSelected: desk.id === focusedDesk?.id, isHighlighted: desk.id === focusedDesk?.id })) : [];

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
  const runBulkDelete = async (anchorRect?: DOMRect) => {
    if (selectedBookingIds.length === 0 || isBulkDeleting) return;
    setIsBulkDeleting(true);
    try {
      await del(`/admin/bookings?ids=${encodeURIComponent(selectedBookingIds.join(','))}`);
      toasts.success(`${selectedBookingIds.length} Buchung(en) gelöscht`, { anchorRect });
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
  const hasActiveFilters = Boolean(floorplanId || deskId || personQuery.trim());
  const selectedFloorplan = floorplans.find((plan) => plan.id === floorplanId);
  const selectedDesk = desks.find((desk) => desk.id === deskId);

  return <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Buchungen" currentUser={currentUser ?? null}>
    <section className="bookings-layout">
      <section className="card stack-sm bookings-filter-card">
        <h3>Filter &amp; Suche</h3>
        <div className="bookings-filter-toolbar">
          <div className="bookings-filter-row">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <select value={floorplanId} onChange={(e) => setFloorplanId(e.target.value)}>
              <option value="">Alle Floorpläne</option>
              {floorplans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
            </select>
            <select value={deskId} onChange={(e) => setDeskId(e.target.value)}>
              <option value="">Alle Ressourcen</option>
              {desks.filter((desk) => (floorplanId ? desk.floorplanId === floorplanId : true)).map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}
            </select>
          </div>
          <div className="bookings-filter-row bookings-filter-row-search">
            <div className="admin-search">
              🔎
              <input value={personQuery} onChange={(e) => setPersonQuery(e.target.value)} placeholder="Person suchen" />
            </div>
            <button className="btn btn-outline" onClick={resetFilters} disabled={!hasActiveFilters}>Filter zurücksetzen</button>
            <button className="btn bookings-new-button" onClick={() => setCreating(true)}>Neu</button>
          </div>
        </div>
        {hasActiveFilters && (
          <div className="bookings-active-filters" aria-label="Aktive Filter">
            {selectedFloorplan && <Badge>Floorplan: {selectedFloorplan.name}</Badge>}
            {selectedDesk && <Badge>Ressource: {selectedDesk.name}</Badge>}
            {personQuery.trim() && <Badge>Person: {personQuery.trim()}</Badge>}
          </div>
        )}
      </section>

      <section className="card stack-sm bookings-list-card">
        <div className="inline-between">
          <h3>Buchungen</h3>
          <Badge>{filtered.length}</Badge>
        </div>
        {state.error && <ErrorState text={state.error} onRetry={load} />}
        {selectedBookingIds.length > 0 && <div className="bulk-actions"><strong>{selectedBookingIds.length} ausgewählt</strong><div className="inline-end"><button className="btn btn-danger" disabled={isBulkDeleting} onClick={() => setBulkDeleteOpen(true)}>{isBulkDeleting ? 'Lösche…' : 'Auswahl löschen'}</button><button className="btn btn-outline" disabled={isBulkDeleting} onClick={() => setSelectedBookingIds([])}>Abbrechen</button></div></div>}
        <div className="table-wrap booking-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={isAllVisibleSelected} onChange={toggleAllVisibleBookings} aria-label="Alle sichtbaren Buchungen auswählen" /></th>
                <th>Datum</th>
                <th>Person</th>
                <th>Gast</th>
                <th>Ressource</th>
                <th>Floorplan</th>
                <th>Erstellt</th>
                <th className="align-right">Aktionen</th>
              </tr>
            </thead>
            {state.loading && !state.ready ? <SkeletonRows columns={8} /> : <tbody>{filtered.map((booking) => {
              const desk = desks.find((item) => item.id === booking.deskId);
              const floorplan = floorplans.find((plan) => plan.id === desk?.floorplanId);
              const creatorName = getCreatorDisplay(booking);
              const creatorEmail = getCreatorEmail(booking);
              const guestLabel = booking.bookedFor === 'GUEST' ? `Ja · ${booking.guestName?.trim() || 'Unbekannt'}` : 'Nein';

              return <tr key={booking.id} className={focusedBooking?.id === booking.id ? 'row-selected' : ''} onClick={() => setFocusedBookingId(booking.id)}>
                <td><input type="checkbox" checked={selectedBookingIds.includes(booking.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleBookingSelection(booking.id)} aria-label={`Buchung ${booking.id} auswählen`} /></td>
                <td>{formatDateOnly(booking.date)}</td>
                <td>
                  <div className="booking-person-cell">
                    <Avatar displayName={creatorName} email={creatorEmail} size={24} />
                    <span className="truncate-cell" title={creatorEmail}>{creatorName}</span>
                  </div>
                </td>
                <td>
                  <span className="booking-guest-cell truncate-cell" title={guestLabel}>
                    {booking.bookedFor === 'GUEST' ? <Badge tone="warn">Ja</Badge> : <Badge>Nein</Badge>}
                    {booking.bookedFor === 'GUEST' && <span className="booking-guest-name">· {booking.guestName?.trim() || 'Unbekannt'}</span>}
                  </span>
                </td>
                <td>{desk?.name ?? booking.deskId}</td>
                <td>{floorplan?.name ?? '—'}</td>
                <td>{formatDate(booking.createdAt)}</td>
                <td className="align-right"><RowMenu items={[{ label: 'Bearbeiten', onSelect: () => setEditing(booking) }, { label: 'Löschen', onSelect: () => setDeleteBooking(booking), danger: true }]} /></td>
              </tr>;
            })}</tbody>}
          </table>
        </div>
      </section>

      <aside className="card stack-sm admin-split-floor-preview bookings-floorplan-card">
        <div className="inline-between"><h3>Floorplan</h3>{focusedDesk && <Badge tone="ok">Ressource: {focusedDesk.name}</Badge>}</div>
        {focusedFloor ? <div className="canvas-body"><FloorplanCanvas imageUrl={resolveApiUrl(focusedFloor.imageUrl) ?? focusedFloor.imageUrl} imageAlt={focusedFloor.name} desks={focusedDesks} selectedDeskId={focusedDesk?.id ?? ''} hoveredDeskId="" onHoverDesk={() => undefined} onSelectDesk={() => undefined} /></div> : <EmptyState text="Buchung auswählen, um die Ressource im Floorplan zu sehen." />}
      </aside>
    </section>
    {(creating || editing) && <BookingEditor booking={editing} desks={desks} employees={employees} floorplans={floorplans} onClose={() => { setCreating(false); setEditing(null); navigate('/admin/bookings'); }} onSaved={async (m) => { toasts.success(m); setCreating(false); setEditing(null); await load(); }} onError={toasts.error} />}
    {deleteBooking && <ConfirmDialog title="Buchung löschen?" description="Die ausgewählte Buchung wird entfernt." onCancel={() => setDeleteBooking(null)} onConfirm={async (event) => { const anchorRect = event.currentTarget.getBoundingClientRect(); await cancelBooking(deleteBooking.id); setDeleteBooking(null); toasts.success('Buchung gelöscht', { anchorRect }); await load(); }} />}
    {bulkDeleteOpen && <ConfirmDialog title={`${selectedBookingIds.length} Einträge löschen?`} description="Dieser Vorgang ist irreversibel." onCancel={() => setBulkDeleteOpen(false)} onConfirm={(event) => void runBulkDelete(event.currentTarget.getBoundingClientRect())} confirmDisabled={isBulkDeleting} confirmLabel={isBulkDeleting ? 'Lösche…' : 'Löschen'} />}
  </AdminLayout>;
}

function BookingEditor({ booking, desks, employees, floorplans, onClose, onSaved, onError }: { booking: Booking | null; desks: Desk[]; employees: Employee[]; floorplans: Floorplan[]; onClose: () => void; onSaved: (m: string) => Promise<void>; onError: (m: string) => void }) {
  const initialDesk = desks.find((desk) => desk.id === booking?.deskId) ?? desks[0] ?? null;
  const [floorplanId, setFloorplanId] = useState(initialDesk?.floorplanId ?? floorplans[0]?.id ?? '');
  const [deskId, setDeskId] = useState(booking?.deskId ?? initialDesk?.id ?? '');
  const [date, setDate] = useState(booking?.date?.slice(0, 10) ?? today);
  const [userEmail, setUserEmail] = useState(booking?.userEmail ?? employees[0]?.email ?? '');
  const [slot, setSlot] = useState<'FULL_DAY' | 'MORNING' | 'AFTERNOON'>(booking?.slot === 'MORNING' || booking?.slot === 'AFTERNOON' ? booking.slot : 'FULL_DAY');
  const [startTime, setStartTime] = useState(booking?.startTime ?? '09:00');
  const [endTime, setEndTime] = useState(booking?.endTime ?? '10:00');
  const floorDesks = desks.filter((desk) => desk.floorplanId === floorplanId);
  const selectedFloor = floorplans.find((floor) => floor.id === floorplanId) ?? null;
  const selectedDesk = floorDesks.find((desk) => desk.id === deskId) ?? null;
  const isRoomDesk = selectedDesk?.kind === 'RAUM';

  useEffect(() => {
    if (deskId && floorDesks.some((desk) => desk.id === deskId)) return;
    setDeskId(floorDesks[0]?.id ?? '');
  }, [deskId, floorDesks]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (booking) {
        await patch(`/admin/bookings/${booking.id}`, { deskId, date, userEmail, slot: isRoomDesk ? undefined : slot, startTime: isRoomDesk ? startTime : undefined, endTime: isRoomDesk ? endTime : undefined });
        await onSaved('Buchung aktualisiert');
      } else {
        await post('/bookings', { deskId, date, userEmail, slot: isRoomDesk ? undefined : slot, startTime: isRoomDesk ? startTime : undefined, endTime: isRoomDesk ? endTime : undefined });
        await onSaved('Buchung angelegt');
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    }
  };

  return <div className="overlay"><section className="card dialog stack-sm booking-editor-dialog"><h3>{booking ? 'Buchung bearbeiten' : 'Buchung anlegen'}</h3>{booking && <div className="booking-editor-meta">{booking.createdBy && <p className="muted">Gebucht von: <strong>{booking.createdBy.displayName?.trim() || booking.createdBy.email}</strong></p>}{booking.bookedFor === 'GUEST' && <p className="muted">Für Gast: <strong>{booking.guestName?.trim() || 'Unbekannt'}</strong></p>}</div>}<div className="booking-editor-layout"><form className="stack-sm" onSubmit={submit}><label className="field"><span>Floorplan</span><select required value={floorplanId} onChange={(e) => setFloorplanId(e.target.value)}>{floorplans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label><label className="field"><span>Ressource</span><select required value={deskId} onChange={(e) => setDeskId(e.target.value)}>{floorDesks.map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}</select></label><input required type="date" value={date} onChange={(e) => setDate(e.target.value)} />{isRoomDesk ? <div className="split"><input required type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /><input required type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></div> : <select value={slot} onChange={(e) => setSlot(e.target.value as 'FULL_DAY' | 'MORNING' | 'AFTERNOON')}><option value="FULL_DAY">Ganzer Tag</option><option value="MORNING">Vormittag</option><option value="AFTERNOON">Nachmittag</option></select>}<select required value={userEmail} onChange={(e) => setUserEmail(e.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.email}>{employee.displayName} ({employee.email})</option>)}</select><div className="inline-end"><button className="btn btn-outline" type="button" onClick={onClose}>Abbrechen</button><button className="btn">Speichern</button></div></form><div className="booking-editor-plan">{selectedFloor ? <div className="canvas-body booking-editor-canvas"><FloorplanCanvas imageUrl={resolveApiUrl(selectedFloor.imageUrl) ?? selectedFloor.imageUrl} imageAlt={selectedFloor.name} desks={floorDesks.map((desk) => ({ id: desk.id, name: desk.name, kind: desk.kind, x: desk.x, y: desk.y, status: 'free' as const, booking: null, isSelected: desk.id === deskId, isHighlighted: desk.id === deskId }))} selectedDeskId={deskId} hoveredDeskId="" onHoverDesk={() => undefined} onSelectDesk={setDeskId} /></div> : <EmptyState text="Kein Floorplan ausgewählt." />}</div></div></section></div>;
}

function EmployeesPage({ path, navigate, onRoleStateChanged, onLogout, currentAdminEmail, currentUser }: RouteProps & { currentAdminEmail: string }) {
  const toasts = useToast();
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
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="Mitarbeiter" currentUser={currentUser ?? null}>
      <section className="card stack-sm">
        <ListToolbar
          title="Mitarbeiter"
          count={filtered.length}
          filters={<div className="admin-search">🔎<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name oder E-Mail" /></div>}
          actions={<button className="btn" onClick={() => setCreating(true)}>Neu</button>}
        />
        {state.error && <ErrorState text={state.error} onRetry={load} />}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th className="avatar-col">Avatar</th><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th className="align-right">Aktionen</th></tr></thead>{state.loading && !state.ready ? <SkeletonRows columns={6} /> : <tbody>{filtered.map((employee) => <tr key={employee.id}><td className="avatar-col"><Avatar displayName={employee.displayName} email={employee.email} photoUrl={employee.photoUrl ?? undefined} size={24} /></td><td>{employee.displayName}</td><td className="truncate-cell" title={employee.email}>{employee.email}</td><td><select value={employee.role} disabled={updatingRoleId === employee.id} onChange={(event) => { const nextRole = event.target.value as 'admin' | 'user'; if (nextRole !== employee.role) void updateRole(employee, nextRole); }}><option value="user">User</option><option value="admin">Admin</option></select>{updatingRoleId === employee.id && <span className="muted"> ⏳</span>}</td><td>{employee.isActive ? <Badge tone="ok">aktiv</Badge> : <Badge tone="warn">deaktiviert</Badge>}</td><td className="align-right"><RowMenu items={[{ label: 'Bearbeiten', onSelect: () => setEditing(employee) }, { label: 'Löschen', onSelect: () => setPendingDeactivate(employee), danger: true }]} /></td></tr>)}</tbody>}</table></div>
        {!state.loading && filtered.length === 0 && <EmptyState text="Keine Mitarbeitenden vorhanden." action={<button className="btn" onClick={() => setCreating(true)}>Neu anlegen</button>} />}
      </section>
      {(creating || editing) && <EmployeeEditor employee={editing} onClose={() => { setCreating(false); setEditing(null); navigate('/admin/employees'); }} onSaved={async () => { setCreating(false); setEditing(null); toasts.success('Mitarbeiter gespeichert'); await load(); await onRoleStateChanged(); }} onError={toasts.error} />}
      {pendingDeactivate && <ConfirmDialog title="Mitarbeiter deaktivieren?" description={`${pendingDeactivate.displayName} wird auf inaktiv gesetzt.`} onCancel={() => setPendingDeactivate(null)} onConfirm={async (event) => { const anchorRect = event.currentTarget.getBoundingClientRect(); await patch(`/admin/employees/${pendingDeactivate.id}`, { isActive: false }); setPendingDeactivate(null); toasts.success('Mitarbeiter deaktiviert', { anchorRect }); await load(); }} />}
    </AdminLayout>
  );
}


function DbAdminPage({ path, navigate, onLogout, currentUser }: RouteProps) {
  const toasts = useToast();
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
  const [clearConfirmInput, setClearConfirmInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortColumn, setSortColumn] = useState('createdAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [deleteTarget, setDeleteTarget] = useState<Record<string, unknown> | null>(null);
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
  const [isCompact, setIsCompact] = useState(() => window.innerWidth < 900);

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
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 900px)');
    const listener = (event: MediaQueryListEvent) => setIsCompact(event.matches);
    setIsCompact(mediaQuery.matches);
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, []);

  useEffect(() => {
    if (!selectedTable) return;
    const hasCreatedAt = selectedTable.columns.some((column) => column.name.toLowerCase() === 'createdat');
    setSortColumn(hasCreatedAt ? 'createdAt' : selectedTable.columns[0]?.name ?? '');
    setSortDirection(hasCreatedAt ? 'desc' : 'asc');
    setSearch('');
  }, [selectedTable]);

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
      setClearConfirmInput('');
      const deletedCount = typeof response?.deleted === 'number' ? response.deleted : rows.length;
      toasts.success(`Tabelle geleert (${deletedCount} Datensätze gelöscht)`);
      await loadRows(selectedTable.name);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Tabelle leeren fehlgeschlagen');
    } finally {
      setClearingTable(false);
    }
  };

  const columnsToShow = useMemo(() => {
    if (!selectedTable) return [] as DbColumn[];
    if (!isCompact) return selectedTable.columns;
    const preferred = ['id', 'useremail', 'date'];
    const compactColumns = selectedTable.columns.filter((column) => preferred.includes(column.name.toLowerCase()));
    return compactColumns.length > 0 ? compactColumns : selectedTable.columns.slice(0, 3);
  }, [isCompact, selectedTable]);

  const filteredRows = useMemo(() => {
    if (!selectedTable) return rows;
    const query = search.trim().toLowerCase();
    const baseRows = query
      ? rows.filter((row) => selectedTable.columns.some((column) => formatCellValue(column.name, row[column.name]).toLowerCase().includes(query)))
      : rows;
    const sorted = [...baseRows].sort((a, b) => {
      const left = a[sortColumn];
      const right = b[sortColumn];
      const leftDate = typeof left === 'string' ? Date.parse(left) : Number.NaN;
      const rightDate = typeof right === 'string' ? Date.parse(right) : Number.NaN;
      let compare = 0;
      if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) compare = leftDate - rightDate;
      else compare = String(left ?? '').localeCompare(String(right ?? ''), 'de', { numeric: true, sensitivity: 'base' });
      return sortDirection === 'asc' ? compare : -compare;
    });
    return sorted;
  }, [rows, search, selectedTable, sortColumn, sortDirection]);

  const toggleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortColumn(column);
    setSortDirection(column.toLowerCase() === 'createdat' ? 'desc' : 'asc');
  };

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toasts.success('Wert kopiert');
    } catch {
      toasts.error('Kopieren fehlgeschlagen');
    }
  };

  return (
    <AdminLayout path={path} navigate={navigate} onLogout={onLogout} title="DB Admin" currentUser={currentUser ?? null}>
      <section className="card stack-sm db-editor-panel">
        <header className="db-editor-header">
          <div>
            <h3>Datenbank Editor</h3>
            <p className="muted">Tabelle bearbeiten, filtern, Einträge verwalten</p>
          </div>
          <div className="db-editor-controls">
            <label className="field">
              <span>Tabelle</span>
              <select value={tableName} onChange={(event) => setTableName(event.target.value)}>
                {tables.map((table) => <option key={table.name} value={table.name}>{dbTableLabel(table)}</option>)}
              </select>
            </label>
            <div className="admin-search">
              🔎
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Suchen" />
            </div>
            <button className="btn" onClick={openCreate} disabled={!selectedTable}>Neu</button>
          </div>
        </header>
        <div className="inline-between">
          <Badge>{selectedTable?.model ?? '—'}</Badge>
          <button className="btn btn-danger-text" onClick={() => setClearTableOpen(true)} disabled={!selectedTable || rows.length === 0}>Tabelle leeren</button>
        </div>
        {(loading || rowLoading) && <div className="table-wrap"><table className="admin-table db-editor-table"><thead><tr>{(selectedTable?.columns ?? Array.from({ length: 5 }).map((_, index) => ({ name: `col-${index}` } as DbColumn))).map((column) => <th key={column.name}>{column.name}</th>)}<th className="align-right">Aktionen</th></tr></thead><SkeletonRows columns={(selectedTable?.columns.length ?? 5) + 1} /></table></div>}
        {error && <ErrorState text={error} onRetry={() => { if (tableName) void loadRows(tableName); else void loadTables(); }} />}
        {selectedTable && !rowLoading && filteredRows.length > 0 && <div className="table-wrap"><table className="admin-table db-editor-table"><thead><tr>{columnsToShow.map((column) => <th key={column.name} className={`db-col-${column.name.toLowerCase()}`}><button type="button" className="btn btn-ghost db-sort-btn" onClick={() => toggleSort(column.name)}>{column.name}{sortColumn === column.name && <span>{sortDirection === 'asc' ? ' ↑' : ' ↓'}</span>}</button></th>)}<th className="align-right">Aktionen</th></tr></thead><tbody>{filteredRows.map((row, index) => <tr key={`${String(row.id ?? 'row')}-${index}`}>{columnsToShow.map((column) => { const rawValue = row[column.name]; const value = formatCellValue(column.name, rawValue); if (isIdColumn(column.name) && typeof rawValue === 'string') { return <td key={column.name} className={`truncate-cell db-col-${column.name.toLowerCase()}`} title={rawValue}><div className="db-id-cell"><span>{rawValue}</span><button className="btn btn-ghost btn-icon" onClick={() => void copyValue(rawValue)} title="Kopieren" aria-label={`${column.name} kopieren`}>📋</button></div></td>; } return <td key={column.name} className={`truncate-cell db-col-${column.name.toLowerCase()}`} title={value}>{value}</td>; })}<td className="align-right"><div className="admin-row-actions"><button className="btn btn-outline" onClick={() => openEdit(row)}>Bearbeiten</button><RowMenu items={[{ label: 'Bearbeiten', onSelect: () => openEdit(row) }, ...(isCompact ? [{ label: 'Details', onSelect: () => setDetailRow(row) }] : []), ...(typeof row.id === 'string' ? [{ label: 'Löschen', onSelect: () => setDeleteTarget(row), danger: true }] : [])]} /></div></td></tr>)}</tbody></table></div>}
        {selectedTable && !rowLoading && filteredRows.length === 0 && <EmptyState text="🗂️ Keine Einträge gefunden." action={<button className="btn" onClick={openCreate} disabled={!selectedTable}>Neu</button>} />}
      </section>
      {editorOpen && <div className="overlay"><section className="card dialog stack-sm"><h3>{editingRowId ? 'Datensatz bearbeiten' : 'Datensatz erstellen'}</h3><form className="stack-sm" onSubmit={submitEditor}><textarea className="db-editor-textarea" rows={16} value={editorValue} onChange={(event) => setEditorValue(event.target.value)} /><p className="muted">JSON Objekt mit Feldwerten eingeben.</p><div className="inline-end"><button className="btn btn-outline" type="button" onClick={() => setEditorOpen(false)}>Abbrechen</button><button className="btn">Speichern</button></div></form></section></div>}
      {deleteTarget && selectedTable && typeof deleteTarget.id === 'string' && <ConfirmDialog title="Datensatz löschen?" description={`ID: ${String(deleteTarget.id)}${deleteTarget['userEmail'] ? ` · ${String(deleteTarget['userEmail'])}` : ''}`} onCancel={() => setDeleteTarget(null)} onConfirm={async () => { await removeRow(String(deleteTarget.id)); setDeleteTarget(null); }} />}
      {detailRow && <div className="overlay"><section className="card dialog stack-sm"><h3>Details</h3><pre className="db-detail-pre">{JSON.stringify(detailRow, null, 2)}</pre><div className="inline-end"><button className="btn btn-outline" onClick={() => setDetailRow(null)}>Schließen</button></div></section></div>}
      {clearTableOpen && selectedTable && <div className="overlay"><section className="card dialog stack-sm" role="dialog" aria-modal="true"><h3>Tabelle wirklich leeren?</h3><p className="muted">Alle Datensätze in "{dbTableLabel(selectedTable)}" werden dauerhaft gelöscht. Zum Bestätigen bitte <strong>DELETE</strong> eingeben.</p><input value={clearConfirmInput} onChange={(event) => setClearConfirmInput(event.target.value)} placeholder="DELETE" /><div className="inline-end"><button className="btn btn-outline" disabled={clearingTable} onClick={() => { setClearTableOpen(false); setClearConfirmInput(''); }}>Abbrechen</button><button className="btn btn-danger" disabled={clearingTable || clearConfirmInput !== 'DELETE'} onClick={() => void clearTable()}>{clearingTable ? 'Lösche…' : 'Tabelle leeren'}</button></div></section></div>}
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

export function AdminRouter({ path, navigate, onRoleStateChanged, onLogout, currentUser }: RouteProps) {
  const [adminSession, setAdminSession] = useState<AdminSession | null>(currentUser ?? null);
  const route = basePath(path);

  useEffect(() => {
    setAdminSession(currentUser ?? null);
  }, [currentUser]);

  useEffect(() => {
    if (currentUser) return;
    void (async () => {
      try {
        const session = await get<{ user: AdminSession }>('/auth/me');
        setAdminSession(session.user);
      } catch {
        setAdminSession(null);
      }
    })();
  }, [currentUser]);

  if (route === '/admin') return <DashboardPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;
  if (route === '/admin/floorplans') return <FloorplansPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;
  if (route === '/admin/desks') return <DesksPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;
  if (route === '/admin/bookings') return <BookingsPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;
  if (route === '/admin/employees') return <EmployeesPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentAdminEmail={adminSession?.email ?? ''} currentUser={adminSession} />;
  if (route === '/admin/db-admin') return <DbAdminPage path={path} navigate={navigate} onRoleStateChanged={onRoleStateChanged} onLogout={onLogout} currentUser={adminSession} />;

  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Admin-Seite nicht gefunden</h2><button className="btn" onClick={() => navigate('/admin')}>Zum Dashboard</button></section></main>;
}
