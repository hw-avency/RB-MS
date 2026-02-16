import { FormEvent, KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { RingSegment } from '../lib/bookingWindows';
import { RoomBusinessDayRing } from './RoomBusinessDayRing';

type BookingType = 'single' | 'recurring';
type BookingSlot = 'FULL_DAY' | 'MORNING' | 'AFTERNOON';
type RoomScheduleItem = { id: string; label: string; person: string; isCurrentUser?: boolean; canCancel?: boolean; debugMeta?: string };
type RoomFreeSlot = { label: string; startTime: string; endTime: string };

export type BookingFormValues = {
  type: BookingType;
  date: string;
  dateFrom: string;
  dateTo: string;
  weekdays: number[];
  slot: BookingSlot;
  startTime: string;
  endTime: string;
  bookedFor: 'SELF' | 'GUEST';
  guestName: string;
};

export type BookingFormSubmitPayload =
  | { type: 'single'; date: string; slot?: BookingSlot; startTime?: string; endTime?: string; bookedFor: 'SELF' | 'GUEST'; guestName?: string }
  | { type: 'recurring'; dateFrom: string; dateTo: string; weekdays: number[]; slot?: BookingSlot; startTime?: string; endTime?: string; bookedFor: 'SELF' | 'GUEST'; guestName?: string };

export const createDefaultBookingFormValues = (selectedDate: string): BookingFormValues => {
  const defaultWeekday = new Date(`${selectedDate}T00:00:00.000Z`).getUTCDay();
  return {
    type: 'single',
    date: selectedDate,
    dateFrom: selectedDate,
    dateTo: selectedDate,
    weekdays: [defaultWeekday],
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
  { label: 'So', value: 0 }
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
    isFullyBooked?: boolean;
    conflictMessage?: string;
    debugInfo?: string[];
    ringDebugTitle?: string;
    onSelectFreeSlot: (startTime: string, endTime: string) => void;
    onBookingClick?: (event: MouseEvent<HTMLButtonElement>, bookingId: string) => void;
  };
}) {
  const [localError, setLocalError] = useState('');
  const typeSelectRef = useRef<HTMLSelectElement | null>(null);
  const isRoom = resourceKind === 'RAUM';
  useEffect(() => {
    typeSelectRef.current?.focus();
  }, []);

  useEffect(() => {
    if (allowRecurring || values.type !== 'recurring') return;
    onChange({ ...values, type: 'single' });
  }, [allowRecurring, isRoom, onChange, values]);

  const fieldErrors = useMemo(() => {
    const nextErrors: { date?: string; dateFrom?: string; dateTo?: string; weekdays?: string; startTime?: string; endTime?: string; guestName?: string } = {};

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
      if (!values.dateTo) nextErrors.dateTo = 'Enddatum ist erforderlich.';
      if (values.dateFrom && values.dateTo && values.dateFrom > values.dateTo) nextErrors.dateTo = 'Enddatum muss nach dem Startdatum liegen.';
      if (values.weekdays.length === 0) nextErrors.weekdays = 'Bitte mindestens einen Wochentag auswählen.';
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
      : { type: 'recurring', dateFrom: values.dateFrom, dateTo: values.dateTo, weekdays: values.weekdays, slot: isRoom ? undefined : values.slot, startTime: isRoom ? values.startTime : undefined, endTime: isRoom ? values.endTime : undefined, bookedFor: values.bookedFor, guestName: values.bookedFor === 'GUEST' ? values.guestName.trim() : undefined };

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
        <label htmlFor="booking-type">Typ</label>
        <select id="booking-type" ref={typeSelectRef} value={values.type} disabled={disabled} onChange={(event) => onChange({ ...values, type: event.target.value === 'recurring' && allowRecurring ? 'recurring' : 'single' })}>
          <option value="single">Einzelbuchung</option>
          {allowRecurring && <option value="recurring">Serienbuchung</option>}
        </select>
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
                            {booking.person}
                            {booking.isCurrentUser && <em className="room-booking-badge">Du</em>}
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
                  <input id="booking-start-time" type="time" value={values.startTime} disabled={disabled} onChange={(event) => onChange({ ...values, startTime: event.target.value })} />
                  {fieldErrors.startTime && <p className="field-error" role="alert">{fieldErrors.startTime}</p>}
                </div>
                <div className="stack-xs">
                  <label htmlFor="booking-end-time">Bis</label>
                  <input id="booking-end-time" type="time" value={values.endTime} disabled={disabled} onChange={(event) => onChange({ ...values, endTime: event.target.value })} />
                  {fieldErrors.endTime && <p className="field-error" role="alert">{fieldErrors.endTime}</p>}
                </div>
              </div>
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
        <>
          <div className="stack-xs"><label htmlFor="booking-date-from">Startdatum</label><input id="booking-date-from" type="date" value={values.dateFrom} disabled={disabled} onChange={(event) => onChange({ ...values, dateFrom: event.target.value })} />{fieldErrors.dateFrom && <p className="field-error" role="alert">{fieldErrors.dateFrom}</p>}</div>
          <div className="stack-xs"><label htmlFor="booking-date-to">Enddatum</label><input id="booking-date-to" type="date" value={values.dateTo} disabled={disabled} onChange={(event) => onChange({ ...values, dateTo: event.target.value })} />{fieldErrors.dateTo && <p className="field-error" role="alert">{fieldErrors.dateTo}</p>}</div>
          {isRoom ? (
            <div className="split">
              <div className="stack-xs">
                <label htmlFor="booking-recurring-start-time">Von</label>
                <input id="booking-recurring-start-time" type="time" value={values.startTime} disabled={disabled} onChange={(event) => onChange({ ...values, startTime: event.target.value })} />
                {fieldErrors.startTime && <p className="field-error" role="alert">{fieldErrors.startTime}</p>}
              </div>
              <div className="stack-xs">
                <label htmlFor="booking-recurring-end-time">Bis</label>
                <input id="booking-recurring-end-time" type="time" value={values.endTime} disabled={disabled} onChange={(event) => onChange({ ...values, endTime: event.target.value })} />
                {fieldErrors.endTime && <p className="field-error" role="alert">{fieldErrors.endTime}</p>}
              </div>
            </div>
          ) : (
            <div className="stack-xs">
              <label htmlFor="booking-recurring-slot">Zeitraum</label>
              <select id="booking-recurring-slot" value={values.slot} disabled={disabled} onChange={(event) => onChange({ ...values, slot: event.target.value as BookingSlot })}>
                <option value="FULL_DAY">Ganzer Tag</option>
                <option value="MORNING">Vormittag</option>
                <option value="AFTERNOON">Nachmittag</option>
              </select>
            </div>
          )}
          <div className="stack-xs">
            <label>Wochentage</label>
            <div className="weekday-toggle-group" role="group" aria-label="Wochentage">
              {weekdayButtons.map((weekday) => <button key={weekday.value} type="button" className={`weekday-toggle ${values.weekdays.includes(weekday.value) ? 'active' : ''}`} disabled={disabled} onClick={() => toggleWeekday(weekday.value)}>{weekday.label}</button>)}
            </div>
            {fieldErrors.weekdays && <p className="field-error" role="alert">{fieldErrors.weekdays}</p>}
          </div>
        </>
      )}

      {(errorMessage || localError) && <div className="error-banner" role="alert">{errorMessage || localError}</div>}
      <div className="desk-booking-form-footer">
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={disabled || isSubmitting} data-state={isSubmitting ? 'loading' : 'idle'}>{isSubmitting ? <><span className="btn-spinner" aria-hidden />Warten…</> : 'Abbrechen'}</button>
        <button className="btn" type="submit" disabled={disabled || isSubmitting || isFormInvalid} data-state={isSubmitting ? 'loading' : 'idle'}>{isSubmitting ? <><span className="btn-spinner" aria-hidden />Buchen…</> : 'Buchen'}</button>
      </div>
    </form>
  );
}
