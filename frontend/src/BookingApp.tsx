import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, checkBackendHealth, del, get, markBackendAvailable, post, resolveApiUrl } from './api';
import { Avatar } from './components/Avatar';
import { BookingForm, createDefaultBookingFormValues } from './components/BookingForm';
import type { BookingFormSubmitPayload, BookingFormValues } from './components/BookingForm';
import { UserMenu } from './components/UserMenu';
import { FloorplanCanvas } from './FloorplanCanvas';
import { APP_TITLE, COMPANY_LOGO_URL } from './config';
import type { AuthUser } from './auth/AuthProvider';
import { useToast } from './components/toast';
import { resourceKindLabel } from './resourceKinds';

type Floorplan = { id: string; name: string; imageUrl: string; isDefault?: boolean };
type OccupancyDesk = {
  id: string;
  name: string;
  kind?: string;
  allowSeriesOverride?: boolean | null;
  effectiveAllowSeries?: boolean;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { id?: string; employeeId?: string; userEmail: string; userDisplayName?: string; userFirstName?: string; userPhotoUrl?: string; type?: 'single' | 'recurring'; daySlot?: 'AM' | 'PM' | 'FULL'; slot?: 'FULL_DAY' | 'MORNING' | 'AFTERNOON' | 'CUSTOM'; startTime?: string; endTime?: string; isCurrentUser?: boolean } | null;
  bookings?: Array<{ id?: string; employeeId?: string; userEmail: string; userDisplayName?: string; userFirstName?: string; userPhotoUrl?: string; type?: 'single' | 'recurring'; daySlot?: 'AM' | 'PM' | 'FULL'; slot?: 'FULL_DAY' | 'MORNING' | 'AFTERNOON' | 'CUSTOM'; startTime?: string; endTime?: string; isCurrentUser?: boolean }>;
  isCurrentUsersDesk?: boolean;
  isHighlighted?: boolean;
};
type OccupancyPerson = { email: string; displayName?: string; deskName?: string; deskId?: string };
type OccupancyResponse = { date: string; floorplanId: string; desks: OccupancyDesk[]; people: OccupancyPerson[] };
type BookingEmployee = { id: string; email: string; firstName?: string; displayName: string; photoUrl?: string };
type OccupantForDay = { deskId: string; deskLabel: string; deskKindLabel: string; userId: string; name: string; firstName: string; email: string; employeeId?: string; photoUrl?: string };
type BookingSubmitPayload = BookingFormSubmitPayload;
type BookingDialogState = 'IDLE' | 'BOOKING_OPEN' | 'SUBMITTING' | 'CONFLICT_REVIEW';
type RebookConfirmState = {
  deskId: string;
  deskLabel: string;
  deskKindLabel: string;
  existingDeskLabel?: string;
  existingKindLabel?: string;
  existingSlotLabel?: string;
  date: string;
  retryPayload: BookingSubmitPayload;
  anchorEl: HTMLElement;
};
type CancelFlowState = 'NONE' | 'DESK_POPOVER_OPEN' | 'CANCEL_CONFIRM_OPEN';
type BulkBookingResponse = {
  createdCount?: number;
  updatedCount?: number;
  skippedCount?: number;
  skippedDates?: string[];
};
type DeskPopupState = { deskId: string; anchorEl: HTMLElement };
type CancelConfirmContext = DeskPopupState & { bookingId: string; bookingLabel: string; isRecurring: boolean; keepPopoverOpen: boolean };
type OccupancyBooking = NonNullable<OccupancyDesk['booking']>;
type RoomBookingListEntry = { id: string; start: number; end: number; label: string; person: string; bookingId?: string; isCurrentUser: boolean; isRecurring: boolean };
type DeskSlotAvailability = 'FREE' | 'AM_BOOKED' | 'PM_BOOKED' | 'FULL_BOOKED';
type PopupPlacement = 'top' | 'right' | 'bottom' | 'left';
type PopupCoordinates = { left: number; top: number; placement: PopupPlacement };
type TimeInterval = { start: number; end: number };
type CalendarBooking = { date: string };

const POPUP_OFFSET = 12;
const POPUP_PADDING = 8;
const WORK_START = 7 * 60;
const WORK_END = 18 * 60;

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
const toBookingDateKey = (value: string): string => value.slice(0, 10);
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

const getFirstName = ({ firstName, displayName, email }: { firstName?: string; displayName?: string; email?: string }): string => {
  if (firstName?.trim()) return firstName.trim();
  if (displayName?.trim()) return displayName.trim().split(/\s+/)[0] ?? 'Unbekannt';
  if (email?.trim()) return email.trim().split('@')[0] ?? 'Unbekannt';
  return 'Unbekannt';
};

const formatDate = (dateString: string): string => new Date(`${dateString}T00:00:00.000Z`).toLocaleDateString('de-DE');
const formatMinutesAsTime = (minutes: number): string => {
  const clamped = Math.max(0, Math.min(24 * 60, minutes));
  const hour = String(Math.floor(clamped / 60)).padStart(2, '0');
  const minute = String(clamped % 60).padStart(2, '0');
  return `${hour}:${minute}`;
};

