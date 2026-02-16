export type TimeInterval = { start: number; end: number };

export const ROOM_WINDOW_START_MINUTES = 7 * 60;
export const ROOM_WINDOW_END_MINUTES = 18 * 60;
export const ROOM_WINDOW_TOTAL_MINUTES = ROOM_WINDOW_END_MINUTES - ROOM_WINDOW_START_MINUTES;

const BASE_RING_START_ANGLE_DEG = -90;
export const ROOM_RING_ROTATION_OFFSET_DEG = 90;
export const ROOM_RING_START_ANGLE_DEG = BASE_RING_START_ANGLE_DEG + ROOM_RING_ROTATION_OFFSET_DEG;

export const clampToRoomWindow = (minutes: number): number => Math.min(ROOM_WINDOW_END_MINUTES, Math.max(ROOM_WINDOW_START_MINUTES, minutes));

export const mergeIntervals = (intervals: TimeInterval[]): TimeInterval[] => {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: TimeInterval[] = [{ ...sorted[0] }];

  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    const current = merged[merged.length - 1];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
      continue;
    }
    merged.push({ ...next });
  }

  return merged;
};

export const normalizeRoomIntervals = (intervals: TimeInterval[]): TimeInterval[] => mergeIntervals(intervals.flatMap((interval) => {
  if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end)) return [];
  const start = clampToRoomWindow(interval.start);
  const end = clampToRoomWindow(interval.end);
  if (end <= start) return [];
  return [{ start, end }];
}));

export const roomMinuteToAngle = (minutes: number): number => {
  const normalized = (clampToRoomWindow(minutes) - ROOM_WINDOW_START_MINUTES) / ROOM_WINDOW_TOTAL_MINUTES;
  return ROOM_RING_START_ANGLE_DEG + normalized * 360;
};
