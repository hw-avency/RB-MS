import { FormEvent, KeyboardEvent, MouseEvent, useEffect, useMemo, useState } from 'react';
import type { RingSegment } from '../lib/bookingWindows';
import { expandRecurrence } from '../lib/recurrence';
import { RoomBusinessDayRing } from './RoomBusinessDayRing';

type BookingType = 'single' | 'recurring';
type BookingSlot = 'FULL_DAY' | 'MORNING' | 'AFTERNOON';
type RoomScheduleItem = { id: string; label: string; person: string; isCurrentUser?: boolean; isSelfMine?: boolean; isGuestMine?: boolean; canCancel?: boolean; isSeries?: boolean; debugMeta?: string };
type RoomFreeSlot = { label: string; startTime: string; endTime: string };

export type BookingFormValues = {
  type: BookingType;
  date: string;
  dateFrom: string;
  dateTo: string;
  endDateTouched: boolean;
  rangeMode: 'BY_DATE' | 'BY_COUNT';
  occurrenceCount: number;
  weekdays: number[];
  recurrencePatternType: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  recurrenceInterval: number;
  recurrenceMonthday: number;
  recurrenceYearMonth: number;
  slot: BookingSlot;
  startTime: string;
  endTime: string;
  bookedFor: 'SELF' | 'GUEST';
  guestName: string;
};

export type BookingFormSubmitPayload =
  | { type: 'single'; date: string; slot?: BookingSlot; startTime?: string; endTime?: string; bookedFor: 'SELF' | 'GUEST'; guestName?: string }
  | { type: 'recurring'; startDate: string; endDate?: string; rangeMode: 'BY_DATE' | 'BY_COUNT'; count?: number; patternType: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval: number; byWeekday?: number[]; byMonthday?: number; byMonth?: number; slot?: BookingSlot; startTime?: string; endTime?: string; bookedFor: 'SELF' | 'GUEST'; guestName?: string };

const addDaysToIsoDate = (dateString: string, days: number): string => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const addMonthsToIsoDate = (dateString: string, months: number): string => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};

const addYearsToIsoDate = (dateString: string, years: number): string => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
};

const suggestedRecurringEndDate = (startDate: string, patternType: BookingFormValues['recurrencePatternType']): string => {
  if (patternType === 'DAILY') return addMonthsToIsoDate(startDate, 3);
  if (patternType === 'WEEKLY') return addMonthsToIsoDate(startDate, 6);
  if (patternType === 'MONTHLY') return addYearsToIsoDate(startDate, 1);
  return addYearsToIsoDate(startDate, 10);
};

const recurrenceIntervalUnitLabel = (patternType: BookingFormValues['recurrencePatternType']): string => {
  if (patternType === 'DAILY') return 'Tag(e)';
  if (patternType === 'WEEKLY') return 'Woche(n)';
  if (patternType === 'MONTHLY') return 'Monat(e)';
  return 'Jahr(e)';
};

const calculateCountBasedEndDate = (values: BookingFormValues): string => {
  const count = Math.max(1, values.occurrenceCount);
  const interval = Math.max(1, values.recurrenceInterval);
  const endProbeDate = values.recurrencePatternType === 'DAILY'
    ? addDaysToIsoDate(values.dateFrom, interval * count + 7)
    : values.recurrencePatternType === 'WEEKLY'
      ? addDaysToIsoDate(values.dateFrom, interval * 7 * count + 14)
      : values.recurrencePatternType === 'MONTHLY'
        ? addMonthsToIsoDate(values.dateFrom, interval * count + 1)
        : addYearsToIsoDate(values.dateFrom, interval * count + 1);

  const dates = expandRecurrence({
    startDate: values.dateFrom,
    endDate: endProbeDate,
    patternType: values.recurrencePatternType,
    interval,
    byWeekday: values.recurrencePatternType === 'WEEKLY' ? values.weekdays : undefined,
    byMonthday: values.recurrencePatternType === 'MONTHLY' || values.recurrencePatternType === 'YEARLY' ? values.recurrenceMonthday : undefined,
    byMonth: values.recurrencePatternType === 'YEARLY' ? values.recurrenceYearMonth : undefined
  }, count);

  return dates[count - 1] ?? dates[dates.length - 1] ?? values.dateFrom;
};

