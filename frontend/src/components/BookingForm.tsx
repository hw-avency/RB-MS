import { FormEvent, useMemo, useState } from 'react';

type BookingType = 'single' | 'range' | 'recurring';

type BookingFormValues = {
  type: BookingType;
  date: string;
  dateFrom: string;
  dateTo: string;
  onlyWeekdays: boolean;
  weekdays: number[];
};

type BookingFormSubmitPayload =
  | { type: 'single'; date: string }
  | { type: 'range'; dateFrom: string; dateTo: string; onlyWeekdays: boolean }
  | { type: 'recurring'; dateFrom: string; dateTo: string; weekdays: number[] };

const weekdayButtons = [
  { label: 'Mo', value: 1 },
  { label: 'Di', value: 2 },
  { label: 'Mi', value: 3 },
  { label: 'Do', value: 4 },
  { label: 'Fr', value: 5 },
  { label: 'Sa', value: 6 },
  { label: 'So', value: 0 }
];

export function BookingForm({
  selectedDate,
  onSubmit,
  onCancel
}: {
  selectedDate: string;
  onSubmit: (payload: BookingFormSubmitPayload) => Promise<void>;
  onCancel: () => void;
}) {
  const defaultWeekday = useMemo(() => new Date(`${selectedDate}T00:00:00.000Z`).getUTCDay(), [selectedDate]);
  const [values, setValues] = useState<BookingFormValues>({
    type: 'single',
    date: selectedDate,
    dateFrom: selectedDate,
    dateTo: selectedDate,
    onlyWeekdays: true,
    weekdays: [defaultWeekday]
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');

  const toggleWeekday = (weekday: number) => {
    setValues((current) => {
      if (current.weekdays.includes(weekday)) {
        return { ...current, weekdays: current.weekdays.filter((value) => value !== weekday) };
      }
      return { ...current, weekdays: [...current.weekdays, weekday].sort((a, b) => a - b) };
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLocalError('');

    if (values.type === 'range') {
      if (!values.dateFrom || !values.dateTo || values.dateFrom > values.dateTo) {
        setLocalError('Für den Zeitraum muss „Von“ vor oder gleich „Bis“ liegen.');
        return;
      }
    }

    if (values.type === 'recurring') {
      if (!values.dateFrom || !values.dateTo || values.dateFrom > values.dateTo) {
        setLocalError('Für Serienbuchungen muss der Zeitraum korrekt gesetzt sein.');
        return;
      }
      if (values.weekdays.length === 0) {
        setLocalError('Bitte mindestens einen Wochentag für die Serienbuchung auswählen.');
        return;
      }
    }

    const payload: BookingFormSubmitPayload = values.type === 'single'
      ? { type: 'single', date: values.date }
      : values.type === 'range'
        ? { type: 'range', dateFrom: values.dateFrom, dateTo: values.dateTo, onlyWeekdays: values.onlyWeekdays }
        : { type: 'recurring', dateFrom: values.dateFrom, dateTo: values.dateTo, weekdays: values.weekdays };

    setIsSubmitting(true);
    try {
      await onSubmit(payload);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="stack-sm" onSubmit={handleSubmit}>
      <div className="stack-xs">
        <label>Typ</label>
        <select
          value={values.type}
          onChange={(event) => {
            const nextType = event.target.value === 'range' ? 'range' : event.target.value === 'recurring' ? 'recurring' : 'single';
            setValues((current) => ({ ...current, type: nextType }));
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
          <input type="date" value={values.date} readOnly />
        </div>
      )}

      {values.type === 'range' && (
        <>
          <div className="inline-grid-two">
            <div className="stack-xs">
              <label>Von</label>
              <input type="date" value={values.dateFrom} autoFocus onChange={(event) => setValues((current) => ({ ...current, dateFrom: event.target.value }))} />
            </div>
            <div className="stack-xs">
              <label>Bis</label>
              <input type="date" value={values.dateTo} onChange={(event) => setValues((current) => ({ ...current, dateTo: event.target.value }))} />
            </div>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={values.onlyWeekdays}
              onChange={(event) => setValues((current) => ({ ...current, onlyWeekdays: event.target.checked }))}
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
              <input type="date" value={values.dateFrom} autoFocus onChange={(event) => setValues((current) => ({ ...current, dateFrom: event.target.value }))} />
            </div>
            <div className="stack-xs">
              <label>Ende</label>
              <input type="date" value={values.dateTo} onChange={(event) => setValues((current) => ({ ...current, dateTo: event.target.value }))} />
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
                  onClick={() => toggleWeekday(weekday.value)}
                >
                  {weekday.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {localError && <p className="muted error-inline">{localError}</p>}

      <div className="inline-end">
        <button type="button" className="btn btn-outline" onClick={onCancel}>Abbrechen</button>
        <button className="btn" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Speichere…' : 'Buchen'}</button>
      </div>
    </form>
  );
}
