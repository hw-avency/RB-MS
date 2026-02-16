import { BOOKABLE_END, BOOKABLE_START, clampInterval, intervalsToSegments, mergeIntervals, toMinutes, type MinuteInterval, type RingSegment } from './bookingWindows';

type RoomOccupancyBooking = {
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
};

const HHMM_PATTERN = /^\d{2}:\d{2}$/;

const toLocalDateKey = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseMinutes = (value?: string | null): number | null => {
  if (!value) return null;
  if (HHMM_PATTERN.test(value)) {
    const parsed = toMinutes(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return null;
  return parsedDate.getHours() * 60 + parsedDate.getMinutes();
};

const bookingBelongsToDay = (booking: RoomOccupancyBooking, day?: string): boolean => {
  if (!day) return true;

  if (booking.date?.slice(0, 10) === day) return true;

  if (!booking.startTime || HHMM_PATTERN.test(booking.startTime)) return true;
  const parsed = new Date(booking.startTime);
  if (Number.isNaN(parsed.getTime())) return true;
  return toLocalDateKey(parsed) === day;
};

export type RoomOccupancyMetrics = {
  intervals: MinuteInterval[];
  segments: RingSegment[];
  occupiedMinutes: number;
  windowMinutes: number;
  occupiedRatio: number;
};

export const computeRoomOccupancy = (
  bookings: RoomOccupancyBooking[],
  day?: string,
  start = BOOKABLE_START,
  end = BOOKABLE_END
): RoomOccupancyMetrics => {
  const winStart = toMinutes(start);
  const winEnd = toMinutes(end);
  const windowMinutes = Math.max(0, winEnd - winStart);
  if (!Number.isFinite(winStart) || !Number.isFinite(winEnd) || windowMinutes <= 0) {
    return { intervals: [], segments: [], occupiedMinutes: 0, windowMinutes: 0, occupiedRatio: 0 };
  }

  const intervals = mergeIntervals(bookings.flatMap((booking) => {
    if (!bookingBelongsToDay(booking, day)) return [];

    const startMinutes = parseMinutes(booking.startTime);
    const endMinutes = parseMinutes(booking.endTime);
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return [];

    const clamped = clampInterval({ startMin: startMinutes, endMin: endMinutes }, winStart, winEnd);
    return clamped ? [clamped] : [];
  }));

  const occupiedMinutes = intervals.reduce((total, interval) => total + (interval.endMin - interval.startMin), 0);
  const segments = intervalsToSegments(winStart, winEnd, intervals);

  return {
    intervals,
    segments,
    occupiedMinutes,
    windowMinutes,
    occupiedRatio: windowMinutes > 0 ? Math.min(1, Math.max(0, occupiedMinutes / windowMinutes)) : 0
  };
};

export const computeRoomOccupancySegments = (
  bookings: RoomOccupancyBooking[],
  day?: string,
  start = BOOKABLE_START,
  end = BOOKABLE_END
): RingSegment[] => computeRoomOccupancy(bookings, day, start, end).segments;
