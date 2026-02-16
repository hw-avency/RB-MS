export type RecurrencePatternType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export type RecurrenceDefinition = {
  startDate: string;
  endDate: string;
  patternType: RecurrencePatternType;
  interval: number;
  byWeekday?: number[] | null; // 1..7 => Mon..Sun
  byMonthday?: number | null;
  bySetPos?: number | null;
  byMonth?: number | null;
};

export const MAX_RECURRING_OCCURRENCES = 200;

const toDateOnly = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const toISODate = (date: Date): string => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const addMonths = (date: Date, months: number): Date => {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

const daysInMonth = (year: number, monthZeroBased: number): number => new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();

const monthsDiff = (start: Date, current: Date): number => (current.getUTCFullYear() - start.getUTCFullYear()) * 12 + (current.getUTCMonth() - start.getUTCMonth());

const toMondayBasedWeekday = (date: Date): number => {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
};

const startOfWeekMonday = (date: Date): Date => {
  const weekday = toMondayBasedWeekday(date);
  return addDays(date, -(weekday - 1));
};

const weekDiff = (start: Date, current: Date): number => Math.floor((startOfWeekMonday(current).getTime() - startOfWeekMonday(start).getTime()) / (7 * 24 * 60 * 60 * 1000));

export const validateRecurrenceDefinition = (definition: RecurrenceDefinition): string | null => {
  const start = toDateOnly(definition.startDate);
  const end = toDateOnly(definition.endDate);
  if (!start || !end) return 'startDate/endDate must use YYYY-MM-DD';
  if (end < start) return 'endDate must be on or after startDate';
  if (!Number.isInteger(definition.interval) || definition.interval < 1) return 'interval must be >= 1';

  if (definition.patternType === 'WEEKLY') {
    if (!Array.isArray(definition.byWeekday) || definition.byWeekday.length === 0) return 'WEEKLY requires byWeekday';
    if (definition.byWeekday.some((value) => !Number.isInteger(value) || value < 1 || value > 7)) return 'byWeekday must contain values in 1..7';
  }

  if (definition.patternType === 'MONTHLY') {
    if (!Number.isInteger(definition.byMonthday) || (definition.byMonthday ?? 0) < 1 || (definition.byMonthday ?? 0) > 31) return 'MONTHLY requires byMonthday in 1..31';
  }

  if (definition.patternType === 'YEARLY') {
    if (!Number.isInteger(definition.byMonth) || (definition.byMonth ?? 0) < 1 || (definition.byMonth ?? 0) > 12) return 'YEARLY requires byMonth in 1..12';
    if (!Number.isInteger(definition.byMonthday) || (definition.byMonthday ?? 0) < 1 || (definition.byMonthday ?? 0) > 31) return 'YEARLY requires byMonthday in 1..31';
  }

  return null;
};

export const expandRecurrence = (definition: RecurrenceDefinition, maxOccurrences = MAX_RECURRING_OCCURRENCES): { dates: string[]; truncated: boolean } => {
  const validationError = validateRecurrenceDefinition(definition);
  if (validationError) throw new Error(validationError);

  const start = toDateOnly(definition.startDate)!;
  const end = toDateOnly(definition.endDate)!;
  const interval = definition.interval;
  const result: string[] = [];

  const push = (date: Date): boolean => {
    result.push(toISODate(date));
    return result.length >= maxOccurrences;
  };

  if (definition.patternType === 'DAILY') {
    for (let current = start; current <= end; current = addDays(current, interval)) {
      if (push(current)) return { dates: result, truncated: true };
    }
    return { dates: result, truncated: false };
  }

  if (definition.patternType === 'WEEKLY') {
    const weekdays = Array.from(new Set(definition.byWeekday ?? [])).sort((a, b) => a - b);
    for (let current = start; current <= end; current = addDays(current, 1)) {
      const currentWeekDiff = weekDiff(start, current);
      if (currentWeekDiff < 0 || currentWeekDiff % interval !== 0) continue;
      if (!weekdays.includes(toMondayBasedWeekday(current))) continue;
      if (push(current)) return { dates: result, truncated: true };
    }
    return { dates: result, truncated: false };
  }

  if (definition.patternType === 'MONTHLY') {
    const day = definition.byMonthday!;
    for (let monthCursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); monthCursor <= end; monthCursor = addMonths(monthCursor, interval)) {
      const year = monthCursor.getUTCFullYear();
      const month = monthCursor.getUTCMonth();
      const monthDays = daysInMonth(year, month);
      if (day > monthDays) continue;
      const occurrence = new Date(Date.UTC(year, month, day));
      if (occurrence < start || occurrence > end) continue;
      if (push(occurrence)) return { dates: result, truncated: true };
    }
    return { dates: result, truncated: false };
  }

  const month = definition.byMonth!;
  const day = definition.byMonthday!;
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  for (let year = startYear; year <= endYear; year += interval) {
    const monthDays = daysInMonth(year, month - 1);
    if (day > monthDays) continue;
    const occurrence = new Date(Date.UTC(year, month - 1, day));
    if (occurrence < start || occurrence > end) continue;
    if (push(occurrence)) return { dates: result, truncated: true };
  }

  return { dates: result, truncated: false };
};

export const filterRecurrenceDatesToRange = (definition: RecurrenceDefinition, from: Date, to: Date): string[] => {
  const boundedStart = toISODate(from > toDateOnly(definition.startDate)! ? from : toDateOnly(definition.startDate)!);
  const boundedEnd = toISODate(to < toDateOnly(definition.endDate)! ? to : toDateOnly(definition.endDate)!);
  if (boundedStart > boundedEnd) return [];
  const { dates } = expandRecurrence({ ...definition, startDate: boundedStart, endDate: boundedEnd }, Number.MAX_SAFE_INTEGER);
  return dates;
};
