import { toMinutes } from './bookingWindows';

export const BUSINESS_START = '07:00';
export const BUSINESS_END = '18:00';

export const DIAL_MINUTES = 12 * 60;
export const BUSINESS_MINUTES = 11 * 60;
export const GAP_MINUTES = DIAL_MINUTES - BUSINESS_MINUTES;

export const BUSINESS_START_MINUTES = toMinutes(BUSINESS_START);
export const BUSINESS_END_MINUTES = toMinutes(BUSINESS_END);

export const BUSINESS_SWEEP_RADIANS = (BUSINESS_MINUTES / DIAL_MINUTES) * Math.PI * 2;
export const GAP_SWEEP_RADIANS = Math.PI * 2 - BUSINESS_SWEEP_RADIANS;

const FULL_CIRCLE_RADIANS = Math.PI * 2;
const TOP_OFFSET_RADIANS = -Math.PI / 2;

export const clockHourToAngleRadians = (hour: number): number => ((hour / 12) * FULL_CIRCLE_RADIANS) + TOP_OFFSET_RADIANS;
export const BUSINESS_START_ANGLE_RADIANS = clockHourToAngleRadians(7);

export const toBusinessProgress = (minuteValue: number): number => {
  const clamped = Math.max(BUSINESS_START_MINUTES, Math.min(BUSINESS_END_MINUTES, minuteValue));
  return (clamped - BUSINESS_START_MINUTES) / BUSINESS_MINUTES;
};

export const toBusinessAngleRadians = (minuteValue: number): number => BUSINESS_START_ANGLE_RADIANS + toBusinessProgress(minuteValue) * BUSINESS_SWEEP_RADIANS;

export const toBusinessAngleDegrees = (minuteValue: number): number => (toBusinessAngleRadians(minuteValue) * 180) / Math.PI;

export const progressToBusinessAngleDegrees = (progress: number): number => {
  const clamped = Math.max(0, Math.min(1, progress));
  return (BUSINESS_START_ANGLE_RADIANS + clamped * BUSINESS_SWEEP_RADIANS) * 180 / Math.PI;
};

export const BUSINESS_START_ANGLE_DEGREES = (BUSINESS_START_ANGLE_RADIANS * 180) / Math.PI;
export const BUSINESS_SWEEP_DEGREES = (BUSINESS_SWEEP_RADIANS * 180) / Math.PI;
export const GAP_SWEEP_DEGREES = (GAP_SWEEP_RADIANS * 180) / Math.PI;
