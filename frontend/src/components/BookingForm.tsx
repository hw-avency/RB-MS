import { FormEvent, useState } from 'react';

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

    if (values.type !== 'single' && (!values.dateFrom || !values.dateTo || values.dateFrom > values.dateTo)) {
      setLocalError('Startdatum muss vor oder gleich Enddatum liegen.');
      return;
    }

    if (values.type === 'recurring' && values.weekdays.length === 0) {
      setLocalError('Bitte mindestens einen Wochentag für die Serienbuchung auswählen.');
      return;
    }

    const payload: BookingFormSubmitPayload = values.type === 'single'
      ? { type: 'single', date: values.date }
      : values.type === 'range'
        ? { type: 'range', dateFrom: values.dateFrom, dateTo: values.dateTo, onlyWeekdays: values.onlyWeekdays }
        : { type: 'recurring', dateFrom: values.dateFrom, dateTo: values.dateTo, weekdays: values.weekdays };

    await onSubmit(payload);
  };

  return (
    <form className="stack-sm" onSubmit={handleSubmit}>
      <div className="stack-xs">
        <label>Typ</label>
        <select
          value={values.type}
          disabled={disabled}
          onChange={(event) => {
            const nextType = event.target.value === 'range' ? 'range' : event.target.value === 'recurring' ? 'recurring' : 'single';
            onChange({ ...values, type: nextType });
          }}
        >
          <option value="single">Einzelbuchung ganzer Tag</option>
          <option value="range">Zeitraum (Von–Bis)</option>
          <option value="recurring">Serienbuchung</option>
        </select>
      </div>

      {values.type === 'single' && (
        <div className="stack-xs">
          <label>Datum</label>
          <input type="date" value={values.date} readOnly disabled />
        </div>
      )}

      {values.type === 'range' && (
        <>
          <div className="inline-grid-two">
            <div className="stack-xs">
              <label>Von</label>
              <input type="date" value={values.dateFrom} autoFocus disabled={disabled} onChange={(event) => onChange({ ...values, dateFrom: event.target.value })} />
            </div>
            <div className="stack-xs">
              <label>Bis</label>
              <input type="date" value={values.dateTo} disabled={disabled} onChange={(event) => onChange({ ...values, dateTo: event.target.value })} />
            </div>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={values.onlyWeekdays}
              disabled={disabled}
              onChange={(event) => onChange({ ...values, onlyWeekdays: event.target.checked })}
            />
            Nur Werktage (Mo–Fr)
          </label>
        </>
      )}

      {values.type === 'recurring' && (
        <>
          <div className="inline-grid-two">
            <div className="stack-xs">
              <label>Start</label>
              <input type="date" value={values.dateFrom} autoFocus disabled={disabled} onChange={(event) => onChange({ ...values, dateFrom: event.target.value })} />
            </div>
            <div className="stack-xs">
              <label>Ende</label>
              <input type="date" value={values.dateTo} disabled={disabled} onChange={(event) => onChange({ ...values, dateTo: event.target.value })} />
            </div>
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
          </div>
        </>
      )}

      {(errorMessage || localError) && <div className="error-banner" role="alert">{errorMessage || localError}</div>}

      <div className="inline-between">
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={disabled}>Abbrechen</button>
        <button className="btn" type="submit" disabled={disabled || isSubmitting}>{isSubmitting ? 'Buchen…' : 'Buchen'}</button>
      </div>
    </form>
  );
}
