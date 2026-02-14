import { FormEvent, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, get, post } from './api';
import { FloorplanCanvas } from './FloorplanCanvas';

type Floorplan = { id: string; name: string; imageUrl: string };
type OccupancyDesk = {
  id: string;
  name: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { id?: string; userEmail: string; userDisplayName?: string } | null;
};
type OccupancyPerson = { email: string; displayName?: string; deskName?: string; deskId?: string };
type OccupancyResponse = { date: string; floorplanId: string; desks: OccupancyDesk[]; people: OccupancyPerson[] };
type BookingEmployee = { id: string; email: string; displayName: string };

type RightTab = 'bookings' | 'people' | 'details';

const today = new Date().toISOString().slice(0, 10);
const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const toDateKey = (value: Date): string => value.toISOString().slice(0, 10);
const startOfMonth = (dateString: string): Date => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
};
const monthLabel = (monthStart: Date): string => monthStart.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

const buildCalendarDays = (monthStart: Date): Date[] => {
  const firstWeekday = (monthStart.getUTCDay() + 6) % 7;
  const gridStart = new Date(monthStart);
  gridStart.setUTCDate(1 - firstWeekday);
  return Array.from({ length: 42 }).map((_, index) => {
    const day = new Date(gridStart);
    day.setUTCDate(gridStart.getUTCDate() + index);
    return day;
  });
};

