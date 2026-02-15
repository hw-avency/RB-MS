import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

type BookingType = 'single' | 'recurring';
type BookingSlot = 'FULL_DAY' | 'MORNING' | 'AFTERNOON';
type RoomScheduleItem = { id: string; label: string; person: string; isCurrentUser?: boolean; canCancel?: boolean };
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
};

export type BookingFormSubmitPayload =
  | { type: 'single'; date: string; slot?: BookingSlot; startTime?: string; endTime?: string }
  | { type: 'recurring'; dateFrom: string; dateTo: string; weekdays: number[] };

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
    endTime: '10:00'
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
    isFullyBooked?: boolean;
    conflictMessage?: string;
    onSelectFreeSlot: (startTime: string, endTime: string) => void;
    onBookingClick?: (bookingId: string) => void;
  };
}) {
  const [localError, setLocalError] = useState('');
  const typeSelectRef = useRef<HTMLSelectElement | null>(null);
  const isRoom = resourceKind === 'RAUM';
  useEffect(() => {
    typeSelectRef.current?.focus();
  }, []);

  useEffect(() => {
    if (allowRecurring || values.type !== 'recurring' || isRoom) return;
    onChange({ ...values, type: 'single' });
  }, [allowRecurring, isRoom, onChange, values]);

  const fieldErrors = useMemo(() => {
    const nextErrors: { date?: string; dateFrom?: string; dateTo?: string; weekdays?: string; startTime?: string; endTime?: string } = {};

    if (values.type === 'single' && !values.date) nextErrors.date = 'Datum ist erforderlich.';
    if (values.type === 'single' && isRoom) {
      if (!values.startTime) nextErrors.startTime = 'Startzeit ist erforderlich.';
      if (!values.endTime) nextErrors.endTime = 'Endzeit ist erforderlich.';
      if (values.startTime && values.endTime && values.startTime >= values.endTime) nextErrors.endTime = 'Endzeit muss nach Startzeit liegen.';
    }

    if (values.type === 'recurring') {
      if (!values.dateFrom) nextErrors.dateFrom = 'Startdatum ist erforderlich.';
      if (!values.dateTo) nextErrors.dateTo = 'Enddatum ist erforderlich.';
      if (values.dateFrom && values.dateTo && values.dateFrom > values.dateTo) nextErrors.dateTo = 'Enddatum muss nach dem Startdatum liegen.';
      if (values.weekdays.length === 0) nextErrors.weekdays = 'Bitte mindestens einen Wochentag auswählen.';
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
        ? { type: 'single', date: values.date, startTime: values.startTime, endTime: values.endTime }
        : { type: 'single', date: values.date, slot: values.slot })
      : { type: 'recurring', dateFrom: values.dateFrom, dateTo: values.dateTo, weekdays: values.weekdays };

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
      {!isRoom && (
        <div className="stack-xs">
          <label htmlFor="booking-type">Typ</label>
          <select id="booking-type" ref={typeSelectRef} value={values.type} disabled={disabled} onChange={(event) => onChange({ ...values, type: event.target.value === 'recurring' && allowRecurring ? 'recurring' : 'single' })}>
            <option value="single">Einzelbuchung</option>
            {allowRecurring && <option value="recurring">Serienbuchung</option>}
          </select>
        </div>
      )}

      {!allowRecurring && !isRoom && <p className="muted">Für diese Ressource sind Serientermine nicht erlaubt.</p>}

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
                <strong className="room-schedule-title">Heute belegt</strong>
                {hasCancelableRoomBooking && <p className="room-booking-hint">Tipp: Deine Buchungen kannst du anklicken, um sie zu stornieren.</p>}
                {roomSchedule && roomSchedule.bookings.length > 0 ? (
                  <div className="room-bookings-list" role="list" aria-label="Raumbelegung heute">
                    {roomSchedule.bookings.map((booking) => (
                      <button
                        key={booking.id}
                        type="button"
                        className={`room-booking-row ${booking.canCancel ? 'is-clickable' : ''}`}
                        role="listitem"
                        onClick={() => roomSchedule.onBookingClick?.(booking.id)}
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
                          {booking.canCancel && <span className="room-booking-action" aria-hidden>Stornieren</span>}
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
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={disabled || isSubmitting}>Abbrechen</button>
        <button className="btn" type="submit" disabled={disabled || isSubmitting || isFormInvalid}>{isSubmitting ? <><span className="btn-spinner" aria-hidden />Buchen…</> : 'Buchen'}</button>
      </div>
    </form>
  );
}
