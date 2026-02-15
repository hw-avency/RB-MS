import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, checkBackendHealth, del, get, markBackendAvailable, post, resolveApiUrl } from './api';
import { Avatar } from './components/Avatar';
import { BookingForm, createDefaultBookingFormValues } from './components/BookingForm';
import type { BookingFormSubmitPayload, BookingFormValues } from './components/BookingForm';
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
type BookingSubmitPayload = BookingFormSubmitPayload;
type BookingDialogState = 'IDLE' | 'BOOKING_OPEN' | 'CONFLICT_REVIEW' | 'SUBMITTING';
type ConflictReviewState = {
  deskId: string;
  deskLabel: string;
  conflictDates: string[];
  retryPayload: BookingSubmitPayload;
  anchorEl: HTMLElement;
};
type BulkBookingResponse = {
  createdCount?: number;
  updatedCount?: number;
  skippedCount?: number;
  skippedDates?: string[];
};
type DeskPopupState = { deskId: string; anchorEl: HTMLElement };
type OccupancyBooking = NonNullable<OccupancyDesk['booking']>;
type PopupPlacement = 'top' | 'right' | 'bottom' | 'left';
type PopupCoordinates = { left: number; top: number; placement: PopupPlacement };

const POPUP_OFFSET = 12;
const POPUP_PADDING = 8;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const getCandidatePosition = (placement: PopupPlacement, anchorRect: DOMRect, popupWidth: number, popupHeight: number): { left: number; top: number } => {
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;

  if (placement === 'right') {
    return { left: anchorRect.right + POPUP_OFFSET, top: anchorCenterY - popupHeight / 2 };
  }
  if (placement === 'left') {
    return { left: anchorRect.left - popupWidth - POPUP_OFFSET, top: anchorCenterY - popupHeight / 2 };
  }
  if (placement === 'top') {
    return { left: anchorCenterX - popupWidth / 2, top: anchorRect.top - popupHeight - POPUP_OFFSET };
  }

  return { left: anchorCenterX - popupWidth / 2, top: anchorRect.bottom + POPUP_OFFSET };
};

const calculatePopupCoordinates = (anchorRect: DOMRect, popupRect: DOMRect): PopupCoordinates => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const spaces = {
    right: viewportWidth - anchorRect.right,
    left: anchorRect.left,
    bottom: viewportHeight - anchorRect.bottom,
    top: anchorRect.top,
  };

  const placements = (Object.keys(spaces) as PopupPlacement[]).sort((a, b) => spaces[b] - spaces[a]);
  const minLeft = POPUP_PADDING;
  const maxLeft = Math.max(POPUP_PADDING, viewportWidth - popupRect.width - POPUP_PADDING);
  const minTop = POPUP_PADDING;
  const maxTop = Math.max(POPUP_PADDING, viewportHeight - popupRect.height - POPUP_PADDING);

  for (const placement of placements) {
    const candidate = getCandidatePosition(placement, anchorRect, popupRect.width, popupRect.height);
    const overflowLeft = Math.max(0, minLeft - candidate.left);
    const overflowRight = Math.max(0, candidate.left + popupRect.width - (viewportWidth - POPUP_PADDING));
    const overflowTop = Math.max(0, minTop - candidate.top);
    const overflowBottom = Math.max(0, candidate.top + popupRect.height - (viewportHeight - POPUP_PADDING));
    const overflow = overflowLeft + overflowRight + overflowTop + overflowBottom;

    if (overflow <= 0.5) {
      return {
        left: clamp(candidate.left, minLeft, maxLeft),
        top: clamp(candidate.top, minTop, maxTop),
        placement,
      };
    }
  }

  const fallback = getCandidatePosition(placements[0] ?? 'right', anchorRect, popupRect.width, popupRect.height);
  return {
    left: clamp(fallback.left, minLeft, maxLeft),
    top: clamp(fallback.top, minTop, maxTop),
    placement: placements[0] ?? 'right',
  };
};

const toLocalDateKey = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const today = toLocalDateKey(new Date());
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