const toMinutes = (value?: string): number | null => {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
};

const mergeIntervals = (intervals: TimeInterval[]): TimeInterval[] => {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: TimeInterval[] = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
};

const toFreeIntervals = (occupied: TimeInterval[], dayStart = WORK_START, dayEnd = WORK_END): TimeInterval[] => {
  const free: TimeInterval[] = [];
  let cursor = dayStart;
  for (const interval of occupied) {
    const start = Math.max(interval.start, dayStart);
    const end = Math.min(interval.end, dayEnd);
    if (end <= dayStart || start >= dayEnd) continue;
    if (start > cursor) free.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < dayEnd) free.push({ start: cursor, end: dayEnd });
  return free;
};
const isUserBookingConflictError = (error: unknown): error is ApiError => {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  if (!error.details || typeof error.details !== 'object') return false;
  const payload = error.details as { details?: { conflictKind?: unknown; existingBooking?: unknown } };
  return typeof payload.details?.conflictKind === 'string' || Boolean(payload.details?.existingBooking);
};

const getConflictExistingDeskLabel = (error: ApiError): string | undefined => {
  if (!error.details || typeof error.details !== 'object') return undefined;
  const details = error.details as { details?: { existingBooking?: { deskName?: unknown } } };
  const deskName = details.details?.existingBooking?.deskName;
  return typeof deskName === 'string' && deskName.trim() ? deskName : undefined;
};


const getConflictExistingSlotLabel = (error: ApiError): string | undefined => {
  if (!error.details || typeof error.details !== 'object') return undefined;
  const details = error.details as { details?: { existingBooking?: { daySlot?: unknown } } };
  return formatDaySlotLabel(typeof details.details?.existingBooking?.daySlot === 'string' ? details.details.existingBooking.daySlot : undefined);
};
const getConflictKindLabel = (error: ApiError): string | undefined => {
  if (!error.details || typeof error.details !== 'object') return undefined;
  const details = error.details as { details?: { conflictKind?: unknown } };
  if (typeof details.details?.conflictKind !== 'string') return undefined;
  return resourceKindLabel(details.details.conflictKind);
};


const formatDaySlotLabel = (slot?: string): string | undefined => {
  if (slot === 'AM') return 'Vormittag';
  if (slot === 'PM') return 'Nachmittag';
  if (slot === 'FULL') return 'Ganztag';
  return undefined;
};

const bookingSlotLabel = (booking?: OccupancyBooking | null): string => {
  if (!booking) return 'Ganztägig';
  if (booking.daySlot === 'AM' || booking.slot === 'MORNING') return 'Vormittag';
  if (booking.daySlot === 'PM' || booking.slot === 'AFTERNOON') return 'Nachmittag';
  if (booking.daySlot === 'FULL' || booking.slot === 'FULL_DAY') return 'Ganztägig';
  if (booking.slot === 'CUSTOM') return `${booking.startTime ?? '--:--'}–${booking.endTime ?? '--:--'}`;
  return 'Ganztägig';
};

const normalizeDeskBookings = (desk: OccupancyDesk): OccupancyBooking[] => {
  if (desk.bookings && desk.bookings.length > 0) return desk.bookings;
  return desk.booking ? [desk.booking] : [];
};

const getDeskSlotAvailability = (desk?: OccupancyDesk | null): DeskSlotAvailability => {
  if (!desk) return 'FREE';
  const bookings = normalizeDeskBookings(desk);
  if (bookings.length === 0) return 'FREE';

  let amTaken = false;
  let pmTaken = false;
  for (const booking of bookings) {
    if (booking.daySlot === 'FULL' || booking.slot === 'FULL_DAY') {
      amTaken = true;
      pmTaken = true;
      break;
    }
    if (booking.daySlot === 'AM' || booking.slot === 'MORNING') amTaken = true;
    if (booking.daySlot === 'PM' || booking.slot === 'AFTERNOON') pmTaken = true;
  }

  if (amTaken && pmTaken) return 'FULL_BOOKED';
  if (amTaken) return 'AM_BOOKED';
  if (pmTaken) return 'PM_BOOKED';
  return 'FREE';
};

const getDefaultSlotForDesk = (desk: OccupancyDesk): BookingFormValues['slot'] | null => {
  const availability = getDeskSlotAvailability(desk);
  if (availability === 'AM_BOOKED') return 'AFTERNOON';
  if (availability === 'PM_BOOKED') return 'MORNING';
  if (availability === 'FREE') return 'FULL_DAY';
  return null;
};

const isRoomResource = (desk?: OccupancyDesk | null): boolean => desk?.kind === 'RAUM';

const canBookDesk = (desk?: OccupancyDesk | null): boolean => {
  if (!desk) return false;
  if (isRoomResource(desk)) return true;
  return getDefaultSlotForDesk(desk) !== null;
};

