import { MouseEvent, PointerEvent, WheelEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, checkBackendHealth, get, markBackendAvailable, post, put, resolveApiUrl } from './api';
import { cancelBooking, createRoomBooking } from './api/bookings';
import { createMutationRequestId, logMutation, toBodySnippet } from './api/mutationLogger';
import { Avatar } from './components/Avatar';
import { BookingForm, createDefaultBookingFormValues } from './components/BookingForm';
import type { BookingFormSubmitPayload, BookingFormValues } from './components/BookingForm';
import { UserMenu } from './components/UserMenu';
import { FloorplanCanvas } from './FloorplanCanvas';
import { APP_TITLE, APP_VERSION, COMPANY_LOGO_URL } from './config';
import type { AuthUser } from './auth/AuthProvider';
import { useToast } from './components/toast';
import { normalizeDaySlotBookings } from './daySlotBookings';
import { RESOURCE_KIND_OPTIONS, resourceKindLabel, type ResourceKind } from './resourceKinds';
import { ROOM_WINDOW_END, ROOM_WINDOW_START, ROOM_WINDOW_TOTAL_MINUTES, clampInterval, formatMinutes, intervalsToSegments, invertIntervals, mergeIntervals, toMinutes } from './lib/bookingWindows';

type Floorplan = { id: string; name: string; imageUrl: string; isDefault?: boolean; defaultResourceKind?: ResourceKind };
type RawFloorplan = Floorplan & { image?: string; imageURL?: string };
type FloorplanResource = { id: string; floorplanId: string; kind?: ResourceKind };
type OccupancyDesk = {
  id: string;
  name: string;
  kind?: string;
  allowSeriesOverride?: boolean | null;
  effectiveAllowSeries?: boolean;
  x: number | null;
  y: number | null;
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
  anchorRect: DOMRect;
};
type CancelFlowState = 'NONE' | 'DESK_POPOVER_OPEN' | 'CANCEL_CONFIRM_OPEN';
type CancelDebugAction = 'IDLE' | 'CANCEL_CLICK' | 'CANCEL_REQUEST' | 'CANCEL_SUCCESS' | 'REFRESH_DONE' | 'CANCEL_ERROR';
type CancelDebugState = {
  lastAction: CancelDebugAction;
  bookingId: string | null;
  endpoint: string;
  httpStatus: number | null;
  errorMessage: string;
};
type BulkBookingResponse = {
  createdCount?: number;
  updatedCount?: number;
  skippedCount?: number;
  skippedDates?: string[];
};
type DeskPopupState = { deskId: string; anchorRect: DOMRect; openedAt: number };
type CancelConfirmContext = DeskPopupState & { bookingIds: string[]; bookingLabel: string; isRecurring: boolean; keepPopoverOpen: boolean };
type OccupancyBooking = NonNullable<OccupancyDesk['booking']>;
type NormalizedOccupancyBooking = ReturnType<typeof normalizeDaySlotBookings<OccupancyBooking>>[number];
type RoomAvailabilityBooking = { id: string; startTime: string | null; endTime: string | null; user: { email: string; name?: string } };
type RoomAvailabilityResponse = {
  resource: { id: string; name: string; type: string };
  date: string;
  bookings: Array<{
    id: string;
    resourceId: string;
    resourceType: string;
    start: string | null;
    end: string | null;
    startTime: string | null;
    endTime: string | null;
    createdBy: string;
    user: { email: string; name: string };
  }>;
  freeWindows: Array<{ startTime: string | null; endTime: string | null; label: string }>;
};
type RoomBookingListEntry = { id: string; start: number; end: number; label: string; person: string; bookingId?: string; isCurrentUser: boolean; isRecurring: boolean };
type DeskSlotAvailability = 'FREE' | 'AM_BOOKED' | 'PM_BOOKED' | 'FULL_BOOKED';
type PopupPlacement = 'top' | 'right' | 'bottom' | 'left';
type PopupCoordinates = { left: number; top: number; placement: PopupPlacement };
type FloorplanTransform = { scale: number; translateX: number; translateY: number };
type FloorplanImageSize = { width: number; height: number };
type FloorplanImageLoadState = 'loading' | 'loaded' | 'error';
type FloorplanDebugCounters = {
  srcChangeCount: number;
  transformRecalcCount: number;
  resizeObserverCount: number;
};
type CalendarBooking = { date: string; deskId: string; daySlot?: 'AM' | 'PM' | 'FULL' };
type DayAvailabilityTone = 'many-free' | 'few-free' | 'none-free';
type OverviewView = 'presence' | 'rooms' | 'myBookings';

const OVERVIEW_QUERY_KEY = 'overview';

const isOverviewView = (value: string | null): value is OverviewView => value === 'presence' || value === 'rooms' || value === 'myBookings';

const getInitialOverviewView = (): OverviewView => {
  if (typeof window === 'undefined') return 'presence';
  const queryValue = new URLSearchParams(window.location.search).get(OVERVIEW_QUERY_KEY);
  return isOverviewView(queryValue) ? queryValue : 'presence';
};

const POPUP_OFFSET = 12;
const POPUP_PADDING = 8;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const FLOORPLAN_FIT_PADDING = 24;
const FLOORPLAN_MIN_SCALE = 0.6;
const FLOORPLAN_MAX_SCALE = 2.4;
const FLOORPLAN_ZOOM_STEP = 1.1;
const FLOORPLAN_DRAG_EPSILON = 0.001;
const FLOORPLAN_VIEWPORT_HEIGHT = 'clamp(520px, 70vh, 680px)';

const getFloorplanMinScale = (fitScale: number): number => Math.min(FLOORPLAN_MIN_SCALE, fitScale);

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
const TOP_LOADING_SHOW_DELAY_MS = 200;
const TOP_LOADING_HIDE_DELAY_MS = 250;
const TOP_LOADING_FADE_OUT_MS = 320;

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

const cloneRect = (rect: DOMRect | DOMRectReadOnly): DOMRect => new DOMRect(rect.x, rect.y, rect.width, rect.height);

const getFirstName = ({ firstName, displayName, email }: { firstName?: string; displayName?: string; email?: string }): string => {
  if (firstName?.trim()) return firstName.trim();
  if (displayName?.trim()) return displayName.trim().split(/\s+/)[0] ?? 'Unbekannt';
  if (email?.trim()) return email.trim().split('@')[0] ?? 'Unbekannt';
  return 'Unbekannt';
};

const formatDate = (dateString: string): string => new Date(`${dateString}T00:00:00.000Z`).toLocaleDateString('de-DE');
const bookingBelongsToDay = (booking: { startTime?: string }, selectedDateValue: string): boolean => {
  if (!booking.startTime) return true;
  const parsed = new Date(booking.startTime);
  if (Number.isNaN(parsed.getTime())) return true;
  return toLocalDateKey(parsed) === selectedDateValue;
};

