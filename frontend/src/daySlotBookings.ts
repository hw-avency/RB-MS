export type DaySlotValue = 'AM' | 'PM' | 'FULL';

type DaySlotBookingShape = {
  id?: string;
  employeeId?: string;
  userEmail?: string | null;
  bookedFor?: 'SELF' | 'GUEST';
  createdByEmployeeId?: string | null;
  guestName?: string | null;
  daySlot?: 'AM' | 'PM' | 'FULL';
  slot?: 'FULL_DAY' | 'MORNING' | 'AFTERNOON' | 'CUSTOM';
};

export type NormalizedDaySlotBooking<T extends DaySlotBookingShape> = T & {
  daySlot: DaySlotValue;
  sourceBookingIds?: string[];
  isVirtualMerged?: boolean;
};

const getBookingDaySlot = (booking: DaySlotBookingShape): DaySlotValue | null => {
  if (booking.daySlot === 'FULL' || booking.slot === 'FULL_DAY') return 'FULL';
  if (booking.daySlot === 'AM' || booking.slot === 'MORNING') return 'AM';
  if (booking.daySlot === 'PM' || booking.slot === 'AFTERNOON') return 'PM';
  return null;
};

const normalizeSingleBookingDaySlot = <T extends DaySlotBookingShape>(booking: T): NormalizedDaySlotBooking<T> => {
  const daySlot = getBookingDaySlot(booking);
  return daySlot ? { ...booking, daySlot } : { ...booking, daySlot: 'FULL' };
};

export const normalizeDaySlotBookingsPerEntry = <T extends DaySlotBookingShape>(bookings: T[]): NormalizedDaySlotBooking<T>[] => bookings.map((booking) => normalizeSingleBookingDaySlot(booking));

const getBookingIdentity = (booking: DaySlotBookingShape, fallbackIndex: number): string => {
  if (booking.bookedFor === 'GUEST') {
    if (booking.createdByEmployeeId?.trim()) return `guest-creator:${booking.createdByEmployeeId.trim()}`;
    if (booking.guestName?.trim()) return `guest-name:${booking.guestName.trim().toLowerCase()}`;
  }

  if (booking.employeeId?.trim()) return `self-employee:${booking.employeeId.trim()}`;
  if (booking.userEmail?.trim()) return `self-email:${booking.userEmail.trim().toLowerCase()}`;
  return `fallback:${booking.id ?? fallbackIndex}`;
};

export const normalizeDaySlotBookings = <T extends DaySlotBookingShape>(bookings: T[]): NormalizedDaySlotBooking<T>[] => {
  if (bookings.length <= 1) {
    return normalizeDaySlotBookingsPerEntry(bookings);
  }

  const fullBookings = bookings.filter((booking) => getBookingDaySlot(booking) === 'FULL');
  const halfDayBookings = bookings.filter((booking) => {
    const slot = getBookingDaySlot(booking);
    return slot === 'AM' || slot === 'PM';
  });
  const passthrough = bookings.filter((booking) => getBookingDaySlot(booking) === null);

  const fullByIdentity = new Map<string, NormalizedDaySlotBooking<T>>();
  for (const [index, booking] of fullBookings.entries()) {
    fullByIdentity.set(getBookingIdentity(booking, index), { ...booking, daySlot: 'FULL' });
  }

  const groupedHalfDay = new Map<string, { am?: T; pm?: T }>();
  for (const [index, booking] of halfDayBookings.entries()) {
    const key = getBookingIdentity(booking, index);
    const current = groupedHalfDay.get(key) ?? {};
    const slot = getBookingDaySlot(booking);
    if (slot === 'AM') current.am = booking;
    if (slot === 'PM') current.pm = booking;
    groupedHalfDay.set(key, current);
  }

  const normalized: NormalizedDaySlotBooking<T>[] = [];

  for (const [identity, fullBooking] of fullByIdentity) {
    normalized.push(fullBooking);
    groupedHalfDay.delete(identity);
  }

  for (const { am, pm } of groupedHalfDay.values()) {
    if (am && pm) {
      normalized.push({
        ...am,
        daySlot: 'FULL',
        sourceBookingIds: [am.id, pm.id].filter((id): id is string => Boolean(id)),
        isVirtualMerged: true
      });
      continue;
    }

    if (am) normalized.push({ ...am, daySlot: 'AM' });
    if (pm) normalized.push({ ...pm, daySlot: 'PM' });
  }

  for (const booking of passthrough) {
    normalized.push({ ...booking, daySlot: 'FULL' });
  }

  return normalized;
};