const deskAvailabilityLabel = (availability: DeskSlotAvailability): string => {
  if (availability === 'AM_BOOKED') return 'Vormittag belegt';
  if (availability === 'PM_BOOKED') return 'Nachmittag belegt';
  if (availability === 'FULL_BOOKED') return 'Ganztag belegt';
  return 'Frei';
};
const getOccupantIdentityKey = (occupant: OccupantForDay): string => {
  if (occupant.employeeId?.trim()) return `employee:${occupant.employeeId}`;
  if (occupant.email.trim()) return `email:${occupant.email.toLowerCase()}`;
  return `user:${occupant.userId}`;
};

const mapBookingsForDay = (desks: OccupancyDesk[]): OccupantForDay[] => {
  const uniqueOccupants = new Map<string, OccupantForDay>();

  desks.forEach((desk) => {
    for (const booking of normalizeDeskBookings(desk)) {
      const fullName = booking.userDisplayName ?? booking.userEmail ?? 'Unbekannt';

      const occupant: OccupantForDay = {
        deskId: desk.id,
        deskLabel: desk.name,
        deskKindLabel: resourceKindLabel(desk.kind),
        userId: booking.id ?? booking.employeeId ?? booking.userEmail ?? `${desk.id}-occupant`,
        name: fullName,
        firstName: getFirstName({ firstName: booking.userFirstName, displayName: fullName, email: booking.userEmail }),
        email: booking.userEmail ?? '',
        employeeId: booking.employeeId,
        photoUrl: booking.userPhotoUrl
      };

      const occupantKey = getOccupantIdentityKey(occupant);
      if (!uniqueOccupants.has(occupantKey)) {
        uniqueOccupants.set(occupantKey, occupant);
      }
    }
  });

  return Array.from(uniqueOccupants.values()).sort((a, b) => a.name.localeCompare(b.name, 'de'));
};

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
  const normalizedBookings = normalizeDeskBookings(desk).map((booking) => {
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
      ...booking,
      employeeId: booking.employeeId ?? employee?.id,
      userFirstName: booking.userFirstName ?? employee?.firstName ?? getFirstName({ displayName: booking.userDisplayName ?? employee?.displayName, email: booking.userEmail }),
      userDisplayName: booking.userDisplayName ?? employee?.displayName,
      userPhotoUrl: bookingPhotoUrl ?? employeePhotoUrl ?? fallbackPhotoUrl,
      isCurrentUser: isMineByEmail || isMineByEmployeeId
    };
  });

  const primaryBooking = normalizedBookings[0] ?? null;

  return {
    ...desk,
    booking: primaryBooking,
    bookings: normalizedBookings,
    status: normalizedBookings.length > 0 ? 'booked' : 'free',
    isCurrentUsersDesk: normalizedBookings.some((booking) => booking.isCurrentUser)
  };
});