export const createDefaultBookingFormValues = (selectedDate: string): BookingFormValues => {
  const parsed = new Date(`${selectedDate}T00:00:00.000Z`);
  const defaultWeekday = parsed.getUTCDay() === 0 ? 7 : parsed.getUTCDay();
  return {
    type: 'single',
    date: selectedDate,
    dateFrom: selectedDate,
    dateTo: suggestedRecurringEndDate(selectedDate, 'WEEKLY'),
    endDateTouched: false,
    rangeMode: 'BY_DATE',
    occurrenceCount: 10,
    weekdays: [defaultWeekday],
    recurrencePatternType: 'WEEKLY',
    recurrenceInterval: 1,
    recurrenceMonthday: new Date(`${selectedDate}T00:00:00.000Z`).getUTCDate(),
    recurrenceYearMonth: new Date(`${selectedDate}T00:00:00.000Z`).getUTCMonth() + 1,
    slot: 'FULL_DAY',
    startTime: '09:00',
    endTime: '10:00',
    bookedFor: 'SELF',
    guestName: ''
  };
};

const weekdayButtons = [
  { label: 'Mo', value: 1 },
  { label: 'Di', value: 2 },
  { label: 'Mi', value: 3 },
  { label: 'Do', value: 4 },
  { label: 'Fr', value: 5 },
  { label: 'Sa', value: 6 },
  { label: 'So', value: 7 }
];

