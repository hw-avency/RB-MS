import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, checkBackendHealth, get, markBackendAvailable, post, put } from './api';
import { Avatar } from './components/Avatar';
import { UserMenu } from './components/UserMenu';
import { FloorplanCanvas } from './FloorplanCanvas';
import type { AuthUser } from './auth/AuthProvider';

type Floorplan = { id: string; name: string; imageUrl: string };
type OccupancyDesk = {
  id: string;
  name: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { id?: string; employeeId?: string; userEmail: string; userDisplayName?: string; userPhotoUrl?: string } | null;
};
type OccupancyPerson = { email: string; displayName?: string; deskName?: string; deskId?: string };
type OccupancyResponse = { date: string; floorplanId: string; desks: OccupancyDesk[]; people: OccupancyPerson[] };
type BookingEmployee = { id: string; email: string; displayName: string; photoUrl?: string };
type OccupantForDay = { deskId: string; deskLabel: string; userId: string; name: string; email: string; employeeId?: string; photoUrl?: string };
type BookingMode = 'single' | 'range' | 'series';
type OverrideDialogState = { existingBookingId: string; existingDeskName: string; nextDeskName: string; newDeskId: string; date: string };

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

const resolvePhotoUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return `${API_BASE}${value.startsWith('/') ? value : `/${value}`}`;
};

