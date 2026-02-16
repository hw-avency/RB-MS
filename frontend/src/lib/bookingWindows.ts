export const BOOKABLE_START = '07:00';
export const BOOKABLE_END = '18:00';

export const ROOM_WINDOW_START = BOOKABLE_START;
export const ROOM_WINDOW_END = BOOKABLE_END;

export const ROOM_WINDOW_TOTAL_MINUTES = 11 * 60;

export type MinuteInterval = { startMin: number; endMin: number };
export type RingSegment = { p0: number; p1: number };

const HHMM_PATTERN = /^(\d{2}):(\d{2})$/;

export const toMinutes = (value: string): number => {
  const match = HHMM_PATTERN.exec(value);
  if (!match) return Number.NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return Number.NaN;
  return hour * 60 + minute;
};

export const formatMinutes = (minutes: number): string => {
  const clamped = Math.max(0, Math.min(24 * 60, Math.floor(minutes)));
  const hour = String(Math.floor(clamped / 60)).padStart(2, '0');
  const minute = String(clamped % 60).padStart(2, '0');
  return `${hour}:${minute}`;
};

export const clampInterval = (interval: MinuteInterval, winStart: number, winEnd: number): MinuteInterval | null => {
  if (!Number.isFinite(interval.startMin) || !Number.isFinite(interval.endMin)) return null;
  const startMin = Math.max(winStart, Math.min(winEnd, interval.startMin));
  const endMin = Math.max(winStart, Math.min(winEnd, interval.endMin));
  if (endMin <= startMin) return null;
  return { startMin, endMin };
};

export const mergeIntervals = (intervals: MinuteInterval[]): MinuteInterval[] => {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin);
  const merged: MinuteInterval[] = [{ ...sorted[0] }];

  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    const current = merged[merged.length - 1];
    if (next.startMin <= current.endMin) {
      current.endMin = Math.max(current.endMin, next.endMin);
      continue;
    }
    merged.push({ ...next });
  }

  return merged;
};

export const invertIntervals = (winStart: number, winEnd: number, mergedIntervals: MinuteInterval[]): MinuteInterval[] => {
  const free: MinuteInterval[] = [];
  let cursor = winStart;

  for (const interval of mergedIntervals) {
    if (interval.startMin > cursor) free.push({ startMin: cursor, endMin: interval.startMin });
    cursor = Math.max(cursor, interval.endMin);
  }

  if (cursor < winEnd) free.push({ startMin: cursor, endMin: winEnd });
  return free;
};

export const intervalsToSegments = (winStart: number, winEnd: number, mergedIntervals: MinuteInterval[]): RingSegment[] => {
  const total = winEnd - winStart;
  if (total <= 0) return [];

  return mergedIntervals
    .map((interval) => ({
      p0: (interval.startMin - winStart) / total,
      p1: (interval.endMin - winStart) / total
    }))
    .filter((segment) => segment.p1 > segment.p0)
    .map((segment) => ({
      p0: Math.max(0, Math.min(1, segment.p0)),
      p1: Math.max(0, Math.min(1, segment.p1))
    }));
};