const bookingTimeToMinutes = (value?: string | null): number | null => {
  if (!value) return null;
  if (/^\d{2}:\d{2}$/.test(value)) {
    const parsed = toMinutes(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return null;
  const hhmm = `${String(parsedDate.getHours()).padStart(2, '0')}:${String(parsedDate.getMinutes()).padStart(2, '0')}`;
  const parsed = toMinutes(hhmm);
  return Number.isFinite(parsed) ? parsed : null;
};

const ROOM_WINDOW_START_MINUTES = toMinutes(ROOM_WINDOW_START);
const ROOM_WINDOW_END_MINUTES = toMinutes(ROOM_WINDOW_END);

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

const normalizeDeskBookings = (desk: OccupancyDesk): NormalizedOccupancyBooking[] => {
  const bookings = desk.bookings && desk.bookings.length > 0 ? desk.bookings : desk.booking ? [desk.booking] : [];
  return normalizeDaySlotBookings(bookings);
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

const removeBookingFromDesk = (desk: OccupancyDesk, bookingId: string): OccupancyDesk => {
  const sourceBookings = desk.bookings && desk.bookings.length > 0
    ? desk.bookings
    : desk.booking
      ? [desk.booking]
      : [];

  if (sourceBookings.length === 0) return desk;

  const nextBookings = sourceBookings.filter((booking) => booking.id !== bookingId);
  if (nextBookings.length === sourceBookings.length) return desk;

  return {
    ...desk,
    bookings: nextBookings,
    booking: nextBookings[0] ?? null,
    status: nextBookings.length > 0 ? 'booked' : 'free',
    isCurrentUsersDesk: nextBookings.some((booking) => booking.isCurrentUser)
  };
};

const removeBookingFromOccupancy = (state: OccupancyResponse | null, bookingId: string): OccupancyResponse | null => {
  if (!state) return state;
  return {
    ...state,
    desks: state.desks.map((desk) => removeBookingFromDesk(desk, bookingId))
  };
};

function TopLoadingBar({ loading }: { loading: boolean }) {
  const [shouldRender, setShouldRender] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let showTimer: number | null = null;
    let hideTimer: number | null = null;
    let unmountTimer: number | null = null;

    if (loading) {
      showTimer = window.setTimeout(() => {
        setShouldRender(true);
        window.requestAnimationFrame(() => setIsVisible(true));
      }, TOP_LOADING_SHOW_DELAY_MS);
    } else {
      hideTimer = window.setTimeout(() => {
        setIsVisible(false);
        unmountTimer = window.setTimeout(() => {
          setShouldRender(false);
        }, TOP_LOADING_FADE_OUT_MS);
      }, TOP_LOADING_HIDE_DELAY_MS);
    }

    return () => {
      if (showTimer) window.clearTimeout(showTimer);
      if (hideTimer) window.clearTimeout(hideTimer);
      if (unmountTimer) window.clearTimeout(unmountTimer);
    };
  }, [loading]);

  if (!shouldRender) return null;

  return (
    <div className={`top-loading-bar ${isVisible ? 'is-visible' : ''}`} aria-hidden={!isVisible}>
      <span className="top-loading-bar-track" />
    </div>
  );
}


export function BookingApp({ onOpenAdmin, canOpenAdmin, currentUserEmail, onLogout, currentUser }: { onOpenAdmin: () => void; canOpenAdmin: boolean; currentUserEmail?: string; onLogout: () => Promise<void>; currentUser: AuthUser }) {
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(today));

  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [roomAvailability, setRoomAvailability] = useState<RoomAvailabilityResponse | null>(null);
  const [employees, setEmployees] = useState<BookingEmployee[]>([]);
  const [selectedEmployeeEmail, setSelectedEmployeeEmail] = useState('');
  const [selectedResourceKindFilter, setSelectedResourceKindFilter] = useState<'ALL' | ResourceKind>('ALL');
  const [overviewView, setOverviewView] = useState<OverviewView>(() => getInitialOverviewView());
  const [isManageEditOpen, setIsManageEditOpen] = useState(false);

  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');
  const [floorplanTransform, setFloorplanTransform] = useState<FloorplanTransform>({ scale: 1, translateX: 0, translateY: 0 });
  const [floorplanInitialTransform, setFloorplanInitialTransform] = useState<FloorplanTransform>({ scale: 1, translateX: 0, translateY: 0 });
  const [floorplanImageSize, setFloorplanImageSize] = useState<FloorplanImageSize | null>(null);
  const [floorplanImageLoadState, setFloorplanImageLoadState] = useState<FloorplanImageLoadState>('loading');
  const [floorplanImageError, setFloorplanImageError] = useState('');
  const [floorplanLoadedSrc, setFloorplanLoadedSrc] = useState('');
  const [floorplanRenderedImageSize, setFloorplanRenderedImageSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [floorplanDisplayedRect, setFloorplanDisplayedRect] = useState<{ left: number; top: number; width: number; height: number }>({ left: 0, top: 0, width: 0, height: 0 });
  const [floorplanViewportSize, setFloorplanViewportSize] = useState<{ width: number; height: number }>({ width: 1, height: 1 });
  const [floorplanSafeModeActive, setFloorplanSafeModeActive] = useState(false);
  const [floorplanDisableTransformsDebug, setFloorplanDisableTransformsDebug] = useState(false);
  const [floorplanDebugCounters, setFloorplanDebugCounters] = useState<FloorplanDebugCounters>({
    srcChangeCount: 0,
    transformRecalcCount: 0,
    resizeObserverCount: 0,
  });
  const [floorplanVisibilityDebug, setFloorplanVisibilityDebug] = useState({
    isMounted: false,
    isHidden: false,
    opacity: '1',
    display: 'block',
    zIndex: 'auto',
    layerOpacity: '1',
    layerDisplay: 'block',
    layerZIndex: 'auto',
  });
  const [bookingVersion, setBookingVersion] = useState(0);
  const [isFloorplanDragging, setIsFloorplanDragging] = useState(false);
  const [lastZoomAction, setLastZoomAction] = useState('init');

  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isUpdatingOccupancy, setIsUpdatingOccupancy] = useState(false);
  const [loadingRequestCount, setLoadingRequestCount] = useState(0);
  const [backendDown, setBackendDown] = useState(false);
  const toast = useToast();
  const { registerDeskAnchor: registerToastDeskAnchor } = toast;

  const [deskPopup, setDeskPopup] = useState<DeskPopupState | null>(null);
  const [bookingDialogState, setBookingDialogState] = useState<BookingDialogState>('IDLE');
  const [bookingFormValues, setBookingFormValues] = useState<BookingFormValues>(createDefaultBookingFormValues(today));
  const [manageTargetSlot, setManageTargetSlot] = useState<BookingFormValues['slot']>('MORNING');
  const [dialogErrorMessage, setDialogErrorMessage] = useState('');
  const [rebookConfirm, setRebookConfirm] = useState<RebookConfirmState | null>(null);
  const [isRebooking, setIsRebooking] = useState(false);
  const [cancelFlowState, setCancelFlowState] = useState<CancelFlowState>('NONE');
  const [cancelConfirmContext, setCancelConfirmContext] = useState<CancelConfirmContext | null>(null);
  const [isCancellingBooking, setIsCancellingBooking] = useState(false);
  const [cancellingBookingId, setCancellingBookingId] = useState<string | null>(null);
  const [cancelDialogError, setCancelDialogError] = useState('');
  const [cancelDebugState, setCancelDebugState] = useState<CancelDebugState>({
    lastAction: 'IDLE',
    bookingId: null,
    endpoint: '',
    httpStatus: null,
    errorMessage: ''
  });
  const [calendarBookings, setCalendarBookings] = useState<CalendarBooking[]>([]);
  const [floorplanResources, setFloorplanResources] = useState<FloorplanResource[]>([]);
  const [bookedCalendarDays, setBookedCalendarDays] = useState<string[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    params.set(OVERVIEW_QUERY_KEY, overviewView);
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
  }, [overviewView]);

  const [highlightedDeskId, setHighlightedDeskId] = useState('');
  const [deskPopupCoords, setDeskPopupCoords] = useState<PopupCoordinates | null>(null);
  const occupantRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const highlightTimerRef = useRef<number | null>(null);
  const popupRef = useRef<HTMLElement | null>(null);
  const cancelDialogRef = useRef<HTMLElement | null>(null);
  const floorplanViewportRef = useRef<HTMLDivElement | null>(null);
  const floorplanTransformLayerRef = useRef<HTMLDivElement | null>(null);
  const hasFloorplanManualTransformRef = useRef(false);
  const floorplanFitTransformRef = useRef<FloorplanTransform | null>(null);
  const floorplanFitTupleRef = useRef('');
  const previousFloorplanSrcRef = useRef('');
  const floorplanRenderCountRef = useRef(0);
  const floorplanDragRef = useRef<{ pointerId: number; startX: number; startY: number; startTranslateX: number; startTranslateY: number; moved: boolean } | null>(null);
  const floorplanSuppressClickRef = useRef(false);
  const availabilityCacheRef = useRef<Map<string, Map<string, DayAvailabilityTone>>>(new Map());
  const deskAnchorElementsRef = useRef<Map<string, HTMLElement>>(new Map());

  const refreshDeskPopupAnchorRect = useCallback((deskId: string) => {
    const anchorElement = deskAnchorElementsRef.current.get(deskId);
    if (!anchorElement) return;
    const nextAnchorRect = cloneRect(anchorElement.getBoundingClientRect());
    setDeskPopup((current) => {
      if (!current || current.deskId !== deskId) return current;
      const sameRect = current.anchorRect.left === nextAnchorRect.left
        && current.anchorRect.top === nextAnchorRect.top
        && current.anchorRect.width === nextAnchorRect.width
        && current.anchorRect.height === nextAnchorRect.height;
      if (sameRect) return current;
      return { ...current, anchorRect: nextAnchorRect };
    });
  }, []);

  const registerDeskAnchor = useCallback((deskId: string, element: HTMLElement | null) => {
    registerToastDeskAnchor(deskId, element);
    if (!element) {
      deskAnchorElementsRef.current.delete(deskId);
      return;
    }

    deskAnchorElementsRef.current.set(deskId, element);
    window.requestAnimationFrame(() => {
      refreshDeskPopupAnchorRect(deskId);
    });
  }, [refreshDeskPopupAnchorRect, registerToastDeskAnchor]);

  const selectedFloorplan = useMemo(() => floorplans.find((f) => f.id === selectedFloorplanId) ?? null, [floorplans, selectedFloorplanId]);
  const showRoomDebugInfo = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('debug') === '1';
  }, []);
  const floorplanImageSrc = useMemo(() => {
    if (!selectedFloorplan?.imageUrl) return '';
    const resolvedSrc = resolveApiUrl(selectedFloorplan.imageUrl) ?? selectedFloorplan.imageUrl;
    return encodeURI(resolvedSrc.trim());
  }, [selectedFloorplan?.imageUrl]);

  floorplanRenderCountRef.current += 1;

  const logFloorplanDebug = useCallback((event: string, payload: Record<string, unknown> = {}) => {
    if (!showRoomDebugInfo) return;
    console.log(`[${new Date().toISOString()}] ${event}`, payload);
  }, [showRoomDebugInfo]);

  const bumpFloorplanCounter = useCallback((counter: keyof FloorplanDebugCounters) => {
    if (!showRoomDebugInfo) return;
    setFloorplanDebugCounters((current) => ({ ...current, [counter]: current[counter] + 1 }));
  }, [showRoomDebugInfo]);

  const isFiniteTransform = useCallback((transform: FloorplanTransform | null | undefined): transform is FloorplanTransform => (
    Boolean(transform)
    && Number.isFinite(transform?.scale)
    && (transform?.scale ?? 0) > 0
    && Number.isFinite(transform?.translateX)
    && Number.isFinite(transform?.translateY)
  ), []);

  const applyFloorplanTransform = useCallback((candidate: FloorplanTransform, reason: string) => {
    if (!isFiniteTransform(candidate)) {
      logFloorplanDebug('INVALID_TRANSFORM_BLOCKED', { reason, candidate });
      return;
    }
    logFloorplanDebug('APPLY_TRANSFORM', { reason, scale: candidate.scale, tx: candidate.translateX, ty: candidate.translateY });
    setFloorplanTransform((current) => {
      if (current.scale === candidate.scale && current.translateX === candidate.translateX && current.translateY === candidate.translateY) return current;
      return candidate;
    });
  }, [isFiniteTransform, logFloorplanDebug]);

  useEffect(() => {
    const previousSrc = previousFloorplanSrcRef.current;
    previousFloorplanSrcRef.current = floorplanImageSrc;
    if (previousSrc !== floorplanImageSrc) bumpFloorplanCounter('srcChangeCount');
    logFloorplanDebug('FLOORPLAN_SET_SRC', {
      previousSrc,
      nextSrc: floorplanImageSrc,
      floorplanId: selectedFloorplan?.id ?? '',
      floorplanName: selectedFloorplan?.name ?? '',
    });

    hasFloorplanManualTransformRef.current = false;
    floorplanFitTransformRef.current = null;
    floorplanFitTupleRef.current = '';
    setFloorplanDisableTransformsDebug(false);
    setFloorplanImageError('');
    setFloorplanLoadedSrc('');
    setFloorplanRenderedImageSize({ width: 0, height: 0 });
    setLastZoomAction('floorplan-change');

    if (!floorplanImageSrc) {
      setFloorplanImageSize(null);
      setFloorplanImageLoadState('error');
      setFloorplanImageError('Floorplan image src is empty.');
      setFloorplanSafeModeActive(true);
      return () => logFloorplanDebug('CLEANUP_SRC_EFFECT', { src: floorplanImageSrc, hasSrc: false });
    }

    setFloorplanImageSize(null);
    setFloorplanImageLoadState('loading');
    setFloorplanSafeModeActive(false);
    setFloorplanInitialTransform({ scale: 1, translateX: 0, translateY: 0 });
    applyFloorplanTransform({ scale: 1, translateX: 0, translateY: 0 }, 'SRC_RESET');

    return () => logFloorplanDebug('CLEANUP_SRC_EFFECT', { src: floorplanImageSrc, hasSrc: true });
  }, [applyFloorplanTransform, bumpFloorplanCounter, floorplanImageSrc, logFloorplanDebug, selectedFloorplan?.id, selectedFloorplan?.name]);

  useLayoutEffect(() => {
    if (!floorplanViewportRef.current) return undefined;
    const viewport = floorplanViewportRef.current;
    let rafId: number | null = null;
    let retryCount = 0;
    const syncSize = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      setFloorplanViewportSize({ width, height });
      bumpFloorplanCounter('resizeObserverCount');
      logFloorplanDebug('WRAPPER_SIZE', { width, height });

      if ((width <= 0 || height <= 0) && retryCount < 8) {
        retryCount += 1;
        rafId = window.requestAnimationFrame(syncSize);
      } else {
        retryCount = 0;
      }
    };
    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(viewport);
    window.addEventListener('resize', syncSize);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', syncSize);
      logFloorplanDebug('CLEANUP_VIEWPORT_OBSERVER', {});
    };
  }, [bumpFloorplanCounter, logFloorplanDebug]);

  useEffect(() => {
    if (floorplanImageLoadState !== 'loaded') return;
    const imgW = floorplanImageSize?.width ?? 0;
    const imgH = floorplanImageSize?.height ?? 0;
    const vw = floorplanViewportSize.width;
    const vh = floorplanViewportSize.height;
    if (!floorplanImageSrc || imgW <= 0 || imgH <= 0 || vw <= 0 || vh <= 0) {
      setFloorplanSafeModeActive(true);
      logFloorplanDebug('APPLY_TRANSFORM_SKIPPED', { reason: 'MISSING_DIMENSIONS', floorplanImageSrc, imgW, imgH, vw, vh });
      return;
    }

    const availableWidth = vw - FLOORPLAN_FIT_PADDING * 2;
    const availableHeight = vh - FLOORPLAN_FIT_PADDING * 2;
    if (availableWidth <= 0 || availableHeight <= 0) {
      setFloorplanSafeModeActive(true);
      logFloorplanDebug('APPLY_TRANSFORM_SKIPPED', { reason: 'NO_AVAILABLE_SPACE', availableWidth, availableHeight });
      return;
    }

    const fitScale = Math.min(availableWidth / imgW, availableHeight / imgH, FLOORPLAN_MAX_SCALE);
    if (!Number.isFinite(fitScale) || fitScale <= 0) {
      setFloorplanSafeModeActive(true);
      logFloorplanDebug('APPLY_TRANSFORM_SKIPPED', { reason: 'INVALID_SCALE', fitScale, imgW, imgH, vw, vh });
      return;
    }

    const fitTransform: FloorplanTransform = {
      scale: fitScale,
      translateX: (vw - imgW * fitScale) / 2,
      translateY: (vh - imgH * fitScale) / 2,
    };

    if (!isFiniteTransform(fitTransform)) {
      setFloorplanSafeModeActive(true);
      logFloorplanDebug('INVALID_TRANSFORM_BLOCKED', { reason: 'FIT_COMPUTE', fitTransform });
      return;
    }

    const nextTuple = `${floorplanImageSrc}|${imgW}x${imgH}|${vw}x${vh}`;
    const previousTuple = floorplanFitTupleRef.current;
    floorplanFitTupleRef.current = nextTuple;
    floorplanFitTransformRef.current = fitTransform;
    setFloorplanInitialTransform(fitTransform);
    setFloorplanSafeModeActive(false);
    bumpFloorplanCounter('transformRecalcCount');

    if (!hasFloorplanManualTransformRef.current || previousTuple !== nextTuple) {
      applyFloorplanTransform(fitTransform, previousTuple === nextTuple ? 'FIT_RECALC_VIEWPORT' : 'FIT_RECALC_SRC_OR_VIEWPORT');
    }

    return () => logFloorplanDebug('CLEANUP_FIT_EFFECT', { tuple: nextTuple });
  }, [applyFloorplanTransform, bumpFloorplanCounter, floorplanImageLoadState, floorplanImageSize?.height, floorplanImageSize?.width, floorplanImageSrc, floorplanViewportSize.height, floorplanViewportSize.width, isFiniteTransform, logFloorplanDebug]);

  useEffect(() => {
    if (!showRoomDebugInfo) return;
    console.log('FLOORPLAN_TRANSFORM', {
      scale: floorplanTransform.scale,
      tx: floorplanTransform.translateX,
      ty: floorplanTransform.translateY,
      finite: {
        scale: Number.isFinite(floorplanTransform.scale),
        tx: Number.isFinite(floorplanTransform.translateX),
        ty: Number.isFinite(floorplanTransform.translateY),
      },
    });
  }, [floorplanTransform.scale, floorplanTransform.translateX, floorplanTransform.translateY, showRoomDebugInfo]);

  useEffect(() => {
    if (!showRoomDebugInfo) return;
    const viewport = floorplanViewportRef.current;
    const layer = floorplanTransformLayerRef.current;
    const viewportStyle = viewport ? window.getComputedStyle(viewport) : null;
    const layerStyle = layer ? window.getComputedStyle(layer) : null;
    setFloorplanVisibilityDebug({
      isMounted: Boolean(viewport),
      isHidden: viewportStyle ? (viewportStyle.visibility === 'hidden' || viewportStyle.display === 'none' || Number(viewportStyle.opacity) <= 0) : false,
      opacity: viewportStyle?.opacity ?? '-',
      display: viewportStyle?.display ?? '-',
      zIndex: viewportStyle?.zIndex ?? '-',
      layerOpacity: layerStyle?.opacity ?? '-',
      layerDisplay: layerStyle?.display ?? '-',
      layerZIndex: layerStyle?.zIndex ?? '-',
    });
  }, [floorplanImageLoadState, floorplanTransform.scale, floorplanTransform.translateX, floorplanTransform.translateY, floorplanViewportSize.height, floorplanViewportSize.width, showRoomDebugInfo]);

  const handleFloorplanImageLoad = useCallback(({ width, height, src }: { width: number; height: number; src: string }) => {
    setFloorplanImageSize({ width, height });
    setFloorplanImageLoadState('loaded');
    setFloorplanImageError('');
    setFloorplanLoadedSrc(src);
    logFloorplanDebug('IMG_ONLOAD', { src, naturalWidth: width, naturalHeight: height });
  }, [logFloorplanDebug]);

  const handleFloorplanImageError = useCallback(({ src, message }: { src: string; message: string }) => {
    setFloorplanImageLoadState('error');
    setFloorplanImageError('Floorplan Bild konnte nicht geladen werden.');
    setFloorplanLoadedSrc(src);
    setFloorplanImageSize(null);
    logFloorplanDebug('IMG_ONERROR', { src, message });
  }, [logFloorplanDebug]);

  const floorplanMinScale = getFloorplanMinScale(floorplanInitialTransform.scale);


  const applyFloorplanZoom = useCallback((zoomDirection: 'in' | 'out') => {
    const factor = zoomDirection === 'in' ? FLOORPLAN_ZOOM_STEP : 1 / FLOORPLAN_ZOOM_STEP;
    setFloorplanTransform((current) => {
      const nextScale = clamp(current.scale * factor, floorplanMinScale, FLOORPLAN_MAX_SCALE);
      if (nextScale === current.scale) return current;
      const centerX = floorplanViewportSize.width / 2;
      const centerY = floorplanViewportSize.height / 2;
      const safeScale = Number.isFinite(current.scale) && current.scale > 0 ? current.scale : 1;
      const worldX = (centerX - current.translateX) / safeScale;
      const worldY = (centerY - current.translateY) / safeScale;
      const nextTransform: FloorplanTransform = {
        scale: nextScale,
        translateX: centerX - worldX * nextScale,
        translateY: centerY - worldY * nextScale,
      };
      if (!isFiniteTransform(nextTransform)) {
        logFloorplanDebug('INVALID_TRANSFORM_BLOCKED', { reason: 'ZOOM_BUTTON', nextTransform });
        return current;
      }
      hasFloorplanManualTransformRef.current = true;
      setLastZoomAction(zoomDirection === 'in' ? 'plus' : 'minus');
      logFloorplanDebug('APPLY_TRANSFORM', { reason: 'ZOOM_BUTTON', ...nextTransform });
      return nextTransform;
    });
  }, [floorplanMinScale, floorplanViewportSize.height, floorplanViewportSize.width, isFiniteTransform, logFloorplanDebug]);

  const applyFloorplanZoomAtPoint = useCallback((factor: number, focalX: number, focalY: number) => {
    setFloorplanTransform((current) => {
      const nextScale = clamp(current.scale * factor, floorplanMinScale, FLOORPLAN_MAX_SCALE);
      if (nextScale === current.scale) return current;
      const safeScale = Number.isFinite(current.scale) && current.scale > 0 ? current.scale : 1;
      const worldX = (focalX - current.translateX) / safeScale;
      const worldY = (focalY - current.translateY) / safeScale;
      const nextTransform: FloorplanTransform = {
        scale: nextScale,
        translateX: focalX - worldX * nextScale,
        translateY: focalY - worldY * nextScale,
      };
      if (!isFiniteTransform(nextTransform)) {
        logFloorplanDebug('INVALID_TRANSFORM_BLOCKED', { reason: 'ZOOM_WHEEL', nextTransform });
        return current;
      }
      hasFloorplanManualTransformRef.current = true;
      setLastZoomAction('wheel');
      logFloorplanDebug('APPLY_TRANSFORM', { reason: 'ZOOM_WHEEL', ...nextTransform });
      return nextTransform;
    });
  }, [floorplanMinScale, isFiniteTransform, logFloorplanDebug]);

  const canPanFloorplan = floorplanTransform.scale > floorplanMinScale + FLOORPLAN_DRAG_EPSILON;

  const stopFloorplanDragging = useCallback((pointerId?: number) => {
    if (!floorplanDragRef.current) return;
    if (typeof pointerId === 'number' && floorplanDragRef.current.pointerId !== pointerId) return;
    if (floorplanViewportRef.current?.hasPointerCapture(floorplanDragRef.current.pointerId)) floorplanViewportRef.current.releasePointerCapture(floorplanDragRef.current.pointerId);
    floorplanDragRef.current = null;
    setIsFloorplanDragging(false);
  }, []);

  const handleFloorplanPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!canPanFloorplan || event.button !== 0 || !floorplanViewportRef.current) return;
    if (event.target !== event.currentTarget) return;
    floorplanSuppressClickRef.current = false;
    floorplanDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTranslateX: floorplanTransform.translateX,
      startTranslateY: floorplanTransform.translateY,
      moved: false,
    };
    floorplanViewportRef.current.setPointerCapture(event.pointerId);
    setIsFloorplanDragging(true);
    setLastZoomAction('pan-start');
  }, [canPanFloorplan, floorplanTransform.translateX, floorplanTransform.translateY]);

  const handleFloorplanPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!floorplanDragRef.current || floorplanDragRef.current.pointerId !== event.pointerId) return;
    const drag = floorplanDragRef.current;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 3) {
      drag.moved = true;
      floorplanSuppressClickRef.current = true;
      setLastZoomAction('drag');
    }
    hasFloorplanManualTransformRef.current = true;
    setFloorplanTransform((current) => {
      const nextTransform: FloorplanTransform = {
        ...current,
        translateX: drag.startTranslateX + deltaX,
        translateY: drag.startTranslateY + deltaY,
      };
      if (!isFiniteTransform(nextTransform)) {
        logFloorplanDebug('INVALID_TRANSFORM_BLOCKED', { reason: 'PAN_DRAG', nextTransform });
        return current;
      }
      return nextTransform;
    });
  }, [isFiniteTransform, logFloorplanDebug]);

  const handleFloorplanPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    stopFloorplanDragging(event.pointerId);
  }, [stopFloorplanDragging]);

  const handleFloorplanPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    stopFloorplanDragging(event.pointerId);
  }, [stopFloorplanDragging]);


  const handleFloorplanClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!floorplanSuppressClickRef.current) return;
    floorplanSuppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleFloorplanWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (!floorplanViewportRef.current) return;
    event.preventDefault();
    const viewportRect = floorplanViewportRef.current.getBoundingClientRect();
    const focalX = event.clientX - viewportRect.left;
    const focalY = event.clientY - viewportRect.top;
    const factor = event.deltaY < 0 ? FLOORPLAN_ZOOM_STEP : 1 / FLOORPLAN_ZOOM_STEP;
    applyFloorplanZoomAtPoint(factor, focalX, focalY);
  }, [applyFloorplanZoomAtPoint]);

  const resetFloorplanView = useCallback(() => {
    stopFloorplanDragging();
    hasFloorplanManualTransformRef.current = false;
    setLastZoomAction('reset');
    applyFloorplanTransform(floorplanFitTransformRef.current ?? floorplanInitialTransform, 'RESET_BUTTON');
  }, [applyFloorplanTransform, floorplanInitialTransform, stopFloorplanDragging]);
  const employeesByEmail = useMemo(() => new Map(employees.map((employee) => [employee.email.toLowerCase(), employee])), [employees]);
  const employeesById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const desks = useMemo(() => enrichDeskBookings({
    desks: occupancy?.desks ?? [],
    employeesById,
    employeesByEmail,
    currentUserEmail,
    currentUserId: currentUser?.id
  }), [occupancy?.desks, employeesByEmail, employeesById, currentUserEmail, currentUser?.id]);
  const selectableResourceKinds = useMemo(() => {
    const availableKinds = new Set<ResourceKind>();
    for (const desk of desks) {
      availableKinds.add((desk.kind ?? 'SONSTIGES') as ResourceKind);
    }
    return RESOURCE_KIND_OPTIONS.filter((option) => availableKinds.has(option.value));
  }, [desks]);
  const desksBySelectedResourceKind = useMemo(() => {
    if (selectedResourceKindFilter === 'ALL') return desks;
    return desks.filter((desk) => (desk.kind ?? 'SONSTIGES') === selectedResourceKindFilter);
  }, [desks, selectedResourceKindFilter]);
  const filteredDesks = useMemo(() => desksBySelectedResourceKind.map((desk) => ({ ...desk, isHighlighted: desk.id === highlightedDeskId })), [desksBySelectedResourceKind, highlightedDeskId]);
  const bookingsForSelectedDate = useMemo<OccupantForDay[]>(() => mapBookingsForDay(desksBySelectedResourceKind), [desksBySelectedResourceKind]);
  const roomsForSelectedDate = useMemo(() => desksBySelectedResourceKind
    .filter((desk) => isRoomResource(desk))
    .map((room) => ({ room, bookings: normalizeDeskBookings(room) })), [desksBySelectedResourceKind]);
  const myBookingsForSelectedDate = useMemo(() => desksBySelectedResourceKind.flatMap((desk) => normalizeDeskBookings(desk)
    .filter((booking) => booking.isCurrentUser)
    .map((booking) => ({ desk, booking }))), [desksBySelectedResourceKind]);
  const popupDesk = useMemo(() => (deskPopup ? desks.find((desk) => desk.id === deskPopup.deskId) ?? null : null), [desks, deskPopup]);
  const popupDeskAvailability = useMemo(() => getDeskSlotAvailability(popupDesk), [popupDesk]);
  const popupDeskBookings = useMemo(() => (popupDesk ? normalizeDeskBookings(popupDesk) : []), [popupDesk]);
  const popupRoomBookingsForSelectedDay = useMemo<RoomAvailabilityBooking[]>(() => {
    if (!popupDesk || !isRoomResource(popupDesk)) return [];
    if (roomAvailability && roomAvailability.resource.id === popupDesk.id && roomAvailability.date === selectedDate) {
      return roomAvailability.bookings
        .map((booking) => ({
          id: booking.id,
          startTime: booking.startTime,
          endTime: booking.endTime,
          user: booking.user
        }))
        .sort((left, right) => (bookingTimeToMinutes(left.startTime) ?? 0) - (bookingTimeToMinutes(right.startTime) ?? 0));
    }

    return popupDeskBookings
      .map((booking) => ({
        id: booking.id ?? `${booking.userEmail}-${booking.startTime}-${booking.endTime}`,
        startTime: booking.startTime ?? null,
        endTime: booking.endTime ?? null,
        user: { email: booking.userEmail, name: booking.userDisplayName }
      }))
      .sort((left, right) => (bookingTimeToMinutes(left.startTime) ?? 0) - (bookingTimeToMinutes(right.startTime) ?? 0));
  }, [popupDesk, popupDeskBookings, roomAvailability, selectedDate]);
  const popupRoomOccupiedIntervals = useMemo(() => mergeIntervals(popupRoomBookingsForSelectedDay
    .flatMap((booking) => {
      const start = bookingTimeToMinutes(booking.startTime);
      const end = bookingTimeToMinutes(booking.endTime);
      if (start === null || end === null || end <= start) return [];
      const clamped = clampInterval({ startMin: start, endMin: end }, ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES);
      return clamped ? [clamped] : [];
    })), [popupRoomBookingsForSelectedDay]);
  const popupRoomFreeIntervals = useMemo(() => invertIntervals(ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES, popupRoomOccupiedIntervals), [popupRoomOccupiedIntervals]);
  const popupRoomOccupiedSegments = useMemo(() => intervalsToSegments(ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES, popupRoomOccupiedIntervals), [popupRoomOccupiedIntervals]);
  const popupRoomBookingsList = useMemo<RoomBookingListEntry[]>(() => {
    const rendered = popupRoomBookingsForSelectedDay
      .flatMap((booking) => {
        const start = bookingTimeToMinutes(booking.startTime);
        const end = bookingTimeToMinutes(booking.endTime);
        if (start === null || end === null || end <= start) return [];
        const clamped = clampInterval({ startMin: start, endMin: end }, ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES);
        if (!clamped) return [];
        const bookingEmail = booking.user.email.toLowerCase();
        const isCurrentUser = Boolean(currentUserEmail && bookingEmail === currentUserEmail.toLowerCase());
        return [{
          id: booking.id,
          start: clamped.startMin,
          end: clamped.endMin,
          label: `${formatMinutes(clamped.startMin)} – ${formatMinutes(clamped.endMin)}`,
          person: booking.user.name ?? booking.user.email,
          bookingId: booking.id,
          isCurrentUser,
          isRecurring: false
        }];
      })
      .sort((a, b) => a.start - b.start);

    return rendered;
  }, [popupRoomBookingsForSelectedDay, currentUserEmail]);
  const popupRoomFreeSlotChips = useMemo(() => popupRoomFreeIntervals
    .filter((interval) => interval.endMin - interval.startMin >= 30)
    .map((interval) => ({
      startTime: formatMinutes(interval.startMin),
      endTime: formatMinutes(interval.endMin),
      label: `${formatMinutes(interval.startMin)} – ${formatMinutes(interval.endMin)}`
    })), [popupRoomFreeIntervals]);
  const roomDebugInfo = useMemo(() => {
    if (!showRoomDebugInfo || !popupDesk || !isRoomResource(popupDesk)) return undefined;

    const formatIntervalList = (intervals: Array<{ startMin: number; endMin: number }>): string => {
      if (intervals.length === 0) return '—';
      return intervals.map((interval) => `${formatMinutes(interval.startMin)}–${formatMinutes(interval.endMin)}`).join(', ');
    };

    return [
      `window: ${ROOM_WINDOW_START}–${ROOM_WINDOW_END} (${ROOM_WINDOW_TOTAL_MINUTES} min)`,
      `mergedOccupied: ${formatIntervalList(popupRoomOccupiedIntervals)}`,
      `free: ${formatIntervalList(popupRoomFreeIntervals)}`,
      `segments: ${popupRoomOccupiedSegments.length > 0 ? popupRoomOccupiedSegments.map((segment) => `[${segment.p0.toFixed(3)}..${segment.p1.toFixed(3)}]`).join(', ') : '—'}`
    ];
  }, [popupDesk, popupRoomFreeIntervals, popupRoomOccupiedIntervals, popupRoomOccupiedSegments, showRoomDebugInfo]);

  const floorplanFitScaleForDebug = useMemo(() => {
    if (!floorplanImageSize?.width || !floorplanImageSize?.height) return null;
    if (floorplanViewportSize.width <= 0 || floorplanViewportSize.height <= 0) return null;
    const availableWidth = Math.max(1, floorplanViewportSize.width - FLOORPLAN_FIT_PADDING * 2);
    const availableHeight = Math.max(1, floorplanViewportSize.height - FLOORPLAN_FIT_PADDING * 2);
    const fitScale = Math.min(Math.min(availableWidth / floorplanImageSize.width, availableHeight / floorplanImageSize.height), FLOORPLAN_MAX_SCALE);
    return Number.isFinite(fitScale) ? fitScale : null;
  }, [floorplanImageSize?.height, floorplanImageSize?.width, floorplanViewportSize.height, floorplanViewportSize.width]);

  const hasValidTransformData = Number.isFinite(floorplanTransform.scale) && floorplanTransform.scale > 0
    && Number.isFinite(floorplanTransform.translateX)
    && Number.isFinite(floorplanTransform.translateY)
    && floorplanViewportSize.width > 0
    && floorplanViewportSize.height > 0
    && (floorplanImageSize?.width ?? 0) > 0
    && (floorplanImageSize?.height ?? 0) > 0;
  const floorplanTransformEnabled = !floorplanSafeModeActive && !floorplanDisableTransformsDebug && hasValidTransformData;
  const floorplanTransformStyle = floorplanTransformEnabled
    ? { transform: `translate3d(${floorplanTransform.translateX}px, ${floorplanTransform.translateY}px, 0) scale(${floorplanTransform.scale})` }
    : undefined;
  const resourcesCount = occupancy?.desks.length ?? 0;
  const bookingsCount = useMemo(() => (occupancy?.desks ?? []).reduce((total, desk) => total + normalizeDeskBookings(desk).length, 0), [occupancy?.desks]);
  const floorplanMarkersCount = filteredDesks.filter((desk) => Number.isFinite(desk.x) && Number.isFinite(desk.y)).length;
  const floorplanCanvasDesks = floorplanImageLoadState === 'loaded'
    ? filteredDesks.filter((desk) => Number.isFinite(desk.x) && Number.isFinite(desk.y))
    : [];
  const shouldWarnMissingMarkers = floorplanImageLoadState === 'loaded' && resourcesCount > 0 && floorplanMarkersCount === 0;
  const roomBookingConflict = useMemo(() => {
    if (!popupDesk || !isRoomResource(popupDesk)) return '';
    const start = bookingTimeToMinutes(bookingFormValues.startTime);
    const end = bookingTimeToMinutes(bookingFormValues.endTime);
    if (start === null || end === null || end <= start) return '';
    const conflict = popupRoomOccupiedIntervals.find((interval) => start < interval.endMin && end > interval.startMin);
    if (!conflict) return '';
    return `Kollidiert mit ${formatMinutes(conflict.startMin)} – ${formatMinutes(conflict.endMin)}`;
  }, [popupDesk, bookingFormValues.startTime, bookingFormValues.endTime, popupRoomOccupiedIntervals]);
  const popupMyBookings = useMemo(() => popupDeskBookings.filter((booking) => booking.isCurrentUser), [popupDeskBookings]);
  const popupMySelectedBooking = useMemo(() => {
    if (!popupDesk || isRoomResource(popupDesk) || popupMyBookings.length === 0) return null;

    const selectedSlot = bookingFormValues.slot;
    const toRange = (slot?: string): { start: number; end: number } => {
      if (slot === 'AM' || slot === 'MORNING') return { start: 0, end: 1 };
      if (slot === 'PM' || slot === 'AFTERNOON') return { start: 1, end: 2 };
      return { start: 0, end: 2 };
    };

    const target = toRange(selectedSlot);
    const overlapping = popupMyBookings.filter((booking) => {
      const source = toRange(booking.daySlot ?? booking.slot);
      return source.start < target.end && source.end > target.start;
    });

    if (overlapping.length > 0) return overlapping[0];
    return popupMyBookings[0];
  }, [bookingFormValues.slot, popupDesk, popupMyBookings]);
  const hasUnexpectedMultipleMyBookings = popupMyBookings.length > 1;
  const popupMode: 'create' | 'manage' = popupMySelectedBooking && popupDesk && !isRoomResource(popupDesk) ? 'manage' : 'create';
  const popupDeskState = popupDesk ? (popupMode === 'manage' ? 'MINE' : !canBookDesk(popupDesk) ? (popupDesk.isCurrentUsersDesk ? 'MINE' : 'TAKEN') : 'FREE') : null;
  const popupOwnBookingIsRecurring = useMemo(() => popupDeskBookings.some((booking) => booking.isCurrentUser && booking.type === 'recurring'), [popupDeskBookings]);
  const manageSlotConflict = useMemo(() => {
    if (!popupDesk || !popupMySelectedBooking || isRoomResource(popupDesk)) return '';
    const conflict = popupDeskBookings.find((booking) => {
      if (!booking.id || booking.id === popupMySelectedBooking.id) return false;
      const isFullDay = booking.daySlot === 'FULL' || booking.slot === 'FULL_DAY';
      const isMorning = booking.daySlot === 'AM' || booking.slot === 'MORNING';
      const isAfternoon = booking.daySlot === 'PM' || booking.slot === 'AFTERNOON';
      if (manageTargetSlot === 'FULL_DAY') return true;
      if (manageTargetSlot === 'MORNING') {
        return isFullDay || isMorning;
      }
      return isFullDay || isAfternoon;
    });
    if (!conflict) return '';
    return `Der Zeitraum ${manageTargetSlot === 'MORNING' ? 'Vormittag' : manageTargetSlot === 'AFTERNOON' ? 'Nachmittag' : 'Ganztag'} ist bereits belegt.`;
  }, [manageTargetSlot, popupDesk, popupDeskBookings, popupMySelectedBooking]);
  const cancelConfirmDesk = useMemo(() => (cancelConfirmContext ? desks.find((desk) => desk.id === cancelConfirmContext.deskId) ?? null : null), [desks, cancelConfirmContext]);
  const cancelConfirmBookingLabel = cancelConfirmContext?.bookingLabel ?? bookingSlotLabel(cancelConfirmDesk?.booking);
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const calendarRange = useMemo(() => ({
    from: toDateKey(calendarDays[0]),
    to: toDateKey(calendarDays[calendarDays.length - 1])
  }), [calendarDays]);
  const bookedCalendarDaysSet = useMemo(() => new Set(bookedCalendarDays), [bookedCalendarDays]);
  const dayAvailabilityByDate = useMemo(() => {
    const monthKey = `${visibleMonth.getUTCFullYear()}-${visibleMonth.getUTCMonth() + 1}`;
    const cacheKey = `${selectedFloorplanId}|${monthKey}|${bookingVersion}`;
    const cached = availabilityCacheRef.current.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextAvailability = new Map<string, DayAvailabilityTone>();

    const resourcesByFloorplan = floorplanResources.filter((resource) => resource.floorplanId === selectedFloorplanId && resource.kind === selectedFloorplan?.defaultResourceKind);
    const total = resourcesByFloorplan.length;
    if (total === 0) {
      availabilityCacheRef.current.set(cacheKey, nextAvailability);
      return nextAvailability;
    }

    const resourceIds = new Set(resourcesByFloorplan.map((resource) => resource.id));
    const bookedByDay = new Map<string, Set<string>>();

    for (const booking of calendarBookings) {
      if (!resourceIds.has(booking.deskId)) continue;
      const dayKey = toBookingDateKey(booking.date);
      const bookedResources = bookedByDay.get(dayKey) ?? new Set<string>();
      bookedResources.add(booking.deskId);
      bookedByDay.set(dayKey, bookedResources);
    }

    for (const day of calendarDays) {
      const dayKey = toDateKey(day);
      const booked = bookedByDay.get(dayKey)?.size ?? 0;
      const free = total - booked;
      const freeRatio = free / total;
      if (free <= 0) {
        nextAvailability.set(dayKey, 'none-free');
      } else if (freeRatio <= 0.33) {
        nextAvailability.set(dayKey, 'few-free');
      } else {
        nextAvailability.set(dayKey, 'many-free');
      }
    }

    availabilityCacheRef.current.set(cacheKey, nextAvailability);
    return nextAvailability;
  }, [bookingVersion, calendarBookings, calendarDays, floorplanResources, selectedFloorplan?.defaultResourceKind, selectedFloorplanId, visibleMonth]);
  const isAppLoading = loadingRequestCount > 0;

  const runWithAppLoading = async <T,>(operation: () => Promise<T>): Promise<T> => {
    setLoadingRequestCount((count) => count + 1);
    try {
      return await operation();
    } finally {
      setLoadingRequestCount((count) => Math.max(0, count - 1));
    }
  };

  const loadOccupancy = async (floorplanId: string, date: string): Promise<OccupancyResponse | null> => {
    if (!floorplanId) return null;

    setIsUpdatingOccupancy(true);

    try {
      const nextOccupancy = await runWithAppLoading(() => get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`));

      setOccupancy(nextOccupancy);
      markBackendAvailable(true);
      setBackendDown(false);
      setSelectedDeskId((prev) => (nextOccupancy.desks.some((desk) => desk.id === prev) ? prev : ''));
      return nextOccupancy;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
      }
      toast.error(getApiErrorMessage(error, 'Belegung konnte nicht geladen werden.'));
      return null;
    } finally {
      setIsUpdatingOccupancy(false);
    }
  };

  const loadInitial = async () => {
    setIsBootstrapping(true);

    try {
      await runWithAppLoading(async () => {
        const healthy = await checkBackendHealth();
        if (!healthy) {
          setBackendDown(true);
          return;
        }

        const [nextFloorplans, nextEmployees] = await Promise.all([get<RawFloorplan[]>('/floorplans'), get<BookingEmployee[]>('/employees')]);
        const normalizedFloorplans: Floorplan[] = nextFloorplans.map((floorplan) => ({
          ...floorplan,
          imageUrl: floorplan.imageUrl || floorplan.imageURL || floorplan.image || ''
        }));
        setFloorplans(normalizedFloorplans);
        setEmployees(nextEmployees);
        setSelectedFloorplanId((prev) => prev || normalizedFloorplans.find((plan) => plan.isDefault)?.id || normalizedFloorplans[0]?.id || '');
        setSelectedEmployeeEmail((prev) => prev || currentUserEmail || nextEmployees[0]?.email || '');
        setBackendDown(false);
      });
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
      setCalendarBookings([]);
      setBookedCalendarDays([]);
      return;
    }

    let cancelled = false;

    const loadCalendarBookings = async () => {
      try {
        const calendarBookings = await runWithAppLoading(() => get<CalendarBooking[]>(`/bookings?from=${calendarRange.from}&to=${calendarRange.to}`));
        if (cancelled) return;
        setCalendarBookings(calendarBookings);
        setBookedCalendarDays(Array.from(new Set(calendarBookings.map((booking) => toBookingDateKey(booking.date)))));
      } catch {
        if (cancelled) return;
        setCalendarBookings([]);
        setBookedCalendarDays([]);
      }
    };

    loadCalendarBookings();

    return () => {
      cancelled = true;
    };
  }, [backendDown, calendarRange.from, calendarRange.to]);

  useEffect(() => {
    availabilityCacheRef.current.clear();
  }, [selectedFloorplanId, visibleMonth, bookingVersion, floorplanResources, selectedFloorplan?.defaultResourceKind]);

  useEffect(() => {
    if (!selectedFloorplanId || backendDown) {
      setFloorplanResources([]);
      return;
    }

    let cancelled = false;

    const loadFloorplanResources = async () => {
      try {
        const resources = await runWithAppLoading(() => get<FloorplanResource[]>(`/floorplans/${selectedFloorplanId}/desks`));
        if (cancelled) return;
        setFloorplanResources(resources);
      } catch {
        if (cancelled) return;
        setFloorplanResources([]);
      }
    };

    loadFloorplanResources();

    return () => {
      cancelled = true;
    };
  }, [backendDown, selectedFloorplanId]);


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

    const popupRect = popupRef.current.getBoundingClientRect();
    setDeskPopupCoords(calculatePopupCoordinates(deskPopup.anchorRect, popupRect));
  }, [deskPopup, bookingDialogState, popupDeskState, dialogErrorMessage]);


  useEffect(() => {
    if (!deskPopup) return;

    const frame = window.requestAnimationFrame(() => {
      refreshDeskPopupAnchorRect(deskPopup.deskId);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [bookingVersion, deskPopup, refreshDeskPopupAnchorRect]);

  useEffect(() => {
    if (!deskPopup) return;

    const closePopup = () => {
      closeBookingFlow();
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (cancelFlowState === 'CANCEL_CONFIRM_OPEN') return;
      if (event.key === 'Escape') {
        closePopup();
      }
    };

    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (cancelFlowState === 'CANCEL_CONFIRM_OPEN') return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target)) return;
      if (cancelDialogRef.current?.contains(target)) return;
      const anchorElement = deskAnchorElementsRef.current.get(deskPopup.deskId);
      if (anchorElement?.contains(target)) return;
      closePopup();
    };

    const closeOnViewportChange = () => {
      if (cancelFlowState === 'CANCEL_CONFIRM_OPEN') return;
      closePopup();
    };

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
  }, [cancelFlowState, deskPopup]);


  useEffect(() => {
    if (!popupMySelectedBooking) return;
    if (popupMySelectedBooking.daySlot === 'FULL' || popupMySelectedBooking.slot === 'FULL_DAY') {
      setManageTargetSlot('FULL_DAY');
      return;
    }
    if (popupMySelectedBooking.daySlot === 'PM' || popupMySelectedBooking.slot === 'AFTERNOON') {
      setManageTargetSlot('AFTERNOON');
      return;
    }
    setManageTargetSlot('MORNING');
  }, [popupMySelectedBooking?.id]);

  useEffect(() => {
    if (!popupDesk || !isRoomResource(popupDesk)) {
      setRoomAvailability(null);
      return;
    }

    let cancelled = false;
    runWithAppLoading(async () => {
      const response = await get<RoomAvailabilityResponse>(`/resources/${encodeURIComponent(popupDesk.id)}/availability?date=${encodeURIComponent(selectedDate)}`);
      if (cancelled) return;
      setRoomAvailability(response);
    }).catch((error) => {
      if (cancelled) return;
      setRoomAvailability(null);
      toast.error(getApiErrorMessage(error, 'Raumverfügbarkeit konnte nicht geladen werden.'));
    });

    return () => {
      cancelled = true;
    };
  }, [popupDesk, selectedDate]);

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

    const anchorRect = cloneRect(anchorEl.getBoundingClientRect());

    if (deskPopup?.deskId === deskId) {
      closeBookingFlow();
      return;
    }

    setSelectedDeskId(deskId);
    triggerDeskHighlight(deskId);
    setDeskPopup({ deskId, anchorRect, openedAt: Date.now() });
    setRebookConfirm(null);
    setIsRebooking(false);
    setCancelFlowState('DESK_POPOVER_OPEN');
    setCancelConfirmContext(null);
    setIsCancellingBooking(false);
    setCancelDialogError('');
    setDialogErrorMessage('');
    setIsManageEditOpen(false);

    if (canBookDesk(desk)) {
      const defaults = createDefaultBookingFormValues(selectedDate);
      if (!isRoomResource(desk)) {
        const nextSlot = getDefaultSlotForDesk(desk);
        if (nextSlot) defaults.slot = nextSlot;
      } else {
        const occupiedIntervals = mergeIntervals(normalizeDeskBookings(desk).flatMap((booking) => {
          const start = bookingTimeToMinutes(booking.startTime);
          const end = bookingTimeToMinutes(booking.endTime);
          if (start === null || end === null || end <= start) return [];
          const clamped = clampInterval({ startMin: start, endMin: end }, ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES);
          return clamped ? [clamped] : [];
        }));
        const freeIntervals = invertIntervals(ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES, occupiedIntervals);
        const firstFreeSlot = freeIntervals.find((interval) => interval.endMin > interval.startMin);

        if (firstFreeSlot) {
          const startMinutes = firstFreeSlot.startMin;
          const endMinutes = Math.min(firstFreeSlot.startMin + 60, firstFreeSlot.endMin);
          defaults.startTime = formatMinutes(startMinutes);
          defaults.endTime = formatMinutes(endMinutes);
        } else {
          defaults.startTime = '';
          defaults.endTime = '';
        }
      }
      setBookingFormValues(defaults);
      setManageTargetSlot(defaults.slot);
      setBookingDialogState('BOOKING_OPEN');
    } else {
      setBookingDialogState('IDLE');
    }

    const row = occupantRowRefs.current[deskId];
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  const reloadBookings = async (options?: { requestId?: string; roomId?: string; date?: string }): Promise<OccupancyResponse | null> => {
    const refreshed = await loadOccupancy(selectedFloorplanId, options?.date ?? selectedDate);
    if (options?.requestId && options.roomId && refreshed) {
      const roomDesk = refreshed.desks.find((desk) => desk.id === options.roomId);
      const roomDeskBookings = roomDesk ? normalizeDeskBookings(roomDesk) : [];
      const roomBookingsCount = roomDeskBookings.length;
      console.log('[ROOM] freshBookings ids', roomDeskBookings.map((booking) => booking.id));
      logMutation('ROOM_REFETCH_DONE', { requestId: options.requestId, roomId: options.roomId, count: roomBookingsCount });
    }
    return refreshed;
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
    setCancellingBookingId(null);
    setCancelDialogError('');
    setIsManageEditOpen(false);
  };

  const updateCancelDebug = useCallback((next: Partial<CancelDebugState> & { lastAction: CancelDebugAction }) => {
    setCancelDebugState((current) => ({
      ...current,
      ...next
    }));
  }, []);

  const openCancelConfirm = () => {
    if (!deskPopup || !popupDesk || popupDeskState !== 'MINE') return;
    const ownBooking = normalizeDeskBookings(popupDesk).find((booking) => booking.isCurrentUser);
    if (!ownBooking) return;
    const bookingIds = ownBooking.sourceBookingIds?.length
      ? ownBooking.sourceBookingIds
      : ownBooking.id
        ? [ownBooking.id]
        : [];
    if (bookingIds.length === 0) return;

    setCancelConfirmContext({
      ...deskPopup,
      bookingIds,
      bookingLabel: bookingSlotLabel(ownBooking),
      isRecurring: normalizeDeskBookings(popupDesk).some((booking) => booking.isCurrentUser && booking.type === 'recurring'),
      keepPopoverOpen: true
    });
    setCancelDialogError('');
    setIsCancellingBooking(false);
    setCancellingBookingId(null);
    setCancelFlowState('CANCEL_CONFIRM_OPEN');
  };

  const cancelCancelConfirm = () => {
    if (!cancelConfirmContext) {
      closeBookingFlow();
      return;
    }

    setCancelDialogError('');
    setIsCancellingBooking(false);
    setCancellingBookingId(null);
    setCancelConfirmContext(null);
    setCancelFlowState('DESK_POPOVER_OPEN');
  };

  const submitPopupBooking = async (deskId: string, payload: BookingSubmitPayload, overwrite = false) => {
    if (!selectedEmployeeEmail) {
      throw new Error('Bitte Mitarbeiter auswählen.');
    }

    if (payload.type === 'single') {
      await runWithAppLoading(() => post('/bookings', { deskId, userEmail: selectedEmployeeEmail, date: payload.date, daySlot: payload.slot === 'FULL_DAY' ? 'FULL' : payload.slot === 'MORNING' ? 'AM' : payload.slot === 'AFTERNOON' ? 'PM' : undefined, startTime: payload.startTime, endTime: payload.endTime, overwrite }));
      toast.success(overwrite ? 'Umbuchung durchgeführt.' : 'Gebucht', { deskId });
      return;
    }
    const response = await runWithAppLoading(() => post<BulkBookingResponse>('/recurring-bookings/bulk', {
      deskId,
      userEmail: selectedEmployeeEmail,
      weekdays: payload.weekdays,
      validFrom: payload.dateFrom,
      validTo: payload.dateTo,
      overrideExisting: overwrite
    }));

    toast.success(overwrite
      ? `${response.createdCount ?? 0} Tage gebucht, ${response.updatedCount ?? 0} Tage umgebucht.`
      : 'Gebucht', { deskId });
  };

  const updateExistingDeskBooking = async () => {
    if (!popupDesk || !popupMySelectedBooking || isRoomResource(popupDesk)) return;
    if (!popupMySelectedBooking.id) {
      setDialogErrorMessage('Die bestehende Buchung konnte nicht eindeutig gefunden werden.');
      return;
    }

    setDialogErrorMessage('');
    setBookingDialogState('SUBMITTING');
    try {
      await runWithAppLoading(() => put(`/bookings/${encodeURIComponent(popupMySelectedBooking.id ?? '')}`, {
        deskId: popupDesk.id,
        date: selectedDate,
        daySlot: manageTargetSlot === 'FULL_DAY' ? 'FULL' : manageTargetSlot === 'MORNING' ? 'AM' : 'PM',
        slot: manageTargetSlot
      }));
      await submitPopupBooking(popupDesk.id, { type: 'single', date: selectedDate, slot: manageTargetSlot }, true);
      await reloadBookings();
      setBookingVersion((value) => value + 1);
      setIsManageEditOpen(false);
    } catch (error) {
      setDialogErrorMessage(error instanceof Error ? error.message : 'Buchung konnte nicht aktualisiert werden.');
      setBookingDialogState('BOOKING_OPEN');
    } finally {
      setBookingDialogState((prev) => (prev === 'SUBMITTING' ? 'BOOKING_OPEN' : prev));
    }
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

    const requestId = createMutationRequestId();
    const isRoomCreate = isRoomResource(popupDesk) && payload.type === 'single';

    setDialogErrorMessage('');
    setBookingDialogState('SUBMITTING');
    logMutation('UI_SET_LOADING', { requestId, value: true });

    if (isRoomCreate) {
      logMutation('ROOM_CREATE_CLICK', {
        requestId,
        roomId: popupDesk.id,
        date: payload.date,
        from: payload.startTime,
        to: payload.endTime
      });
    }

    try {
      if (isRoomCreate) {
        if (!selectedEmployeeEmail) {
          throw new Error('Bitte Mitarbeiter auswählen.');
        }
        const body = {
          deskId: popupDesk.id,
          userEmail: selectedEmployeeEmail,
          date: payload.date,
          startTime: payload.startTime,
          endTime: payload.endTime,
          overwrite: false
        };
        await runWithAppLoading(() => createRoomBooking(body, { requestId }));
        toast.success('Gebucht', { deskId: popupDesk.id });
      } else {
        await submitPopupBooking(popupDesk.id, payload, false);
      }
      await reloadBookings(isRoomCreate ? { requestId, roomId: popupDesk.id, date: payload.date } : undefined);
      setBookingVersion((value) => value + 1);
      closeBookingFlow();
    } catch (error) {
      if (isRoomCreate) {
        logMutation('ROOM_CREATE_ERROR', {
          requestId,
          err: error instanceof Error ? error.message : toBodySnippet(error)
        });
      }
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
          anchorRect: deskPopup.anchorRect
        });
        return;
      }

      setBookingDialogState('BOOKING_OPEN');
      setDialogErrorMessage(error instanceof Error ? error.message : 'Buchung fehlgeschlagen.');
    } finally {
      logMutation('UI_SET_LOADING', { requestId, value: false });
      setBookingDialogState((prev) => (prev === 'SUBMITTING' ? 'BOOKING_OPEN' : prev));
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
    setDeskPopup({ deskId: rebookConfirm.deskId, anchorRect: rebookConfirm.anchorRect, openedAt: Date.now() });
    setCancelFlowState('DESK_POPOVER_OPEN');
    setBookingDialogState('BOOKING_OPEN');
    setRebookConfirm(null);
  };

  const handleRoomBookingCancel = (event: MouseEvent<HTMLButtonElement>, bookingId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!deskPopup || !popupDesk || !isRoomResource(popupDesk)) return;
    const selectedBooking = popupRoomBookingsList.find((booking) => booking.id === bookingId);
    if (!selectedBooking || !selectedBooking.isCurrentUser || !selectedBooking.bookingId) return;

    setCancelConfirmContext({
      ...deskPopup,
      bookingIds: [selectedBooking.bookingId],
      bookingLabel: selectedBooking.label,
      isRecurring: selectedBooking.isRecurring,
      keepPopoverOpen: true
    });
    setCancelDialogError('');
    setIsCancellingBooking(false);
    setCancellingBookingId(null);
    setCancelFlowState('CANCEL_CONFIRM_OPEN');
  };

  const cancelBookingWithRefresh = async ({ bookingId, requestId, deskId, date, keepPopoverOpen, popupDeskId, isRoomCancel }: { bookingId: string; requestId: string; deskId: string; date: string; keepPopoverOpen: boolean; popupDeskId: string; isRoomCancel: boolean }) => {
    const endpoint = `${API_BASE}/bookings/${bookingId}`;
    updateCancelDebug({ lastAction: 'CANCEL_REQUEST', bookingId, endpoint, httpStatus: null, errorMessage: '' });
    await runWithAppLoading(async () => {
      await cancelBooking(bookingId, isRoomCancel ? { requestId } : undefined);
    });
    updateCancelDebug({ lastAction: 'CANCEL_SUCCESS', bookingId, endpoint, httpStatus: 200, errorMessage: '' });

    setOccupancy((current) => removeBookingFromOccupancy(current, bookingId));
    setBookingVersion((value) => value + 1);
    toast.success('Buchung storniert', { deskId });

    setCancelDialogError('');
    if (keepPopoverOpen) {
      setCancelFlowState('DESK_POPOVER_OPEN');
      window.requestAnimationFrame(() => {
        refreshDeskPopupAnchorRect(popupDeskId);
      });
    } else {
      setCancelFlowState('NONE');
      setDeskPopup(null);
    }
    setCancelConfirmContext(null);

    const refreshed = await reloadBookings(isRoomCancel ? { requestId, roomId: deskId, date } : undefined);
    const refreshedDesk = refreshed?.desks.find((desk) => desk.id === deskId);
    const refreshedCount = refreshedDesk ? normalizeDeskBookings(refreshedDesk).length : 0;
    updateCancelDebug({ lastAction: 'REFRESH_DONE', bookingId, endpoint, httpStatus: 200, errorMessage: '' });
    if (isRoomCancel) {
      logMutation('ROOM_REFETCH_DONE', { requestId, roomId: deskId, count: refreshedCount });
    }
  };

  const submitPopupCancel = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!cancelConfirmDesk || !cancelConfirmContext) return;
    if (cancelConfirmContext.isRecurring) {
      toast.error('Serienbuchungen können aktuell nur im Admin-Modus storniert werden.');
      return;
    }

    const bookingId = cancelConfirmContext.bookingIds[0];
    const requestId = createMutationRequestId();
    const isRoomCancel = isRoomResource(cancelConfirmDesk);

    if (isRoomCancel) {
      logMutation('ROOM_CANCEL_CLICK', {
        requestId,
        bookingId,
        roomId: cancelConfirmDesk.id,
        date: selectedDate
      });
    }

    if (!bookingId) {
      const message = 'Stornieren fehlgeschlagen: bookingId fehlt.';
      if (isRoomCancel) {
        logMutation('ROOM_CANCEL_ERROR', { requestId, err: message });
      }
      setCancelDialogError(message);
      updateCancelDebug({ lastAction: 'CANCEL_ERROR', bookingId: null, endpoint: '', httpStatus: null, errorMessage: message });
      return;
    }

    const endpoint = `${API_BASE}/bookings/${bookingId}`;
    updateCancelDebug({ lastAction: 'CANCEL_CLICK', bookingId, endpoint, httpStatus: null, errorMessage: '' });
    setCancelDialogError('');
    setIsCancellingBooking(true);
    setCancellingBookingId(bookingId);
    logMutation('UI_SET_LOADING', { requestId, value: true });

    try {
      await cancelBookingWithRefresh({
        bookingId,
        requestId,
        deskId: cancelConfirmDesk.id,
        date: selectedDate,
        keepPopoverOpen: cancelConfirmContext.keepPopoverOpen,
        popupDeskId: cancelConfirmContext.deskId,
        isRoomCancel
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Stornieren fehlgeschlagen';
      if (isRoomCancel) {
        logMutation('ROOM_CANCEL_ERROR', {
          requestId,
          err: error instanceof Error ? error.message : toBodySnippet(error)
        });
      }
      updateCancelDebug({ lastAction: 'CANCEL_ERROR', bookingId, endpoint, httpStatus: null, errorMessage });
      setCancelDialogError(`Stornierung fehlgeschlagen: ${errorMessage}`);
    } finally {
      logMutation('UI_SET_LOADING', { requestId, value: false });
      setIsCancellingBooking(false);
      setCancellingBookingId(null);
    }
  };

  const selectDay = (day: Date) => {
    const key = toDateKey(day);
    setSelectedDate(key);
    setVisibleMonth(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
  };

  const retryHealthCheck = async () => {
    const healthy = await runWithAppLoading(() => checkBackendHealth());
    if (!healthy) {
      setBackendDown(true);
      return;
    }

    setBackendDown(false);
    await loadInitial();
  };

  const dateAndViewPanel = (
    <section className="card compact-card stack-sm">
      <h3 className="section-title">Datum &amp; Ansicht</h3>
      <label className="stack-xs">
        <span className="field-label">Standort</span>
        <select value={selectedFloorplanId} onChange={(event) => setSelectedFloorplanId(event.target.value)}>
          {floorplans.map((floorplan) => <option key={floorplan.id} value={floorplan.id}>{floorplan.name}</option>)}
        </select>
      </label>
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
          const availabilityTone = dayAvailabilityByDate.get(dayKey);
          return (
            <button key={dayKey} className={`day-btn ${inVisibleMonth ? '' : 'outside'} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''} ${!isSelected && hasBookingsForDay ? 'has-bookings' : ''} ${!isSelected && availabilityTone ? `availability-${availabilityTone}` : ''}`} onClick={() => selectDay(day)}>
              {day.getUTCDate()}
            </button>
          );
        })}
      </div>
      <label className="stack-xs">
        <span className="field-label">Ressourcenart</span>
        <select value={selectedResourceKindFilter} onChange={(event) => setSelectedResourceKindFilter(event.target.value as 'ALL' | ResourceKind)}>
          <option value="ALL">Alle Ressourcen</option>
          {selectableResourceKinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
        </select>
      </label>
      <div className="legend-chip-list" aria-label="Legende">
        <span className="legend-chip"><i className="dot free" /> Frei</span>
        <span className="legend-chip"><i className="dot booked" /> Belegt</span>
        <span className="legend-chip"><i className="dot selected" /> Dein Platz</span>
      </div>
    </section>
  );

  const renderOccupancyList = (items: OccupantForDay[], title: string, emptyText: string) => {
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
            key={`selected-${occupant.userId}-${occupant.deskId}`}
            ref={(node) => { occupantRowRefs.current[occupant.deskId] = node; }}
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



  const dayOverviewPanel = (
    <section className="card compact-card stack-sm details-panel">
      <h3>Tagesübersicht</h3>
      <label className="stack-xs overview-view-select">
        <span className="field-label">Ansicht</span>
        <select value={overviewView} onChange={(event) => setOverviewView(event.target.value as OverviewView)} aria-label="Ansicht wählen">
          <option value="presence">Anwesenheit</option>
          <option value="rooms">Räume</option>
          <option value="myBookings">Meine Buchungen</option>
        </select>
      </label>

      {overviewView === 'presence' && renderOccupancyList(bookingsForSelectedDate, 'Anwesenheit am ausgewählten Datum', 'Niemand anwesend')}

      {overviewView === 'rooms' && (
        <div className="occupancy-list" role="list" aria-label="Raumübersicht">
          {roomsForSelectedDate.length === 0 && <div className="empty-state compact-empty-state"><p>Keine Räume gefunden.</p></div>}
          {roomsForSelectedDate.map(({ room, bookings }) => (
            <div key={room.id} className="occupant-compact-card" role="listitem">
              <div className="occupant-card-main">
                <div className="occupant-card-text">
                  <strong>{room.name}</strong>
                  <p className="muted">{bookings.length === 0 ? 'Heute frei' : `${bookings.length} Buchung(en)`}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {overviewView === 'myBookings' && (
        <div className="occupancy-list" role="list" aria-label="Eigene Buchungen">
          {myBookingsForSelectedDate.length === 0 && <div className="empty-state compact-empty-state"><p>Keine eigenen Buchungen am gewählten Tag.</p></div>}
          {myBookingsForSelectedDate.map(({ desk, booking }) => (
            <div key={`${desk.id}-${booking.id ?? bookingSlotLabel(booking)}`} className="occupant-compact-card" role="listitem">
              <div className="occupant-card-main">
                <div className="occupant-card-text">
                  <strong>{resourceKindLabel(desk.kind)}: {desk.name}</strong>
                  <p className="muted">{bookingSlotLabel(booking)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  useEffect(() => {
    if (backendDown) {
      setCalendarBookings([]);
      setBookedCalendarDays([]);
      return;
    }

    let cancelled = false;

    const loadCalendarBookings = async () => {
      try {
        const calendarBookings = await runWithAppLoading(() => get<CalendarBooking[]>(`/bookings?from=${calendarRange.from}&to=${calendarRange.to}`));
        if (cancelled) return;
        setCalendarBookings(calendarBookings);
        setBookedCalendarDays(Array.from(new Set(calendarBookings.map((booking) => toBookingDateKey(booking.date)))));
      } catch {
        if (cancelled) return;
        setCalendarBookings([]);
        setBookedCalendarDays([]);
      }
    };

    loadCalendarBookings();

    return () => {
      cancelled = true;
    };
  }, [backendDown, calendarRange.from, calendarRange.to]);

  useEffect(() => {
    availabilityCacheRef.current.clear();
  }, [selectedFloorplanId, visibleMonth, bookingVersion, floorplanResources, selectedFloorplan?.defaultResourceKind]);

  useEffect(() => {
    if (!selectedFloorplanId || backendDown) {
      setFloorplanResources([]);
      return;
    }

    let cancelled = false;

    const loadFloorplanResources = async () => {
      try {
        const resources = await runWithAppLoading(() => get<FloorplanResource[]>(`/floorplans/${selectedFloorplanId}/desks`));
        if (cancelled) return;
        setFloorplanResources(resources);
      } catch {
        if (cancelled) return;
        setFloorplanResources([]);
      }
    };

    loadFloorplanResources();

    return () => {
      cancelled = true;
    };
  }, [backendDown, selectedFloorplanId]);


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

    const popupRect = popupRef.current.getBoundingClientRect();
    setDeskPopupCoords(calculatePopupCoordinates(deskPopup.anchorRect, popupRect));
  }, [deskPopup, bookingDialogState, popupDeskState, dialogErrorMessage]);


  useEffect(() => {
    if (!deskPopup) return;

    const frame = window.requestAnimationFrame(() => {
      refreshDeskPopupAnchorRect(deskPopup.deskId);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [bookingVersion, deskPopup, refreshDeskPopupAnchorRect]);

  useEffect(() => {
    if (!deskPopup) return;

    const closePopup = () => {
      closeBookingFlow();
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (cancelFlowState === 'CANCEL_CONFIRM_OPEN') return;
      if (event.key === 'Escape') {
        closePopup();
      }
    };

    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (cancelFlowState === 'CANCEL_CONFIRM_OPEN') return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target)) return;
      if (cancelDialogRef.current?.contains(target)) return;
      const anchorElement = deskAnchorElementsRef.current.get(deskPopup.deskId);
      if (anchorElement?.contains(target)) return;
      closePopup();
    };

    const closeOnViewportChange = () => {
      if (cancelFlowState === 'CANCEL_CONFIRM_OPEN') return;
      closePopup();
    };

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
  }, [cancelFlowState, deskPopup]);


  if (backendDown) {
    return (
      <main className="app-shell">
        <TopLoadingBar loading={isAppLoading} />
        <section className="card stack-sm down-card">
          <h2>Backend nicht erreichbar</h2>
          <p>Bitte prüfen, ob Server läuft.</p>
          <div>
            <button className="btn" onClick={retryHealthCheck}>Erneut versuchen</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <TopLoadingBar loading={isAppLoading} />
      <header className="app-header simplified-header compact-topbar">
        <div className="header-left">
          {COMPANY_LOGO_URL ? <img className="brand-logo" src={COMPANY_LOGO_URL} alt={`${APP_TITLE} Logo`} /> : <span className="brand-mark" aria-hidden="true">A</span>}
          <h1>{APP_TITLE}</h1>
        </div>
        <div className="header-right">
          <UserMenu user={currentUser} onLogout={onLogout} onOpenAdmin={onOpenAdmin} showAdminAction={canOpenAdmin} />
        </div>
      </header>

      <section className="layout-grid">
        <aside className="left-col stack-sm">
          {isBootstrapping ? <div className="card skeleton h-480" /> : dateAndViewPanel}
        </aside>
        <section className="center-col">
          <article className="card canvas-card">
            <div className="card-header-row">
              <div>
                <h2>{selectedFloorplan?.name ?? 'Floorplan'} · {formatDate(selectedDate)}</h2>
                <p className="muted">Klicke auf einen Platz zum Buchen</p>
              </div>
              <div className="toolbar" />
            </div>
            <div className={`canvas-body canvas-body-focus ${isUpdatingOccupancy ? 'is-loading' : ''}`}>
              {isBootstrapping ? (
                <div className="skeleton h-420" />
              ) : selectedFloorplan ? (
                <div className="floorplan-viewport" style={{ height: FLOORPLAN_VIEWPORT_HEIGHT, minHeight: 520 }}>
                  {!floorplanImageSrc ? (
                    <div className="floorplan-status-banner is-error" role="alert">Floorplan-Bildquelle fehlt.</div>
                  ) : (
                    <FloorplanCanvas
                      imageUrl={floorplanImageSrc}
                      imageAlt={selectedFloorplan.name}
                      desks={floorplanCanvasDesks}
                      selectedDeskId={selectedDeskId}
                      hoveredDeskId={hoveredDeskId}
                      onHoverDesk={(deskId) => { setHoveredDeskId(deskId); if (deskId) triggerDeskHighlight(deskId, 900); }}
                      selectedDate={selectedDate}
                      onSelectDesk={selectDeskFromCanvas}
                      onCanvasClick={() => { setSelectedDeskId(''); setHighlightedDeskId(''); closeBookingFlow(); }}
                      onDeskAnchorChange={registerDeskAnchor}
                      onImageLoad={handleFloorplanImageLoad}
                      onImageError={handleFloorplanImageError}
                      onImageRenderSizeChange={setFloorplanRenderedImageSize}
                      onDisplayedRectChange={setFloorplanDisplayedRect}
                      bookingVersion={bookingVersion}
                      debugEnabled={showRoomDebugInfo}
                      style={{ width: '100%', height: '100%' }}
                    />
                  )}

                  {floorplanImageLoadState === 'loading' && <div className="floorplan-status-banner" aria-live="polite">Floorplan lädt…</div>}
                  {floorplanImageLoadState === 'error' && (
                    <div className="floorplan-status-banner is-error" role="alert">
                      {floorplanImageError || 'Floorplan konnte nicht geladen werden.'}
                      {showRoomDebugInfo && floorplanImageSrc ? <span> src={floorplanImageSrc}</span> : null}
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty-state"><p>Kein Floorplan ausgewählt.</p></div>
              )}

              {showRoomDebugInfo && (
                <div className="floorplan-debug" aria-live="polite">
                  <div>selectedStandortId={selectedFloorplanId || '-'}</div>
                  <div>selectedFloorplanId={selectedFloorplan?.id ?? '-'}</div>
                  <div>floorplanName={selectedFloorplan?.name ?? '-'}</div>
                  <div>imageSrc={floorplanImageSrc || '-'}</div>
                  <div>imageStatus={floorplanImageLoadState}</div>
                  <div>error={floorplanImageError || '-'}</div>
                  <div>loadedSrc={floorplanLoadedSrc || '-'}</div>
                  <div>naturalWidth/naturalHeight={Math.round(floorplanImageSize?.width ?? 0)}×{Math.round(floorplanImageSize?.height ?? 0)}</div>

                  <div>displayedRect={Math.round(floorplanDisplayedRect.left)} / {Math.round(floorplanDisplayedRect.top)} / {Math.round(floorplanDisplayedRect.width)} / {Math.round(floorplanDisplayedRect.height)}</div>
                  <div>resourcesCount={resourcesCount}</div>
                  <div>markersRenderedCount={floorplanMarkersCount}</div>
                </div>
              )}
            </div>
          </article>
        </section>

        <aside className="right-col">{isBootstrapping ? <div className="card skeleton h-480" /> : dayOverviewPanel}</aside>
      </section>

      {deskPopup && popupDesk && popupDeskState && cancelFlowState !== 'CANCEL_CONFIRM_OPEN' && createPortal(
        <section
          ref={popupRef}
          className="card desk-popup"
          style={{ left: deskPopupCoords?.left ?? deskPopup.anchorRect.left, top: deskPopupCoords?.top ?? deskPopup.anchorRect.top, visibility: deskPopupCoords ? 'visible' : 'hidden' }}
          role="menu"
          data-placement={deskPopupCoords?.placement ?? 'right'}
        >
          {popupMode === 'create' ? (
            <>
              <div className="desk-popup-header">
                <div className="stack-xxs">
                  <h3>{resourceKindLabel(popupDesk.kind)}: {popupDesk.name}</h3>
                  <p className="muted">Buchung anlegen{!isRoomResource(popupDesk) ? ` · ${deskAvailabilityLabel(popupDeskAvailability)}` : ''}</p>
                </div>
                <button type="button" className="btn btn-ghost desk-popup-close" aria-label="Popover schließen" onClick={closeBookingFlow} disabled={isCancellingBooking}>✕</button>
              </div>
              {showRoomDebugInfo && (
                <div className="muted" style={{ fontSize: 12, border: '1px solid hsl(var(--border))', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                  <div>mode: {popupMode}</div>
                  <div>myBookingId: {popupMySelectedBooking?.id ?? '—'}</div>
                  <div>myBookingPeriod: {popupMySelectedBooking ? bookingSlotLabel(popupMySelectedBooking) : '—'}</div>
                  {hasUnexpectedMultipleMyBookings && <div>warning: multiple own bookings on resource/date</div>}
                </div>
              )}
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
                    occupiedSegments: popupRoomOccupiedSegments,
                    isFullyBooked: popupRoomFreeSlotChips.length === 0,
                    conflictMessage: roomBookingConflict,
                    debugInfo: roomDebugInfo,
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
                {popupMode === 'manage' && popupMySelectedBooking
                  ? <p className="muted">Deine Buchung: {bookingSlotLabel(popupMySelectedBooking)}</p>
                  : !isRoomResource(popupDesk) && <p className="muted">Status: {deskAvailabilityLabel(popupDeskAvailability)}</p>}
                {popupDeskBookings.map((booking) => (
                  <p key={booking.id ?? `${booking.userEmail}-${bookingSlotLabel(booking)}`} className="muted">
                    {bookingSlotLabel(booking)}: {booking.userDisplayName ?? booking.userEmail}
                  </p>
                ))}
                {showRoomDebugInfo && (
                  <div className="muted" style={{ fontSize: 12, border: '1px solid hsl(var(--border))', borderRadius: 8, padding: 8 }}>
                    <div>mode: {popupMode}</div>
                    <div>myBookingId: {popupMySelectedBooking?.id ?? '—'}</div>
                    <div>myBookingPeriod: {popupMySelectedBooking ? bookingSlotLabel(popupMySelectedBooking) : '—'}</div>
                    {hasUnexpectedMultipleMyBookings && <div>warning: multiple own bookings on resource/date</div>}
                  </div>
                )}
                {popupMode === 'manage' && popupMySelectedBooking && !popupOwnBookingIsRecurring && (
                  <div className="stack-xs">
                    {!isManageEditOpen ? (
                      <button type="button" className="btn" onClick={() => setIsManageEditOpen(true)} disabled={bookingDialogState === 'SUBMITTING'}>Ändern</button>
                    ) : (
                      <>
                        <label className="stack-xs">
                          <span className="field-label">Zeitraum ändern</span>
                          <select value={manageTargetSlot} onChange={(event) => setManageTargetSlot(event.target.value as BookingFormValues['slot'])} disabled={bookingDialogState === 'SUBMITTING'}>
                            <option value="MORNING">Vormittag</option>
                            <option value="AFTERNOON">Nachmittag</option>
                            <option value="FULL_DAY">Ganztag</option>
                          </select>
                        </label>
                        {manageSlotConflict && <p className="field-error" role="alert">{manageSlotConflict}</p>}
                        {dialogErrorMessage && <p className="error-banner" role="alert">{dialogErrorMessage}</p>}
                        <div className="inline-end">
                          <button type="button" className="btn btn-outline" onClick={() => { setIsManageEditOpen(false); setDialogErrorMessage(''); }} disabled={bookingDialogState === 'SUBMITTING'}>Abbrechen</button>
                          <button type="button" className="btn" onClick={() => void updateExistingDeskBooking()} disabled={bookingDialogState === 'SUBMITTING' || Boolean(manageSlotConflict)}>{bookingDialogState === 'SUBMITTING' ? 'Speichern…' : 'Speichern'}</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                <div className="inline-end">
                  <button type="button" className="btn btn-outline" onClick={closeBookingFlow} disabled={isCancellingBooking}>Schließen</button>
                  {popupDeskState === 'MINE' && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={openCancelConfirm}
                      disabled={popupOwnBookingIsRecurring || bookingDialogState === 'SUBMITTING'}
                    >
                      Stornieren
                    </button>
                  )}
                </div>
                {popupOwnBookingIsRecurring && popupDeskState === 'MINE' && <p className="muted">Serienbuchungen können derzeit nur im Admin-Modus storniert werden.</p>}
              </div>
            </>
          )}
        </section>,
        document.body
      )}

      {cancelFlowState === 'CANCEL_CONFIRM_OPEN' && cancelConfirmDesk && createPortal(
        <div className="overlay" role="presentation">
          <section
            ref={cancelDialogRef}
            className="card dialog stack-sm cancel-booking-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cancel-booking-title"
            onMouseDown={(event) => { event.stopPropagation(); }}
            onClick={(event) => { event.stopPropagation(); }}
          >
            <h3 id="cancel-booking-title">Buchung stornieren?</h3>
            <p>Möchtest du deine Buchung {cancelConfirmBookingLabel} stornieren?</p>
            <p className="muted cancel-booking-subline">{resourceKindLabel(cancelConfirmDesk.kind)}: {cancelConfirmDesk.name} · {new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</p>
            {cancelDialogError && <p className="error-banner">{cancelDialogError}</p>}
            {showRoomDebugInfo && (
              <div className="muted" style={{ fontSize: 12, border: '1px solid hsl(var(--border))', borderRadius: 8, padding: 8 }}>
                <strong>Cancel Debug</strong>
                <div>lastAction: {cancelDebugState.lastAction}</div>
                <div>bookingId: {cancelDebugState.bookingId ?? '—'}</div>
                <div>endpoint: {cancelDebugState.endpoint || '—'}</div>
                <div>httpStatus: {cancelDebugState.httpStatus ?? '—'}</div>
                <div>errorMessage: {cancelDebugState.errorMessage || '—'}</div>
              </div>
            )}
            <div className="inline-end">
              <button type="button" className="btn btn-outline" onMouseDown={(event) => { event.stopPropagation(); }} onClick={cancelCancelConfirm} disabled={isCancellingBooking} data-state={isCancellingBooking ? 'loading' : 'idle'}>Abbrechen</button>
              <button type="button" className="btn btn-danger" onMouseDown={(event) => { event.stopPropagation(); }} onClick={(event) => void submitPopupCancel(event)} disabled={isCancellingBooking} data-state={isCancellingBooking ? 'loading' : 'idle'}>
                {isCancellingBooking && cancellingBookingId === cancelConfirmContext?.bookingIds[0] ? <><span className="btn-spinner" aria-hidden />Stornieren…</> : 'Stornieren'}
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


      <p className="api-base">{APP_TITLE} · v{APP_VERSION}</p>
    </main>
  );
}
