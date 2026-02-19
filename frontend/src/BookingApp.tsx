import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, checkBackendHealth, get, markBackendAvailable, post, put, resolveApiUrl } from './api';
import { cancelBooking, createRoomBooking, fetchBookingCancelPreview } from './api/bookings';
import type { BookingCancelPreview } from './api/bookings';
import { createMutationRequestId, logMutation, toBodySnippet } from './api/mutationLogger';
import { Avatar } from './components/Avatar';
import { BookingForm, createDefaultBookingFormValues } from './components/BookingForm';
import type { BookingFormSubmitPayload, BookingFormValues } from './components/BookingForm';
import { ParkingScheduleGrid } from './components/ParkingScheduleGrid';
import { UserMenu } from './components/UserMenu';
import { FloorplanCanvas } from './FloorplanCanvas';
import { APP_TITLE, APP_VERSION, COMPANY_LOGO_URL } from './config';
import type { AuthUser } from './auth/AuthProvider';
import { useToast } from './components/toast';
import { normalizeDaySlotBookings, normalizeDaySlotBookingsPerEntry } from './daySlotBookings';
import { RESOURCE_KIND_OPTIONS, resourceKindLabel, type ResourceKind } from './resourceKinds';
import { ROOM_WINDOW_END, ROOM_WINDOW_START, ROOM_WINDOW_TOTAL_MINUTES, clampInterval, formatMinutes, invertIntervals, mergeIntervals, toMinutes } from './lib/bookingWindows';
import { computeRoomBusySegments, computeRoomOccupancy } from './lib/roomOccupancy';
import { bookingDisplayName, canCancelBooking, isMineBooking } from './lib/bookingOwnership';
import { getLastMutation, isDebugMode, setLastMutation } from './debug/runtimeDebug';

type Floorplan = { id: string; name: string; imageUrl: string; isDefault?: boolean; defaultResourceKind?: ResourceKind };
type RawFloorplan = Floorplan & { image?: string; imageURL?: string };
type FloorplanResource = { id: string; floorplanId: string; kind?: ResourceKind; hasCharger?: boolean; isBookableForMe?: boolean; tenantScope?: 'ALL' | 'SELECTED'; tenantIds?: string[] };
type BookingActor = { id: string; displayName?: string | null; name?: string | null; email?: string | null };
type OccupancyBookingEmployee = { id?: string; email: string; displayName: string; phone?: string | null; photoUrl?: string | null };

type OccupancyBookingData = {
  id?: string;
  employeeId?: string;
  userId?: string | null;
  userEmail?: string | null;
  userDisplayName?: string;
  userFirstName?: string;
  userPhotoUrl?: string;
  userPhone?: string;
  employee?: OccupancyBookingEmployee | null;
  bookedFor?: 'SELF' | 'GUEST';
  guestName?: string | null;
  createdBy?: BookingActor;
  createdByUserId?: string;
  createdByEmployeeId?: string;
  recurringBookingId?: string | null;
  recurringGroupId?: string | null;
  type?: 'single' | 'recurring';
  daySlot?: 'AM' | 'PM' | 'FULL';
  slot?: 'FULL_DAY' | 'MORNING' | 'AFTERNOON' | 'CUSTOM';
  startTime?: string;
  endTime?: string;
  isCurrentUser?: boolean;
};
type OccupancyDesk = {
  id: string;
  name: string;
  kind?: string;
  allowSeriesOverride?: boolean | null;
  hasCharger?: boolean;
  effectiveAllowSeries?: boolean;
  x: number | null;
  y: number | null;
  status: 'free' | 'booked';
  booking: OccupancyBookingData | null;
  bookings?: OccupancyBookingData[];
  isCurrentUsersDesk?: boolean;
  isHighlighted?: boolean;
  isBookableForMe?: boolean;
  tenantScope?: 'ALL' | 'SELECTED';
  tenantIds?: string[];
};
type OccupancyPerson = { email: string; displayName?: string; deskName?: string; deskId?: string };
type OccupancyResponse = { date: string; floorplanId: string; desks: OccupancyDesk[]; people: OccupancyPerson[] };
type BookingEmployee = { id: string; email: string; firstName?: string; displayName: string; phone?: string | null; photoUrl?: string };
type OccupantForDay = { deskId: string; deskLabel: string; deskKindLabel: string; userId: string; name: string; firstName: string; email: string; employeeId?: string; photoUrl?: string };
type BookingSubmitPayload = BookingFormSubmitPayload;
type BookingMode = 'create' | 'manage';
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
  movedCount?: number;
  skippedCount?: number;
  skippedDates?: string[];
  skippedConflicts?: string[];
};
type RecurringPreviewResponse = {
  conflictDates: string[];
  freeDates: string[];
};
type RecurringConflictState = {
  payload: Extract<BookingSubmitPayload, { type: 'recurring' }>;
  conflictDates: string[];
  freeDates: string[];
};
type DeskPopupState = { deskId: string; anchorRect: DOMRect; openedAt: number };
type CancelConfirmContext = DeskPopupState & { bookingIds: string[]; bookingLabel: string; recurringBookingId?: string | null; recurringGroupId?: string | null; isRecurring: boolean; keepPopoverOpen: boolean };
type CancelSeriesPreviewState = {
  loading: boolean;
  details: BookingCancelPreview | null;
  error: string;
};

function extractParkingNumber(label: string): string {
  const match = label.match(/\d+/);
  return match?.[0] ?? label;
}

function SparklesIcon() {
  return (
    <svg className="smart-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6.2 3.7 7.6 7l3.3 1.4L7.6 9.8 6.2 13 4.9 9.8 1.6 8.4 4.9 7z" fill="currentColor" />
      <path d="m16.4 2.2.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z" fill="currentColor" />
      <path d="m15.1 10.4 1.8 4.5 4.5 1.8-4.5 1.8-1.8 4.5-1.8-4.5-4.5-1.8 4.5-1.8z" fill="currentColor" />
    </svg>
  );
}
type OccupancyBooking = NonNullable<OccupancyDesk['booking']>;
type NormalizedOccupancyBooking = ReturnType<typeof normalizeDaySlotBookings<OccupancyBooking>>[number];
type RoomAvailabilityBooking = { id: string; startTime: string | null; endTime: string | null; bookedFor?: 'SELF' | 'GUEST'; guestName?: string | null; employeeId?: string | null; userId?: string | null; user: { email?: string | null; name?: string | null; displayName?: string | null } | null; createdBy?: BookingActor; createdByUserId?: string; createdByEmployeeId?: string; recurringBookingId?: string | null; recurringGroupId?: string | null; type?: 'single' | 'recurring'; };
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
    bookedFor?: 'SELF' | 'GUEST';
    guestName?: string | null;
    employeeId?: string | null;
    userId?: string | null;
    createdBy: BookingActor;
    createdByEmployeeId?: string;
    recurringBookingId?: string | null;
    recurringGroupId?: string | null;
    type?: 'single' | 'recurring';
    user: { email?: string | null; name?: string | null; displayName?: string | null } | null;
  }>;
  freeWindows: Array<{ startTime: string | null; endTime: string | null; label: string }>;
};
type RoomBookingListEntry = {
  id: string;
  start: number;
  end: number;
  label: string;
  person: string;
  bookingId?: string;
  isCurrentUser: boolean;
  isRecurring: boolean;
  bookedFor?: 'SELF' | 'GUEST';
  userId?: string | null;
  createdByEmployeeId?: string;
  canCancel: boolean;
  recurringBookingId?: string | null;
  recurringGroupId?: string | null;
};
type DeskSlotAvailability = 'FREE' | 'AM_BOOKED' | 'PM_BOOKED' | 'FULL_BOOKED';
type FloorplanTransform = { scale: number; translateX: number; translateY: number };
type FloorplanImageSize = { width: number; height: number };
type FloorplanImageLoadState = 'loading' | 'loaded' | 'error';
type FloorplanDebugCounters = {
  srcChangeCount: number;
  transformRecalcCount: number;
  resizeObserverCount: number;
};
type CalendarBooking = { date: string; deskId: string; daySlot?: 'AM' | 'PM' | 'FULL'; slot?: 'FULL_DAY' | 'MORNING' | 'AFTERNOON' | 'CUSTOM' };
type DayAvailabilityTone = 'many-free' | 'few-free' | 'none-free';
type OverviewView = 'presence' | 'rooms' | 'myBookings';
type FeedbackReportType = 'BUG' | 'FEATURE_REQUEST';

type ParkingSmartProposal = {
  proposalType: 'single' | 'split';
  usedFallbackChargerFullWindow: boolean;
  switchAfterCharging: boolean;
  bookings: Array<{ deskId: string; deskName: string; startMinute: number; endMinute: number; startTime?: string; endTime?: string; hasCharger: boolean }>;
};

type ParkingSmartProposeResponse = {
  status: 'ok' | 'none';
  message?: string;
  proposalType?: 'single' | 'split';
  usedFallbackChargerFullWindow?: boolean;
  switchAfterCharging?: boolean;
  adjustedChargingMinutes?: number;
  bookings?: ParkingSmartProposal['bookings'];
  fallbackWithoutCharging?: ParkingSmartProposal;
};

const FEEDBACK_SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;
const FEEDBACK_SCREENSHOT_ACCEPT = 'image/png,image/jpeg,image/webp';

const OVERVIEW_QUERY_KEY = 'overview';
const FLOORPLAN_QUERY_KEY = 'floorplan';

const isOverviewView = (value: string | null): value is OverviewView => value === 'presence' || value === 'rooms' || value === 'myBookings';

const getInitialOverviewView = (): OverviewView => {
  if (typeof window === 'undefined') return 'presence';
  const queryValue = new URLSearchParams(window.location.search).get(OVERVIEW_QUERY_KEY);
  return isOverviewView(queryValue) ? queryValue : 'presence';
};

const getInitialFloorplanId = (): string => {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(FLOORPLAN_QUERY_KEY) ?? '';
};

const normalizeFloorplanUrlValue = (value: string): string => value
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');

const floorplanUrlValue = (floorplan: Floorplan): string => {
  const normalizedName = normalizeFloorplanUrlValue(floorplan.name ?? '');
  return normalizedName || floorplan.id;
};