export function BookingApp({ onOpenAdmin, canOpenAdmin, currentUserEmail, onLogout, currentUser }: { onOpenAdmin: () => void; canOpenAdmin: boolean; currentUserEmail?: string; onLogout: () => Promise<void>; currentUser: AuthUser }) {
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(today));

  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [todayOccupancy, setTodayOccupancy] = useState<OccupancyResponse | null>(null);
  const [employees, setEmployees] = useState<BookingEmployee[]>([]);
  const [selectedEmployeeEmail, setSelectedEmployeeEmail] = useState('');

  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');
  const [floorplanZoom, setFloorplanZoom] = useState(1);
  const [bookingVersion, setBookingVersion] = useState(0);

  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isUpdatingOccupancy, setIsUpdatingOccupancy] = useState(false);
  const [backendDown, setBackendDown] = useState(false);
  const toast = useToast();
  const { registerDeskAnchor } = toast;

  const [deskPopup, setDeskPopup] = useState<DeskPopupState | null>(null);
  const [bookingDialogState, setBookingDialogState] = useState<BookingDialogState>('IDLE');
  const [bookingFormValues, setBookingFormValues] = useState<BookingFormValues>(createDefaultBookingFormValues(today));
  const [dialogErrorMessage, setDialogErrorMessage] = useState('');
  const [rebookConfirm, setRebookConfirm] = useState<RebookConfirmState | null>(null);
  const [isRebooking, setIsRebooking] = useState(false);
  const [cancelFlowState, setCancelFlowState] = useState<CancelFlowState>('NONE');
  const [cancelConfirmContext, setCancelConfirmContext] = useState<CancelConfirmContext | null>(null);
  const [isCancellingBooking, setIsCancellingBooking] = useState(false);
  const [cancelDialogError, setCancelDialogError] = useState('');
  const [bookedCalendarDays, setBookedCalendarDays] = useState<string[]>([]);

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
  const filteredDesks = useMemo(() => desks.map((desk) => ({ ...desk, isHighlighted: desk.id === highlightedDeskId })), [desks, highlightedDeskId]);
  const bookingsForSelectedDate = useMemo<OccupantForDay[]>(() => mapBookingsForDay(desks), [desks]);
  const bookingsForToday = useMemo<OccupantForDay[]>(() => mapBookingsForDay(desksToday), [desksToday]);
  const popupDesk = useMemo(() => (deskPopup ? desks.find((desk) => desk.id === deskPopup.deskId) ?? null : null), [desks, deskPopup]);
  const popupDeskAvailability = useMemo(() => getDeskSlotAvailability(popupDesk), [popupDesk]);
  const popupDeskBookings = useMemo(() => (popupDesk ? normalizeDeskBookings(popupDesk) : []), [popupDesk]);
  const popupRoomOccupiedIntervals = useMemo(() => mergeIntervals(popupDeskBookings.flatMap((booking) => {
    const start = toMinutes(booking.startTime);
    const end = toMinutes(booking.endTime);
    if (start === null || end === null || end <= start) return [];
    return [{ start, end }];
  })), [popupDeskBookings]);
  const popupRoomFreeIntervals = useMemo(() => toFreeIntervals(popupRoomOccupiedIntervals), [popupRoomOccupiedIntervals]);
  const popupRoomBookingsList = useMemo<RoomBookingListEntry[]>(() => popupDeskBookings
    .flatMap((booking) => {
      const start = toMinutes(booking.startTime);
      const end = toMinutes(booking.endTime);
      if (start === null || end === null || end <= start) return [];
      const bookingEmail = booking.userEmail.toLowerCase();
      const isCurrentUser = Boolean(booking.isCurrentUser || (currentUser?.id && booking.employeeId === currentUser.id) || (currentUserEmail && bookingEmail === currentUserEmail.toLowerCase()));
      return [{
        id: booking.id ?? `${booking.userEmail}-${booking.startTime}-${booking.endTime}`,
        start,
        end,
        label: `${formatMinutesAsTime(start)} – ${formatMinutesAsTime(end)}`,
        person: booking.userDisplayName ?? booking.userEmail,
        bookingId: booking.id,
        isCurrentUser,
        isRecurring: booking.type === 'recurring'
      }];
    })
    .sort((a, b) => a.start - b.start), [popupDeskBookings, currentUser?.id, currentUserEmail]);
  const popupRoomFreeSlotChips = useMemo(() => popupRoomFreeIntervals
    .filter((interval) => interval.end - interval.start >= 30)
    .map((interval) => ({
      startTime: formatMinutesAsTime(interval.start),
      endTime: formatMinutesAsTime(interval.end),
      label: `${formatMinutesAsTime(interval.start)} – ${formatMinutesAsTime(interval.end)}`
    })), [popupRoomFreeIntervals]);
  const roomBookingConflict = useMemo(() => {
    if (!popupDesk || !isRoomResource(popupDesk)) return '';
    const start = toMinutes(bookingFormValues.startTime);
    const end = toMinutes(bookingFormValues.endTime);
    if (start === null || end === null || end <= start) return '';
    const conflict = popupRoomOccupiedIntervals.find((interval) => start < interval.end && end > interval.start);
    if (!conflict) return '';
    return `Kollidiert mit ${formatMinutesAsTime(conflict.start)} – ${formatMinutesAsTime(conflict.end)}`;
  }, [popupDesk, bookingFormValues.startTime, bookingFormValues.endTime, popupRoomOccupiedIntervals]);
  const popupDeskState = popupDesk ? (!canBookDesk(popupDesk) ? (popupDesk.isCurrentUsersDesk ? 'MINE' : 'TAKEN') : 'FREE') : null;
  const cancelConfirmDesk = useMemo(() => (cancelConfirmContext ? desks.find((desk) => desk.id === cancelConfirmContext.deskId) ?? null : null), [desks, cancelConfirmContext]);
  const cancelConfirmBookingLabel = cancelConfirmContext?.bookingLabel ?? bookingSlotLabel(cancelConfirmDesk?.booking);
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const calendarRange = useMemo(() => ({
    from: toDateKey(calendarDays[0]),
    to: toDateKey(calendarDays[calendarDays.length - 1])
  }), [calendarDays]);
  const bookedCalendarDaysSet = useMemo(() => new Set(bookedCalendarDays), [bookedCalendarDays]);

  const loadOccupancy = async (floorplanId: string, date: string) => {
    if (!floorplanId) return;

    setIsUpdatingOccupancy(true);

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
      toast.error(getApiErrorMessage(error, 'Belegung konnte nicht geladen werden.'));
      setTodayOccupancy(null);
    } finally {
      setIsUpdatingOccupancy(false);
    }
  };

  const loadInitial = async () => {
    setIsBootstrapping(true);

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
      setSelectedFloorplanId((prev) => prev || nextFloorplans.find((plan) => plan.isDefault)?.id || nextFloorplans[0]?.id || '');
      setSelectedEmployeeEmail((prev) => prev || currentUserEmail || nextEmployees[0]?.email || '');
      setBackendDown(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
      }
      toast.error(getApiErrorMessage(error, 'Daten konnten nicht geladen werden.'));
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
    if (backendDown) {
      setBookedCalendarDays([]);
      return;
    }

    let cancelled = false;

    const loadCalendarBookings = async () => {
      try {
        const calendarBookings = await get<CalendarBooking[]>(`/bookings?from=${calendarRange.from}&to=${calendarRange.to}`);
        if (cancelled) return;
        setBookedCalendarDays(Array.from(new Set(calendarBookings.map((booking) => toBookingDateKey(booking.date)))));
      } catch {
        if (cancelled) return;
        setBookedCalendarDays([]);
      }
    };

    loadCalendarBookings();

    return () => {
      cancelled = true;
    };
  }, [backendDown, calendarRange.from, calendarRange.to]);


  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!deskPopup || !popupRef.current) {
      setDeskPopupCoords(null);
      return;
    }

    const anchorRect = deskPopup.anchorEl.getBoundingClientRect();
    const popupRect = popupRef.current.getBoundingClientRect();
    setDeskPopupCoords(calculatePopupCoordinates(anchorRect, popupRect));
  }, [deskPopup, bookingDialogState, popupDeskState, dialogErrorMessage]);

  useEffect(() => {
    if (!deskPopup) return;

    const closePopup = () => {
      closeBookingFlow();
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
      if (deskPopup.anchorEl.contains(target)) return;
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

  const selectDeskFromCanvas = (deskId: string, anchorEl?: HTMLElement) => {
    const desk = desks.find((entry) => entry.id === deskId);
    if (!desk || !anchorEl) return;

    if (deskPopup?.deskId === deskId) {
      closeBookingFlow();
      return;
    }

    setSelectedDeskId(deskId);
    triggerDeskHighlight(deskId);
    setDeskPopup({ deskId, anchorEl });
    setRebookConfirm(null);
    setIsRebooking(false);
    setCancelFlowState('DESK_POPOVER_OPEN');
    setCancelConfirmContext(null);
    setIsCancellingBooking(false);
    setCancelDialogError('');
    setDialogErrorMessage('');

    if (canBookDesk(desk)) {
      const defaults = createDefaultBookingFormValues(selectedDate);
      if (!isRoomResource(desk)) {
        const nextSlot = getDefaultSlotForDesk(desk);
        if (nextSlot) defaults.slot = nextSlot;
      } else {
        const occupiedIntervals = mergeIntervals(normalizeDeskBookings(desk).flatMap((booking) => {
          const start = toMinutes(booking.startTime);
          const end = toMinutes(booking.endTime);
          if (start === null || end === null || end <= start) return [];
          return [{ start, end }];
        }));
        const freeIntervals = toFreeIntervals(occupiedIntervals);
        const firstFreeSlot = freeIntervals.find((interval) => interval.end > interval.start);

        if (firstFreeSlot) {
          const startMinutes = firstFreeSlot.start;
          const endMinutes = Math.min(firstFreeSlot.start + 60, firstFreeSlot.end);
          defaults.startTime = formatMinutesAsTime(startMinutes);
          defaults.endTime = formatMinutesAsTime(endMinutes);
        } else {
          defaults.startTime = '';
          defaults.endTime = '';
        }
      }
      setBookingFormValues(defaults);
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
    setRebookConfirm(null);
    setBookingDialogState('IDLE');
    setDialogErrorMessage('');
    setIsRebooking(false);
    setDeskPopupCoords(null);
    setCancelFlowState('NONE');
    setCancelConfirmContext(null);
    setIsCancellingBooking(false);
    setCancelDialogError('');
  };

  const openCancelConfirm = () => {
    if (!deskPopup || !popupDesk || popupDeskState !== 'MINE') return;
    const ownBooking = normalizeDeskBookings(popupDesk).find((booking) => booking.isCurrentUser && booking.id);
    if (!ownBooking?.id) return;
    setCancelConfirmContext({
      ...deskPopup,
      bookingId: ownBooking.id,
      bookingLabel: bookingSlotLabel(ownBooking),
      isRecurring: ownBooking.type === 'recurring',
      keepPopoverOpen: false
    });
    setDeskPopup(null);
    setDeskPopupCoords(null);
    setCancelDialogError('');
    setIsCancellingBooking(false);
    setCancelFlowState('CANCEL_CONFIRM_OPEN');
  };

  const cancelCancelConfirm = () => {
    if (!cancelConfirmContext) {
      closeBookingFlow();
      return;
    }

    setCancelDialogError('');
    setIsCancellingBooking(false);
    setDeskPopup({ deskId: cancelConfirmContext.deskId, anchorEl: cancelConfirmContext.anchorEl });
    setCancelFlowState('DESK_POPOVER_OPEN');
  };

  const submitPopupBooking = async (deskId: string, payload: BookingSubmitPayload, overwrite = false) => {
    if (!selectedEmployeeEmail) {
      throw new Error('Bitte Mitarbeiter auswählen.');
    }

    if (payload.type === 'single') {
      await post('/bookings', { deskId, userEmail: selectedEmployeeEmail, date: payload.date, daySlot: payload.slot === 'FULL_DAY' ? 'FULL' : payload.slot === 'MORNING' ? 'AM' : payload.slot === 'AFTERNOON' ? 'PM' : undefined, startTime: payload.startTime, endTime: payload.endTime, overwrite });
      toast.success(overwrite ? 'Umbuchung durchgeführt.' : 'Gebucht', { deskId });
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

    toast.success(overwrite
      ? `${response.createdCount ?? 0} Tage gebucht, ${response.updatedCount ?? 0} Tage umgebucht.`
      : 'Gebucht', { deskId });
  };



  const handleBookingSubmit = async (payload: BookingSubmitPayload) => {
    if (payload.type === 'recurring' && popupDesk?.effectiveAllowSeries === false) {
      setDialogErrorMessage('Für diese Ressource sind Serientermine nicht erlaubt.');
      return;
    }
    if (roomBookingConflict) {
      setDialogErrorMessage(roomBookingConflict);
      return;
    }
    if (!deskPopup || !popupDesk || !canBookDesk(popupDesk)) return;

    setDialogErrorMessage('');
    setBookingDialogState('SUBMITTING');

    try {
      await submitPopupBooking(popupDesk.id, payload, false);
      closeBookingFlow();
      await reloadBookings();
      setBookingVersion((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
        setBookingDialogState('BOOKING_OPEN');
        setDialogErrorMessage('Backend nicht erreichbar. Bitte erneut versuchen.');
        return;
      }

      if (isUserBookingConflictError(error)) {
        setDeskPopup(null);
        setDeskPopupCoords(null);
        setCancelFlowState('NONE');
        setCancelConfirmContext(null);
        setBookingDialogState('CONFLICT_REVIEW');
        setDialogErrorMessage('');
        setIsRebooking(false);
        setRebookConfirm({
          deskId: popupDesk.id,
          deskLabel: popupDesk.name,
          deskKindLabel: resourceKindLabel(popupDesk.kind),
          existingDeskLabel: getConflictExistingDeskLabel(error),
          existingKindLabel: getConflictKindLabel(error) ?? resourceKindLabel(popupDesk.kind),
          existingSlotLabel: getConflictExistingSlotLabel(error),
          date: payload.type === 'single' ? payload.date : selectedDate,
          retryPayload: payload,
          anchorEl: deskPopup.anchorEl
        });
        return;
      }

      setBookingDialogState('BOOKING_OPEN');
      setDialogErrorMessage(error instanceof Error ? error.message : 'Buchung fehlgeschlagen.');
    }
  };

  const confirmRebook = async () => {
    if (!rebookConfirm) return;

    setIsRebooking(true);

    try {
      await submitPopupBooking(rebookConfirm.deskId, rebookConfirm.retryPayload, true);
      setRebookConfirm(null);
      setIsRebooking(false);
      closeBookingFlow();
      await reloadBookings();
      setBookingVersion((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
        setIsRebooking(false);
        toast.error('Umbuchen fehlgeschlagen. Bitte erneut versuchen.');
        return;
      }

      setIsRebooking(false);
      toast.error('Umbuchen fehlgeschlagen. Bitte erneut versuchen.');
    }
  };

  const cancelRebook = () => {
    if (!rebookConfirm) return;

    setIsRebooking(false);
    setDeskPopup({ deskId: rebookConfirm.deskId, anchorEl: rebookConfirm.anchorEl });
    setCancelFlowState('DESK_POPOVER_OPEN');
    setBookingDialogState('BOOKING_OPEN');
    setRebookConfirm(null);
  };

  const handleRoomBookingCancel = (bookingId: string) => {
    if (!deskPopup || !popupDesk || !isRoomResource(popupDesk)) return;
    const selectedBooking = popupRoomBookingsList.find((booking) => booking.id === bookingId);
    if (!selectedBooking || !selectedBooking.isCurrentUser || !selectedBooking.bookingId) return;

    setCancelConfirmContext({
      ...deskPopup,
      bookingId: selectedBooking.bookingId,
      bookingLabel: selectedBooking.label,
      isRecurring: selectedBooking.isRecurring,
      keepPopoverOpen: true
    });
    setDeskPopup(null);
    setDeskPopupCoords(null);
    setCancelDialogError('');
    setIsCancellingBooking(false);
    setCancelFlowState('CANCEL_CONFIRM_OPEN');
  };

  const submitPopupCancel = async () => {
    if (!cancelConfirmDesk || !cancelConfirmContext) return;
    if (cancelConfirmContext.isRecurring) {
      toast.error('Serienbuchungen können aktuell nur im Admin-Modus storniert werden.');
      return;
    }

    setCancelDialogError('');
    setIsCancellingBooking(true);

    try {
      await del(`/bookings/${cancelConfirmContext.bookingId}`);
      toast.success('Buchung storniert', { deskId: cancelConfirmDesk.id });
      await reloadBookings();
      setBookingVersion((value) => value + 1);

      setCancelDialogError('');
      setIsCancellingBooking(false);
      if (cancelConfirmContext.keepPopoverOpen) {
        setCancelFlowState('DESK_POPOVER_OPEN');
        setDeskPopup({ deskId: cancelConfirmContext.deskId, anchorEl: cancelConfirmContext.anchorEl });
      } else {
        setCancelFlowState('NONE');
        setDeskPopup(null);
      }
      setCancelConfirmContext(null);
    } catch (_error) {
      setCancelDialogError('Stornieren fehlgeschlagen');
      setIsCancellingBooking(false);
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
    await loadInitial();
  };

  const calendarPanel = (
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
            const hasBookingsForDay = bookedCalendarDaysSet.has(dayKey);
            return (
              <button key={dayKey} className={`day-btn ${inVisibleMonth ? '' : 'outside'} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''} ${!isSelected && hasBookingsForDay ? 'has-bookings' : ''}`} onClick={() => selectDay(day)}>
                {day.getUTCDate()}
              </button>
            );
          })}
        </div>
      </section>
  );

  const legendPanel = (
    <section className="card compact-card stack-sm">
        <h3 className="section-title">Legende</h3>
        <div className="legend">
          <span><i className="dot free" /> Grün = frei</span>
          <span><i className="dot booked" /> Rot = belegt</span>
          <span><i className="dot selected" /> Blau = dein Platz</span>
        </div>
      </section>
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
            {occupant.deskLabel && <span className="occupant-desk-label" title={`${occupant.deskKindLabel}: ${occupant.deskLabel}`}>{occupant.deskKindLabel}: {occupant.deskLabel}</span>}
          </div>
        ))}
      </div>
    );
  };

  const todayPanel = (
    <section className="card compact-card today-compact-panel">
      <div className="today-summary-header">
        <strong>Heute im Büro</strong>
      </div>
      {bookingsForToday.length === 0 ? (
        <div className="empty-state compact-empty-state today-people-empty-state">
          <p>Heute noch niemand eingetragen.</p>
        </div>
      ) : (
        <div className="today-people-grid" role="list" aria-label="Anwesende heute">
          {bookingsForToday.map((person) => (
            <button
              key={`today-${person.userId}-${person.deskId}`}
              type="button"
              role="listitem"
              className={`today-person-tile ${(hoveredDeskId === person.deskId || selectedDeskId === person.deskId) ? 'is-active' : ''} ${highlightedDeskId === person.deskId ? 'is-highlighted' : ''}`}
              onMouseEnter={() => {
                setHoveredDeskId(person.deskId);
                setHighlightedDeskId(person.deskId);
              }}
              onMouseLeave={() => {
                setHoveredDeskId('');
                setHighlightedDeskId('');
              }}
              onFocus={() => setHighlightedDeskId(person.deskId)}
              onBlur={() => setHighlightedDeskId('')}
              onClick={() => {
                setSelectedDate(today);
                setVisibleMonth(startOfMonth(today));
              }}
              title={person.name}
            >
              <Avatar displayName={person.name} email={person.email} photoUrl={person.photoUrl} size={50} />
              <span>{person.firstName}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );

  const detailPanel = (
    <div className="stack">
      <section className="card compact-card stack-sm details-panel">
        <div className="stack-sm">
          <h3>Anwesend am {formatDate(selectedDate)}</h3>
          {renderOccupancyList(bookingsForSelectedDate, 'selected', 'Anwesenheit am ausgewählten Datum', 'Niemand anwesend')}
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
          {COMPANY_LOGO_URL ? <img className="brand-logo" src={COMPANY_LOGO_URL} alt={`${APP_TITLE} Logo`} /> : <span className="brand-mark" aria-hidden="true">A</span>}
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


      {isBootstrapping ? <div className="card skeleton h-120" /> : todayPanel}

      <section className="layout-grid">
        <aside className="left-col">{isBootstrapping ? <div className="card skeleton h-480" /> : calendarPanel}</aside>
        <aside className="legend-col">{isBootstrapping ? <div className="card skeleton h-120" /> : legendPanel}</aside>
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
                  onDeskAnchorChange={registerDeskAnchor}
                  bookingVersion={bookingVersion}
                />
              ) : (
                <div className="empty-state"><p>Kein Floorplan ausgewählt.</p></div>
              )}
            </div>
          </article>
        </section>

        <aside className="right-col">{isBootstrapping ? <div className="card skeleton h-480" /> : detailPanel}</aside>
      </section>

      {deskPopup && popupDesk && popupDeskState && cancelFlowState !== 'CANCEL_CONFIRM_OPEN' && createPortal(
        <section
          ref={popupRef}
          className="card desk-popup"
          style={{ left: deskPopupCoords?.left ?? POPUP_PADDING, top: deskPopupCoords?.top ?? POPUP_PADDING, visibility: deskPopupCoords ? 'visible' : 'hidden' }}
          role="menu"
          data-placement={deskPopupCoords?.placement ?? 'right'}
        >
          {popupDeskState === 'FREE' ? (
            <>
              <div className="desk-popup-header">
                <div className="stack-xxs">
                  <h3>{resourceKindLabel(popupDesk.kind)}: {popupDesk.name}</h3>
                  <p className="muted">Buchung anlegen{!isRoomResource(popupDesk) ? ` · ${deskAvailabilityLabel(popupDeskAvailability)}` : ''}</p>
                </div>
                <button type="button" className="btn btn-ghost desk-popup-close" aria-label="Popover schließen" onClick={closeBookingFlow}>✕</button>
              </div>
              <BookingForm
                values={bookingFormValues}
                onChange={setBookingFormValues}
                onCancel={closeBookingFlow}
                onSubmit={handleBookingSubmit}
                isSubmitting={bookingDialogState === 'SUBMITTING'}
                disabled={bookingDialogState === 'SUBMITTING'}
                errorMessage={dialogErrorMessage}
                allowRecurring={popupDesk.effectiveAllowSeries !== false}
                resourceKind={popupDesk.kind}
                roomSchedule={isRoomResource(popupDesk)
                  ? {
                    bookings: popupRoomBookingsList.map((booking) => ({
                      id: booking.id,
                      label: booking.label,
                      person: booking.person,
                      isCurrentUser: booking.isCurrentUser,
                      canCancel: booking.isCurrentUser && Boolean(booking.bookingId)
                    })),
                    freeSlots: popupRoomFreeSlotChips,
                    isFullyBooked: popupRoomFreeSlotChips.length === 0,
                    conflictMessage: roomBookingConflict,
                    onSelectFreeSlot: (startTime, endTime) => {
                      setBookingFormValues((current) => ({ ...current, startTime, endTime }));
                    },
                    onBookingClick: handleRoomBookingCancel
                  }
                  : undefined}
              />
            </>
          ) : (
            <>
              <h3>{resourceKindLabel(popupDesk.kind)}: {popupDesk.name}</h3>
              <div className="stack-sm">
                <p className="muted">Datum: {new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</p>
                {!isRoomResource(popupDesk) && <p className="muted">Status: {deskAvailabilityLabel(popupDeskAvailability)}</p>}
                {popupDeskBookings.map((booking) => (
                  <p key={booking.id ?? `${booking.userEmail}-${bookingSlotLabel(booking)}`} className="muted">
                    {bookingSlotLabel(booking)}: {booking.userDisplayName ?? booking.userEmail}
                  </p>
                ))}
                <div className="inline-end">
                  <button type="button" className="btn btn-outline" onClick={closeBookingFlow}>Schließen</button>
                  {popupDeskState === 'MINE' && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={openCancelConfirm}
                      disabled={popupDesk.booking?.type === 'recurring'}
                    >
                      Buchung stornieren
                    </button>
                  )}
                </div>
                {popupDesk.booking?.type === 'recurring' && popupDeskState === 'MINE' && <p className="muted">Serienbuchungen können derzeit nur im Admin-Modus storniert werden.</p>}
              </div>
            </>
          )}
        </section>,
        document.body
      )}

      {cancelFlowState === 'CANCEL_CONFIRM_OPEN' && cancelConfirmDesk && createPortal(
        <div className="overlay" role="presentation">
          <section className="card dialog stack-sm cancel-booking-dialog" role="alertdialog" aria-modal="true" aria-labelledby="cancel-booking-title">
            <h3 id="cancel-booking-title">Buchung stornieren?</h3>
            <p>Möchtest du deine Raumbuchung {cancelConfirmBookingLabel} stornieren?</p>
            <p className="muted cancel-booking-subline">{resourceKindLabel(cancelConfirmDesk.kind)}: {cancelConfirmDesk.name} · {new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</p>
            {cancelDialogError && <p className="error-banner">{cancelDialogError}</p>}
            <div className="inline-end">
              <button type="button" className="btn btn-outline" onClick={cancelCancelConfirm} disabled={isCancellingBooking}>Abbrechen</button>
              <button type="button" className="btn btn-danger" onClick={() => void submitPopupCancel()} disabled={isCancellingBooking}>
                {isCancellingBooking ? 'Stornieren…' : 'Stornieren'}
              </button>
            </div>
          </section>
        </div>,
        document.body
      )}


      {rebookConfirm && createPortal(
        <div className="overlay" role="presentation">
          <section className="card dialog stack-sm rebook-dialog" role="dialog" aria-modal="true" aria-labelledby="rebook-title">
            <h3 id="rebook-title">Umbuchen?</h3>
            <p>
              Du hast am <strong className="rebook-date">{formatDate(rebookConfirm.date)}</strong> bereits eine {rebookConfirm.existingKindLabel ?? rebookConfirm.deskKindLabel}-Buchung{rebookConfirm.existingSlotLabel ? ` (${rebookConfirm.existingSlotLabel})` : ''}.
              <br />
              Möchtest du diese auf {rebookConfirm.deskKindLabel} {rebookConfirm.deskLabel} umbuchen?
            </p>
            {rebookConfirm.existingDeskLabel && <p className="muted rebook-subline">Aktuelle Ressource: {rebookConfirm.existingDeskLabel}</p>}
            <div className="inline-end rebook-actions">
              <button type="button" className="btn btn-outline" onClick={cancelRebook} disabled={isRebooking}>Abbrechen</button>
              <button type="button" className="btn btn-danger" onClick={() => void confirmRebook()} disabled={isRebooking}>
                {isRebooking ? 'Umbuchen…' : 'Umbuchen'}
              </button>
            </div>
          </section>
        </div>,
        document.body
      )}


      <p className="api-base">API: {API_BASE}</p>
    </main>
  );
}