const formatDate = (dateString: string): string => new Date(`${dateString}T00:00:00.000Z`).toLocaleDateString('de-DE');

const mapBookingsForDay = (desks: OccupancyDesk[]): OccupantForDay[] => desks
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
  .sort((a, b) => a.name.localeCompare(b.name, 'de'));

const enrichDeskBookings = ({
  desks,
  employeesById,
  employeesByEmail,
  currentUserEmail,
  currentUserId
}: {
  desks: OccupancyDesk[];
  employeesById: Map<string, BookingEmployee>;
  employeesByEmail: Map<string, BookingEmployee>;
  currentUserEmail?: string;
  currentUserId?: string;
}): OccupancyDesk[] => desks.map((desk) => {
  if (!desk.booking) return desk;

  const booking: OccupancyBooking = desk.booking;
  const employee = booking.employeeId ? employeesById.get(booking.employeeId) : employeesByEmail.get(booking.userEmail.toLowerCase());
  const fallbackPhotoUrl = currentUserEmail && booking.userEmail.toLowerCase() === currentUserEmail.toLowerCase()
    ? resolveApiUrl(`/user/me/photo?v=${encodeURIComponent(currentUserEmail)}`)
    : undefined;
  const employeePhotoUrl = resolveApiUrl(employee?.photoUrl);
  const bookingPhotoUrl = resolveApiUrl(booking.userPhotoUrl);
  const bookingEmail = booking.userEmail.toLowerCase();
  const isMineByEmail = Boolean(currentUserEmail && bookingEmail === currentUserEmail.toLowerCase());
  const isMineByEmployeeId = Boolean(currentUserId && booking.employeeId && booking.employeeId === currentUserId);

  return {
    ...desk,
    booking: {
      ...booking,
      employeeId: booking.employeeId ?? employee?.id,
      userDisplayName: booking.userDisplayName ?? employee?.displayName,
      userPhotoUrl: bookingPhotoUrl ?? employeePhotoUrl ?? fallbackPhotoUrl
    },
    isCurrentUsersDesk: isMineByEmail || isMineByEmployeeId
  };
});

