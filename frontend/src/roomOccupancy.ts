export const ROOM_DAY_WINDOW = { start: '07:00', end: '18:00' } as const;

export type MinuteInterval = { start: number; end: number };

type BookingWithTime = { startTime?: string | null; endTime?: string | null };

export const toMinutes = (value: string): number => {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return Number.NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return Number.NaN;
  return hour * 60 + minute;
};

const getDayBounds = (selectedDate: string): { start: Date; end: Date } => {
  const dayStart = new Date(`${selectedDate}T00:00:00`);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return { start: dayStart, end: dayEnd };
};

const parseDateTime = (value?: string | null): Date | null => {
  if (!value || /^\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const getMinutesFromDate = (value: Date): number => value.getHours() * 60 + value.getMinutes();

export const getBookingMinutesOnDate = (booking: BookingWithTime, selectedDate: string): MinuteInterval | null => {
  const startRaw = booking.startTime ?? undefined;
  const endRaw = booking.endTime ?? undefined;
  if (!startRaw || !endRaw) return null;

  const startPlain = toMinutes(startRaw);
  const endPlain = toMinutes(endRaw);
  if (Number.isFinite(startPlain) && Number.isFinite(endPlain)) {
    if (endPlain <= startPlain) return null;
    return { start: startPlain, end: endPlain };
  }

  const startDate = parseDateTime(startRaw);
  const endDate = parseDateTime(endRaw);
  if (!startDate || !endDate || endDate <= startDate) return null;

  const { start: dayStart, end: dayEnd } = getDayBounds(selectedDate);
  if (endDate <= dayStart || startDate >= dayEnd) return null;
  const boundedStart = startDate <= dayStart ? 0 : getMinutesFromDate(startDate);
  const boundedEnd = endDate >= dayEnd ? 24 * 60 : getMinutesFromDate(endDate);
  if (boundedEnd <= boundedStart) return null;
  return { start: boundedStart, end: boundedEnd };
};

export const clampInterval = (interval: MinuteInterval, windowStartMin: number, windowEndMin: number): MinuteInterval | null => {
  const start = Math.max(interval.start, windowStartMin);
  const end = Math.min(interval.end, windowEndMin);
  if (end <= start) return null;
  return { start, end };
};

export const mergeIntervals = (intervals: MinuteInterval[]): MinuteInterval[] => {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: MinuteInterval[] = [{ ...sorted[0] }];
  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    const last = merged[merged.length - 1];
    if (next.start <= last.end) {
      last.end = Math.max(last.end, next.end);
      continue;
    }
    merged.push({ ...next });
  }
  return merged;
};

export const getRoomMergedIntervals = (
  bookings: BookingWithTime[],
  selectedDate: string,
  windowStartMin: number,
  windowEndMin: number,
): MinuteInterval[] => mergeIntervals(bookings.flatMap((booking) => {
  const minutes = getBookingMinutesOnDate(booking, selectedDate);
  if (!minutes) return [];
  const clamped = clampInterval(minutes, windowStartMin, windowEndMin);
  return clamped ? [clamped] : [];
}));

export const formatInterval = (interval: MinuteInterval): string => {
  const toTime = (minutes: number): string => {
    const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
    const minute = String(minutes % 60).padStart(2, '0');
    return `${hour}:${minute}`;
  };

  return `${toTime(interval.start)}–${toTime(interval.end)}`;
};