const resolveFloorplanSelection = (rawValue: string, floorplans: Floorplan[]): string => {
  const candidate = rawValue.trim();
  if (!candidate) return '';

  const byId = floorplans.find((plan) => plan.id === candidate);
  if (byId) return byId.id;

  const normalizedCandidate = normalizeFloorplanUrlValue(candidate);
  const byName = floorplans.find((plan) => normalizeFloorplanUrlValue(plan.name) === normalizedCandidate);
  if (byName) return byName.id;

  return '';
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const FLOORPLAN_FIT_PADDING = 24;
const FLOORPLAN_MIN_SCALE = 0.6;
const FLOORPLAN_MAX_SCALE = 2.4;
const FLOORPLAN_ZOOM_STEP = 1.1;
const FLOORPLAN_DRAG_EPSILON = 0.001;
const FLOORPLAN_VIEWPORT_HEIGHT = 'clamp(520px, 70vh, 680px)';

const getFloorplanMinScale = (fitScale: number): number => Math.min(FLOORPLAN_MIN_SCALE, fitScale);

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


const getBookingCreatorName = (booking: { createdBy?: BookingActor }): string => {
  return booking.createdBy?.displayName ?? booking.createdBy?.name ?? 'Unbekannt';
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
  if (booking.startTime && booking.endTime) return `${booking.startTime}–${booking.endTime}`;
  if (booking.slot === 'CUSTOM') return `${booking.startTime ?? '--:--'}–${booking.endTime ?? '--:--'}`;
  if (booking.daySlot === 'AM' || booking.slot === 'MORNING') return 'Vormittag';
  if (booking.daySlot === 'PM' || booking.slot === 'AFTERNOON') return 'Nachmittag';
  if (booking.daySlot === 'FULL' || booking.slot === 'FULL_DAY') return 'Ganztägig';
  return 'Ganztägig';
};

const isE164Phone = (phone: string): boolean => /^\+[1-9]\d{6,14}$/.test(phone.trim());

const getDialablePhone = (phone?: string | null): string | null => {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  if (isE164Phone(trimmed)) return trimmed;

  const compact = trimmed.replace(/[\s().-]/g, '');
  if (/^\+?\d{6,15}$/.test(compact)) return compact.startsWith('+') ? compact : `+${compact}`;

  return null;
};

const toTeamsCallUrl = (dialablePhone: string): string => `https://teams.microsoft.com/l/call/0/0?users=${encodeURIComponent(dialablePhone)}`;

const getContactEmail = (email?: string | null): string | null => {
  if (!email) return null;
  const trimmed = email.trim();
  return trimmed ? trimmed : null;
};

const toMailtoUrl = (email: string): string => `mailto:${encodeURIComponent(email)}`;

const toTeamsChatUrl = (email: string): string => `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`;

const toTeamsChatClientUrl = (email: string): string => `msteams:/l/chat/0/0?users=${encodeURIComponent(email)}`;

const callLabelForBooking = (booking: OccupancyBooking): string => {
  if (booking.startTime && booking.endTime) return `${booking.startTime}–${booking.endTime}`;
  if (booking.slot === 'CUSTOM') return `${booking.startTime ?? '--:--'}–${booking.endTime ?? '--:--'}`;
  if (booking.daySlot === 'AM' || booking.slot === 'MORNING') return 'Vormittags';
  if (booking.daySlot === 'PM' || booking.slot === 'AFTERNOON') return 'Nachmittags';
  return 'Ganztags';
};

const normalizeDeskBookings = (desk: OccupancyDesk): NormalizedOccupancyBooking[] => {
  const bookings = desk.bookings && desk.bookings.length > 0 ? desk.bookings : desk.booking ? [desk.booking] : [];
  if (desk.kind === 'RAUM' || desk.kind === 'PARKPLATZ') return normalizeDaySlotBookingsPerEntry(bookings);
  return normalizeDaySlotBookings(bookings);
};

const getRecurringMetadataForBooking = (desk: OccupancyDesk, booking: NormalizedOccupancyBooking): { recurringBookingId: string | null; recurringGroupId: string | null; isRecurring: boolean } => {
  const rawBookings = desk.bookings && desk.bookings.length > 0 ? desk.bookings : desk.booking ? [desk.booking] : [];
  const bookingIds = booking.sourceBookingIds?.length
    ? booking.sourceBookingIds
    : booking.id
      ? [booking.id]
      : [];

  const matchingSources = bookingIds.length > 0
    ? rawBookings.filter((item) => item.id && bookingIds.includes(item.id))
    : [];

  const recurringSource = matchingSources.find((item) => Boolean(item.recurringBookingId || item.recurringGroupId));
  const recurringBookingId = recurringSource?.recurringBookingId ?? booking.recurringBookingId ?? null;
  const recurringGroupId = recurringSource?.recurringGroupId ?? booking.recurringGroupId ?? null;

  return {
    recurringBookingId,
    recurringGroupId,
    isRecurring: Boolean(recurringBookingId || recurringGroupId)
  };
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
const isTimeBasedResource = (desk?: OccupancyDesk | null): boolean => desk?.kind === 'RAUM' || desk?.kind === 'PARKPLATZ';

const canBookDesk = (desk?: OccupancyDesk | null): boolean => {
  if (!desk) return false;
  if (desk.isBookableForMe === false) return false;
  if (isTimeBasedResource(desk)) return true;
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
      const fullName = bookingDisplayName(booking);

      const occupant: OccupantForDay = {
        deskId: desk.id,
        deskLabel: desk.name,
        deskKindLabel: resourceKindLabel(desk.kind),
        userId: booking.userId ?? booking.id ?? booking.employeeId ?? booking.userEmail ?? `${desk.id}-occupant`,
        name: fullName,
        firstName: getFirstName({ firstName: booking.userFirstName, displayName: fullName, email: booking.userEmail ?? undefined }),
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
  currentUser
}: {
  desks: OccupancyDesk[];
  employeesById: Map<string, BookingEmployee>;
  employeesByEmail: Map<string, BookingEmployee>;
  currentUserEmail?: string;
  currentUser?: AuthUser | null;
}): OccupancyDesk[] => desks.map((desk) => {
  const normalizedBookings = normalizeDeskBookings(desk).map((booking) => {
    const normalizedEmail = booking.userEmail?.toLowerCase();
    const employee = booking.employeeId
      ? employeesById.get(booking.employeeId)
      : normalizedEmail
        ? employeesByEmail.get(normalizedEmail)
        : undefined;
    const fallbackPhotoUrl = currentUserEmail && normalizedEmail && normalizedEmail === currentUserEmail.toLowerCase()
      ? resolveApiUrl(`/user/me/photo?v=${encodeURIComponent(currentUserEmail)}`)
      : undefined;
    const employeePhotoUrl = resolveApiUrl(employee?.photoUrl);
    const bookingPhotoUrl = resolveApiUrl(booking.userPhotoUrl);
    const isCurrentUser = isMineBooking(booking, currentUser?.id);

    return {
      ...booking,
      employeeId: booking.employeeId ?? employee?.id,
      userFirstName: booking.userFirstName ?? employee?.firstName ?? getFirstName({ displayName: booking.userDisplayName ?? employee?.displayName, email: booking.userEmail ?? undefined }),
      userDisplayName: booking.userDisplayName ?? employee?.displayName,
      userPhone: booking.userPhone ?? employee?.phone ?? undefined,
      userPhotoUrl: bookingPhotoUrl ?? employeePhotoUrl ?? fallbackPhotoUrl,
      employee: booking.employee ?? (booking.userEmail ? {
        id: booking.employeeId ?? employee?.id,
        email: booking.userEmail,
        displayName: booking.userDisplayName ?? employee?.displayName ?? booking.userEmail,
        phone: booking.userPhone ?? employee?.phone ?? null,
        photoUrl: booking.userPhotoUrl ?? employee?.photoUrl ?? null
      } : null),
      isCurrentUser
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
  const [selectedFloorplanId, setSelectedFloorplanId] = useState(() => getInitialFloorplanId());
  const [activeFloorId, setActiveFloorId] = useState(() => getInitialFloorplanId());
  const [selectedDate, setSelectedDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(today));

  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [roomAvailability, setRoomAvailability] = useState<RoomAvailabilityResponse | null>(null);
  const [employees, setEmployees] = useState<BookingEmployee[]>([]);
  const [selectedEmployeeEmail, setSelectedEmployeeEmail] = useState('');
  const [selectedResourceKindFilter, setSelectedResourceKindFilter] = useState<'ALL' | ResourceKind>('ALL');
  const [overviewView, setOverviewView] = useState<OverviewView>(() => getInitialOverviewView());
  const [isManageEditOpen, setIsManageEditOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState<FeedbackReportType>('BUG');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackScreenshotDataUrl, setFeedbackScreenshotDataUrl] = useState('');
  const [feedbackScreenshotName, setFeedbackScreenshotName] = useState('');
  const [feedbackScreenshotError, setFeedbackScreenshotError] = useState('');
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);

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
  const [parkingSmartArrivalTime, setParkingSmartArrivalTime] = useState('08:00');
  const [parkingSmartDepartureTime, setParkingSmartDepartureTime] = useState('16:00');
  const [parkingChargeMinutes, setParkingChargeMinutes] = useState(60);
  const [parkingSmartBookedFor, setParkingSmartBookedFor] = useState<'SELF' | 'GUEST'>('SELF');
  const [parkingSmartGuestName, setParkingSmartGuestName] = useState('');
  const [parkingSmartProposal, setParkingSmartProposal] = useState<ParkingSmartProposal | null>(null);
  const [parkingSmartError, setParkingSmartError] = useState('');
  const [parkingSmartInfo, setParkingSmartInfo] = useState('');
  const [isParkingSmartLoading, setIsParkingSmartLoading] = useState(false);
  const [isParkingSmartDialogOpen, setIsParkingSmartDialogOpen] = useState(false);
  const [isParkingSmartConfirmDialogOpen, setIsParkingSmartConfirmDialogOpen] = useState(false);
  const [rebookConfirm, setRebookConfirm] = useState<RebookConfirmState | null>(null);
  const [isRebooking, setIsRebooking] = useState(false);
  const [recurringConflictState, setRecurringConflictState] = useState<RecurringConflictState | null>(null);
  const [isResolvingRecurringConflict, setIsResolvingRecurringConflict] = useState(false);
  const [cancelFlowState, setCancelFlowState] = useState<CancelFlowState>('NONE');
  const [cancelConfirmContext, setCancelConfirmContext] = useState<CancelConfirmContext | null>(null);
  const [isCancellingBooking, setIsCancellingBooking] = useState(false);
  const [cancellingBookingId, setCancellingBookingId] = useState<string | null>(null);
  const [cancelDialogError, setCancelDialogError] = useState('');
  const [cancelSeriesPreview, setCancelSeriesPreview] = useState<CancelSeriesPreviewState>({
    loading: false,
    details: null,
    error: ''
  });
  const [cancelDebugState, setCancelDebugState] = useState<CancelDebugState>({
    lastAction: 'IDLE',
    bookingId: null,
    endpoint: '',
    httpStatus: null,
    errorMessage: ''
  });
  const [lastMutationDebug, setLastMutationDebug] = useState(() => getLastMutation());
  const [calendarBookings, setCalendarBookings] = useState<CalendarBooking[]>([]);
  const [floorplanResources, setFloorplanResources] = useState<FloorplanResource[]>([]);
  const [bookedCalendarDays, setBookedCalendarDays] = useState<string[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const selectedFloorplanForUrl = floorplans.find((floorplan) => floorplan.id === selectedFloorplanId) ?? null;
    params.set(OVERVIEW_QUERY_KEY, overviewView);
    if (selectedFloorplanForUrl) {
      params.set(FLOORPLAN_QUERY_KEY, floorplanUrlValue(selectedFloorplanForUrl));
    } else {
      params.delete(FLOORPLAN_QUERY_KEY);
    }

    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }, [overviewView, floorplans, selectedFloorplanId]);

  const [highlightedDeskId, setHighlightedDeskId] = useState('');
  const occupantRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const highlightTimerRef = useRef<number | null>(null);
  const cancelDialogRef = useRef<HTMLElement | null>(null);
  const recurringConflictDialogRef = useRef<HTMLElement | null>(null);
  const rebookDialogRef = useRef<HTMLElement | null>(null);
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
  const occupancyRequestIdRef = useRef(0);
  const floorplanResourcesRequestIdRef = useRef(0);

  const switchFloorplan = useCallback((nextFloorplanId: string) => {
    if (nextFloorplanId === selectedFloorplanId) return;
    setActiveFloorId(nextFloorplanId);
    setOccupancy(null);
    setFloorplanResources([]);
    setSelectedDeskId('');
    setHoveredDeskId('');
    setDeskPopup(null);
    setIsUpdatingOccupancy(Boolean(nextFloorplanId));
    setSelectedFloorplanId(nextFloorplanId);
  }, [selectedFloorplanId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const nextOverview = params.get(OVERVIEW_QUERY_KEY);
      const nextFloorplanId = params.get(FLOORPLAN_QUERY_KEY) ?? '';
      setOverviewView((current) => (isOverviewView(nextOverview) ? nextOverview : current));
      switchFloorplan(nextFloorplanId);
    };

    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, [switchFloorplan]);

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
  const showRoomDebugInfo = useMemo(() => isDebugMode(), []);
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

  const handleFloorplanPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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

  const handleFloorplanPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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

  const handleFloorplanPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    stopFloorplanDragging(event.pointerId);
  }, [stopFloorplanDragging]);

  const handleFloorplanPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    stopFloorplanDragging(event.pointerId);
  }, [stopFloorplanDragging]);


  const handleFloorplanClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!floorplanSuppressClickRef.current) return;
    floorplanSuppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleFloorplanWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
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
  const visibleOccupancy = useMemo(() => {
    if (!occupancy) return null;
    if (occupancy.floorplanId !== activeFloorId) return null;
    return occupancy;
  }, [activeFloorId, occupancy]);
  const desks = useMemo(() => enrichDeskBookings({
    desks: visibleOccupancy?.desks ?? [],
    employeesById,
    employeesByEmail,
    currentUserEmail,
    currentUser
  }), [visibleOccupancy?.desks, employeesByEmail, employeesById, currentUserEmail, currentUser]);
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
    if (!popupDesk || !isTimeBasedResource(popupDesk)) return [];
    if (roomAvailability && roomAvailability.resource.id === popupDesk.id && roomAvailability.date === selectedDate) {
      return roomAvailability.bookings
        .map((booking) => ({
          id: booking.id,
          startTime: booking.startTime,
          endTime: booking.endTime,
          bookedFor: booking.bookedFor,
          guestName: booking.guestName,
          employeeId: booking.employeeId ?? booking.userId ?? null,
          userId: booking.userId,
          createdBy: booking.createdBy,
          createdByEmployeeId: booking.createdByEmployeeId,
          recurringBookingId: booking.recurringBookingId,
          recurringGroupId: booking.recurringGroupId,
          type: booking.type,
          user: booking.user
        }))
        .sort((left, right) => (bookingTimeToMinutes(left.startTime) ?? 0) - (bookingTimeToMinutes(right.startTime) ?? 0));
    }

    return popupDeskBookings
      .map((booking) => ({
        id: booking.id ?? `${booking.userEmail ?? 'unknown'}-${booking.startTime}-${booking.endTime}`,
        startTime: booking.startTime ?? null,
        endTime: booking.endTime ?? null,
        bookedFor: booking.bookedFor,
        guestName: booking.guestName,
        employeeId: booking.employeeId ?? booking.userId ?? null,
        userId: booking.userId,
        createdBy: booking.createdBy,
        createdByUserId: booking.createdByUserId,
        createdByEmployeeId: booking.createdByEmployeeId,
        recurringBookingId: booking.recurringBookingId,
        recurringGroupId: booking.recurringGroupId,
        type: booking.type,
        user: booking.bookedFor === 'GUEST'
          ? null
          : { email: booking.userEmail ?? undefined, name: booking.userDisplayName }
      }))
      .sort((left, right) => (bookingTimeToMinutes(left.startTime) ?? 0) - (bookingTimeToMinutes(right.startTime) ?? 0));
  }, [popupDesk, popupDeskBookings, roomAvailability, selectedDate]);
  const popupRoomOccupancy = useMemo(() => computeRoomOccupancy(popupRoomBookingsForSelectedDay, selectedDate), [popupRoomBookingsForSelectedDay, selectedDate]);
  const popupRoomOccupiedIntervals = popupRoomOccupancy.intervals;
  const popupRoomFreeIntervals = popupRoomOccupancy.freeIntervals;
  const popupRoomOccupiedSegments = useMemo(() => computeRoomBusySegments(popupRoomBookingsForSelectedDay, {
    day: selectedDate,
    start: ROOM_WINDOW_START,
    end: ROOM_WINDOW_END,
    isOwnBooking: (booking) => isMineBooking(booking, currentUser?.id)
  }), [currentUser?.id, popupRoomBookingsForSelectedDay, selectedDate]);
  const popupRoomFreeSegments = popupRoomOccupancy.freeSegments;
  const popupRoomBookingsList = useMemo<RoomBookingListEntry[]>(() => {
    const rendered = popupRoomBookingsForSelectedDay
      .flatMap((booking) => {
        const start = bookingTimeToMinutes(booking.startTime);
        const end = bookingTimeToMinutes(booking.endTime);
        if (start === null || end === null || end <= start) return [];
        const clamped = clampInterval({ startMin: start, endMin: end }, ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES);
        if (!clamped) return [];
        const isCurrentUser = isMineBooking(booking, currentUser?.id);
        const canCancel = canCancelBooking(booking, currentUser?.id, currentUser?.role === 'admin');
        return [{
          id: booking.id,
          start: clamped.startMin,
          end: clamped.endMin,
          label: `${formatMinutes(clamped.startMin)} – ${formatMinutes(clamped.endMin)}`,
          person: bookingDisplayName(booking),
          bookingId: booking.id,
          isCurrentUser,
          isRecurring: Boolean(booking.recurringBookingId || booking.recurringGroupId || booking.type === 'recurring'),
          bookedFor: booking.bookedFor,
          userId: booking.userId,
          createdByEmployeeId: booking.createdByEmployeeId,
          recurringBookingId: booking.recurringBookingId,
          recurringGroupId: booking.recurringGroupId,
          canCancel
        }];
      })
      .sort((a, b) => a.start - b.start);

    return rendered;
  }, [popupRoomBookingsForSelectedDay, currentUser]);
  const popupRoomFreeSlotChips = useMemo(() => popupRoomFreeIntervals
    .filter((interval) => interval.endMin - interval.startMin >= 30)
    .map((interval) => ({
      startTime: formatMinutes(interval.startMin),
      endTime: formatMinutes(interval.endMin),
      label: `${formatMinutes(interval.startMin)} – ${formatMinutes(interval.endMin)}`
    })), [popupRoomFreeIntervals]);
  const roomDebugInfo = useMemo(() => {
    if (!showRoomDebugInfo || !popupDesk || !isTimeBasedResource(popupDesk)) return undefined;

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
  const popupRoomRingDebugTitle = useMemo(() => {
    if (!showRoomDebugInfo || !popupDesk || !isTimeBasedResource(popupDesk)) return undefined;

    const segmentList = popupRoomOccupiedIntervals.length > 0
      ? popupRoomOccupiedIntervals.map((interval) => `${formatMinutes(interval.startMin)}–${formatMinutes(interval.endMin)}`).join(', ')
      : '—';

    return [
      `business minutes booked: ${popupRoomOccupancy.occupiedMinutes}`,
      `business minutes free: ${popupRoomOccupancy.freeMinutes}`,
      `segments: ${segmentList}`,
      `percent booked: ${(popupRoomOccupancy.occupiedRatio * 100).toFixed(1)}%`
    ].join('\n');
  }, [popupDesk, popupRoomOccupancy.freeMinutes, popupRoomOccupancy.occupiedMinutes, popupRoomOccupancy.occupiedRatio, popupRoomOccupiedIntervals, showRoomDebugInfo]);

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
  const resourcesCount = visibleOccupancy?.desks.length ?? 0;
  const bookingsCount = useMemo(() => (visibleOccupancy?.desks ?? []).reduce((total, desk) => total + normalizeDeskBookings(desk).length, 0), [visibleOccupancy?.desks]);
  const floorplanMarkersCount = filteredDesks.filter((desk) => Number.isFinite(desk.x) && Number.isFinite(desk.y)).length;
  const floorplanCanvasDesks = floorplanImageLoadState === 'loaded'
    ? filteredDesks
      .filter((desk) => Number.isFinite(desk.x) && Number.isFinite(desk.y))
      .map((desk) => {
        if (!floorplanImageSize || floorplanImageSize.width <= 0 || floorplanImageSize.height <= 0) return desk;
        const rawX = Number(desk.x);
        const rawY = Number(desk.y);
        const legacyNormalized = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
        const xPct = legacyNormalized ? rawX * 100 : (rawX / floorplanImageSize.width) * 100;
        const yPct = legacyNormalized ? rawY * 100 : (rawY / floorplanImageSize.height) * 100;
        return { ...desk, xPct: Math.max(0, Math.min(100, xPct)), yPct: Math.max(0, Math.min(100, yPct)) };
      })
    : [];
  const shouldWarnMissingMarkers = floorplanImageLoadState === 'loaded' && resourcesCount > 0 && floorplanMarkersCount === 0;

  const firstMarkerDebug = useMemo(() => {
    const firstDesk = floorplanCanvasDesks.find((desk) => Number.isFinite(desk.x) && Number.isFinite(desk.y));
    if (!firstDesk || !floorplanImageSize || floorplanImageSize.width <= 0 || floorplanImageSize.height <= 0) return null;
    const rawX = Number(firstDesk.x);
    const rawY = Number(firstDesk.y);
    const legacyNormalized = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
    const xPct = legacyNormalized ? rawX * 100 : (rawX / floorplanImageSize.width) * 100;
    const yPct = legacyNormalized ? rawY * 100 : (rawY / floorplanImageSize.height) * 100;
    const clampedXPct = Math.max(0, Math.min(100, xPct));
    const clampedYPct = Math.max(0, Math.min(100, yPct));
    return {
      deskId: firstDesk.id,
      left: floorplanDisplayedRect.left + (clampedXPct / 100) * floorplanDisplayedRect.width,
      top: floorplanDisplayedRect.top + (clampedYPct / 100) * floorplanDisplayedRect.height,
    };
  }, [floorplanCanvasDesks, floorplanDisplayedRect.height, floorplanDisplayedRect.left, floorplanDisplayedRect.top, floorplanDisplayedRect.width, floorplanImageSize]);

  const roomBookingConflict = useMemo(() => {
    if (!popupDesk || !isRoomResource(popupDesk)) return '';
    const start = bookingTimeToMinutes(bookingFormValues.startTime);
    const end = bookingTimeToMinutes(bookingFormValues.endTime);
    if (start === null || end === null || end <= start) return '';
    const conflict = popupRoomOccupiedIntervals.find((interval) => start < interval.endMin && end > interval.startMin);
    if (!conflict) return '';
    return `Kollidiert mit ${formatMinutes(conflict.startMin)} – ${formatMinutes(conflict.endMin)}`;
  }, [popupDesk, bookingFormValues.startTime, bookingFormValues.endTime, popupRoomOccupiedIntervals]);
  const popupMyBookings = useMemo(() => popupDeskBookings.filter((booking) => isMineBooking(booking, currentUser?.id)), [popupDeskBookings, currentUser?.id]);
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
  const popupMode: BookingMode = popupDesk && popupMyBookings.length > 0 ? 'manage' : 'create';
  const popupDeskState = popupDesk ? (popupDesk.isBookableForMe === false ? 'UNBOOKABLE' : !canBookDesk(popupDesk) ? 'TAKEN' : 'FREE') : null;
  const meEmployeeId = currentUser?.id;
  const popupCancelableBookings = useMemo(() => {
    if (!popupDesk || isRoomResource(popupDesk)) return [] as NormalizedOccupancyBooking[];
    return popupDeskBookings.filter((booking) => canCancelBooking(booking, meEmployeeId, currentUser?.role === 'admin'));
  }, [currentUser?.role, meEmployeeId, popupDesk, popupDeskBookings]);
  const canCancelHere = popupCancelableBookings.length > 0;
  const popupOwnBookingIsRecurring = useMemo(() => popupDeskBookings.some((booking) => booking.isCurrentUser && (Boolean(booking.recurringBookingId) || Boolean(booking.recurringGroupId))), [popupDeskBookings]);
  const popupForeignBookings = useMemo(() => popupDeskBookings.filter((booking) => !isMineBooking(booking, currentUser?.id)), [popupDeskBookings, currentUser?.id]);
  const showForeignBookingInfoDialog = Boolean(
    popupDesk
    && !isRoomResource(popupDesk)
    && popupDeskBookings.length > 0
    && popupMyBookings.length === 0
    && popupForeignBookings.length > 0
  );

  const handleCallPerson = useCallback((phone?: string | null) => {
    const dialablePhone = getDialablePhone(phone);
    if (!dialablePhone) return;

    const teamsUrl = toTeamsCallUrl(dialablePhone);
    const telUrl = `tel:${dialablePhone}`;
    window.open(teamsUrl, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => {
      window.location.href = telUrl;
    }, 600);
  }, []);
  const handleEmailPerson = useCallback((email?: string | null) => {
    const contactEmail = getContactEmail(email);
    if (!contactEmail) return;
    window.location.href = toMailtoUrl(contactEmail);
  }, []);
  const handleChatWithPerson = useCallback((email?: string | null) => {
    const contactEmail = getContactEmail(email);
    if (!contactEmail) return;

    const teamsWebUrl = toTeamsChatUrl(contactEmail);
    const teamsClientUrl = toTeamsChatClientUrl(contactEmail);
    const openedWindow = window.open(teamsWebUrl, '_blank', 'noopener,noreferrer');
    if (!openedWindow) {
      window.location.href = teamsClientUrl;
    }
  }, []);
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
  const cancelConfirmIsSeries = Boolean(cancelConfirmContext?.recurringBookingId || cancelConfirmContext?.recurringGroupId);
  const cancelSeriesPreviewCount = cancelSeriesPreview.details?.seriesBookingCount ?? null;
  const recurrencePatternLabel = useMemo(() => {
    const patternType = cancelSeriesPreview.details?.recurrence?.patternType;
    if (!patternType) return '';
    if (patternType === 'DAILY') return 'Täglich';
    if (patternType === 'WEEKLY') return 'Wöchentlich';
    if (patternType === 'MONTHLY') return 'Monatlich';
    if (patternType === 'YEARLY') return 'Jährlich';
    return '';
  }, [cancelSeriesPreview.details?.recurrence?.patternType]);
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

    const resourcesByFloorplan = floorplanResources.filter((resource) => (
      resource.floorplanId === selectedFloorplanId
      && resource.kind !== 'RAUM'
      && resource.isBookableForMe !== false
    ));
    const total = resourcesByFloorplan.length;
    if (total === 0) {
      availabilityCacheRef.current.set(cacheKey, nextAvailability);
      return nextAvailability;
    }

    const resourceIds = new Set(resourcesByFloorplan.map((resource) => resource.id));
    const occupancyByDayDesk = new Map<string, Map<string, { am: boolean; pm: boolean }>>();

    for (const booking of calendarBookings) {
      if (!resourceIds.has(booking.deskId)) continue;
      const dayKey = toBookingDateKey(booking.date);
      const perDesk = occupancyByDayDesk.get(dayKey) ?? new Map<string, { am: boolean; pm: boolean }>();
      const slotState = perDesk.get(booking.deskId) ?? { am: false, pm: false };
      const normalizedSlot = booking.daySlot ?? (booking.slot === 'MORNING' ? 'AM' : booking.slot === 'AFTERNOON' ? 'PM' : booking.slot === 'FULL_DAY' ? 'FULL' : undefined);
      if (normalizedSlot === 'FULL') {
        slotState.am = true;
        slotState.pm = true;
      } else if (normalizedSlot === 'AM') {
        slotState.am = true;
      } else if (normalizedSlot === 'PM') {
        slotState.pm = true;
      }
      perDesk.set(booking.deskId, slotState);
      occupancyByDayDesk.set(dayKey, perDesk);
    }

    for (const day of calendarDays) {
      const dayKey = toDateKey(day);
      const perDesk = occupancyByDayDesk.get(dayKey) ?? new Map<string, { am: boolean; pm: boolean }>();
      let totalFreeHalfSlots = 0;
      for (const resource of resourcesByFloorplan) {
        const slotState = perDesk.get(resource.id) ?? { am: false, pm: false };
        if (!slotState.am) totalFreeHalfSlots += 1;
        if (!slotState.pm) totalFreeHalfSlots += 1;
      }

      if (totalFreeHalfSlots <= 0) {
        nextAvailability.set(dayKey, 'none-free');
      } else {
        const freeRatio = totalFreeHalfSlots / (resourcesByFloorplan.length * 2);
        nextAvailability.set(dayKey, freeRatio <= 0.25 ? 'few-free' : 'many-free');
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

    const currentRequestId = occupancyRequestIdRef.current + 1;
    occupancyRequestIdRef.current = currentRequestId;
    setIsUpdatingOccupancy(true);

    try {
      const nextOccupancy = await runWithAppLoading(() => get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`));
      if (currentRequestId !== occupancyRequestIdRef.current) return null;
      if (nextOccupancy.floorplanId !== activeFloorId) return null;

      setOccupancy(nextOccupancy);
      markBackendAvailable(true);
      setBackendDown(false);
      setSelectedDeskId((prev) => (nextOccupancy.desks.some((desk) => desk.id === prev) ? prev : ''));
      return nextOccupancy;
    } catch (error) {
      if (currentRequestId !== occupancyRequestIdRef.current) return null;
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
      }

      if (error instanceof ApiError && error.status === 403) {
        setOccupancy(null);
        setFloorplanResources([]);
        setSelectedDeskId('');
        setSelectedFloorplanId((current) => (current === floorplanId ? '' : current));
      }

      toast.error(getApiErrorMessage(error, 'Belegung konnte nicht geladen werden.'));
      return null;
    } finally {
      if (currentRequestId === occupancyRequestIdRef.current) {
        setIsUpdatingOccupancy(false);
      }
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
        const resolvedInitialFloorplanId = resolveFloorplanSelection(selectedFloorplanId, normalizedFloorplans);
        setFloorplans(normalizedFloorplans);
        setEmployees(nextEmployees);
        setSelectedFloorplanId(resolvedInitialFloorplanId || normalizedFloorplans.find((plan) => plan.isDefault)?.id || normalizedFloorplans[0]?.id || '');
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
    if (selectedFloorplanId === activeFloorId) return;
    setActiveFloorId(selectedFloorplanId);
    setOccupancy(null);
    setFloorplanResources([]);
    setSelectedDeskId('');
    setIsUpdatingOccupancy(Boolean(selectedFloorplanId));
  }, [activeFloorId, selectedFloorplanId]);

  useEffect(() => {
    if (!selectedFloorplanId) return;
    if (floorplans.some((floorplan) => floorplan.id === selectedFloorplanId)) return;
    const resolvedFloorplanId = resolveFloorplanSelection(selectedFloorplanId, floorplans);
    setSelectedFloorplanId(resolvedFloorplanId || floorplans.find((plan) => plan.isDefault)?.id || floorplans[0]?.id || '');
    setSelectedDeskId('');
    setFloorplanResources([]);
    setOccupancy(null);
  }, [floorplans, selectedFloorplanId]);

  useEffect(() => {
    if (backendDown || isBootstrapping || !selectedFloorplanId) return;
    if (!floorplans.some((floorplan) => floorplan.id === selectedFloorplanId)) return;

    loadOccupancy(selectedFloorplanId, selectedDate);
  }, [backendDown, floorplans, isBootstrapping, selectedDate, selectedFloorplanId]);

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
      const currentRequestId = floorplanResourcesRequestIdRef.current + 1;
      floorplanResourcesRequestIdRef.current = currentRequestId;
      try {
        const resources = await runWithAppLoading(() => get<FloorplanResource[]>(`/floorplans/${selectedFloorplanId}/desks`));
        if (currentRequestId !== floorplanResourcesRequestIdRef.current) return;
        if (selectedFloorplanId !== activeFloorId) return;
        if (cancelled) return;
        setFloorplanResources(resources);
      } catch {
        if (cancelled) return;
        if (currentRequestId !== floorplanResourcesRequestIdRef.current) return;
        setFloorplanResources([]);
      }
    };

    loadFloorplanResources();

    return () => {
      cancelled = true;
    };
  }, [activeFloorId, backendDown, selectedFloorplanId]);


  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

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

  const selectDeskFromCanvas = (deskId: string, anchorEl?: HTMLElement, options?: { allowUnbookable?: boolean }) => {
    const desk = desks.find((entry) => entry.id === deskId);
    if (!desk || !anchorEl) return;
    if (desk.isBookableForMe === false && !options?.allowUnbookable) return;

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
    setParkingSmartProposal(null);
    setParkingSmartError('');
    setIsManageEditOpen(false);

    const defaults = createDefaultBookingFormValues(selectedDate);
    setBookingFormValues(defaults);
    setManageTargetSlot(defaults.slot);

    const deskBookings = normalizeDeskBookings(desk);
    const mineBookings = deskBookings.filter((booking) => isMineBooking(booking, currentUser?.id));
    const hasMineBookings = mineBookings.length > 0;

    let fullyOccupiedByOthers = false;
    if (isRoomResource(desk)) {
      const occupiedIntervals = mergeIntervals(deskBookings
        .filter((booking) => !isMineBooking(booking, currentUser?.id))
        .flatMap((booking) => {
          const start = bookingTimeToMinutes(booking.startTime);
          const end = bookingTimeToMinutes(booking.endTime);
          if (start === null || end === null || end <= start) return [];
          const clamped = clampInterval({ startMin: start, endMin: end }, ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES);
          return clamped ? [clamped] : [];
        }));
      const freeIntervals = invertIntervals(ROOM_WINDOW_START_MINUTES, ROOM_WINDOW_END_MINUTES, occupiedIntervals);
      fullyOccupiedByOthers = freeIntervals.every((interval) => interval.endMin <= interval.startMin);
    } else {
      fullyOccupiedByOthers = !canBookDesk(desk);
    }

    if (hasMineBookings) {
      setBookingDialogState('IDLE');
    } else if (fullyOccupiedByOthers && !isRoomResource(desk)) {
      setBookingDialogState('IDLE');
    } else {
      if (!isRoomResource(desk)) {
        const nextSlot = getDefaultSlotForDesk(desk);
        if (nextSlot) defaults.slot = nextSlot;
      } else {
        const occupiedIntervals = mergeIntervals(deskBookings.flatMap((booking) => {
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
    setBookingFormValues(createDefaultBookingFormValues(selectedDate));
    setDeskPopup(null);
    setRebookConfirm(null);
    setBookingDialogState('IDLE');
    setDialogErrorMessage('');
    setIsRebooking(false);
    setCancelFlowState('NONE');
    setCancelConfirmContext(null);
    setIsCancellingBooking(false);
    setCancellingBookingId(null);
    setCancelDialogError('');
    setIsManageEditOpen(false);
    setRecurringConflictState(null);
    setIsResolvingRecurringConflict(false);
  };

  const updateCancelDebug = useCallback((next: Partial<CancelDebugState> & { lastAction: CancelDebugAction }) => {
    setCancelDebugState((current) => ({
      ...current,
      ...next
    }));
  }, []);

  useEffect(() => {
    const bookingId = cancelConfirmContext?.bookingIds[0];
    if (cancelFlowState !== 'CANCEL_CONFIRM_OPEN' || !cancelConfirmIsSeries || !bookingId) {
      setCancelSeriesPreview({ loading: false, details: null, error: '' });
      return;
    }

    let cancelled = false;
    setCancelSeriesPreview({ loading: true, details: null, error: '' });

    void fetchBookingCancelPreview(bookingId)
      .then((details) => {
        if (cancelled) return;
        setCancelSeriesPreview({ loading: false, details, error: '' });
      })
      .catch((error) => {
        if (cancelled) return;
        const errorMessage = error instanceof Error ? error.message : 'Details zur Serie konnten nicht geladen werden.';
        setCancelSeriesPreview({ loading: false, details: null, error: errorMessage });
      });

    return () => {
      cancelled = true;
    };
  }, [cancelConfirmContext?.bookingIds, cancelConfirmIsSeries, cancelFlowState]);

  const openCancelConfirm = () => {
    if (!deskPopup || !popupDesk || !canCancelHere) return;

    const ownBooking = popupCancelableBookings[0] ?? null;
    if (!ownBooking) return;

    const isTimeBasedParking = popupDesk.kind === 'PARKPLATZ' && isTimeBasedResource(popupDesk);
    const bookingIds = isTimeBasedParking
      ? popupCancelableBookings
        .map((booking) => booking.id)
        .filter((id): id is string => Boolean(id))
      : ownBooking.sourceBookingIds?.length
        ? ownBooking.sourceBookingIds.filter((id) => {
          const sourceBooking = popupDeskBookings.find((booking) => booking.id === id);
          return Boolean(sourceBooking && canCancelBooking(sourceBooking, meEmployeeId, currentUser?.role === 'admin'));
        })
        : ownBooking.id
          ? [ownBooking.id]
          : [];
    if (bookingIds.length === 0) return;

    const recurringMeta = getRecurringMetadataForBooking(popupDesk, ownBooking);

    setCancelConfirmContext({
      ...deskPopup,
      bookingIds,
      bookingLabel: isTimeBasedParking && bookingIds.length > 1 ? `${bookingIds.length} Buchungen` : bookingSlotLabel(ownBooking),
      recurringBookingId: recurringMeta.recurringBookingId,
      recurringGroupId: recurringMeta.recurringGroupId,
      isRecurring: recurringMeta.isRecurring,
      keepPopoverOpen: false
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

  const submitPopupBooking = async (deskId: string, payload: BookingSubmitPayload, options?: { overwrite?: boolean; explicitDates?: string[]; conflictResolution?: 'BOOK_ONLY_FREE' | 'REBOOK_CONFLICTS_AND_BOOK_FREE'; suppressSuccessToast?: boolean }): Promise<BulkBookingResponse | void> => {
    if (!selectedEmployeeEmail) {
      throw new Error('Bitte Mitarbeiter auswählen.');
    }

    if (payload.type === 'single') {
      await runWithAppLoading(() => post('/bookings', {
        deskId,
        userEmail: selectedEmployeeEmail,
        bookedFor: payload.bookedFor,
        guestName: payload.bookedFor === 'GUEST' ? payload.guestName : undefined,
        date: payload.date,
        daySlot: isTimeBasedResource(popupDesk) ? undefined : payload.slot === 'FULL_DAY' ? 'FULL' : payload.slot === 'MORNING' ? 'AM' : payload.slot === 'AFTERNOON' ? 'PM' : undefined,
        startTime: isTimeBasedResource(popupDesk) ? payload.startTime : undefined,
        endTime: isTimeBasedResource(popupDesk) ? payload.endTime : undefined,
        overwrite: options?.overwrite ?? false
      }));
      toast.success((options?.overwrite ?? false) ? 'Umbuchung durchgeführt.' : 'Gebucht', { deskId });
      return { createdCount: 1 };

    }
    const recurringTarget = popupDesk?.id === deskId ? popupDesk : desks.find((desk) => desk.id === deskId);
    const isTimeRecurring = Boolean(recurringTarget && isTimeBasedResource(recurringTarget));
    const recurringPayload = {
      resourceId: deskId,
      startDate: payload.startDate,
      endDate: payload.endDate ?? payload.startDate,
      patternType: payload.patternType,
      interval: payload.interval,
      byWeekday: payload.byWeekday,
      byMonthday: payload.byMonthday,
      byMonth: payload.byMonth,
      rangeMode: payload.rangeMode,
      count: payload.count,
      bookedFor: payload.bookedFor,
      guestName: payload.bookedFor === 'GUEST' ? payload.guestName : undefined,
      period: isTimeRecurring ? null : payload.slot === 'MORNING' ? 'AM' : payload.slot === 'AFTERNOON' ? 'PM' : 'FULL',
      startTime: isTimeRecurring ? payload.startTime : null,
      endTime: isTimeRecurring ? payload.endTime : null,
      overwrite: options?.overwrite ?? false,
      conflictResolution: options?.conflictResolution,
      explicitDates: options?.explicitDates
    };

    if (showRoomDebugInfo) {
      console.log('[BOOKING_DEBUG] recurring payload', recurringPayload);
    }

    const response = await runWithAppLoading(() => post<BulkBookingResponse>('/recurring-bookings', recurringPayload));

    if (!options?.suppressSuccessToast) {
      toast.success((options?.overwrite ?? false)
        ? `${response.createdCount ?? 0} Tage gebucht, ${response.updatedCount ?? 0} Tage umgebucht.`
        : 'Gebucht', { deskId });
    }
    return response;
  };


  const requestSmartParkingProposal = async () => {
    if (!selectedFloorplanId || !selectedDate || !parkingSmartArrivalTime || !parkingSmartDepartureTime) return;
    if (toMinutes(parkingSmartDepartureTime) <= toMinutes(parkingSmartArrivalTime)) {
      setParkingSmartError('Abreise muss nach der Anreise liegen.');
      setParkingSmartProposal(null);
      return;
    }
    if (parkingSmartBookedFor === 'GUEST' && parkingSmartGuestName.trim().length < 2) {
      setParkingSmartError('Gastname muss mindestens 2 Zeichen haben.');
      setParkingSmartProposal(null);
      return;
    }

    setParkingSmartError('');
    setParkingSmartInfo('');
    setParkingSmartProposal(null);
    setIsParkingSmartConfirmDialogOpen(false);
    setIsParkingSmartLoading(true);
    try {
      const response = await post<ParkingSmartProposeResponse>('/bookings/parking-smart/propose', {
        floorplanId: selectedFloorplanId,
        date: selectedDate,
        arrivalTime: parkingSmartArrivalTime,
        departureTime: parkingSmartDepartureTime,
        chargingMinutes: parkingChargeMinutes
      });

      if (response.status !== 'ok' || !response.bookings) {
        if (response.fallbackWithoutCharging) {
          setParkingSmartInfo(response.message ?? 'Laden ist nicht verfügbar. Möchtest du stattdessen ohne Laden buchen?');
          setParkingSmartProposal(response.fallbackWithoutCharging);
          return;
        }
        setParkingSmartError(response.message ?? 'Keine passende Kombination verfügbar.');
        return;
      }

      if (response.message) setParkingSmartInfo(response.message);
      if (typeof response.adjustedChargingMinutes === 'number' && response.adjustedChargingMinutes > 0 && response.adjustedChargingMinutes !== parkingChargeMinutes) {
        setParkingSmartInfo(response.message ?? `Es ist aktuell eine kürzere Ladedauer von ${Math.floor(response.adjustedChargingMinutes / 60)}h ${response.adjustedChargingMinutes % 60}min verfügbar.`);
      }

      setParkingSmartProposal({
        proposalType: response.proposalType ?? (response.bookings.length === 2 ? 'split' : 'single'),
        usedFallbackChargerFullWindow: Boolean(response.usedFallbackChargerFullWindow),
        switchAfterCharging: Boolean(response.switchAfterCharging),
        bookings: response.bookings
      });
    } catch (error) {
      setParkingSmartError(getApiErrorMessage(error, 'Parkplatz konnte nicht zugewiesen werden.'));
    } finally {
      setIsParkingSmartLoading(false);
    }
  };

  const confirmSmartParkingProposal = async () => {
    if (!parkingSmartProposal) return;
    if (parkingSmartBookedFor === 'GUEST' && parkingSmartGuestName.trim().length < 2) {
      setParkingSmartError('Gastname muss mindestens 2 Zeichen haben.');
      return;
    }
    setIsParkingSmartLoading(true);
    setParkingSmartError('');
    try {
      await post('/bookings/parking-smart/confirm', {
        date: selectedDate,
        bookedFor: parkingSmartBookedFor,
        guestName: parkingSmartBookedFor === 'GUEST' ? parkingSmartGuestName.trim() : undefined,
        bookings: parkingSmartProposal.bookings.map((entry) => ({ deskId: entry.deskId, startMinute: entry.startMinute, endMinute: entry.endMinute }))
      });
      toast.success('Parkplatz gebucht');
      setParkingSmartProposal(null);
      setIsParkingSmartConfirmDialogOpen(false);
      setIsParkingSmartDialogOpen(false);
      reloadBookings().catch(() => undefined);
    } catch (error) {
      setParkingSmartError(getApiErrorMessage(error, 'Nicht mehr verfügbar, bitte neu zuweisen.'));
    } finally {
      setIsParkingSmartLoading(false);
    }
  };

  const openParkingSmartDialog = () => {
    setParkingSmartError('');
    setParkingSmartInfo('');
    setParkingSmartProposal(null);
    setParkingSmartBookedFor('SELF');
    setParkingSmartGuestName('');
    setIsParkingSmartConfirmDialogOpen(false);
    setIsParkingSmartDialogOpen(true);
  };

  const closeParkingSmartDialog = () => {
    if (isParkingSmartLoading) return;
    setParkingSmartError('');
    setParkingSmartInfo('');
    setParkingSmartProposal(null);
    setParkingSmartBookedFor('SELF');
    setParkingSmartGuestName('');
    setIsParkingSmartConfirmDialogOpen(false);
    setIsParkingSmartDialogOpen(false);
  };

  const parkingRelocationTime = useMemo(() => {
    if (!parkingSmartProposal?.switchAfterCharging || parkingSmartProposal.bookings.length < 2) return null;
    const firstSegment = parkingSmartProposal.bookings[0];
    return firstSegment.endTime ?? formatMinutes(firstSegment.endMinute);
  }, [parkingSmartProposal]);

  const isParkingTimeRangeInvalid = useMemo(
    () => Boolean(parkingSmartArrivalTime && parkingSmartDepartureTime && toMinutes(parkingSmartDepartureTime) <= toMinutes(parkingSmartArrivalTime)),
    [parkingSmartArrivalTime, parkingSmartDepartureTime]
  );

  const parkingScheduleEntries = useMemo(() => {
    if (!parkingSmartProposal) return [];
    return parkingSmartProposal.bookings.map((entry, index) => ({
      id: `${entry.deskId}-${index}`,
      number: extractParkingNumber(entry.deskName),
      startTime: entry.startTime ?? formatMinutes(entry.startMinute),
      endTime: entry.endTime ?? formatMinutes(entry.endMinute),
      hasCharging: entry.hasCharger,
      hint: entry.hasCharger ? 'Ladezeit' : undefined,
      transitionLabel: parkingRelocationTime && parkingSmartProposal.switchAfterCharging && index === 0 ? `Umparken um ${parkingRelocationTime}` : undefined
    }));
  }, [parkingRelocationTime, parkingSmartProposal]);

  const hasParkingProposalConflict = useMemo(() => {
    if (!parkingSmartProposal) return false;
    return parkingSmartProposal.bookings.some((entry, index) => parkingSmartProposal.bookings.some((candidate, candidateIndex) => {
      if (index === candidateIndex || entry.deskId !== candidate.deskId) return false;
      return entry.startMinute < candidate.endMinute && candidate.startMinute < entry.endMinute;
    }));
  }, [parkingSmartProposal]);

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
      await submitPopupBooking(popupDesk.id, { type: 'single', date: selectedDate, slot: manageTargetSlot, bookedFor: 'SELF' }, { overwrite: true });
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

  const previewRecurringConflicts = async (deskId: string, payload: Extract<BookingSubmitPayload, { type: 'recurring' }>): Promise<RecurringPreviewResponse> => {
    const period = payload.slot === 'MORNING' ? 'AM' : payload.slot === 'AFTERNOON' ? 'PM' : 'FULL';
    return runWithAppLoading(() => post<RecurringPreviewResponse>('/recurring-bookings/preview', {
      resourceId: deskId,
      resourceType: popupDesk?.kind,
      bookedFor: payload.bookedFor,
      guestName: payload.bookedFor === 'GUEST' ? payload.guestName : undefined,
      startDate: payload.startDate,
      endDate: payload.endDate,
      rangeMode: payload.rangeMode,
      count: payload.count,
      patternType: payload.patternType,
      interval: payload.interval,
      byWeekday: payload.byWeekday,
      byMonthday: payload.byMonthday,
      byMonth: payload.byMonth,
      period
    }));
  };

  const runRecurringReassign = async () => {
    if (!popupDesk || !recurringConflictState) return;
    setIsResolvingRecurringConflict(true);
    setDialogErrorMessage('');
    try {
      const result = await submitPopupBooking(popupDesk.id, recurringConflictState.payload, {
        conflictResolution: 'REBOOK_CONFLICTS_AND_BOOK_FREE',
        suppressSuccessToast: true
      });
      await reloadBookings();
      toast.success(`Konflikte umgebucht. ${(result as BulkBookingResponse | undefined)?.createdCount ?? 0} Termine erstellt, ${(result as BulkBookingResponse | undefined)?.movedCount ?? 0} verschoben.`);
      setRecurringConflictState(null);
      setBookingVersion((value) => value + 1);
      closeBookingFlow();
    } catch (error) {
      setDialogErrorMessage(error instanceof Error ? error.message : 'Konfliktauflösung fehlgeschlagen.');
    } finally {
      setIsResolvingRecurringConflict(false);
    }
  };




  const runRecurringIgnoreConflicts = async () => {
    if (!popupDesk || !recurringConflictState) return;
    setIsResolvingRecurringConflict(true);
    try {
      const result = await submitPopupBooking(popupDesk.id, recurringConflictState.payload, {
        conflictResolution: 'BOOK_ONLY_FREE',
        suppressSuccessToast: true
      });
      await reloadBookings();
      const created = (result as BulkBookingResponse | undefined)?.createdCount ?? 0;
      const skipped = (result as BulkBookingResponse | undefined)?.skippedDates?.length ?? recurringConflictState.conflictDates.length;
      toast.success(`${created} Termine erstellt, ${skipped} übersprungen (Konflikte).`);
      setRecurringConflictState(null);
      setBookingVersion((value) => value + 1);
      closeBookingFlow();
    } catch (error) {
      setDialogErrorMessage(error instanceof Error ? error.message : 'Teilweise Serienbuchung fehlgeschlagen.');
    } finally {
      setIsResolvingRecurringConflict(false);
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
    const mutationName = payload.type === 'single' && payload.bookedFor === 'GUEST' ? 'BOOKING_CREATE_GUEST' : 'BOOKING_CREATE_SELF';

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
          bookedFor: payload.bookedFor,
          guestName: payload.bookedFor === 'GUEST' ? payload.guestName : undefined,
          date: payload.date,
          startTime: payload.startTime,
          endTime: payload.endTime,
          overwrite: false
        };
        await runWithAppLoading(() => createRoomBooking(body, { requestId }));
        toast.success('Gebucht', { deskId: popupDesk.id });
      } else {
        if (payload.type === 'recurring' && !isRoomResource(popupDesk)) {
          const preview = await previewRecurringConflicts(popupDesk.id, payload);
          if (preview.conflictDates.length > 0) {
            setRecurringConflictState({
              payload,
              conflictDates: preview.conflictDates,
              freeDates: preview.freeDates
            });
            setBookingDialogState('BOOKING_OPEN');
            return;
          }
        }
        await submitPopupBooking(popupDesk.id, payload, { overwrite: false });
      }
      const refreshed = await reloadBookings(isRoomCreate ? { requestId, roomId: popupDesk.id, date: payload.date } : undefined);
      if (!refreshed) {
        const failedMutation = setLastMutation({
          mutation: mutationName,
          status: 'error',
          errorMessage: 'Refetch fehlgeschlagen',
          responseSnippet: 'refetch_failed'
        });
        setLastMutationDebug(failedMutation);
        setBookingDialogState('BOOKING_OPEN');
        setDialogErrorMessage('Buchung gespeichert, aber Aktualisierung fehlgeschlagen. Bitte erneut laden.');
        return;
      }
      const successfulMutation = setLastMutation({
        mutation: mutationName,
        status: 'success',
        responseSnippet: toBodySnippet({ deskId: popupDesk.id, date: payload.type === 'single' ? payload.date : selectedDate, bookedFor: payload.type === 'single' ? payload.bookedFor : 'SELF' })
      });
      setLastMutationDebug(successfulMutation);
      setBookingVersion((value) => value + 1);
      closeBookingFlow();
    } catch (error) {
      if (isRoomCreate) {
        logMutation('ROOM_CREATE_ERROR', {
          requestId,
          err: error instanceof Error ? error.message : toBodySnippet(error)
        });
      }
      const failedMutation = setLastMutation({
        mutation: mutationName,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Buchung fehlgeschlagen',
        responseSnippet: toBodySnippet(error)
      });
      setLastMutationDebug(failedMutation);
      if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
        setBackendDown(true);
        setBookingDialogState('BOOKING_OPEN');
        setDialogErrorMessage('Backend nicht erreichbar. Bitte erneut versuchen.');
        return;
      }

      if (isUserBookingConflictError(error)) {
        setDeskPopup(null);
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

      if (error instanceof ApiError && error.backendCode === 'RECURRENCE_LIMIT_EXCEEDED') {
        const details = (typeof error.details === 'object' && error.details !== null ? error.details : null) as { max?: number; count?: number; message?: string } | null;
        const max = typeof details?.max === 'number' ? details.max : 365;
        const count = typeof details?.count === 'number' ? details.count : undefined;
        setBookingDialogState('BOOKING_OPEN');
        setDialogErrorMessage(details?.message ?? (typeof count === 'number'
          ? `Serienbuchung überschreitet das Maximum von ${max} Terminen (berechnet: ${count}).`
          : `Serienbuchung überschreitet das Maximum von ${max} Terminen.`));
        return;
      }

      if (payload.type === 'recurring' && error instanceof ApiError && error.backendCode === 'SERIES_CONFLICT') {
        const details = (typeof error.details === 'object' && error.details !== null ? error.details : null) as { conflictDates?: unknown } | null;
        const conflictDates = Array.isArray(details?.conflictDates)
          ? details.conflictDates.filter((value): value is string => typeof value === 'string')
          : [];
        if (conflictDates.length > 0) {
          setRecurringConflictState({
            payload,
            conflictDates,
            freeDates: []
          });
          setBookingDialogState('BOOKING_OPEN');
          setDialogErrorMessage('');
          return;
        }
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
      await submitPopupBooking(rebookConfirm.deskId, rebookConfirm.retryPayload, { overwrite: true });
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

  const handleRoomBookingCancel = (event: ReactMouseEvent<HTMLButtonElement>, bookingId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!deskPopup || !popupDesk || !isTimeBasedResource(popupDesk)) return;
    const selectedBooking = popupRoomBookingsList.find((booking) => booking.id === bookingId);
    if (!selectedBooking || !selectedBooking.canCancel || !selectedBooking.bookingId) return;

    setCancelConfirmContext({
      ...deskPopup,
      bookingIds: [selectedBooking.bookingId],
      bookingLabel: selectedBooking.label,
      recurringBookingId: selectedBooking.recurringBookingId ?? null,
      recurringGroupId: selectedBooking.recurringGroupId ?? null,
      isRecurring: selectedBooking.isRecurring,
      keepPopoverOpen: false
    });
    setCancelDialogError('');
    setIsCancellingBooking(false);
    setCancellingBookingId(null);
    setCancelFlowState('CANCEL_CONFIRM_OPEN');
  };

  const cancelBookingWithRefresh = async ({
    bookingId,
    cancelMode,
    requestId,
    deskId,
    date,
    keepPopoverOpen,
    popupDeskId,
    isRoomCancel
  }: {
    bookingId: string;
    cancelMode: 'SINGLE' | 'SERIES_ALL';
    requestId: string;
    deskId: string;
    date: string;
    keepPopoverOpen: boolean;
    popupDeskId: string;
    isRoomCancel: boolean;
  }) => {
    const endpoint = `${API_BASE}/bookings/${bookingId}?scope=${cancelMode === 'SERIES_ALL' ? 'series' : 'single'}`;
    updateCancelDebug({ lastAction: 'CANCEL_REQUEST', bookingId, endpoint, httpStatus: null, errorMessage: '' });

    const scope = cancelMode === 'SERIES_ALL' ? 'series' : 'single';
    let deletedCount = 1;
    await runWithAppLoading(async () => {
      const result = await cancelBooking(bookingId, scope, isRoomCancel ? { requestId } : undefined);
      deletedCount = result.deletedCount;
    });

    updateCancelDebug({ lastAction: 'CANCEL_SUCCESS', bookingId, endpoint, httpStatus: 200, errorMessage: '' });

    if (cancelMode === 'SERIES_ALL') {
      toast.success(`Serie storniert (${deletedCount} Termin(e))`, { deskId });
    } else {
      setOccupancy((current) => removeBookingFromOccupancy(current, bookingId));
      toast.success('Buchung storniert', { deskId });
    }

    setBookingVersion((value) => value + 1);
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
    try {
      const calendarEntries = await runWithAppLoading(() => get<CalendarBooking[]>(`/bookings?from=${calendarRange.from}&to=${calendarRange.to}`));
      setCalendarBookings(calendarEntries);
      setBookedCalendarDays(Array.from(new Set(calendarEntries.map((entry) => toBookingDateKey(entry.date)))));
    } catch {
      setCalendarBookings([]);
      setBookedCalendarDays([]);
    }

    const refreshedDesk = refreshed?.desks.find((desk) => desk.id === deskId);
    const refreshedCount = refreshedDesk ? normalizeDeskBookings(refreshedDesk).length : 0;
    updateCancelDebug({ lastAction: 'REFRESH_DONE', bookingId, endpoint, httpStatus: 200, errorMessage: '' });
    if (isRoomCancel) {
      logMutation('ROOM_REFETCH_DONE', { requestId, roomId: deskId, count: refreshedCount });
    }
  };

  const submitPopupCancel = async (event: ReactMouseEvent<HTMLButtonElement>, cancelMode: 'SINGLE' | 'SERIES_ALL' = 'SINGLE') => {
    event.preventDefault();
    event.stopPropagation();
    if (!cancelConfirmDesk || !cancelConfirmContext) return;

    const bookingIds = cancelConfirmContext.bookingIds;
    const bookingId = bookingIds[0];
    const requestId = createMutationRequestId();
    const isRoomCancel = isRoomResource(cancelConfirmDesk);
    const cancelAllByDefault = cancelMode === 'SINGLE' && cancelConfirmDesk.kind === 'PARKPLATZ' && bookingIds.length > 1;

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

    const endpoint = `${API_BASE}/bookings/${bookingId}?scope=${cancelMode === 'SERIES_ALL' ? 'series' : 'single'}`;
    updateCancelDebug({ lastAction: 'CANCEL_CLICK', bookingId, endpoint, httpStatus: null, errorMessage: '' });
    setCancelDialogError('');
    setIsCancellingBooking(true);
    setCancellingBookingId(bookingId);
    logMutation('UI_SET_LOADING', { requestId, value: true });

    try {
      if (cancelAllByDefault) {
        const endpointAll = `${API_BASE}/bookings/${bookingId}?scope=resource_day_self`;
        updateCancelDebug({ lastAction: 'CANCEL_REQUEST', bookingId, endpoint: endpointAll, httpStatus: null, errorMessage: '' });

        let deletedCount = 0;
        await runWithAppLoading(async () => {
          const result = await cancelBooking(bookingId, 'resource_day_self', isRoomCancel ? { requestId } : undefined);
          deletedCount = result.deletedCount;
        });

        updateCancelDebug({ lastAction: 'CANCEL_SUCCESS', bookingId, endpoint: endpointAll, httpStatus: 200, errorMessage: '' });
        toast.success(`Alle eigenen Buchungen storniert (${deletedCount} Termin(e))`, { deskId: cancelConfirmDesk.id });

        setBookingVersion((value) => value + 1);
        setCancelDialogError('');
        if (cancelConfirmContext.keepPopoverOpen) {
          setCancelFlowState('DESK_POPOVER_OPEN');
          window.requestAnimationFrame(() => {
            refreshDeskPopupAnchorRect(cancelConfirmContext.deskId);
          });
        } else {
          setCancelFlowState('NONE');
          setDeskPopup(null);
        }
        setCancelConfirmContext(null);

        const refreshed = await reloadBookings(isRoomCancel ? { requestId, roomId: cancelConfirmDesk.id, date: selectedDate } : undefined);
        try {
          const calendarEntries = await runWithAppLoading(() => get<CalendarBooking[]>(`/bookings?from=${calendarRange.from}&to=${calendarRange.to}`));
          setCalendarBookings(calendarEntries);
          setBookedCalendarDays(Array.from(new Set(calendarEntries.map((entry) => toBookingDateKey(entry.date)))));
        } catch {
          setCalendarBookings([]);
          setBookedCalendarDays([]);
        }

        const refreshedDesk = refreshed?.desks.find((desk) => desk.id === cancelConfirmDesk.id);
        const refreshedCount = refreshedDesk ? normalizeDeskBookings(refreshedDesk).length : 0;
        updateCancelDebug({ lastAction: 'REFRESH_DONE', bookingId, endpoint: endpointAll, httpStatus: 200, errorMessage: '' });
        if (isRoomCancel) {
          logMutation('ROOM_REFETCH_DONE', { requestId, roomId: cancelConfirmDesk.id, count: refreshedCount });
        }
      } else {
        await cancelBookingWithRefresh({
          bookingId,
          cancelMode,
          requestId,
          deskId: cancelConfirmDesk.id,
          date: selectedDate,
          keepPopoverOpen: cancelConfirmContext.keepPopoverOpen,
          popupDeskId: cancelConfirmContext.deskId,
          isRoomCancel
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Stornieren fehlgeschlagen';
      if (isRoomCancel) {
        logMutation('ROOM_CANCEL_ERROR', {
          requestId,
          err: error instanceof Error ? error.message : toBodySnippet(error)
        });
      }
      if (errorMessage.includes('Du darfst diese Serie nicht stornieren')) {
        setCancelDialogError('Du darfst diese Serie nicht stornieren.');
      } else {
        setCancelDialogError(`Stornierung fehlgeschlagen: ${errorMessage}`);
      }
      updateCancelDebug({ lastAction: 'CANCEL_ERROR', bookingId, endpoint, httpStatus: null, errorMessage });
    } finally {
      logMutation('UI_SET_LOADING', { requestId, value: false });
      setIsCancellingBooking(false);
      setCancellingBookingId(null);
    }
  };

  const onFeedbackScreenshotChange = async (file: File | null) => {
    setFeedbackScreenshotError('');
    if (!file) {
      setFeedbackScreenshotDataUrl('');
      setFeedbackScreenshotName('');
      return;
    }

    if (![ 'image/png', 'image/jpeg', 'image/webp' ].includes(file.type)) {
      setFeedbackScreenshotDataUrl('');
      setFeedbackScreenshotName('');
      setFeedbackScreenshotError('Bitte nur PNG, JPG oder WEBP hochladen.');
      return;
    }

    if (file.size > FEEDBACK_SCREENSHOT_MAX_BYTES) {
      setFeedbackScreenshotDataUrl('');
      setFeedbackScreenshotName('');
      setFeedbackScreenshotError('Der Screenshot darf maximal 3 MB groß sein.');
      return;
    }

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            resolve(reader.result);
            return;
          }
          reject(new Error('Datei konnte nicht gelesen werden'));
        };
        reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
        reader.readAsDataURL(file);
      });

      setFeedbackScreenshotDataUrl(dataUrl);
      setFeedbackScreenshotName(file.name);
    } catch {
      setFeedbackScreenshotDataUrl('');
      setFeedbackScreenshotName('');
      setFeedbackScreenshotError('Screenshot konnte nicht gelesen werden.');
    }
  };

  const submitFeedbackReport = async () => {
    const trimmedMessage = feedbackMessage.trim();
    if (trimmedMessage.length < 10) {
      toast.error('Bitte gib mindestens 10 Zeichen ein.');
      return;
    }

    try {
      setIsSubmittingFeedback(true);
      await post('/feedback-reports', {
        type: feedbackType,
        message: trimmedMessage,
        screenshotDataUrl: feedbackType === 'BUG' && feedbackScreenshotDataUrl ? feedbackScreenshotDataUrl : undefined
      });
      toast.success('Danke! Deine Meldung wurde gespeichert.');
      setFeedbackDialogOpen(false);
      setFeedbackType('BUG');
      setFeedbackMessage('');
      setFeedbackScreenshotDataUrl('');
      setFeedbackScreenshotName('');
      setFeedbackScreenshotError('');
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Meldung konnte nicht gespeichert werden'));
    } finally {
      setIsSubmittingFeedback(false);
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
        <select value={selectedFloorplanId} onChange={(event) => switchFloorplan(event.target.value)}>
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
        <span className="legend-chip"><i className="dot availability-few" /> Fast voll</span>
        <span className="legend-chip"><i className="dot availability-none" /> Voll</span>
        <span className="legend-chip"><i className="dot booked" /> Belegt</span>
        <span className="legend-chip"><i className="dot selected" /> Dein Platz</span>
      </div>
    </section>
  );

  const feedbackCallout = (
    <section className="feedback-callout">
      <button className="btn feedback-callout-btn" onClick={() => setFeedbackDialogOpen(true)}>Feature Request / Bug melden</button>
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
            tabIndex={0}
            className={`occupant-compact-card ${(hoveredDeskId === occupant.deskId || selectedDeskId === occupant.deskId) ? 'is-active' : ''} ${highlightedDeskId === occupant.deskId ? 'is-highlighted' : ''}`}
            onClick={(event) => {
              selectDeskFromCanvas(occupant.deskId, event.currentTarget, { allowUnbookable: true });
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              selectDeskFromCanvas(occupant.deskId, event.currentTarget);
            }}
            onMouseEnter={() => {
              setHoveredDeskId(occupant.deskId);
              setHighlightedDeskId(occupant.deskId);
            }}
            onMouseLeave={() => {
              setHoveredDeskId('');
              setHighlightedDeskId('');
            }}
            aria-label={`Profilkarte für ${occupant.name} öffnen`}
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

  const isParkingFloor = selectedFloorplan?.defaultResourceKind === 'PARKPLATZ';

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
          {!isBootstrapping && feedbackCallout}
        </aside>
        <section className="center-col">
          <article className="card canvas-card">
            <div className="card-header-row">
              <div>
                <h2>{selectedFloorplan?.name ?? 'Floorplan'} · {formatDate(selectedDate)}</h2>
                <p className="muted">Klicke auf einen Platz zum Buchen</p>
              </div>
              <div className="toolbar">
                {isParkingFloor && (
                  <button type="button" className="btn btn-primary-smart" onClick={openParkingSmartDialog}>
                    <SparklesIcon />
                    Parkplatz intelligent zuweisen
                  </button>
                )}
              </div>
            </div>
            <div className={`canvas-body canvas-body-focus ${isUpdatingOccupancy ? 'is-loading' : ''}`}>
              {isBootstrapping ? (
                <div className="skeleton h-420" />
              ) : selectedFloorplan ? (
                <div className={`floorplan-viewport ${isUpdatingOccupancy ? 'floorplan-viewport-loading' : ''}`} style={{ height: FLOORPLAN_VIEWPORT_HEIGHT, minHeight: 520 }}>
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
                  {isUpdatingOccupancy && floorplanImageLoadState === 'loaded' && <div className="floorplan-status-banner" aria-live="polite">Lade Ressourcen…</div>}
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
                  <div>containerRect(left/top/width/height)=0 / 0 / {Math.round(floorplanViewportSize.width)} / {Math.round(floorplanViewportSize.height)}</div>
                  <div>imageNatural(width/height)={Math.round(floorplanImageSize?.width ?? 0)} / {Math.round(floorplanImageSize?.height ?? 0)}</div>
                  <div>drawnRect(left/top/width/height)={Math.round(floorplanDisplayedRect.left)} / {Math.round(floorplanDisplayedRect.top)} / {Math.round(floorplanDisplayedRect.width)} / {Math.round(floorplanDisplayedRect.height)}</div>
                  <div>renderedImageSize={Math.round(floorplanRenderedImageSize.width)}×{Math.round(floorplanRenderedImageSize.height)}</div>
                  <div>firstMarker(left/top)={firstMarkerDebug ? `${Math.round(firstMarkerDebug.left)} / ${Math.round(firstMarkerDebug.top)} (deskId=${firstMarkerDebug.deskId})` : '-'}</div>
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
        <div className="desk-popup-overlay" role="presentation">
          <section className="card desk-popup" role="dialog" aria-modal="true" aria-labelledby="booking-panel-title">
          {(popupDeskState === 'FREE' || (isRoomResource(popupDesk) && popupDeskState !== 'UNBOOKABLE')) ? (
            <>
              <div className="desk-popup-header">
                <div className="stack-xxs">
                  <h3 id="booking-panel-title">{resourceKindLabel(popupDesk.kind)}: {popupDesk.name}</h3>
                  <p className="muted">{popupMode === 'manage' ? 'Deine Buchungen verwalten' : 'Buchung anlegen'}{!isRoomResource(popupDesk) ? ` · ${deskAvailabilityLabel(popupDeskAvailability)}` : ''}</p>
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
              <div className="desk-popup-body">
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
                  roomSchedule={isTimeBasedResource(popupDesk)
                    ? {
                      bookings: popupRoomBookingsList.map((booking) => ({
                        id: booking.id,
                        label: booking.label,
                        person: booking.person,
                        isCurrentUser: booking.isCurrentUser,
                        isSelfMine: booking.isCurrentUser && booking.bookedFor === 'SELF',
                        isGuestMine: booking.isCurrentUser && booking.bookedFor === 'GUEST',
                        isSeries: Boolean(booking.recurringBookingId || booking.recurringGroupId),
                        canCancel: booking.canCancel && Boolean(booking.bookingId),
                        debugMeta: showRoomDebugInfo
                          ? `bookedFor=${booking.bookedFor ?? '-'} · employeeId=${booking.userId ?? '-'} · createdByEmployeeId=${booking.createdByEmployeeId ?? '-'} · canCancel=${booking.canCancel ? 'true' : 'false'}`
                          : undefined
                      })),
                      freeSlots: popupRoomFreeSlotChips,
                      occupiedSegments: popupRoomOccupiedSegments,
                      freeSegments: popupRoomFreeSegments,
                      isFullyBooked: popupRoomFreeSlotChips.length === 0,
                      conflictMessage: popupRoomFreeSlotChips.length === 0 ? 'Heute vollständig belegt' : roomBookingConflict,
                      debugInfo: roomDebugInfo,
                      ringDebugTitle: popupRoomRingDebugTitle,
                      onSelectFreeSlot: (startTime, endTime) => {
                        setBookingFormValues((current) => ({ ...current, startTime, endTime }));
                      },
                      onBookingClick: handleRoomBookingCancel
                    }
                    : undefined}
                />
                {!isRoomResource(popupDesk) && canCancelHere && (
                  <footer className="desk-popup-footer-actions">
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={openCancelConfirm}
                      disabled={bookingDialogState === 'SUBMITTING' || isCancellingBooking}
                    >
                      Stornieren
                    </button>
                  </footer>
                )}
              </div>
            </>
          ) : showForeignBookingInfoDialog ? (
            <>
              <div className="desk-popup-header">
                <h3 id="booking-panel-title">{resourceKindLabel(popupDesk.kind)}: {popupDesk.name}</h3>
                <button type="button" className="btn btn-ghost desk-popup-close" aria-label="Popover schließen" onClick={closeBookingFlow} disabled={isCancellingBooking}>✕</button>
              </div>
              <div className="desk-popup-body booking-details-panel">
                <section className="booking-detail-card stack-xs">
                  <h4>Belegt am ausgewählten Tag</h4>
                  <p><span className="muted">Datum</span><strong>{new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</strong></p>
                  <p><span className="muted">Ressource</span><strong>{resourceKindLabel(popupDesk.kind)}: {popupDesk.name}</strong></p>
                </section>

                <section className="booking-info-cards">
                  {popupForeignBookings.map((booking) => {
                    const personName = booking.bookedFor === 'GUEST'
                      ? `Gast: ${booking.guestName?.trim() || 'Unbekannt'}`
                      : (booking.employee?.displayName ?? booking.userDisplayName ?? booking.userEmail ?? 'Unbekannt');
                    const personEmail = booking.bookedFor === 'GUEST' ? undefined : (booking.employee?.email ?? booking.userEmail ?? undefined);
                    const contactEmail = getContactEmail(personEmail);
                    const personPhone = booking.bookedFor === 'GUEST' ? null : (booking.employee?.phone ?? booking.userPhone ?? null);
                    const dialablePhone = getDialablePhone(personPhone);
                    const personPhotoUrl = booking.bookedFor === 'GUEST' ? undefined : (booking.employee?.photoUrl ?? booking.userPhotoUrl ?? undefined);

                    return (
                      <article key={booking.id ?? `${personEmail ?? personName}-${callLabelForBooking(booking)}`} className="booking-info-card stack-xs">
                        <span className="booking-info-period">{callLabelForBooking(booking)}</span>
                        <div className="booking-info-person">
                          <Avatar
                            displayName={personName}
                            email={personEmail}
                            photoUrl={personPhotoUrl}
                            size={60}
                          />
                          <div className="stack-xxs booking-info-person-text">
                            <strong>{personName}</strong>
                            {personEmail && <span className="muted">{personEmail}</span>}
                            <span className="muted">{personPhone ?? 'Kein Telefon hinterlegt'}</span>
                          </div>
                        </div>
                        <p><span className="muted">Zeitraum: </span><strong>{bookingSlotLabel(booking)}</strong></p>
                        <div className="booking-info-contact-actions">
                          <button type="button" className="btn btn-outline booking-info-contact-btn" onClick={() => handleCallPerson(personPhone)} disabled={!dialablePhone} title={!dialablePhone ? 'Keine Telefonnummer hinterlegt' : undefined}>📞 Anrufen</button>
                          <button type="button" className="btn btn-outline booking-info-contact-btn" onClick={() => handleEmailPerson(contactEmail)} disabled={!contactEmail} title={!contactEmail ? 'Keine E-Mail hinterlegt' : undefined}>✉️ Email</button>
                          <button type="button" className="btn btn-outline booking-info-contact-btn" onClick={() => handleChatWithPerson(contactEmail)} disabled={!contactEmail} title={!contactEmail ? 'Keine E-Mail hinterlegt' : undefined}>💬 Chat</button>
                        </div>
                      </article>
                    );
                  })}
                </section>

                <footer className="desk-popup-footer-actions">
                  <button type="button" className="btn btn-outline" onClick={closeBookingFlow} disabled={isCancellingBooking}>Schließen</button>
                </footer>
              </div>
            </>
          ) : (
            <>
              <div className="desk-popup-header">
                <h3 id="booking-panel-title">{resourceKindLabel(popupDesk.kind)}: {popupDesk.name}</h3>
                <button type="button" className="btn btn-ghost desk-popup-close" aria-label="Popover schließen" onClick={closeBookingFlow} disabled={isCancellingBooking}>✕</button>
              </div>
              <div className="desk-popup-body booking-details-panel">
                <section className="booking-detail-card stack-xs">
                  <h4>Buchungsdetails</h4>
                  <p><span className="muted">Datum</span><strong>{new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</strong></p>
                  {popupMySelectedBooking
                    ? <p><span className="muted">Zeitraum: </span><strong>{bookingSlotLabel(popupMySelectedBooking)}</strong></p>
                    : !isRoomResource(popupDesk) && <p><span className="muted">Status</span><strong>{popupDeskState === 'UNBOOKABLE' ? 'Für deinen Mandanten nicht buchbar' : deskAvailabilityLabel(popupDeskAvailability)}</strong></p>}
                  {popupDeskState === 'UNBOOKABLE' && <p className="muted">Für deinen Mandanten nicht buchbar.</p>}
                  {popupDeskBookings.map((booking) => (
                    <p key={booking.id ?? `${booking.userEmail ?? 'unknown'}-${bookingSlotLabel(booking)}`}>
                      <span className="muted">Gebucht für</span>
                      <strong>{bookingDisplayName(booking)}{booking.bookedFor === 'GUEST' ? ` · gebucht von ${getBookingCreatorName(booking)}` : ''}</strong>
                    </p>
                  ))}
                  <p><span className="muted">Ressource</span><strong>{resourceKindLabel(popupDesk.kind)}: {popupDesk.name}</strong></p>
                </section>

                {popupOwnBookingIsRecurring && (
                  <section className="booking-detail-card stack-xs">
                    <h4>Hinweis</h4>
                    <p>🔁 Diese Buchung ist Teil einer Serie.</p>
                  </section>
                )}

                {showRoomDebugInfo && (
                  <div className="muted" style={{ fontSize: 12, border: '1px solid hsl(var(--border))', borderRadius: 8, padding: 8 }}>
                    <div>mode: {popupMode}</div>
                    <div>myBookingId: {popupMySelectedBooking?.id ?? '—'}</div>
                    <div>myBookingPeriod: {popupMySelectedBooking ? bookingSlotLabel(popupMySelectedBooking) : '—'}</div>
                    {hasUnexpectedMultipleMyBookings && <div>warning: multiple own bookings on resource/date</div>}
                  </div>
                )}

                <footer className="desk-popup-footer-actions">
                  <button type="button" className="btn btn-outline" onClick={closeBookingFlow} disabled={isCancellingBooking}>Schließen</button>
                  {canCancelHere && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={openCancelConfirm}
                      disabled={bookingDialogState === 'SUBMITTING'}
                    >
                      Stornieren
                    </button>
                  )}
                </footer>
              </div>
            </>
          )}
          </section>
        </div>,
        document.body
      )}

      {isParkingSmartDialogOpen && createPortal(
        <div className="desk-popup-overlay" role="presentation">
          <section className="card desk-popup" role="dialog" aria-modal="true" aria-labelledby="parking-smart-title">
            <div className="desk-popup-header">
              <div className="stack-xxs">
                <h3 id="parking-smart-title">Parkplatz intelligent zuweisen</h3>
                <p className="parking-smart-helper muted">Automatische Empfehlung für Lade- und Restzeit auf dem ausgewählten Floor.</p>
              </div>
              <button type="button" className="btn btn-ghost desk-popup-close" aria-label="Dialog schließen" onClick={closeParkingSmartDialog} disabled={isParkingSmartLoading}>✕</button>
            </div>
            <div className="desk-popup-body parking-smart-dialog-body">
              <div className="parking-smart-form-grid">
                <label className="field parking-smart-field">
                  <span>Parken für</span>
                  <select value={parkingSmartBookedFor} onChange={(event) => {
                    const nextValue = event.target.value === 'GUEST' ? 'GUEST' : 'SELF';
                    setParkingSmartBookedFor(nextValue);
                    if (nextValue === 'SELF') setParkingSmartGuestName('');
                  }} disabled={isParkingSmartLoading}>
                    <option value="SELF">Für mich</option>
                    <option value="GUEST">Für Gast</option>
                  </select>
                </label>
                {parkingSmartBookedFor === 'GUEST' && (
                  <label className="field parking-smart-field">
                    <span>Gastname</span>
                    <input type="text" value={parkingSmartGuestName} onChange={(event) => setParkingSmartGuestName(event.target.value)} placeholder="Name des Gasts" disabled={isParkingSmartLoading} />
                  </label>
                )}
                <label className="field parking-smart-field">
                  <span>Anreise</span>
                  <div className="time-input-wrap">
                    <input type="time" min="00:00" max="23:30" step={1800} value={parkingSmartArrivalTime} onChange={(event) => setParkingSmartArrivalTime(event.target.value)} disabled={isParkingSmartLoading} />
                    <span className="time-input-icon" aria-hidden="true">🕒</span>
                  </div>
                </label>
                <label className="field parking-smart-field">
                  <span>Abreise</span>
                  <div className="time-input-wrap">
                    <input type="time" min="00:30" max="23:59" step={1800} value={parkingSmartDepartureTime} onChange={(event) => setParkingSmartDepartureTime(event.target.value)} disabled={isParkingSmartLoading} />
                    <span className="time-input-icon" aria-hidden="true">🕒</span>
                  </div>
                </label>
                <div className="field parking-smart-field">
                  <span>Laden erforderlich</span>
                  <label className="toggle parking-smart-toggle">
                    <input type="checkbox" checked={parkingChargeMinutes > 0} onChange={(event) => setParkingChargeMinutes(event.target.checked ? (parkingChargeMinutes > 0 ? parkingChargeMinutes : 60) : 0)} disabled={isParkingSmartLoading} />
                  </label>
                </div>
                {parkingChargeMinutes > 0 && (
                  <label className="field parking-smart-field">
                    <span>Ladedauer</span>
                    <select value={String(parkingChargeMinutes)} onChange={(event) => setParkingChargeMinutes(Math.max(60, Number(event.target.value) || 60))} disabled={isParkingSmartLoading}>
                      {Array.from({ length: 8 }, (_, index) => {
                        const hours = index + 1;
                        const minutes = hours * 60;
                        return <option key={hours} value={minutes}>{hours} h</option>;
                      })}
                    </select>
                  </label>
                )}
              </div>
              {isParkingTimeRangeInvalid && <p className="field-error">Abreise muss nach der Anreise liegen.</p>}
              {hasParkingProposalConflict && <p className="field-error">Überlappende Buchungszeiten für denselben Parkplatz sind nicht erlaubt.</p>}
              {parkingSmartError && <p className="field-error">{parkingSmartError}</p>}
              {parkingSmartInfo && <p className="muted">{parkingSmartInfo}</p>}
              {parkingSmartProposal && (
                <div className="stack-xs parking-smart-proposal-block">
                  <strong>Vorschlag</strong>
                  <ParkingScheduleGrid entries={parkingScheduleEntries} />
                </div>
              )}
              <div className="parking-smart-actions">
                <button type="button" className="btn btn-outline" onClick={closeParkingSmartDialog} disabled={isParkingSmartLoading}>Abbrechen</button>
                {parkingSmartProposal
                  ? (
                    <>
                      <button type="button" className="btn btn-ghost" onClick={requestSmartParkingProposal} disabled={isParkingSmartLoading || isParkingTimeRangeInvalid}>Vorschlag neu berechnen</button>
                      <button type="button" className="btn" onClick={() => setIsParkingSmartConfirmDialogOpen(true)} disabled={isParkingSmartLoading || hasParkingProposalConflict}>Vorschlag bestätigen</button>
                    </>
                    )
                  : <button type="button" className="btn" onClick={requestSmartParkingProposal} disabled={isParkingSmartLoading || isParkingTimeRangeInvalid}>Vorschlag berechnen</button>}
              </div>
            </div>
          </section>
        </div>,
        document.body
      )}

      {isParkingSmartConfirmDialogOpen && parkingSmartProposal && createPortal(
        <div className="overlay" role="presentation">
          <section className="card dialog rebook-dialog parking-smart-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="parking-smart-confirm-title">
            <h3 id="parking-smart-confirm-title">Parkplatz-Buchung bestätigen?</h3>
            <p>Bitte bestätige den vorgeschlagenen Parkplatz-Zeitplan.</p>
            <ParkingScheduleGrid entries={parkingScheduleEntries.map((entry) => ({ ...entry, id: `confirm-${entry.id}` }))} />
            <div className="inline-end">
              <button type="button" className="btn btn-outline" onClick={() => setIsParkingSmartConfirmDialogOpen(false)} disabled={isParkingSmartLoading}>Zurück</button>
              <button type="button" className="btn" onClick={confirmSmartParkingProposal} disabled={isParkingSmartLoading || hasParkingProposalConflict}>Jetzt verbindlich buchen</button>
            </div>
          </section>
        </div>,
        document.body
      )}

      {feedbackDialogOpen && createPortal(
        <div className="overlay" role="presentation">
          <section className="card dialog stack-sm" role="dialog" aria-modal="true" aria-labelledby="feedback-report-title">
            <h3 id="feedback-report-title">Feature Request / Bug melden</h3>
            <p className="muted">Dein Feedback hilft uns, die Buchungs-App zu verbessern.</p>
            <label className="stack-xs">
              <span className="field-label">Typ</span>
              <select value={feedbackType} onChange={(event) => { const nextType = event.target.value as FeedbackReportType; setFeedbackType(nextType); if (nextType !== 'BUG') { setFeedbackScreenshotDataUrl(''); setFeedbackScreenshotName(''); setFeedbackScreenshotError(''); } }} disabled={isSubmittingFeedback}>
                <option value="BUG">Bug</option>
                <option value="FEATURE_REQUEST">Feature Request</option>
              </select>
            </label>
            <label className="stack-xs">
              <span className="field-label">Beschreibung</span>
              <textarea
                rows={6}
                value={feedbackMessage}
                onChange={(event) => setFeedbackMessage(event.target.value)}
                placeholder="Bitte beschreibe dein Anliegen möglichst konkret …"
                disabled={isSubmittingFeedback}
              />
            </label>
            {feedbackType === 'BUG' && (
              <label className="stack-xs">
                <span className="field-label">Screenshot (optional, für Bugs)</span>
                <input
                  type="file"
                  accept={FEEDBACK_SCREENSHOT_ACCEPT}
                  disabled={isSubmittingFeedback}
                  onChange={(event) => { void onFeedbackScreenshotChange(event.target.files?.[0] ?? null); }}
                />
                {feedbackScreenshotName && <span className="muted">Ausgewählt: {feedbackScreenshotName}</span>}
                {feedbackScreenshotError && <span className="error-banner">{feedbackScreenshotError}</span>}
                {feedbackScreenshotDataUrl && (
                  <img src={feedbackScreenshotDataUrl} alt="Screenshot Vorschau" className="feedback-screenshot-preview" />
                )}
              </label>
            )}
            <div className="inline-end">
              <button className="btn btn-outline" onClick={() => { setFeedbackDialogOpen(false); setFeedbackScreenshotDataUrl(''); setFeedbackScreenshotName(''); setFeedbackScreenshotError(''); }} disabled={isSubmittingFeedback}>Abbrechen</button>
              <button className="btn" onClick={() => void submitFeedbackReport()} disabled={isSubmittingFeedback}>
                {isSubmittingFeedback ? 'Sende…' : 'Meldung absenden'}
              </button>
            </div>
          </section>
        </div>,
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
            <h3 id="cancel-booking-title">{cancelConfirmIsSeries ? 'Diese Buchung ist Teil einer Serie.' : 'Buchung stornieren?'}</h3>
            {cancelConfirmIsSeries
              ? <p>Wie möchtest du fortfahren?</p>
              : <p>Möchtest du deine Buchung {cancelConfirmBookingLabel} stornieren?</p>}
            <p className="muted cancel-booking-subline">{resourceKindLabel(cancelConfirmDesk.kind)}: {cancelConfirmDesk.name} · {new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</p>
            {cancelConfirmIsSeries && (
              <div className="cancel-series-preview muted">
                {cancelSeriesPreview.loading && <p>Seriendetails werden geladen…</p>}
                {!cancelSeriesPreview.loading && cancelSeriesPreview.error && <p>{cancelSeriesPreview.error}</p>}
                {!cancelSeriesPreview.loading && !cancelSeriesPreview.error && cancelSeriesPreview.details && (
                  <>
                    <p>Beim Löschen der gesamten Serie werden voraussichtlich <strong>{cancelSeriesPreviewCount ?? 0}</strong> Termin(e) entfernt.</p>
                    {cancelSeriesPreview.details.recurrence && (
                      <p>
                        Rhythmus: {recurrencePatternLabel}
                        {cancelSeriesPreview.details.recurrence.interval > 1 ? ` (alle ${cancelSeriesPreview.details.recurrence.interval})` : ''}
                        {' · '}Zeitraum: {new Date(cancelSeriesPreview.details.recurrence.startDate).toLocaleDateString('de-DE')} – {new Date(cancelSeriesPreview.details.recurrence.endDate).toLocaleDateString('de-DE')}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
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
            <div className="stack-xs cancel-options">
              {cancelConfirmIsSeries ? (
                <>
                  <button type="button" className="btn btn-danger" onMouseDown={(event) => { event.stopPropagation(); }} onClick={(event) => void submitPopupCancel(event, 'SINGLE')} disabled={isCancellingBooking} data-state={isCancellingBooking ? 'loading' : 'idle'}>
                    {isCancellingBooking && cancellingBookingId === cancelConfirmContext?.bookingIds[0] ? <><span className="btn-spinner" aria-hidden />Löschen…</> : 'Nur diesen Termin löschen'}
                  </button>
                  <button type="button" className="btn btn-danger" onMouseDown={(event) => { event.stopPropagation(); }} onClick={(event) => void submitPopupCancel(event, 'SERIES_ALL')} disabled={isCancellingBooking} data-state={isCancellingBooking ? 'loading' : 'idle'}>
                    {isCancellingBooking && cancellingBookingId === cancelConfirmContext?.bookingIds[0] ? <><span className="btn-spinner" aria-hidden />Löschen…</> : 'Ganze Serie löschen'}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-danger" onMouseDown={(event) => { event.stopPropagation(); }} onClick={(event) => void submitPopupCancel(event, 'SINGLE')} disabled={isCancellingBooking} data-state={isCancellingBooking ? 'loading' : 'idle'}>
                  {isCancellingBooking && cancellingBookingId === cancelConfirmContext?.bookingIds[0]
                    ? <><span className="btn-spinner" aria-hidden />Löschen…</>
                    : (cancelConfirmDesk?.kind === 'PARKPLATZ' && (cancelConfirmContext?.bookingIds.length ?? 0) > 1 ? 'Alle eigenen Buchungen stornieren' : 'Stornieren')}
                </button>
              )}
              <button type="button" className="btn btn-outline" onMouseDown={(event) => { event.stopPropagation(); }} onClick={cancelCancelConfirm} disabled={isCancellingBooking} data-state={isCancellingBooking ? 'loading' : 'idle'}>Abbrechen</button>
            </div>
          </section>
        </div>,
        document.body
      )}


      {recurringConflictState && popupDesk && createPortal(
        <div className="overlay" role="presentation">
          <section ref={recurringConflictDialogRef} className="card dialog recurring-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="series-conflict-title">
            <header className="recurring-conflict-header inline-between">
              <h3 id="series-conflict-title">Konflikte in der Serie</h3>
              <button type="button" className="btn btn-outline btn-icon" onClick={() => setRecurringConflictState(null)} disabled={isResolvingRecurringConflict} aria-label="Konflikt-Dialog schließen">✕</button>
            </header>
            <div className="recurring-conflict-body stack-sm">
              <p>Einige Termine der Serie stehen im Konflikt mit bestehenden Buchungen.</p>
              <p><strong>Betroffene Termine: {recurringConflictState.conflictDates.length}</strong></p>
              {dialogErrorMessage && <p className="error-banner">{dialogErrorMessage}</p>}
            </div>
            <footer className="recurring-conflict-footer">
              <div className="stack-xs recurring-conflict-actions">
                <button type="button" className="btn" onClick={() => void runRecurringIgnoreConflicts()} disabled={isResolvingRecurringConflict}>Nur freie Termine buchen</button>
                <span className="muted">Bestehende Buchungen bleiben unverändert.</span>
                <button type="button" className="btn btn-danger" onClick={() => void runRecurringReassign()} disabled={isResolvingRecurringConflict}>Umbuchen und freie Termine buchen</button>
                <span className="muted">Eigene bestehende Buchungen an Konflikttagen werden ersetzt.</span>
                <button type="button" className="btn btn-outline" onClick={() => setRecurringConflictState(null)} disabled={isResolvingRecurringConflict}>Abbrechen</button>
              </div>
            </footer>
          </section>
        </div>,
        document.body
      )}


      {rebookConfirm && createPortal(
        <div className="overlay" role="presentation">
          <section ref={rebookDialogRef} className="card dialog stack-sm rebook-dialog" role="dialog" aria-modal="true" aria-labelledby="rebook-title">
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


      {showRoomDebugInfo && (
        <p className="api-base">
          Last action: {lastMutationDebug ? `${lastMutationDebug.mutation} · ${lastMutationDebug.status}` : '—'}
          {lastMutationDebug?.responseSnippet ? ` · ${lastMutationDebug.responseSnippet}` : ''}
        </p>
      )}

      <p className="api-base">{APP_TITLE} · v{APP_VERSION}</p>
    </main>
  );
}
