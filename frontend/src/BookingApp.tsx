import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, checkBackendHealth, del, get, markBackendAvailable, post, resolveApiUrl } from './api';
import { Avatar } from './components/Avatar';
import { BookingForm } from './components/BookingForm';
import { UserMenu } from './components/UserMenu';
import { FloorplanCanvas } from './FloorplanCanvas';
import { APP_TITLE } from './config';
import type { AuthUser } from './auth/AuthProvider';

type Floorplan = { id: string; name: string; imageUrl: string };
type OccupancyDesk = {
  id: string;
  name: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { id?: string; employeeId?: string; userEmail: string; userDisplayName?: string; userPhotoUrl?: string; type?: 'single' | 'recurring' } | null;
  isCurrentUsersDesk?: boolean;
  isHighlighted?: boolean;
};
type OccupancyPerson = { email: string; displayName?: string; deskName?: string; deskId?: string };
type OccupancyResponse = { date: string; floorplanId: string; desks: OccupancyDesk[]; people: OccupancyPerson[] };
type BookingEmployee = { id: string; email: string; displayName: string; photoUrl?: string };
type OccupantForDay = { deskId: string; deskLabel: string; userId: string; name: string; email: string; employeeId?: string; photoUrl?: string };
type BookingSubmitPayload =
  | { type: 'single'; date: string }
  | { type: 'range'; dateFrom: string; dateTo: string; onlyWeekdays: boolean }
  | { type: 'recurring'; dateFrom: string; dateTo: string; weekdays: number[] };
type OverrideDialogState = {
  requestedDeskName: string;
  dates: string[];
  retryPayload: BookingSubmitPayload;
};
type BulkBookingResponse = {
  createdCount?: number;
  updatedCount?: number;
  skippedCount?: number;
  skippedDates?: string[];
};
type DeskPopupState = { deskId: string; anchorRect: DOMRect };

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

const getApiErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) {
    return error.message;
  }
  return fallback;
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

  const [deskPopup, setDeskPopup] = useState<DeskPopupState | null>(null);
  const [overrideDialog, setOverrideDialog] = useState<OverrideDialogState | null>(null);
  const [isOverrideSubmitting, setIsOverrideSubmitting] = useState(false);

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
      ? resolveApiUrl(`/user/me/photo?v=${encodeURIComponent(currentUserEmail)}`)
      : undefined;
    const employeePhotoUrl = resolveApiUrl(employee?.photoUrl);
    const bookingPhotoUrl = resolveApiUrl(desk.booking.userPhotoUrl);
    const bookingEmail = desk.booking.userEmail.toLowerCase();
    const isMineByEmail = Boolean(currentUserEmail && bookingEmail === currentUserEmail.toLowerCase());
    const isMineByEmployeeId = Boolean(currentUser?.id && desk.booking.employeeId && desk.booking.employeeId === currentUser.id);

    return {
      ...desk,
      booking: {
        ...desk.booking,
        employeeId: desk.booking.employeeId ?? employee?.id,
        userDisplayName: desk.booking.userDisplayName ?? employee?.displayName,
        userPhotoUrl: bookingPhotoUrl ?? employeePhotoUrl ?? fallbackPhotoUrl
      },
      isCurrentUsersDesk: isMineByEmail || isMineByEmployeeId
    };
  }), [occupancy?.desks, employeesByEmail, employeesById, currentUserEmail, currentUser?.id]);
  const filteredDesks = useMemo(() => (onlyFree ? desks.filter((desk) => desk.status === 'free') : desks).map((desk) => ({ ...desk, isHighlighted: desk.id === highlightedDeskId })), [desks, onlyFree, highlightedDeskId]);
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
  const popupDesk = useMemo(() => (deskPopup ? desks.find((desk) => desk.id === deskPopup.deskId) ?? null : null), [desks, deskPopup]);
  const popupDeskState = popupDesk ? (!popupDesk.booking ? 'FREE' : popupDesk.isCurrentUsersDesk ? 'MINE' : 'TAKEN') : null;
  const deskPopupPosition = useMemo(() => {
    if (!deskPopup) return null;
    const viewportPadding = 12;
    const popupWidth = 460;
    const popupHeight = 500;
    const preferRight = deskPopup.anchorRect.right + 10;
    const preferLeft = deskPopup.anchorRect.left - popupWidth - 10;
    const canUseRight = preferRight + popupWidth <= window.innerWidth - viewportPadding;
    const left = canUseRight
      ? preferRight
      : Math.max(viewportPadding, Math.min(window.innerWidth - popupWidth - viewportPadding, preferLeft));
    const centeredTop = deskPopup.anchorRect.top + deskPopup.anchorRect.height / 2 - popupHeight / 2;
    const top = Math.max(viewportPadding, Math.min(window.innerHeight - popupHeight - viewportPadding, centeredTop));
    return { left, top };
  }, [deskPopup]);

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
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!deskPopup) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDeskPopup(null);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [deskPopup]);

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

  const selectDeskFromCanvas = (deskId: string, pinRect?: DOMRect) => {
    const desk = desks.find((entry) => entry.id === deskId);
    if (!desk) return;
    const state = !desk.booking ? 'FREE' : desk.isCurrentUsersDesk ? 'MINE' : 'TAKEN';
    if (state === 'TAKEN' || !pinRect) {
      return;
    }

    setSelectedDeskId(deskId);
    triggerDeskHighlight(deskId);
    setDeskPopup({ deskId, anchorRect: pinRect });
    const row = occupantRowRefs.current[deskId];
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  const reloadBookings = async () => {
    await loadOccupancy(selectedFloorplanId, selectedDate);
  };

  const createSingleBooking = async (deskId: string, date: string, replaceExisting: boolean) => {
    await post('/bookings', { deskId, userEmail: selectedEmployeeEmail, date, replaceExisting });
    setToastMessage('Einzelbuchung erstellt.');
  };

  const cancelOwnBooking = async (deskId: string) => {
    const bookingId = desks.find((desk) => desk.id === deskId)?.booking?.id;
    if (!bookingId) {
      throw new Error('Eigene Buchung konnte nicht gefunden werden.');
    }

    await del(`/bookings/${bookingId}`);
    setToastMessage('Buchung storniert.');
  };

  const submitPopupBooking = async (payload: BookingSubmitPayload, overrideExisting = false) => {
    if (!popupDesk || !popupDeskState) return;
    try {
      if (!selectedEmployeeEmail) {
        throw new Error('Bitte Mitarbeiter auswählen.');
      }

      if (popupDeskState !== 'FREE') {
        return;
      }

      if (payload.type === 'single') {
        await createSingleBooking(popupDesk.id, payload.date, overrideExisting);
      } else if (payload.type === 'range') {
        const response = await post<BulkBookingResponse>('/bookings/range', {
          deskId: popupDesk.id,
          userEmail: selectedEmployeeEmail,
          from: payload.dateFrom,
          to: payload.dateTo,
          weekdaysOnly: payload.onlyWeekdays,
          overrideExisting
        });

        if (!overrideExisting && (response.skippedCount ?? 0) > 0) {
          setOverrideDialog({
            requestedDeskName: popupDesk.name,
            dates: response.skippedDates ?? [],
            retryPayload: payload
          });
          setErrorMessage('');
          return;
        }

        setToastMessage(
          overrideExisting
            ? `${response.createdCount ?? 0} Tage gebucht, ${response.updatedCount ?? 0} Tage umgebucht.`
            : `${response.createdCount ?? 0} Tage gebucht, ${response.skippedCount ?? 0} Tage übersprungen.`
        );
      } else {
        const response = await post<BulkBookingResponse>('/recurring-bookings/bulk', {
          deskId: popupDesk.id,
          userEmail: selectedEmployeeEmail,
          weekdays: payload.weekdays,
          validFrom: payload.dateFrom,
          validTo: payload.dateTo,
          overrideExisting
        });

        if (!overrideExisting && (response.skippedCount ?? 0) > 0) {
          setOverrideDialog({
            requestedDeskName: popupDesk.name,
            dates: response.skippedDates ?? [],
            retryPayload: payload
          });
          setErrorMessage('');
          return;
        }

        setToastMessage(
          overrideExisting
            ? `${response.createdCount ?? 0} Tage gebucht, ${response.updatedCount ?? 0} Tage umgebucht.`
            : `${response.createdCount ?? 0} Tage gebucht, ${response.skippedCount ?? 0} Tage übersprungen.`
        );
      }

      setErrorMessage('');
      setDeskPopup(null);
      await reloadBookings();
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

  const handleOverride = async () => {
    if (!overrideDialog) return;

    setIsOverrideSubmitting(true);
    try {
      await submitPopupBooking(overrideDialog.retryPayload, true);
      setOverrideDialog(null);
      setSelectedDeskId(popupDesk?.id ?? '');
    } catch (error) {
      setErrorMessage(getApiErrorMessage(error, 'Buchung überschreiben fehlgeschlagen.'));
    } finally {
      setIsOverrideSubmitting(false);
    }
  };

  const submitPopupCancel = async () => {
    if (!popupDesk || !popupDeskState || popupDeskState !== 'MINE') return;
    if (popupDesk.booking?.type === 'recurring') {
      setErrorMessage('Serienbuchungen können aktuell nur im Admin-Modus storniert werden.');
      return;
    }

    try {
      await cancelOwnBooking(popupDesk.id);
      setErrorMessage('');
      setDeskPopup(null);
      await reloadBookings();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Stornierung fehlgeschlagen.');
    }
  };

  const selectDay = (day: Date) => {
    const key = toDateKey(day);
    setSelectedDate(key);
    setVisibleMonth(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
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
        <h3 className="section-title">Legende</h3>
        <label className="toggle">
          <input type="checkbox" checked={onlyFree} onChange={(event) => setOnlyFree(event.target.checked)} />
          <span>Nur freie Plätze anzeigen</span>
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

      {occupantsForDay.length === 0 ? (
        <div className="empty-state">
          <p>Niemand im Büro an diesem Tag.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Tisch</th>
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
                  <td>Tisch: {occupant.deskLabel}</td>
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
          <h1>{APP_TITLE}</h1>
          <select value={selectedFloorplanId} onChange={(event) => setSelectedFloorplanId(event.target.value)}>
            {floorplans.map((floorplan) => <option key={floorplan.id} value={floorplan.id}>{floorplan.name}</option>)}
          </select>
        </div>
        <div className="header-right">
          <UserMenu user={currentUser} onLogout={onLogout} onOpenAdmin={onOpenAdmin} showAdminAction={canOpenAdmin} />
        </div>
      </header>

      {errorMessage && <div className="toast toast-error">{errorMessage} <button className="btn btn-ghost" onClick={reloadBookings}>Retry</button></div>}
      {toastMessage && <div className="toast toast-success">{toastMessage}</div>}

      <section className="layout-grid">
        <aside className="left-col desktop-only">{isBootstrapping ? <div className="card skeleton h-480" /> : sidebar}</aside>
        <section className="center-col">
          <article className="card canvas-card">
            <div className="card-header-row">
              <h2>{selectedFloorplan?.name ?? 'Floorplan'}</h2>
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
                  onCanvasClick={() => { setSelectedDeskId(''); setHighlightedDeskId(''); setDeskPopup(null); }}
                />
              ) : (
                <div className="empty-state"><p>Kein Floorplan ausgewählt.</p></div>
              )}
            </div>
          </article>
        </section>

        <aside className="right-col desktop-right">{isBootstrapping ? <div className="card skeleton h-480" /> : detailPanel}</aside>
      </section>

      {deskPopup && popupDesk && popupDeskState && deskPopupPosition && createPortal(
        <>
          <div className="desk-popup-backdrop" onClick={() => setDeskPopup(null)} />
          <section className="card desk-popup" style={{ left: deskPopupPosition.left, top: deskPopupPosition.top }} role="dialog" aria-modal="true">
            {popupDeskState === 'FREE' ? (
              <>
                <h3>Tisch: {popupDesk.name} buchen</h3>
                <BookingForm
                  selectedDate={selectedDate}
                  onCancel={() => setDeskPopup(null)}
                  onSubmit={async (payload) => {
                    await submitPopupBooking(payload);
                  }}
                />
              </>
            ) : (
              <>
                <h3>Tisch: {popupDesk.name}</h3>
                <div className="stack-sm">
                  <p className="muted">Datum: {new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</p>
                  <p className="muted">Zeitraum: Ganztägig</p>
                  {popupDesk.booking?.type === 'recurring' && <p className="muted">Typ: Serienbuchung (wöchentlich)</p>}
                  <div className="inline-end">
                    <button type="button" className="btn btn-outline" onClick={() => setDeskPopup(null)}>Abbrechen</button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => void submitPopupCancel()}
                      disabled={popupDesk.booking?.type === 'recurring'}
                    >
                      Buchung stornieren
                    </button>
                  </div>
                  {popupDesk.booking?.type === 'recurring' && <p className="muted">Serienbuchungen können derzeit nur im Admin-Modus storniert werden.</p>}
                </div>
              </>
            )}
          </section>
        </>,
        document.body
      )}

      {overrideDialog && createPortal(
        <div className="overlay" onClick={() => setOverrideDialog(null)}>
          <div className="dialog card stack-sm" onClick={(event) => event.stopPropagation()}>
            <h3>Buchungen überschreiben?</h3>
            <p>
              Für {overrideDialog.dates.length} Tage existieren bereits Buchungen. Soll auf Tisch: {overrideDialog.requestedDeskName} umgebucht werden?
            </p>
            {overrideDialog.dates.length > 0 && (
              <p className="muted">Betroffene Tage: {overrideDialog.dates.slice(0, 6).join(', ')}{overrideDialog.dates.length > 6 ? ' …' : ''}</p>
            )}
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
