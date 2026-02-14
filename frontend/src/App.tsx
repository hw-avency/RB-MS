import { FormEvent, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, checkBackendHealth, get, markBackendAvailable, post } from './api';
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
type DayBooking = { id: string; deskId: string; userEmail: string; date: string; desk?: { id: string; name: string } };
type RecurringBooking = { id: string; deskId: string; userEmail: string; weekday: number; validFrom: string; validTo: string | null };

type RightTab = 'bookings' | 'people' | 'details';
type BookingMode = 'single' | 'range' | 'series';

const today = new Date().toISOString().slice(0, 10);
const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const weekdayToBackend = [1, 2, 3, 4, 5, 6, 0];

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

const getApiErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) {
    return error.message;
  }
  return fallback;
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
  const [dayBookings, setDayBookings] = useState<DayBooking[]>([]);
  const [recurringBookings, setRecurringBookings] = useState<RecurringBooking[]>([]);

  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');
  const [rightTab, setRightTab] = useState<RightTab>('bookings');

  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isUpdatingOccupancy, setIsUpdatingOccupancy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const [backendDown, setBackendDown] = useState(false);

  const [bookingDialogOpen, setBookingDialogOpen] = useState(false);
  const [sidebarSheetOpen, setSidebarSheetOpen] = useState(false);
  const [detailsSheetOpen, setDetailsSheetOpen] = useState(false);

  const [bookingMode, setBookingMode] = useState<BookingMode>('single');
  const [rangeStartDate, setRangeStartDate] = useState(selectedDate);
  const [rangeEndDate, setRangeEndDate] = useState(selectedDate);
  const [seriesStartDate, setSeriesStartDate] = useState(selectedDate);
  const [seriesEndDate, setSeriesEndDate] = useState('');
  const [seriesWeekdays, setSeriesWeekdays] = useState<number[]>([]);

  const selectedFloorplan = useMemo(() => floorplans.find((f) => f.id === selectedFloorplanId) ?? null, [floorplans, selectedFloorplanId]);
  const desks = useMemo(() => occupancy?.desks ?? [], [occupancy]);
  const filteredDesks = useMemo(() => (onlyFree ? desks.filter((desk) => desk.status === 'free') : desks), [desks, onlyFree]);
  const people = useMemo(() => occupancy?.people ?? [], [occupancy]);
  const selectedDesk = useMemo(() => desks.find((desk) => desk.id === selectedDeskId) ?? null, [desks, selectedDeskId]);

  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);

  const recurringForSelectedDesk = useMemo(
    () => recurringBookings.filter((booking) => booking.deskId === selectedDeskId || (!selectedDeskId && booking.deskId)),
    [recurringBookings, selectedDeskId]
  );

  const loadOccupancy = async (floorplanId: string, date: string) => {
    if (!floorplanId) return;

    setIsUpdatingOccupancy(true);
    setErrorMessage('');

    try {
      const [nextOccupancy, nextDayBookings, nextRecurring] = await Promise.all([
        get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`),
        get<DayBooking[]>(`/bookings?floorplanId=${floorplanId}&from=${date}&to=${date}`),
        get<RecurringBooking[]>(`/recurring-bookings?floorplanId=${floorplanId}`)
      ]);

      setOccupancy(nextOccupancy);
      setDayBookings(nextDayBookings);
      setRecurringBookings(nextRecurring);
      markBackendAvailable(true);
      setBackendDown(false);
      setSelectedDeskId((prev) => (nextOccupancy.desks.some((desk) => desk.id === prev) ? prev : ''));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
      }
      setErrorMessage(getApiErrorMessage(error, 'Belegung konnte nicht geladen werden.'));
    } finally {
      setIsUpdatingOccupancy(false);
    }
  };

  const loadInitial = async () => {
    setIsBootstrapping(true);
    setErrorMessage('');

    const healthy = await checkBackendHealth();
    if (!healthy) {
      setBackendDown(true);
      setIsBootstrapping(false);
      return;
    }

    try {
      const [nextFloorplans, nextEmployees] = await Promise.all([get<Floorplan[]>('/floorplans'), get<BookingEmployee[]>('/employees')]);
      setFloorplans(nextFloorplans);
      setEmployees(nextEmployees);
      setSelectedFloorplanId((prev) => prev || nextFloorplans[0]?.id || '');
      setSelectedEmployeeEmail((prev) => prev || nextEmployees[0]?.email || '');
      setBackendDown(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
      }
      setErrorMessage(getApiErrorMessage(error, 'Daten konnten nicht geladen werden.'));
    } finally {
      setIsBootstrapping(false);
    }
  };

  useEffect(() => {
    loadInitial();
  }, []);

  useEffect(() => {
    if (selectedFloorplanId && !backendDown) {
      loadOccupancy(selectedFloorplanId, selectedDate);
    }
  }, [selectedFloorplanId, selectedDate, backendDown]);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(''), 3500);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    if (!bookingDialogOpen) return;
    setRangeStartDate(selectedDate);
    setRangeEndDate(selectedDate);
    setSeriesStartDate(selectedDate);
  }, [bookingDialogOpen, selectedDate]);

  const refreshData = async () => {
    await loadOccupancy(selectedFloorplanId, selectedDate);
  };

  const createSingleBooking = async () => {
    if (!selectedDeskId) {
      throw new Error('Bitte Desk auswählen.');
    }

    await post('/bookings', { deskId: selectedDeskId, userEmail: selectedEmployeeEmail, date: selectedDate });
    setToastMessage('Einzelbuchung erstellt.');
  };

  const createRangeBooking = async () => {
    if (!selectedDeskId) {
      throw new Error('Bitte Desk auswählen.');
    }

    if (rangeStartDate > rangeEndDate) {
      throw new Error('Startdatum muss vor oder gleich Enddatum liegen.');
    }

    await post('/bookings/range', {
      deskId: selectedDeskId,
      userEmail: selectedEmployeeEmail,
      from: rangeStartDate,
      to: rangeEndDate,
      weekdaysOnly: false
    });

    setToastMessage('Zeitraumbuchung erstellt.');
  };

  const createSeriesBooking = async () => {
    if (!selectedDeskId) {
      throw new Error('Bitte Desk auswählen.');
    }

    if (seriesWeekdays.length === 0) {
      throw new Error('Bitte mindestens einen Wochentag auswählen.');
    }

    await post('/recurring-bookings/bulk', {
      deskId: selectedDeskId,
      userEmail: selectedEmployeeEmail,
      weekdays: seriesWeekdays.map((weekdayIndex) => weekdayToBackend[weekdayIndex]),
      validFrom: seriesStartDate,
      validTo: seriesEndDate || undefined
    });

    setToastMessage('Serienbuchung erstellt.');
  };

  const createBooking = async (event: FormEvent) => {
    event.preventDefault();

    try {
      if (!selectedEmployeeEmail) {
        throw new Error('Bitte Mitarbeiter auswählen.');
      }

      if (bookingMode === 'single') {
        await createSingleBooking();
      } else if (bookingMode === 'range') {
        await createRangeBooking();
      } else {
        await createSeriesBooking();
      }

      setErrorMessage('');
      setBookingDialogOpen(false);
      await refreshData();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
        return;
      }

      if (error instanceof ApiError && error.status === 409) {
        const details = (error.details as { conflictingDates?: string[]; conflictingDatesPreview?: string[] } | undefined) ?? {};
        const list = details.conflictingDates ?? details.conflictingDatesPreview ?? [];
        const info = list.length > 0 ? ` Konflikte: ${list.slice(0, 8).join(', ')}` : '';
        setErrorMessage(`${error.message}${info}`);
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : 'Buchung fehlgeschlagen.');
    }
  };

  const selectDay = (day: Date) => {
    const key = toDateKey(day);
    setSelectedDate(key);
    setVisibleMonth(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
  };

  const toggleSeriesWeekday = (weekday: number) => {
    setSeriesWeekdays((prev) => (prev.includes(weekday) ? prev.filter((value) => value !== weekday) : [...prev, weekday].sort((a, b) => a - b)));
  };

  const retryHealthCheck = async () => {
    const healthy = await checkBackendHealth();
    if (!healthy) {
      setBackendDown(true);
      return;
    }

    setBackendDown(false);
    setErrorMessage('');
    await loadInitial();
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
        <div className="table-wrap stack-sm">
          {dayBookings.length === 0 && recurringBookings.length === 0 ? (
            <div className="empty-state">
              <p>Keine Buchungen gefunden.</p>
              <button className="btn" onClick={() => setBookingDialogOpen(true)}>Buchung erstellen</button>
            </div>
          ) : (
            <>
              <div>
                <h4>Tagesbuchungen</h4>
                <table>
                  <thead><tr><th>Desk</th><th>Person</th></tr></thead>
                  <tbody>
                    {dayBookings.map((booking) => (
                      <tr
                        key={booking.id}
                        className={selectedDeskId === booking.deskId ? 'row-selected' : ''}
                        onMouseEnter={() => setHoveredDeskId(booking.deskId)}
                        onMouseLeave={() => setHoveredDeskId('')}
                        onClick={() => {
                          setSelectedDeskId(booking.deskId);
                          setRightTab('details');
                        }}
                      >
                        <td>{booking.desk?.name ?? desks.find((desk) => desk.id === booking.deskId)?.name ?? 'Desk'}</td>
                        <td>{booking.userEmail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <h4>Serienbuchungen</h4>
                {recurringForSelectedDesk.length === 0 ? (
                  <p className="muted">Keine Serienbuchungen für die Auswahl.</p>
                ) : (
                  <table>
                    <thead><tr><th>Desk</th><th>Wochentag</th><th>Zeitraum</th></tr></thead>
                    <tbody>
                      {recurringForSelectedDesk.map((booking) => (
                        <tr key={booking.id} onMouseEnter={() => setHoveredDeskId(booking.deskId)} onMouseLeave={() => setHoveredDeskId('')} onClick={() => setSelectedDeskId(booking.deskId)}>
                          <td>{desks.find((desk) => desk.id === booking.deskId)?.name ?? 'Desk'}</td>
                          <td>{weekdays[(booking.weekday + 6) % 7]}</td>
                          <td>{booking.validFrom} – {booking.validTo ?? 'offen'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
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

  if (backendDown) {
    return (
      <main className="app-shell">
        <section className="card stack-sm down-card">
          <h2>Backend nicht erreichbar</h2>
          <p>Bitte prüfen, ob Server läuft.</p>
          <p className="muted">Backend-URL: {API_BASE}</p>
          <div>
            <button className="btn" onClick={retryHealthCheck}>Erneut versuchen</button>
          </div>
        </section>
      </main>
    );
  }

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

      {errorMessage && <div className="toast toast-error">{errorMessage} <button className="btn btn-ghost" onClick={refreshData}>Retry</button></div>}
      {toastMessage && <div className="toast toast-success">{toastMessage}</div>}

      <section className="layout-grid">
        <aside className="left-col desktop-only">{isBootstrapping ? <div className="card skeleton h-480" /> : sidebar}</aside>
        <section className="center-col">
          <article className="card canvas-card">
            <div className="card-header-row">
              <h2>{selectedFloorplan?.name ?? 'Floorplan'}</h2>
              <div className="toolbar">
                {isUpdatingOccupancy && <span className="updating-indicator">Aktualisiere…</span>}
                <button className="btn" onClick={() => setBookingDialogOpen(true)}>Buchung erstellen</button>
              </div>
            </div>
            <div className="canvas-body">
              {isBootstrapping ? (
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

        <aside className="right-col desktop-right">{isBootstrapping ? <div className="card skeleton h-480" /> : detailPanel}</aside>
      </section>

      {bookingDialogOpen && createPortal(
        <div className="overlay" onClick={() => setBookingDialogOpen(false)}>
          <div className="dialog card" onClick={(event) => event.stopPropagation()}>
            <h3>Buchung erstellen</h3>
            <div className="tabs">
              <button type="button" className={`tab-btn ${bookingMode === 'single' ? 'active' : ''}`} onClick={() => setBookingMode('single')}>Einzeln</button>
              <button type="button" className={`tab-btn ${bookingMode === 'range' ? 'active' : ''}`} onClick={() => setBookingMode('range')}>Zeitraum</button>
              <button type="button" className={`tab-btn ${bookingMode === 'series' ? 'active' : ''}`} onClick={() => setBookingMode('series')}>Serie</button>
            </div>
            <form onSubmit={createBooking} className="stack-sm">
              <label className="field">
                <span>Desk</span>
                <select value={selectedDeskId} onChange={(event) => setSelectedDeskId(event.target.value)}>
                  <option value="">Desk wählen</option>
                  {desks.map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Mitarbeiter</span>
                <select value={selectedEmployeeEmail} onChange={(event) => setSelectedEmployeeEmail(event.target.value)}>
                  {employees.map((employee) => <option key={employee.id} value={employee.email}>{employee.displayName}</option>)}
                </select>
              </label>

              {bookingMode === 'single' && (
                <label className="field">
                  <span>Datum</span>
                  <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
                </label>
              )}

              {bookingMode === 'range' && (
                <div className="inline-grid-two">
                  <label className="field">
                    <span>Startdatum</span>
                    <input type="date" value={rangeStartDate} onChange={(event) => setRangeStartDate(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Enddatum</span>
                    <input type="date" value={rangeEndDate} onChange={(event) => setRangeEndDate(event.target.value)} />
                  </label>
                </div>
              )}

              {bookingMode === 'series' && (
                <>
                  <div className="inline-grid-two">
                    <label className="field">
                      <span>Startdatum</span>
                      <input type="date" value={seriesStartDate} onChange={(event) => setSeriesStartDate(event.target.value)} />
                    </label>
                    <label className="field">
                      <span>Enddatum (optional)</span>
                      <input type="date" value={seriesEndDate} onChange={(event) => setSeriesEndDate(event.target.value)} />
                    </label>
                  </div>
                  <div className="weekday-toggle-group">
                    {weekdays.map((label, index) => (
                      <button key={label} type="button" className={`weekday-toggle ${seriesWeekdays.includes(index) ? 'active' : ''}`} onClick={() => toggleSeriesWeekday(index)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}

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