export function BookingApp({ onOpenAdmin, canOpenAdmin, currentUserEmail, onLogout, currentUser }: { onOpenAdmin: () => void; canOpenAdmin: boolean; currentUserEmail?: string; onLogout: () => Promise<void>; currentUser: AuthUser }) {
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

  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isUpdatingOccupancy, setIsUpdatingOccupancy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const [backendDown, setBackendDown] = useState(false);

  const [bookingDialogOpen, setBookingDialogOpen] = useState(false);
  const [overrideDialog, setOverrideDialog] = useState<OverrideDialogState | null>(null);
  const [isOverrideSubmitting, setIsOverrideSubmitting] = useState(false);

  const [bookingMode, setBookingMode] = useState<BookingMode>('single');
  const [rangeStartDate, setRangeStartDate] = useState(selectedDate);
  const [rangeEndDate, setRangeEndDate] = useState(selectedDate);
  const [seriesStartDate, setSeriesStartDate] = useState(selectedDate);
  const [seriesEndDate, setSeriesEndDate] = useState('');
  const [seriesWeekdays, setSeriesWeekdays] = useState<number[]>([]);

  const [highlightedDeskId, setHighlightedDeskId] = useState('');
  const occupantRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const highlightTimerRef = useRef<number | null>(null);

  const selectedFloorplan = useMemo(() => floorplans.find((f) => f.id === selectedFloorplanId) ?? null, [floorplans, selectedFloorplanId]);
  const employeesByEmail = useMemo(() => new Map(employees.map((employee) => [employee.email.toLowerCase(), employee])), [employees]);
  const employeesById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const desks = useMemo(() => (occupancy?.desks ?? []).map((desk) => {
    if (!desk.booking) return desk;
    const employee = desk.booking.employeeId ? employeesById.get(desk.booking.employeeId) : employeesByEmail.get(desk.booking.userEmail.toLowerCase());
    const fallbackPhotoUrl = currentUserEmail && desk.booking.userEmail.toLowerCase() === currentUserEmail.toLowerCase()
      ? resolvePhotoUrl(`/user/me/photo?v=${encodeURIComponent(currentUserEmail)}`)
      : undefined;
    const employeePhotoUrl = resolvePhotoUrl(employee?.photoUrl);
    const bookingPhotoUrl = resolvePhotoUrl(desk.booking.userPhotoUrl);
    return {
      ...desk,
      booking: {
        ...desk.booking,
        employeeId: desk.booking.employeeId ?? employee?.id,
        userDisplayName: desk.booking.userDisplayName ?? employee?.displayName,
        userPhotoUrl: bookingPhotoUrl ?? employeePhotoUrl ?? fallbackPhotoUrl
      },
      isCurrentUsersDesk: Boolean(currentUserEmail && desk.booking.userEmail.toLowerCase() === currentUserEmail.toLowerCase())
    };
  }), [occupancy?.desks, employeesByEmail, employeesById, currentUserEmail]);
  const filteredDesks = useMemo(() => (onlyFree ? desks.filter((desk) => desk.status === 'free') : desks).map((desk) => ({ ...desk, isHighlighted: desk.id === highlightedDeskId })), [desks, onlyFree, highlightedDeskId]);
  const selectedDesk = useMemo(() => desks.find((desk) => desk.id === selectedDeskId) ?? null, [desks, selectedDeskId]);
  const occupantsForDay = useMemo<OccupantForDay[]>(
    () => desks
      .filter((desk) => desk.booking)
      .map((desk) => ({
        deskId: desk.id,
        deskLabel: desk.name,
        userId: desk.booking?.id ?? desk.booking?.employeeId ?? desk.booking?.userEmail ?? `${desk.id}-occupant`,
        name: desk.booking?.userDisplayName ?? desk.booking?.userEmail ?? 'Unbekannt',
        email: desk.booking?.userEmail ?? '',
        employeeId: desk.booking?.employeeId,
        photoUrl: desk.booking?.userPhotoUrl
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [desks]
  );
  const selectedDeskOccupant = useMemo(() => occupantsForDay.find((occupant) => occupant.deskId === selectedDeskId) ?? null, [occupantsForDay, selectedDeskId]);

  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);

  const loadOccupancy = async (floorplanId: string, date: string) => {
    if (!floorplanId) return;

    setIsUpdatingOccupancy(true);
    setErrorMessage('');

    try {
      const nextOccupancy = await get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`);

      setOccupancy(nextOccupancy);
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
      setSelectedEmployeeEmail((prev) => prev || currentUserEmail || nextEmployees[0]?.email || '');
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
  }, [currentUserEmail]);

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

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  const triggerDeskHighlight = (deskId: string, hold = 1300) => {
    setHighlightedDeskId(deskId);
    if (highlightTimerRef.current) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedDeskId('');
      highlightTimerRef.current = null;
    }, hold);
  };

  const selectDeskFromCanvas = (deskId: string) => {
    setSelectedDeskId(deskId);
    triggerDeskHighlight(deskId);
    const row = occupantRowRefs.current[deskId];
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  const refreshData = async () => {
    await loadOccupancy(selectedFloorplanId, selectedDate);
  };

  const createSingleBooking = async (): Promise<'created' | 'pending_override' | 'unchanged'> => {
    if (!selectedDeskId) {
      throw new Error('Bitte Desk auswählen.');
    }

    const existingBooking = desks.find((desk) => desk.booking && desk.booking.userEmail.toLowerCase() === selectedEmployeeEmail.toLowerCase())?.booking;
    const existingDesk = desks.find((desk) => desk.booking?.id === existingBooking?.id);

    if (existingBooking && existingBooking.id && existingBooking.id !== '' && existingDesk && existingDesk.id !== selectedDeskId) {
      const nextDesk = desks.find((desk) => desk.id === selectedDeskId);
      setOverrideDialog({
        existingBookingId: existingBooking.id,
        existingDeskName: existingDesk.name,
        nextDeskName: nextDesk?.name ?? selectedDeskId,
        newDeskId: selectedDeskId,
        date: selectedDate
      });
      return 'pending_override';
    }

    if (existingBooking && existingDesk?.id === selectedDeskId) {
      setToastMessage('Dieser Platz ist bereits gebucht.');
      return 'unchanged';
    }

    await post('/bookings', { deskId: selectedDeskId, userEmail: selectedEmployeeEmail, date: selectedDate });
    setToastMessage('Einzelbuchung erstellt.');
    return 'created';
  };

  const handleOverride = async () => {
    if (!overrideDialog) return;

    setIsOverrideSubmitting(true);
    try {
      await put(`/bookings/${overrideDialog.existingBookingId}`, { deskId: overrideDialog.newDeskId, date: overrideDialog.date });
      setOverrideDialog(null);
      setSelectedDeskId(overrideDialog.newDeskId);
      setErrorMessage('');
      await refreshData();
      setBookingDialogOpen(false);
      setToastMessage('Buchung überschrieben.');
    } catch (error) {
      setErrorMessage(getApiErrorMessage(error, 'Buchung überschreiben fehlgeschlagen.'));
    } finally {
      setIsOverrideSubmitting(false);
    }
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
        const result = await createSingleBooking();
        if (result !== 'created') {
          setErrorMessage('');
          return;
        }
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
        <span className="badge">Im Büro: {occupantsForDay.length}</span>
      </div>

      {selectedDesk && (
        <div className="filter-row">
          <span className="badge">Gefiltert: {selectedDesk.name}</span>
          <button className="btn btn-outline" onClick={() => setSelectedDeskId('')}>Alle anzeigen</button>
        </div>
      )}

      {selectedDesk ? (
        selectedDeskOccupant ? (
          <div className="occupant-card">
            <p className="muted">Belegt</p>
            <h4>{selectedDeskOccupant.name}</h4>
            <p className="muted">{selectedDeskOccupant.email}</p>
            <p><strong>Desk:</strong> {selectedDeskOccupant.deskLabel}</p>
          </div>
        ) : (
          <div className="empty-state stack-sm">
            <p>{selectedDesk.name} ist frei.</p>
            <div>
              <button
                className="btn"
                onClick={() => {
                  setSelectedDeskId(selectedDesk.id);
                  setBookingDialogOpen(true);
                }}
              >
                Buchung erstellen
              </button>
            </div>
          </div>
        )
      ) : occupantsForDay.length === 0 ? (
        <div className="empty-state">
          <p>Niemand im Büro an diesem Tag.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Desk</th>
              </tr>
            </thead>
            <tbody>
              {occupantsForDay.map((occupant) => (
                <tr
                  key={`${occupant.userId}-${occupant.deskId}`}
                  ref={(node) => { occupantRowRefs.current[occupant.deskId] = node; }}
                  className={`${hoveredDeskId === occupant.deskId || selectedDeskId === occupant.deskId ? 'row-active' : ''} ${highlightedDeskId === occupant.deskId ? 'row-highlighted' : ''}`}
                  tabIndex={0}
                  onMouseEnter={() => {
                    setHoveredDeskId(occupant.deskId);
                    triggerDeskHighlight(occupant.deskId, 900);
                  }}
                  onMouseLeave={() => setHoveredDeskId('')}
                  onFocus={() => setHoveredDeskId(occupant.deskId)}
                  onBlur={() => setHoveredDeskId('')}
                  onClick={() => {
                    setSelectedDeskId(occupant.deskId);
                    triggerDeskHighlight(occupant.deskId);
                  }}
                >
                  <td>
                    <div className="occupant-person-cell">
                      <Avatar displayName={occupant.name} email={occupant.email} photoUrl={occupant.photoUrl} size={24} />
                      <div>
                        <strong>{occupant.name}</strong>
                        <p className="muted">{occupant.email}</p>
                      </div>
                    </div>
                  </td>
                  <td>{occupant.deskLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
      <header className="app-header simplified-header">
        <div className="header-left">
          <h1>AVENCY Booking</h1>
          <select value={selectedFloorplanId} onChange={(event) => setSelectedFloorplanId(event.target.value)}>
            {floorplans.map((floorplan) => <option key={floorplan.id} value={floorplan.id}>{floorplan.name}</option>)}
          </select>
        </div>
        <div className="header-right">
          <UserMenu user={currentUser} onLogout={onLogout} onOpenAdmin={onOpenAdmin} showAdminAction={canOpenAdmin} />
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
                <button className="btn" onClick={() => setBookingDialogOpen(true)}>Buchung erstellen</button>
              </div>
            </div>
            <div className={`refresh-progress ${isUpdatingOccupancy ? "is-active" : ""}`} aria-hidden={!isUpdatingOccupancy}>
              <span className="refresh-progress-bar" />
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
                  onHoverDesk={(deskId) => { setHoveredDeskId(deskId); if (deskId) triggerDeskHighlight(deskId, 900); }}
                  selectedDate={selectedDate}
                  onSelectDesk={selectDeskFromCanvas}
                  onCanvasClick={() => { setSelectedDeskId(''); setHighlightedDeskId(''); }}
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

      {overrideDialog && createPortal(
        <div className="overlay" onClick={() => setOverrideDialog(null)}>
          <div className="dialog card stack-sm" onClick={(event) => event.stopPropagation()}>
            <h3>Buchung überschreiben?</h3>
            <p>Du hast am {new Date(`${overrideDialog.date}T00:00:00.000Z`).toLocaleDateString('de-DE')} bereits {overrideDialog.existingDeskName} gebucht. Wenn du fortfährst, wird diese Buchung durch {overrideDialog.nextDeskName} ersetzt.</p>
            <div className="inline-end">
              <button type="button" className="btn btn-outline" onClick={() => setOverrideDialog(null)} disabled={isOverrideSubmitting}>Abbrechen</button>
              <button type="button" className="btn btn-danger" onClick={() => void handleOverride()} disabled={isOverrideSubmitting}>{isOverrideSubmitting ? 'Überschreibe…' : 'Überschreiben'}</button>
            </div>
          </div>
        </div>,
        document.body
      )}


      <p className="api-base">API: {API_BASE}</p>
    </main>
  );
}
