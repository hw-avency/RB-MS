export type RecurrencePatternType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export type RecurrenceDefinition = {
  startDate: string;
  endDate: string;
  patternType: RecurrencePatternType;
  interval: number;
  byWeekday?: number[];
  byMonthday?: number | null;
  byMonth?: number | null;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (value: string): Date | null => {
  if (!DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toIso = (date: Date): string => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
const addDays = (date: Date, days: number): Date => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const mondayWeekday = (date: Date): number => (date.getUTCDay() === 0 ? 7 : date.getUTCDay());
const mondayWeekStart = (date: Date): Date => addDays(date, -(mondayWeekday(date) - 1));
const weekDiff = (start: Date, current: Date): number => Math.floor((mondayWeekStart(current).getTime() - mondayWeekStart(start).getTime()) / (7 * 24 * 60 * 60 * 1000));

export const expandRecurrence = (definition: RecurrenceDefinition, cap = 200): string[] => {
  const start = toDate(definition.startDate);
  const end = toDate(definition.endDate);
  if (!start || !end || end < start || definition.interval < 1) return [];

  const dates: string[] = [];
  const push = (date: Date): boolean => {
    dates.push(toIso(date));
    return dates.length >= cap;
  };

  if (definition.patternType === 'DAILY') {
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, definition.interval)) {
      if (push(cursor)) return dates;
    }
    return dates;
  }

  if (definition.patternType === 'WEEKLY') {
    const weekdays = Array.from(new Set(definition.byWeekday ?? []));
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
      if (weekDiff(start, cursor) % definition.interval !== 0) continue;
      if (!weekdays.includes(mondayWeekday(cursor))) continue;
      if (push(cursor)) return dates;
    }
    return dates;
  }

  if (definition.patternType === 'MONTHLY') {
    const targetDay = definition.byMonthday ?? start.getUTCDate();
    for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m += definition.interval) {
      y += Math.floor(m / 12);
      m %= 12;
      const monthDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      if (targetDay <= monthDays) {
        const occurrence = new Date(Date.UTC(y, m, targetDay));
        if (occurrence > end) break;
        if (occurrence >= start && push(occurrence)) return dates;
      }
      const probe = new Date(Date.UTC(y, m, 1));
      if (probe > end) break;
    }
    return dates;
  }

  const month = (definition.byMonth ?? (start.getUTCMonth() + 1)) - 1;
  const day = definition.byMonthday ?? start.getUTCDate();
  for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year += definition.interval) {
    const monthDays = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (day > monthDays) continue;
    const occurrence = new Date(Date.UTC(year, month, day));
    if (occurrence < start || occurrence > end) continue;
    if (push(occurrence)) return dates;
  }
  return dates;
};