export function BookingApp({ onOpenAdmin, canOpenAdmin, currentUserEmail, onLogout, currentUser }: { onOpenAdmin: () => void; canOpenAdmin: boolean; currentUserEmail?: string; onLogout: () => Promise<void>; currentUser: AuthUser }) {
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(today));
  const [onlyFree, setOnlyFree] = useState(false);

  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [todayOccupancy, setTodayOccupancy] = useState<OccupancyResponse | null>(null);
  const [employees, setEmployees] = useState<BookingEmployee[]>([]);
  const [selectedEmployeeEmail, setSelectedEmployeeEmail] = useState('');

  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');
  const [floorplanZoom, setFloorplanZoom] = useState(1);

  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isUpdatingOccupancy, setIsUpdatingOccupancy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const [backendDown, setBackendDown] = useState(false);

  const [deskPopup, setDeskPopup] = useState<DeskPopupState | null>(null);
  const [bookingDialogState, setBookingDialogState] = useState<BookingDialogState>('IDLE');
  const [bookingFormValues, setBookingFormValues] = useState<BookingFormValues>(createDefaultBookingFormValues(today));
  const [dialogErrorMessage, setDialogErrorMessage] = useState('');
  const [conflictReview, setConflictReview] = useState<ConflictReviewState | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  const [highlightedDeskId, setHighlightedDeskId] = useState('');
  const [deskPopupCoords, setDeskPopupCoords] = useState<PopupCoordinates | null>(null);
  const occupantRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const highlightTimerRef = useRef<number | null>(null);
  const popupRef = useRef<HTMLElement | null>(null);

  const selectedFloorplan = useMemo(() => floorplans.find((f) => f.id === selectedFloorplanId) ?? null, [floorplans, selectedFloorplanId]);
  const employeesByEmail = useMemo(() => new Map(employees.map((employee) => [employee.email.toLowerCase(), employee])), [employees]);
  const employeesById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const desks = useMemo(() => enrichDeskBookings({
    desks: occupancy?.desks ?? [],
    employeesById,
    employeesByEmail,
    currentUserEmail,
    currentUserId: currentUser?.id
  }), [occupancy?.desks, employeesByEmail, employeesById, currentUserEmail, currentUser?.id]);
  const desksToday = useMemo(() => enrichDeskBookings({
    desks: todayOccupancy?.desks ?? [],
    employeesById,
    employeesByEmail,
    currentUserEmail,
    currentUserId: currentUser?.id
  }), [todayOccupancy?.desks, employeesByEmail, employeesById, currentUserEmail, currentUser?.id]);
  const filteredDesks = useMemo(() => (onlyFree ? desks.filter((desk) => desk.status === 'free') : desks).map((desk) => ({ ...desk, isHighlighted: desk.id === highlightedDeskId })), [desks, onlyFree, highlightedDeskId]);
  const bookingsForSelectedDate = useMemo<OccupantForDay[]>(() => mapBookingsForDay(desks), [desks]);
  const bookingsForToday = useMemo<OccupantForDay[]>(() => mapBookingsForDay(desksToday), [desksToday]);
  const visibleTodayAvatars = useMemo(() => bookingsForToday.slice(0, 5), [bookingsForToday]);
  const hiddenTodayCount = Math.max(0, bookingsForToday.length - visibleTodayAvatars.length);
  const activeDialogDeskRef = bookingDialogState === 'CONFLICT_REVIEW' ? conflictReview : deskPopup;
  const popupDesk = useMemo(() => (activeDialogDeskRef ? desks.find((desk) => desk.id === activeDialogDeskRef.deskId) ?? null : null), [desks, activeDialogDeskRef]);
  const popupDeskState = popupDesk ? (!popupDesk.booking ? 'FREE' : popupDesk.isCurrentUsersDesk ? 'MINE' : 'TAKEN') : null;
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);

  const loadOccupancy = async (floorplanId: string, date: string) => {
    if (!floorplanId) return;

    setIsUpdatingOccupancy(true);
    setErrorMessage('');

    try {
      const [nextOccupancy, nextTodayOccupancy] = await Promise.all([
        get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`),
        get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${today}`)
      ]);

      setOccupancy(nextOccupancy);
      setTodayOccupancy(nextTodayOccupancy);
      markBackendAvailable(true);
      setBackendDown(false);
      setSelectedDeskId((prev) => (nextOccupancy.desks.some((desk) => desk.id === prev) ? prev : ''));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
      }
      setErrorMessage(getApiErrorMessage(error, 'Belegung konnte nicht geladen werden.'));
      setTodayOccupancy(null);
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

  useLayoutEffect(() => {
    if (!activeDialogDeskRef || !popupRef.current) {
      setDeskPopupCoords(null);
      return;
    }

    const anchorRect = activeDialogDeskRef.anchorEl.getBoundingClientRect();
    const popupRect = popupRef.current.getBoundingClientRect();
    setDeskPopupCoords(calculatePopupCoordinates(anchorRect, popupRect));
  }, [activeDialogDeskRef, bookingDialogState, popupDeskState, dialogErrorMessage]);

  useEffect(() => {
    if (!activeDialogDeskRef) return;

    const closePopup = () => {
      setDeskPopup(null);
      setConflictReview(null);
      setBookingDialogState('IDLE');
      setDeskPopupCoords(null);
      setDialogErrorMessage('');
      setCancelConfirmOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePopup();
      }
    };

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target)) return;
      if (activeDialogDeskRef.anchorEl.contains(target)) return;
      closePopup();
    };

    const closeOnViewportChange = () => closePopup();

    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('mousedown', closeOnOutsideClick, true);
    window.addEventListener('scroll', closeOnViewportChange, true);
    window.addEventListener('wheel', closeOnViewportChange, { passive: true });
    window.addEventListener('resize', closeOnViewportChange);

    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('mousedown', closeOnOutsideClick, true);
      window.removeEventListener('scroll', closeOnViewportChange, true);
      window.removeEventListener('wheel', closeOnViewportChange);
      window.removeEventListener('resize', closeOnViewportChange);
    };
  }, [activeDialogDeskRef]);

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

  const selectDeskFromCanvas = (deskId: string, anchorEl?: HTMLElement) => {
    const desk = desks.find((entry) => entry.id === deskId);
    if (!desk || !anchorEl) return;

    const state = !desk.booking ? 'FREE' : desk.isCurrentUsersDesk ? 'MINE' : 'TAKEN';
    if (state === 'TAKEN') {
      return;
    }

    if (deskPopup?.deskId === deskId && bookingDialogState !== 'CONFLICT_REVIEW') {
      closeBookingFlow();
      return;
    }

    setSelectedDeskId(deskId);
    triggerDeskHighlight(deskId);
    setDeskPopup({ deskId, anchorEl });
    setConflictReview(null);
    setCancelConfirmOpen(false);
    setDialogErrorMessage('');
    if (state === 'FREE') {
      setBookingFormValues(createDefaultBookingFormValues(selectedDate));
      setBookingDialogState('BOOKING_OPEN');
    } else {
      setBookingDialogState('IDLE');
    }

    const row = occupantRowRefs.current[deskId];
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  const reloadBookings = async () => {
    await loadOccupancy(selectedFloorplanId, selectedDate);
  };

  const closeBookingFlow = () => {
    setDeskPopup(null);
    setConflictReview(null);
    setBookingDialogState('IDLE');
    setDialogErrorMessage('');
    setDeskPopupCoords(null);
    setCancelConfirmOpen(false);
  };

  const submitPopupBooking = async (deskId: string, payload: BookingSubmitPayload, overwrite = false) => {
    if (!selectedEmployeeEmail) {
      throw new Error('Bitte Mitarbeiter auswählen.');
    }

    if (payload.type === 'single') {
      await post('/bookings', { deskId, userEmail: selectedEmployeeEmail, date: payload.date, replaceExisting: overwrite });
      setToastMessage(overwrite ? 'Umbuchung durchgeführt.' : 'Gebucht');
      return;
    }

    if (payload.type === 'range') {
      const response = await post<BulkBookingResponse>('/bookings/range', {
        deskId,
        userEmail: selectedEmployeeEmail,
        from: payload.dateFrom,
        to: payload.dateTo,
        weekdaysOnly: payload.onlyWeekdays,
        overrideExisting: overwrite
      });

      setToastMessage(overwrite
        ? `${response.createdCount ?? 0} Tage gebucht, ${response.updatedCount ?? 0} Tage umgebucht.`
        : 'Gebucht');
      return;
    }

    const response = await post<BulkBookingResponse>('/recurring-bookings/bulk', {
      deskId,
      userEmail: selectedEmployeeEmail,
      weekdays: payload.weekdays,
      validFrom: payload.dateFrom,
      validTo: payload.dateTo,
      overrideExisting: overwrite
    });

    setToastMessage(overwrite
      ? `${response.createdCount ?? 0} Tage gebucht, ${response.updatedCount ?? 0} Tage umgebucht.`
      : 'Gebucht');
  };

  const checkConflicts = async (deskId: string, payload: BookingSubmitPayload) => {
    const start = payload.type === 'single' ? payload.date : payload.dateFrom;
    const end = payload.type === 'single' ? payload.date : payload.dateTo;
    const weekdaysForType = payload.type === 'recurring' ? payload.weekdays : undefined;

    return post<{ hasConflicts: boolean; conflictDates: string[] }>('/bookings/check-conflicts', {
      deskId,
      userEmail: selectedEmployeeEmail,
      userId: currentUser?.id,
      start,
      end,
      weekdays: weekdaysForType,
      type: payload.type
    });
  };

  const handleBookingSubmit = async (payload: BookingSubmitPayload) => {
    if (!deskPopup || !popupDesk || popupDeskState !== 'FREE') return;

    setDialogErrorMessage('');
    setBookingDialogState('SUBMITTING');

    try {
      const conflictResult = await checkConflicts(popupDesk.id, payload);
      if (conflictResult.hasConflicts) {
        setConflictReview({
          deskId: popupDesk.id,
          deskLabel: popupDesk.name,
          conflictDates: conflictResult.conflictDates,
          retryPayload: payload,
          anchorEl: deskPopup.anchorEl
        });
        setBookingDialogState('CONFLICT_REVIEW');
        return;
      }

      await submitPopupBooking(popupDesk.id, payload, false);
      closeBookingFlow();
      await reloadBookings();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
        return;
      }

      setBookingDialogState('BOOKING_OPEN');
      setDialogErrorMessage(error instanceof Error ? error.message : 'Buchung fehlgeschlagen.');
    }
  };

  const confirmConflictOverride = async () => {
    if (!conflictReview) return;

    setBookingDialogState('SUBMITTING');
    setDialogErrorMessage('');

    try {
      await submitPopupBooking(conflictReview.deskId, conflictReview.retryPayload, true);
      closeBookingFlow();
      await reloadBookings();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
        return;
      }

      setBookingDialogState('CONFLICT_REVIEW');
      setDialogErrorMessage(getApiErrorMessage(error, 'Buchung überschreiben fehlgeschlagen.'));
    }
  };

  const submitPopupCancel = async () => {
    if (!popupDesk || !popupDeskState || popupDeskState !== 'MINE') return;
    if (popupDesk.booking?.type === 'recurring') {
      setErrorMessage('Serienbuchungen können aktuell nur im Admin-Modus storniert werden.');
      return;
    }

    try {
      const bookingId = desks.find((desk) => desk.id === popupDesk.id)?.booking?.id;
      if (!bookingId) {
        throw new Error('Eigene Buchung konnte nicht gefunden werden.');
      }

      await del(`/bookings/${bookingId}`);
      setToastMessage('Buchung storniert.');
      setErrorMessage('');
      closeBookingFlow();
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
      <section className="card compact-card">
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

      <section className="card compact-card stack-sm">
        <h3 className="section-title">Filter &amp; Legende</h3>
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

  const renderOccupancyList = (items: OccupantForDay[], sectionKey: 'today' | 'selected', title: string, emptyText: string) => {
    if (items.length === 0) {
      return (
        <div className="empty-state compact-empty-state">
          <p>{emptyText}</p>
        </div>
      );
    }

    return (
      <div className="occupancy-list" role="list" aria-label={title}>
        {items.map((occupant) => (
          <div
            key={`${sectionKey}-${occupant.userId}-${occupant.deskId}`}
            ref={sectionKey === 'selected' ? (node) => { occupantRowRefs.current[occupant.deskId] = node; } : undefined}
            role="listitem"
            className={`occupant-compact-card ${(hoveredDeskId === occupant.deskId || selectedDeskId === occupant.deskId) ? 'is-active' : ''} ${highlightedDeskId === occupant.deskId ? 'is-highlighted' : ''}`}
            onMouseEnter={() => {
              setHoveredDeskId(occupant.deskId);
              setHighlightedDeskId(occupant.deskId);
            }}
            onMouseLeave={() => {
              setHoveredDeskId('');
              setHighlightedDeskId('');
            }}
          >
            <div className="occupant-card-main">
              <Avatar displayName={occupant.name} email={occupant.email} photoUrl={occupant.photoUrl} size={26} />
              <div className="occupant-card-text">
                <strong>{occupant.name}</strong>
                <p className="muted">{occupant.email}</p>
              </div>
            </div>
            {occupant.deskLabel && <span className="occupant-desk-label">{occupant.deskLabel}</span>}
          </div>
        ))}
      </div>
    );
  };

  const todayPanel = (
    <section className="card compact-card today-compact-panel">
      <button
        type="button"
        className="today-summary-btn"
        onClick={() => {
          setSelectedDate(today);
          setVisibleMonth(startOfMonth(today));
        }}
      >
        <div>
          <strong>Heute im Büro</strong>
          <p className="muted">{bookingsForToday.length} anwesend</p>
        </div>
        <div className="today-avatar-row" aria-label="Anwesende heute">
          {visibleTodayAvatars.map((person) => (
            <Avatar key={`today-${person.userId}-${person.deskId}`} displayName={person.name} email={person.email} photoUrl={person.photoUrl} size={28} />
          ))}
          {hiddenTodayCount > 0 && <span className="avatar-overflow">+{hiddenTodayCount}</span>}
        </div>
      </button>
    </section>
  );

  const detailPanel = (
    <div className="stack">
      <section className="card compact-card stack-sm details-panel">
        <div className="stack-sm">
          <h3>Anwesend am {formatDate(selectedDate)}</h3>
          {renderOccupancyList(bookingsForSelectedDate, 'selected', 'Anwesenheit am ausgewählten Datum', 'Noch keine Anwesenheiten')}
        </div>
      </section>
    </div>
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
      <header className="app-header simplified-header compact-topbar">
        <div className="header-left">
          <span className="brand-mark" aria-hidden="true">A</span>
          <h1>{APP_TITLE}</h1>
          <label className="field-inline">
            <span>Standort</span>
            <select value={selectedFloorplanId} onChange={(event) => setSelectedFloorplanId(event.target.value)}>
            {floorplans.map((floorplan) => <option key={floorplan.id} value={floorplan.id}>{floorplan.name}</option>)}
            </select>
          </label>
        </div>
        <div className="header-right">
          <UserMenu user={currentUser} onLogout={onLogout} onOpenAdmin={onOpenAdmin} showAdminAction={canOpenAdmin} />
        </div>
      </header>

      {errorMessage && <div className="inline-alert">{errorMessage} <button className="btn btn-ghost" onClick={reloadBookings}>Retry</button></div>}
      {toastMessage && <div className="toast toast-success">{toastMessage}</div>}

      {isBootstrapping ? <div className="card skeleton h-120" /> : todayPanel}

      <section className="layout-grid">
        <aside className="left-col desktop-only">{isBootstrapping ? <div className="card skeleton h-480" /> : sidebar}</aside>
        <section className="center-col">
          <article className="card canvas-card">
            <div className="card-header-row">
              <div>
                <h2>{selectedFloorplan?.name ?? 'Floorplan'} · {formatDate(selectedDate)}</h2>
                <p className="muted">Klicke auf einen Platz zum Buchen</p>
              </div>
              <div className="toolbar">
                <button className="btn btn-ghost" type="button" onClick={() => setFloorplanZoom((prev) => Math.max(0.8, Number((prev - 0.1).toFixed(2))))}>−</button>
                <button className="btn btn-ghost" type="button" onClick={() => setFloorplanZoom(1)}>Reset</button>
                <button className="btn btn-ghost" type="button" onClick={() => setFloorplanZoom((prev) => Math.min(1.8, Number((prev + 0.1).toFixed(2))))}>＋</button>
              </div>
            </div>
            <div className={`refresh-progress ${isUpdatingOccupancy ? "is-active" : ""}`} aria-hidden={!isUpdatingOccupancy}>
              <span className="refresh-progress-bar" />
            </div>
            <div className="canvas-body canvas-body-focus" style={{ ['--floorplan-zoom' as string]: floorplanZoom }}>
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
                  onCanvasClick={() => { setSelectedDeskId(''); setHighlightedDeskId(''); closeBookingFlow(); }}
                />
              ) : (
                <div className="empty-state"><p>Kein Floorplan ausgewählt.</p></div>
              )}
            </div>
          </article>
        </section>

        <aside className="right-col desktop-right">{isBootstrapping ? <div className="card skeleton h-480" /> : detailPanel}</aside>
      </section>

      {activeDialogDeskRef && popupDesk && popupDeskState && createPortal(
        <section
          ref={popupRef}
          className="card desk-popup"
          style={{ left: deskPopupCoords?.left ?? POPUP_PADDING, top: deskPopupCoords?.top ?? POPUP_PADDING, visibility: deskPopupCoords ? 'visible' : 'hidden' }}
          role="menu"
          data-placement={deskPopupCoords?.placement ?? 'right'}
        >
            {(popupDeskState === 'FREE' && (!conflictReview || bookingDialogState === 'BOOKING_OPEN' || (bookingDialogState === 'SUBMITTING' && !conflictReview))) ? (
              <>
                <div className="desk-popup-header">
                  <div className="stack-xxs">
                    <h3>Tisch: {popupDesk.name}</h3>
                    <p className="muted">Buchung anlegen</p>
                  </div>
                  <button type="button" className="btn btn-ghost desk-popup-close" aria-label="Popover schließen" onClick={closeBookingFlow}>✕</button>
                </div>
                <hr className="separator" />
                <BookingForm
                  values={bookingFormValues}
                  onChange={setBookingFormValues}
                  onCancel={closeBookingFlow}
                  onSubmit={handleBookingSubmit}
                  isSubmitting={bookingDialogState === 'SUBMITTING'}
                  disabled={bookingDialogState === 'SUBMITTING'}
                  errorMessage={dialogErrorMessage}
                />
              </>
            ) : popupDeskState === 'FREE' && conflictReview ? (
              <>
                <h3>Konflikt: bestehende Buchungen</h3>
                <p>
                  Für {conflictReview.conflictDates.length} Tage existieren bereits Buchungen. Möchtest du diese auf Tisch {conflictReview.deskLabel} umbuchen?
                </p>
                {dialogErrorMessage && <div className="error-banner" role="alert">{dialogErrorMessage}</div>}
                <div className="stack-xs" style={{ maxHeight: 200, overflowY: 'auto' }}>
                  <div className="weekday-toggle-group" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                    {conflictReview.conflictDates.slice(0, 10).map((date) => (
                      <span key={date} className="weekday-toggle active" style={{ cursor: 'default' }}>{formatDate(date)}</span>
                    ))}
                  </div>
                  {conflictReview.conflictDates.length > 10 && <p className="muted">+{conflictReview.conflictDates.length - 10} weitere</p>}
                  <hr className="separator" />
                  <div className="stack-xs">
                    {conflictReview.conflictDates.map((date) => <p key={`line-${date}`} className="muted">{formatDate(date)}</p>)}
                  </div>
                </div>
                <div className="inline-end">
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => {
                      setBookingDialogState('BOOKING_OPEN');
                      setDialogErrorMessage('');
                    }}
                    disabled={bookingDialogState === 'SUBMITTING'}
                  >
                    Abbrechen
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => void confirmConflictOverride()} disabled={bookingDialogState === 'SUBMITTING'}>
                    {bookingDialogState === 'SUBMITTING' ? 'Umbuchen…' : 'Umbuchen & buchen'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Tisch: {popupDesk.name}</h3>
                <div className="stack-sm">
                  <p className="muted">Datum: {new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</p>
                  <p className="muted">Zeitraum: Ganztägig</p>
                  {popupDesk.booking?.type === 'recurring' && <p className="muted">Typ: Serienbuchung (wöchentlich)</p>}
                  <div className="inline-end">
                    <button type="button" className="btn btn-outline" onClick={closeBookingFlow}>Abbrechen</button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => setCancelConfirmOpen(true)}
                      disabled={popupDesk.booking?.type === 'recurring'}
                    >
                      Buchung stornieren
                    </button>
                  </div>
                  {cancelConfirmOpen && (
                    <div className="stack-xs desk-popup-confirm">
                      <p className="muted">Möchtest du die Buchung für diesen Tisch wirklich stornieren?</p>
                      <div className="inline-end">
                        <button type="button" className="btn btn-outline" onClick={() => setCancelConfirmOpen(false)}>Abbrechen</button>
                        <button type="button" className="btn btn-danger" onClick={() => void submitPopupCancel()}>Stornierung bestätigen</button>
                      </div>
                    </div>
                  )}
                  {popupDesk.booking?.type === 'recurring' && <p className="muted">Serienbuchungen können derzeit nur im Admin-Modus storniert werden.</p>}
                </div>
              </>
            )}
          </section>,
        document.body
      )}


      <p className="api-base">API: {API_BASE}</p>
    </main>
  );
}