export function App() {
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(today));
  const [onlyFree, setOnlyFree] = useState(false);

  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [employees, setEmployees] = useState<BookingEmployee[]>([]);
  const [selectedEmployeeEmail, setSelectedEmployeeEmail] = useState('');

  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');
  const [rightTab, setRightTab] = useState<RightTab>('bookings');

  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [toastMessage, setToastMessage] = useState('');

  const [bookingDialogOpen, setBookingDialogOpen] = useState(false);
  const [sidebarSheetOpen, setSidebarSheetOpen] = useState(false);
  const [detailsSheetOpen, setDetailsSheetOpen] = useState(false);

  const selectedFloorplan = useMemo(() => floorplans.find((f) => f.id === selectedFloorplanId) ?? null, [floorplans, selectedFloorplanId]);
  const desks = useMemo(() => occupancy?.desks ?? [], [occupancy]);
  const filteredDesks = useMemo(() => (onlyFree ? desks.filter((desk) => desk.status === 'free') : desks), [desks, onlyFree]);
  const people = useMemo(() => occupancy?.people ?? [], [occupancy]);
  const selectedDesk = useMemo(() => desks.find((desk) => desk.id === selectedDeskId) ?? null, [desks, selectedDeskId]);

  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);

  const loadInitial = async () => {
    setLoading(true);
    setErrorMessage('');
    try {
      const [nextFloorplans, nextEmployees] = await Promise.all([get<Floorplan[]>('/floorplans'), get<BookingEmployee[]>('/employees')]);
      setFloorplans(nextFloorplans);
      setEmployees(nextEmployees);
      setSelectedFloorplanId((prev) => prev || nextFloorplans[0]?.id || '');
      setSelectedEmployeeEmail(nextEmployees[0]?.email ?? '');
    } catch {
      setErrorMessage('Daten konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  };

  const loadOccupancy = async (floorplanId: string, date: string) => {
    if (!floorplanId) return;
    setLoading(true);
    setErrorMessage('');
    try {
      const next = await get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`);
      setOccupancy(next);
      setSelectedDeskId((prev) => (next.desks.some((desk) => desk.id === prev) ? prev : ''));
    } catch {
      setErrorMessage('Belegung konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInitial();
  }, []);

  useEffect(() => {
    if (selectedFloorplanId) {
      loadOccupancy(selectedFloorplanId, selectedDate);
    }
  }, [selectedFloorplanId, selectedDate]);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(''), 2500);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  const createBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedDesk || selectedDesk.status !== 'free') return;

    try {
      await post('/bookings', { deskId: selectedDesk.id, userEmail: selectedEmployeeEmail, date: selectedDate });
      setToastMessage('Buchung erstellt');
      setBookingDialogOpen(false);
      await loadOccupancy(selectedFloorplanId, selectedDate);
    } catch (error) {
      if (error instanceof ApiError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage('Buchung fehlgeschlagen.');
      }
    }
  };

  const selectDay = (day: Date) => {
    const key = toDateKey(day);
    setSelectedDate(key);
    setVisibleMonth(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
  };

  const sidebar = (
    <div className="stack">
      <section className="card">
        <div className="calendar-header">
          <button className="btn btn-ghost" onClick={() => setVisibleMonth((prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)))}>‹</button>
          <strong>{monthLabel(visibleMonth)}</strong>
          <button className="btn btn-ghost" onClick={() => setVisibleMonth((prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1)))}>›</button>
        </div>
        <div className="calendar-grid" role="grid" aria-label="Monatsansicht">
          {weekdays.map((weekday) => <span key={weekday} className="weekday-label">{weekday}</span>)}
          {calendarDays.map((day) => {
            const dayKey = toDateKey(day);
            const inVisibleMonth = day.getUTCMonth() === visibleMonth.getUTCMonth();
            const isSelected = dayKey === selectedDate;
            const isToday = dayKey === today;
            return (
              <button key={dayKey} className={`day-btn ${inVisibleMonth ? '' : 'outside'} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}`} onClick={() => selectDay(day)}>
                {day.getUTCDate()}
              </button>
            );
          })}
        </div>
      </section>

      <section className="card stack-sm">
        <h3 className="section-title">Filter & Legende</h3>
        <label className="field">
          <span>Standort/Floorplan</span>
          <select value={selectedFloorplanId} onChange={(event) => setSelectedFloorplanId(event.target.value)}>
            {floorplans.map((floorplan) => <option key={floorplan.id} value={floorplan.id}>{floorplan.name}</option>)}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={onlyFree} onChange={(event) => setOnlyFree(event.target.checked)} />
          <span>Nur freie Plätze</span>
        </label>
        <div className="legend">
          <span><i className="dot free" /> Frei</span>
          <span><i className="dot booked" /> Belegt</span>
          <span><i className="dot selected" /> Dein Platz</span>
        </div>
      </section>
    </div>
  );

  const detailPanel = (
    <section className="card stack-sm details-panel">
      <div className="summary-row">
        <div>
          <p className="muted">{new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</p>
          <h3>{selectedFloorplan?.name ?? 'Kein Floorplan'}</h3>
        </div>
        <span className="badge">Im Büro: {people.length}</span>
      </div>

      <div className="tabs">
        {(['bookings', 'people', 'details'] as RightTab[]).map((tab) => (
          <button key={tab} className={`tab-btn ${rightTab === tab ? 'active' : ''}`} onClick={() => setRightTab(tab)}>
            {tab === 'bookings' ? 'Buchungen' : tab === 'people' ? 'Personen' : 'Details'}
          </button>
        ))}
      </div>

      {rightTab === 'bookings' && (
        <div className="table-wrap">
          {desks.filter((desk) => desk.booking).length === 0 ? (
            <div className="empty-state">
              <p>Keine Buchungen an diesem Tag.</p>
              <button className="btn" onClick={() => setBookingDialogOpen(true)}>Buchung erstellen</button>
            </div>
          ) : (
            <table>
              <thead><tr><th>Desk</th><th>Person</th></tr></thead>
              <tbody>
                {desks.filter((desk) => desk.booking).map((desk) => (
                  <tr
                    key={desk.id}
                    className={selectedDeskId === desk.id ? 'row-selected' : ''}
                    onMouseEnter={() => setHoveredDeskId(desk.id)}
                    onMouseLeave={() => setHoveredDeskId('')}
                    onClick={() => {
                      setSelectedDeskId(desk.id);
                      setRightTab('details');
                    }}
                  >
                    <td>{desk.name}</td>
                    <td>{desk.booking?.userDisplayName ?? desk.booking?.userEmail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {rightTab === 'people' && (
        <ul className="people-list">
          {people.map((person) => (
            <li
              key={`${person.email}-${person.deskId ?? 'none'}`}
              className={selectedDeskId === person.deskId ? 'row-selected' : ''}
              onMouseEnter={() => setHoveredDeskId(person.deskId ?? '')}
              onMouseLeave={() => setHoveredDeskId('')}
              onClick={() => person.deskId && setSelectedDeskId(person.deskId)}
            >
              <div>
                <strong>{person.displayName ?? person.email}</strong>
                <p className="muted">{person.email}</p>
              </div>
              <span>{person.deskName ?? '—'}</span>
            </li>
          ))}
        </ul>
      )}

      {rightTab === 'details' && (
        <div>
          {selectedDesk ? (
            <div className="stack-sm">
              <h4>{selectedDesk.name}</h4>
              <p className="muted">Status: {selectedDesk.status === 'free' ? 'Frei' : 'Belegt'}</p>
              <p className="muted">Ausstattung: Monitor, Docking</p>
            </div>
          ) : (
            <div className="empty-state"><p>Kein Desk ausgewählt. Klicke auf einen Platz im Plan.</p></div>
          )}
        </div>
      )}
    </section>
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <button className="btn btn-ghost mobile-only" onClick={() => setSidebarSheetOpen(true)}>☰</button>
          <h1>AVENCY Booking</h1>
          <select value={selectedFloorplanId} onChange={(event) => setSelectedFloorplanId(event.target.value)}>
            {floorplans.map((floorplan) => <option key={floorplan.id} value={floorplan.id}>{floorplan.name}</option>)}
          </select>
        </div>
        <div className="header-center">
          ⌕
          <input placeholder="Suche Person oder Desk" />
        </div>
        <div className="header-right">
          <button className="btn btn-ghost" onClick={() => setDetailsSheetOpen(true)}>≡ Details</button>
          <button className="avatar-btn">👤</button>
        </div>
      </header>

      {errorMessage && <div className="toast toast-error">{errorMessage} <button className="btn btn-ghost" onClick={() => loadOccupancy(selectedFloorplanId, selectedDate)}>Retry</button></div>}
      {toastMessage && <div className="toast toast-success">{toastMessage}</div>}

      <section className="layout-grid">
        <aside className="left-col desktop-only">{loading ? <div className="card skeleton h-480" /> : sidebar}</aside>
        <section className="center-col">
          <article className="card canvas-card">
            <div className="card-header-row">
              <h2>{selectedFloorplan?.name ?? 'Floorplan'}</h2>
              <div className="toolbar">
                <button className="btn btn-outline">Fit</button>
                <button className="btn btn-outline">IDs</button>
                <button className="btn" onClick={() => setBookingDialogOpen(true)}>Buchung erstellen</button>
              </div>
            </div>
            <div className="canvas-body">
              {loading ? (
                <div className="skeleton h-420" />
              ) : selectedFloorplan ? (
                <FloorplanCanvas
                  imageUrl={selectedFloorplan.imageUrl}
                  imageAlt={selectedFloorplan.name}
                  desks={filteredDesks}
                  selectedDeskId={selectedDeskId}
                  hoveredDeskId={hoveredDeskId}
                  onHoverDesk={setHoveredDeskId}
                  onSelectDesk={(deskId) => {
                    setSelectedDeskId(deskId);
                    setRightTab('details');
                  }}
                />
              ) : (
                <div className="empty-state"><p>Kein Floorplan ausgewählt.</p></div>
              )}
            </div>
          </article>
        </section>

        <aside className="right-col desktop-right">{loading ? <div className="card skeleton h-480" /> : detailPanel}</aside>
      </section>

      {bookingDialogOpen && createPortal(
        <div className="overlay" onClick={() => setBookingDialogOpen(false)}>
          <div className="dialog card" onClick={(event) => event.stopPropagation()}>
            <h3>Buchung erstellen</h3>
            <form onSubmit={createBooking} className="stack-sm">
              <label className="field"><span>Desk</span><select value={selectedDeskId} onChange={(event) => setSelectedDeskId(event.target.value)}>{desks.filter((desk) => desk.status === 'free').map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}</select></label>
              <label className="field"><span>Mitarbeiter</span><select value={selectedEmployeeEmail} onChange={(event) => setSelectedEmployeeEmail(event.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.email}>{employee.displayName}</option>)}</select></label>
              <div className="inline-end"><button type="button" className="btn btn-outline" onClick={() => setBookingDialogOpen(false)}>Abbrechen</button><button className="btn" type="submit">Speichern</button></div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {sidebarSheetOpen && createPortal(<div className="overlay" onClick={() => setSidebarSheetOpen(false)}><aside className="sheet card" onClick={(e) => e.stopPropagation()}>{sidebar}</aside></div>, document.body)}
      {detailsSheetOpen && createPortal(<div className="overlay" onClick={() => setDetailsSheetOpen(false)}><aside className="sheet sheet-right card" onClick={(e) => e.stopPropagation()}>{detailPanel}</aside></div>, document.body)}

      <p className="api-base">API: {API_BASE}</p>
    </main>
  );
}