export function BookingForm({ values, onChange, onSubmit, onCancel, isSubmitting, disabled, errorMessage, allowRecurring = true, resourceKind, roomSchedule }: {
  values: BookingFormValues;
  onChange: (next: BookingFormValues) => void;
  onSubmit: (payload: BookingFormSubmitPayload) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
  disabled: boolean;
  errorMessage?: string;
  allowRecurring?: boolean;
  resourceKind?: string;
  roomSchedule?: {
    bookings: RoomScheduleItem[];
    freeSlots: RoomFreeSlot[];
    occupiedSegments: RingSegment[];
    freeSegments?: RingSegment[];
    isFullyBooked?: boolean;
    conflictMessage?: string;
    debugInfo?: string[];
    ringDebugTitle?: string;
    onSelectFreeSlot: (startTime: string, endTime: string) => void;
    onBookingClick?: (event: MouseEvent<HTMLButtonElement>, bookingId: string) => void;
  };
}) {
  const [localError, setLocalError] = useState('');
  const [showRecurrenceDetails, setShowRecurrenceDetails] = useState(true);
  const [showRecurrencePreview, setShowRecurrencePreview] = useState(false);
  const isRoom = resourceKind === 'RAUM';

  useEffect(() => {
    if (allowRecurring || values.type !== 'recurring') return;
    onChange({ ...values, type: 'single' });
  }, [allowRecurring, isRoom, onChange, values]);

  const fieldErrors = useMemo(() => {
    const nextErrors: { date?: string; dateFrom?: string; dateTo?: string; weekdays?: string; interval?: string; monthday?: string; yearmonth?: string; occurrenceCount?: string; startTime?: string; endTime?: string; guestName?: string } = {};

    if (values.type === 'single' && !values.date) nextErrors.date = 'Datum ist erforderlich.';
    if (values.type === 'single' && isRoom) {
      if (!values.startTime) nextErrors.startTime = 'Startzeit ist erforderlich.';
      if (!values.endTime) nextErrors.endTime = 'Endzeit ist erforderlich.';
      if (values.startTime && values.endTime && values.startTime >= values.endTime) nextErrors.endTime = 'Endzeit muss nach Startzeit liegen.';
    }
    if (values.type === 'single' && values.bookedFor === 'GUEST' && values.guestName.trim().length < 2) {
      nextErrors.guestName = 'Gastname ist erforderlich (mind. 2 Zeichen).';
    }

    if (values.type === 'recurring') {
      if (!values.dateFrom) nextErrors.dateFrom = 'Startdatum ist erforderlich.';
      if (values.rangeMode === 'BY_DATE') {
        if (!values.dateTo) nextErrors.dateTo = 'Enddatum ist erforderlich.';
        if (values.dateFrom && values.dateTo && values.dateFrom > values.dateTo) nextErrors.dateTo = 'Enddatum muss nach dem Startdatum liegen.';
      }
      if (values.rangeMode === 'BY_COUNT' && values.occurrenceCount < 1) nextErrors.occurrenceCount = 'Anzahl muss mindestens 1 sein.';
      if (values.recurrenceInterval < 1) nextErrors.interval = 'Intervall muss mindestens 1 sein.';
      if (values.recurrencePatternType === 'WEEKLY' && values.weekdays.length === 0) nextErrors.weekdays = 'Bitte mindestens einen Wochentag auswählen.';
      if ((values.recurrencePatternType === 'MONTHLY' || values.recurrencePatternType === 'YEARLY') && (values.recurrenceMonthday < 1 || values.recurrenceMonthday > 31)) nextErrors.monthday = 'Tag muss zwischen 1 und 31 liegen.';
      if (values.recurrencePatternType === 'YEARLY' && (values.recurrenceYearMonth < 1 || values.recurrenceYearMonth > 12)) nextErrors.yearmonth = 'Monat muss zwischen 1 und 12 liegen.';
      if (isRoom) {
        if (!values.startTime) nextErrors.startTime = 'Startzeit ist erforderlich.';
        if (!values.endTime) nextErrors.endTime = 'Endzeit ist erforderlich.';
        if (values.startTime && values.endTime && values.startTime >= values.endTime) nextErrors.endTime = 'Endzeit muss nach Startzeit liegen.';
      }
      if (values.bookedFor === 'GUEST' && values.guestName.trim().length < 2) nextErrors.guestName = 'Gastname ist erforderlich (mind. 2 Zeichen).';
    }

    return nextErrors;
  }, [values, isRoom]);

  const hasCancelableRoomBooking = Boolean(roomSchedule?.bookings.some((booking) => booking.canCancel));

  const isFormInvalid = Object.values(fieldErrors).some(Boolean) || Boolean(roomSchedule?.conflictMessage);

  useEffect(() => {
    if (values.type !== 'recurring' || values.endDateTouched || !values.dateFrom) return;
    const nextDateTo = suggestedRecurringEndDate(values.dateFrom, values.recurrencePatternType);
    if (values.dateTo === nextDateTo) return;
    onChange({ ...values, dateTo: nextDateTo });
  }, [onChange, values]);

  const effectiveRecurrenceEndDate = useMemo(() => {
    if (values.type !== 'recurring') return values.dateTo;
    return values.rangeMode === 'BY_COUNT' ? calculateCountBasedEndDate(values) : values.dateTo;
  }, [values]);

  const recurrencePreviewCount = useMemo(() => {
    if (values.type !== 'recurring' || !values.dateFrom || !effectiveRecurrenceEndDate) return 0;
    return expandRecurrence({
      startDate: values.dateFrom,
      endDate: effectiveRecurrenceEndDate,
      patternType: values.recurrencePatternType,
      interval: values.recurrenceInterval,
      byWeekday: values.recurrencePatternType === 'WEEKLY' ? values.weekdays : undefined,
      byMonthday: values.recurrencePatternType === 'MONTHLY' || values.recurrencePatternType === 'YEARLY' ? values.recurrenceMonthday : undefined,
      byMonth: values.recurrencePatternType === 'YEARLY' ? values.recurrenceYearMonth : undefined
    }).length;
  }, [effectiveRecurrenceEndDate, values]);

  const recurrenceSummary = useMemo(() => {
    if (values.type !== 'recurring') return '';
    const patternLabel = values.recurrencePatternType === 'DAILY'
      ? 'Täglich'
      : values.recurrencePatternType === 'WEEKLY'
        ? 'Wöchentlich'
        : values.recurrencePatternType === 'MONTHLY'
          ? 'Monatlich'
          : 'Jährlich';
    const weekdayLabel = values.recurrencePatternType === 'WEEKLY' && values.weekdays.length > 0
      ? `, ${values.weekdays.map((day) => weekdayButtons.find((entry) => entry.value === day)?.label ?? '').filter(Boolean).join('-')}`
      : '';
    const rangeLabel = values.rangeMode === 'BY_COUNT'
      ? `${Math.max(1, values.occurrenceCount)} Termine`
      : `bis ${effectiveRecurrenceEndDate || values.dateTo}`;
    return `${patternLabel}${weekdayLabel}, ${rangeLabel}`;
  }, [effectiveRecurrenceEndDate, values]);

  const toggleWeekday = (weekday: number) => {
    if (values.weekdays.includes(weekday)) {
      onChange({ ...values, weekdays: values.weekdays.filter((value) => value !== weekday) });
      return;
    }
    onChange({ ...values, weekdays: [...values.weekdays, weekday].sort((a, b) => a - b) });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLocalError('');
    if (isFormInvalid) {
      setLocalError('Bitte prüfe die markierten Felder.');
      return;
    }

    const payload: BookingFormSubmitPayload = values.type === 'single'
      ? (isRoom
        ? { type: 'single', date: values.date, startTime: values.startTime, endTime: values.endTime, bookedFor: values.bookedFor, guestName: values.bookedFor === 'GUEST' ? values.guestName.trim() : undefined }
        : { type: 'single', date: values.date, slot: values.slot, bookedFor: values.bookedFor, guestName: values.bookedFor === 'GUEST' ? values.guestName.trim() : undefined })
      : (isRoom
        ? {
          type: 'recurring',
          startDate: values.dateFrom,
          endDate: effectiveRecurrenceEndDate,
          rangeMode: values.rangeMode,
          count: values.rangeMode === 'BY_COUNT' ? Math.max(1, values.occurrenceCount) : undefined,
          patternType: values.recurrencePatternType,
          interval: values.recurrenceInterval,
          byWeekday: values.recurrencePatternType === 'WEEKLY' ? values.weekdays : undefined,
          byMonthday: values.recurrencePatternType === 'MONTHLY' || values.recurrencePatternType === 'YEARLY' ? values.recurrenceMonthday : undefined,
          byMonth: values.recurrencePatternType === 'YEARLY' ? values.recurrenceYearMonth : undefined,
          startTime: values.startTime,
          endTime: values.endTime,
          bookedFor: values.bookedFor,
          guestName: values.bookedFor === 'GUEST' ? values.guestName.trim() : undefined
        }
        : {
          type: 'recurring',
          startDate: values.dateFrom,
          endDate: effectiveRecurrenceEndDate,
          rangeMode: values.rangeMode,
          count: values.rangeMode === 'BY_COUNT' ? Math.max(1, values.occurrenceCount) : undefined,
          patternType: values.recurrencePatternType,
          interval: values.recurrenceInterval,
          byWeekday: values.recurrencePatternType === 'WEEKLY' ? values.weekdays : undefined,
          byMonthday: values.recurrencePatternType === 'MONTHLY' || values.recurrencePatternType === 'YEARLY' ? values.recurrenceMonthday : undefined,
          byMonth: values.recurrencePatternType === 'YEARLY' ? values.recurrenceYearMonth : undefined,
          slot: values.slot,
          bookedFor: values.bookedFor,
          guestName: values.bookedFor === 'GUEST' ? values.guestName.trim() : undefined
        });

    await onSubmit(payload);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form className="desk-booking-form" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
      <div className="desk-booking-form-body">
      <div className="stack-xs">
        <label>Buchung für</label>
        <div className="weekday-toggle-group" role="group" aria-label="Buchung für">
          <button type="button" className={`weekday-toggle ${values.bookedFor === 'SELF' ? 'active' : ''}`} disabled={disabled} onClick={() => onChange({ ...values, bookedFor: 'SELF', guestName: '' })}>Mich</button>
          <button type="button" className={`weekday-toggle ${values.bookedFor === 'GUEST' ? 'active' : ''}`} disabled={disabled} onClick={() => onChange({ ...values, bookedFor: 'GUEST' })}>Gast</button>
        </div>
      </div>

      {values.bookedFor === 'GUEST' && (
        <div className="stack-xs">
          <label htmlFor="guest-name">Name des Gastes</label>
          <input id="guest-name" type="text" value={values.guestName} disabled={disabled} onChange={(event) => onChange({ ...values, guestName: event.target.value })} />
          {fieldErrors.guestName && <p className="field-error" role="alert">{fieldErrors.guestName}</p>}
        </div>
      )}
      <div className="stack-xs">
        <label>Typ</label>
        <div className="weekday-toggle-group" role="group" aria-label="Buchungstyp">
          <button type="button" className={`weekday-toggle ${values.type === 'single' ? 'active' : ''}`} disabled={disabled} onClick={() => onChange({ ...values, type: 'single' })}>Einzel</button>
          <button
            type="button"
            className={`weekday-toggle ${values.type === 'recurring' ? 'active' : ''}`}
            disabled={disabled || !allowRecurring}
            onClick={() => {
              if (!allowRecurring) return;
              setShowRecurrenceDetails(true);
              onChange({
                ...values,
                type: 'recurring',
                endDateTouched: false,
                rangeMode: 'BY_DATE',
                dateTo: suggestedRecurringEndDate(values.dateFrom, values.recurrencePatternType)
              });
            }}
          >
            Serie
          </button>
        </div>
      </div>

      {!allowRecurring && <p className="muted">Für diese Ressource sind Serientermine nicht erlaubt.</p>}

      {values.type === 'single' && (
        <>
          <div className="stack-xs">
            <label htmlFor="booking-date">Datum</label>
            <input id="booking-date" type="date" value={values.date} disabled={disabled} onChange={(event) => onChange({ ...values, date: event.target.value })} />
            {fieldErrors.date && <p className="field-error" role="alert">{fieldErrors.date}</p>}
          </div>

          {isRoom ? (
            <>
              <section className="room-schedule-block stack-xs">
                <div className="room-schedule-header">
                  <strong className="room-schedule-title">Heute belegt</strong>
                  <RoomBusinessDayRing
                    segments={roomSchedule?.occupiedSegments ?? []}
                    freeSegments={roomSchedule?.freeSegments ?? []}
                    className="room-schedule-ring"
                    strokeWidth={12}
                    debugTitle={roomSchedule?.ringDebugTitle}
                  />
                </div>
                {hasCancelableRoomBooking && <p className="room-booking-hint">Tipp: Deine Buchungen kannst du anklicken, um sie zu stornieren.</p>}
                {roomSchedule && roomSchedule.bookings.length > 0 ? (
                  <div className="room-bookings-list" role="list" aria-label="Raumbelegung heute">
                    {roomSchedule.bookings.map((booking) => (
                      <button
                        key={booking.id}
                        type="button"
                        className={`room-booking-row ${booking.canCancel ? 'is-clickable' : ''}`}
                        role="listitem"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          roomSchedule.onBookingClick?.(event, booking.id);
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        disabled={!booking.canCancel || disabled || isSubmitting}
                        title={booking.canCancel ? 'Eigene Buchung stornieren' : undefined}
                        aria-label={booking.canCancel ? `Buchung ${booking.label.replace(' – ', '-')} stornieren` : undefined}
                      >
                        <span className="room-booking-time">{booking.label}</span>
                        <span className="room-booking-meta">
                          <span className="room-booking-person">
                            {booking.isSeries && <span className="room-booking-repeat" aria-label="Teil einer Serie" title="Serienbuchung">🔁</span>}
                            {booking.person}
                            {booking.isSelfMine && <em className="room-booking-badge">Du</em>}
                            {booking.isGuestMine && <em className="room-booking-badge">von Dir</em>}
                          </span>
                          <span>
                            {booking.canCancel && <span className="room-booking-action" aria-hidden>Stornieren</span>}
                            {booking.debugMeta && <small className="muted" style={{ display: 'block' }}>{booking.debugMeta}</small>}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="room-free-hint">Heute frei</p>
                )}

                <strong className="room-schedule-title">Freie Zeitfenster</strong>
                {roomSchedule && roomSchedule.freeSlots.length > 0 && (
                  <div className="room-free-slots" role="group" aria-label="Freie Zeitfenster">
                    {roomSchedule.freeSlots.map((slot) => (
                      <button key={slot.label} type="button" className="free-slot-chip" disabled={disabled || isSubmitting} onClick={() => roomSchedule.onSelectFreeSlot(slot.startTime, slot.endTime)}>{slot.label}</button>
                    ))}
                  </div>
                )}
                {roomSchedule?.isFullyBooked && <p className="room-fully-booked-hint">Heute vollständig belegt</p>}
                {roomSchedule?.debugInfo && roomSchedule.debugInfo.length > 0 && (
                  <div className="room-debug-panel muted">
                    {roomSchedule.debugInfo.map((line) => <p key={line}>{line}</p>)}
                  </div>
                )}
              </section>
              <div className="split">
                <div className="stack-xs">
                  <label htmlFor="booking-start-time">Von</label>
                  <input id="booking-start-time" type="time" min="06:00" max="18:00" value={values.startTime} disabled={disabled} onChange={(event) => onChange({ ...values, startTime: event.target.value })} />
                  {fieldErrors.startTime && <p className="field-error" role="alert">{fieldErrors.startTime}</p>}
                </div>
                <div className="stack-xs">
                  <label htmlFor="booking-end-time">Bis</label>
                  <input id="booking-end-time" type="time" min="06:00" max="18:00" value={values.endTime} disabled={disabled} onChange={(event) => onChange({ ...values, endTime: event.target.value })} />
                  {fieldErrors.endTime && <p className="field-error" role="alert">{fieldErrors.endTime}</p>}
                </div>
              </div>
              <p className="muted room-bookable-hours">Buchbare Zeit 06:00 - 18:00 Uhr</p>
              {roomSchedule?.conflictMessage && <p className="field-error room-conflict-hint" role="alert">{roomSchedule.conflictMessage}</p>}
            </>
          ) : (
            <div className="stack-xs">
              <label htmlFor="booking-slot">Zeitraum</label>
              <select id="booking-slot" value={values.slot} disabled={disabled} onChange={(event) => onChange({ ...values, slot: event.target.value as BookingSlot })}>
                <option value="FULL_DAY">Ganzer Tag</option>
                <option value="MORNING">Vormittag</option>
                <option value="AFTERNOON">Nachmittag</option>
              </select>
            </div>
          )}
        </>
      )}

      {values.type === 'recurring' && (
        <section className="stack-sm recurring-panel recurring-section">
          <button type="button" className="recurrence-accordion-toggle" onClick={() => setShowRecurrenceDetails((current) => !current)}>
            <strong>Serienbuchung</strong>
            <span className="muted">{recurrenceSummary}</span>
          </button>
          {showRecurrenceDetails && (
            <>
              <div className="stack-xs">
                {isRoom && <label className="recurrence-section-title">Terminzeit</label>}
                {isRoom ? (
                  <>
                    <div className="split">
                      <div className="stack-xs"><label htmlFor="booking-recurring-start-time">Von</label><input id="booking-recurring-start-time" type="time" min="06:00" max="18:00" value={values.startTime} disabled={disabled} onChange={(event) => onChange({ ...values, startTime: event.target.value })} />{fieldErrors.startTime && <p className="field-error" role="alert">{fieldErrors.startTime}</p>}</div>
                      <div className="stack-xs"><label htmlFor="booking-recurring-end-time">Bis</label><input id="booking-recurring-end-time" type="time" min="06:00" max="18:00" value={values.endTime} disabled={disabled} onChange={(event) => onChange({ ...values, endTime: event.target.value })} />{fieldErrors.endTime && <p className="field-error" role="alert">{fieldErrors.endTime}</p>}</div>
                    </div>
                    <p className="muted room-bookable-hours">Buchbare Zeit 06:00 - 18:00 Uhr</p>
                  </>
                ) : (
                  <div className="stack-xs"><label htmlFor="booking-recurring-slot">Zeitraum</label><select id="booking-recurring-slot" value={values.slot} disabled={disabled} onChange={(event) => onChange({ ...values, slot: event.target.value as BookingSlot })}><option value="FULL_DAY">Ganztag</option><option value="MORNING">Vormittag</option><option value="AFTERNOON">Nachmittag</option></select></div>
                )}
              </div>

              <div className="stack-xs">
                <label className="recurrence-section-title">Wiederholung</label>
                <div className="weekday-toggle-group" role="group" aria-label="Wiederholungsmuster">
                  {(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).map((pattern) => (
                    <button
                      key={pattern}
                      type="button"
                      className={`weekday-toggle ${values.recurrencePatternType === pattern ? 'active' : ''}`}
                      disabled={disabled}
                      onClick={() => onChange({ ...values, recurrencePatternType: pattern, dateTo: values.endDateTouched ? values.dateTo : suggestedRecurringEndDate(values.dateFrom, pattern) })}
                    >
                      {pattern === 'DAILY' ? 'Täglich' : pattern === 'WEEKLY' ? 'Wöchentlich' : pattern === 'MONTHLY' ? 'Monatlich' : 'Jährlich'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="stack-xs">
                <label className="recurrence-section-title" htmlFor="recurrence-interval">Intervall</label>
                <div className="recurrence-interval-row" role="group" aria-label="Wiederholungsintervall">
                  <span>Alle</span>
                  <input id="recurrence-interval" type="number" min={1} value={values.recurrenceInterval} disabled={disabled} onChange={(event) => onChange({ ...values, recurrenceInterval: Math.max(1, Number(event.target.value || 1)) })} />
                  <span className="muted">{recurrenceIntervalUnitLabel(values.recurrencePatternType)}</span>
                </div>
                {fieldErrors.interval && <p className="field-error" role="alert">{fieldErrors.interval}</p>}
              </div>

              {values.recurrencePatternType === 'WEEKLY' && <div className="stack-xs"><label>Wochentage</label><div className="weekday-toggle-group" role="group" aria-label="Wochentage">{weekdayButtons.map((weekday) => <button key={weekday.value} type="button" className={`weekday-toggle ${values.weekdays.includes(weekday.value) ? 'active' : ''}`} disabled={disabled} onClick={() => toggleWeekday(weekday.value)}>{weekday.label}</button>)}</div>{fieldErrors.weekdays && <p className="field-error" role="alert">{fieldErrors.weekdays}</p>}</div>}

              {values.recurrencePatternType === 'MONTHLY' && (
                <div className="stack-xs recurrence-monthly-row">
                  <label htmlFor="recurrence-monthday">Am Tag</label>
                  <input id="recurrence-monthday" type="number" min={1} max={31} value={values.recurrenceMonthday} disabled={disabled} onChange={(event) => onChange({ ...values, recurrenceMonthday: Number(event.target.value || 1) })} />
                  {fieldErrors.monthday && <p className="field-error" role="alert">{fieldErrors.monthday}</p>}
                </div>
              )}

              {values.recurrencePatternType === 'YEARLY' && (
                <div className="stack-xs">
                  <label>Am</label>
                  <div className="recurrence-yearly-row">
                    <div className="stack-xs">
                      <label htmlFor="recurrence-monthday">Tag</label>
                      <input id="recurrence-monthday" type="number" min={1} max={31} value={values.recurrenceMonthday} disabled={disabled} onChange={(event) => onChange({ ...values, recurrenceMonthday: Number(event.target.value || 1) })} />
                    </div>
                    <div className="stack-xs">
                      <label htmlFor="recurrence-year-month">Monat</label>
                      <input id="recurrence-year-month" type="number" min={1} max={12} value={values.recurrenceYearMonth} disabled={disabled} onChange={(event) => onChange({ ...values, recurrenceYearMonth: Number(event.target.value || 1) })} />
                    </div>
                  </div>
                  {fieldErrors.monthday && <p className="field-error" role="alert">{fieldErrors.monthday}</p>}
                  {fieldErrors.yearmonth && <p className="field-error" role="alert">{fieldErrors.yearmonth}</p>}
                </div>
              )}

              <div className="stack-xs">
                <strong className="recurrence-section-title">Zeitraum</strong>
                <div className="stack-xs">
                  <label htmlFor="booking-date-from">Startdatum</label>
                  <input id="booking-date-from" type="date" value={values.dateFrom} disabled={disabled} onChange={(event) => onChange({ ...values, dateFrom: event.target.value, recurrenceMonthday: new Date(`${event.target.value || values.dateFrom}T00:00:00.000Z`).getUTCDate(), recurrenceYearMonth: new Date(`${event.target.value || values.dateFrom}T00:00:00.000Z`).getUTCMonth() + 1 })} />
                  {fieldErrors.dateFrom && <p className="field-error" role="alert">{fieldErrors.dateFrom}</p>}
                </div>
                <div className="stack-xs recurrence-range-group">
                  <strong>Ende</strong>
                  <label className="end-option-row">
                    <input type="radio" name="recurrence-range" checked={values.rangeMode === 'BY_DATE'} disabled={disabled} onChange={() => onChange({ ...values, rangeMode: 'BY_DATE' })} />
                    <span className="end-option-label">Am Datum</span>
                    <input className="end-option-control" id="booking-date-to" type="date" value={values.dateTo} disabled={disabled || values.rangeMode !== 'BY_DATE'} onChange={(event) => onChange({ ...values, dateTo: event.target.value, endDateTouched: true })} />
                  </label>
                  <label className="end-option-row">
                    <input type="radio" name="recurrence-range" checked={values.rangeMode === 'BY_COUNT'} disabled={disabled} onChange={() => onChange({ ...values, rangeMode: 'BY_COUNT' })} />
                    <span className="end-option-label">Nach Anzahl</span>
                    <div className="end-option-control-with-suffix">
                      <input className="end-option-control" type="number" min={1} value={values.occurrenceCount} disabled={disabled || values.rangeMode !== 'BY_COUNT'} onChange={(event) => onChange({ ...values, occurrenceCount: Math.max(1, Number(event.target.value || 1)) })} />
                      <span className="end-option-suffix">Termine</span>
                    </div>
                  </label>
                </div>
                {fieldErrors.dateTo && <p className="field-error" role="alert">{fieldErrors.dateTo}</p>}
                {fieldErrors.occurrenceCount && <p className="field-error" role="alert">{fieldErrors.occurrenceCount}</p>}
              </div>
            </>
          )}
          {recurrencePreviewCount > 0 && <details className="recurrence-preview" open={showRecurrencePreview} onToggle={(event) => setShowRecurrencePreview((event.target as HTMLDetailsElement).open)}><summary>Vorschau anzeigen</summary><p className="muted">Diese Serie erzeugt {recurrencePreviewCount} Termine.</p></details>}
        </section>
      )}

      {(errorMessage || localError) && <div className="error-banner" role="alert">{errorMessage || localError}</div>}
      </div>
      <div className="desk-booking-form-footer">
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={disabled || isSubmitting} data-state={isSubmitting ? 'loading' : 'idle'}>{isSubmitting ? <><span className="btn-spinner" aria-hidden />Warten…</> : 'Abbrechen'}</button>
        <button className="btn" type="submit" disabled={disabled || isSubmitting || isFormInvalid} data-state={isSubmitting ? 'loading' : 'idle'}>{isSubmitting ? <><span className="btn-spinner" aria-hidden />Buchen…</> : 'Buchen'}</button>
      </div>
    </form>
  );
}
