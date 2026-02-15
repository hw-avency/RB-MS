import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

type BookingType = 'single' | 'range' | 'recurring';

export type BookingFormValues = {
  type: BookingType;
  date: string;
  dateFrom: string;
  dateTo: string;
  onlyWeekdays: boolean;
  weekdays: number[];
};

export type BookingFormSubmitPayload =
  | { type: 'single'; date: string }
  | { type: 'range'; dateFrom: string; dateTo: string; onlyWeekdays: boolean }
  | { type: 'recurring'; dateFrom: string; dateTo: string; weekdays: number[] };

export const createDefaultBookingFormValues = (selectedDate: string): BookingFormValues => {
  const defaultWeekday = new Date(`${selectedDate}T00:00:00.000Z`).getUTCDay();
  return {
    type: 'single',
    date: selectedDate,
    dateFrom: selectedDate,
    dateTo: selectedDate,
    onlyWeekdays: true,
    weekdays: [defaultWeekday]
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

export function BookingForm({ values, onChange, onSubmit, onCancel, isSubmitting, disabled, errorMessage }: {
  values: BookingFormValues;
  onChange: (next: BookingFormValues) => void;
  onSubmit: (payload: BookingFormSubmitPayload) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
  disabled: boolean;
  errorMessage?: string;
}) {
  const [localError, setLocalError] = useState('');
  const typeSelectRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    typeSelectRef.current?.focus();
  }, []);

  const fieldErrors = useMemo(() => {
    const nextErrors: { date?: string; dateFrom?: string; dateTo?: string; weekdays?: string } = {};

    if (values.type === 'single' && !values.date) {
      nextErrors.date = 'Datum ist erforderlich.';
    }

    if (values.type === 'recurring') {
      if (!values.dateFrom) {
        nextErrors.dateFrom = 'Startdatum ist erforderlich.';
      }
      if (!values.dateTo) {
        nextErrors.dateTo = 'Enddatum ist erforderlich.';
      }
      if (values.dateFrom && values.dateTo && values.dateFrom > values.dateTo) {
        nextErrors.dateTo = 'Enddatum muss nach dem Startdatum liegen.';
      }
      if (values.weekdays.length === 0) {
        nextErrors.weekdays = 'Bitte mindestens einen Wochentag auswählen.';
      }
    }

    return nextErrors;
  }, [values]);

  const isFormInvalid = Object.values(fieldErrors).some(Boolean);

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
      ? { type: 'single', date: values.date }
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
      <div className="stack-xs">
        <label htmlFor="booking-type">Typ</label>
        <select
          id="booking-type"
          ref={typeSelectRef}
          value={values.type}
          disabled={disabled}
          onChange={(event) => {
            const nextType = event.target.value === 'recurring' ? 'recurring' : 'single';
            onChange({ ...values, type: nextType });
          }}
        >
          <option value="single">Einzelbuchung ganzer Tag</option>
          <option value="recurring">Serienbuchung</option>
        </select>
      </div>

      {values.type === 'single' && (
        <div className="stack-xs">
          <label htmlFor="booking-date">Datum</label>
          <input id="booking-date" type="date" value={values.date} disabled={disabled} onChange={(event) => onChange({ ...values, date: event.target.value })} />
          {fieldErrors.date && <p className="field-error" role="alert">{fieldErrors.date}</p>}
        </div>
      )}

      {values.type === 'recurring' && (
        <>
          <div className="stack-xs">
              <label htmlFor="booking-date-from">Startdatum</label>
              <input id="booking-date-from" type="date" value={values.dateFrom} disabled={disabled} onChange={(event) => onChange({ ...values, dateFrom: event.target.value })} />
              {fieldErrors.dateFrom && <p className="field-error" role="alert">{fieldErrors.dateFrom}</p>}
            </div>
            <div className="stack-xs">
              <label htmlFor="booking-date-to">Enddatum</label>
              <input id="booking-date-to" type="date" value={values.dateTo} disabled={disabled} onChange={(event) => onChange({ ...values, dateTo: event.target.value })} />
              {fieldErrors.dateTo && <p className="field-error" role="alert">{fieldErrors.dateTo}</p>}
            </div>
          <div className="stack-xs">
            <label>Wochentage</label>
            <div className="weekday-toggle-group" role="group" aria-label="Wochentage">
              {weekdayButtons.map((weekday) => (
                <button
                  key={weekday.value}
                  type="button"
                  className={`weekday-toggle ${values.weekdays.includes(weekday.value) ? 'active' : ''}`}
                  disabled={disabled}
                  onClick={() => toggleWeekday(weekday.value)}
                >
                  {weekday.label}
                </button>
              ))}
            </div>
            {fieldErrors.weekdays && <p className="field-error" role="alert">{fieldErrors.weekdays}</p>}
          </div>
        </>
      )}

      {(errorMessage || localError) && <div className="error-banner" role="alert">{errorMessage || localError}</div>}

      <div className="desk-booking-form-footer">
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={disabled || isSubmitting}>Abbrechen</button>
        <button className="btn" type="submit" disabled={disabled || isSubmitting || isFormInvalid}>
          {isSubmitting ? <><span className="btn-spinner" aria-hidden />Buchen…</> : 'Buchen'}
        </button>
      </div>
    </form>
  );
}
