import { FormEvent, MouseEvent, useEffect, useMemo, useState } from 'react';
import { API_BASE, ApiError, get, post } from './api';

type Me = { id: string; email: string; displayName: string; role: string };
type Floorplan = { id: string; name: string; imageUrl: string; createdAt: string; updatedAt: string };
type Desk = { id: string; floorplanId: string; name: string; x: number; y: number; createdAt: string; updatedAt: string };
type Booking = { id: string; deskId: string; userEmail: string; date: string; createdAt: string; updatedAt: string };

type Tab = 'single' | 'recurring';

const today = new Date();
const toISODate = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const WEEKDAYS = [
  { label: 'Montag', value: 1 },
  { label: 'Dienstag', value: 2 },
  { label: 'Mittwoch', value: 3 },
  { label: 'Donnerstag', value: 4 },
  { label: 'Freitag', value: 5 },
  { label: 'Samstag', value: 6 },
  { label: 'Sonntag', value: 0 }
];

export function App() {
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState<string>('');
  const [selectedFloorplan, setSelectedFloorplan] = useState<Floorplan | null>(null);
  const [desks, setDesks] = useState<Desk[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [selectedDeskId, setSelectedDeskId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('single');

  const [createName, setCreateName] = useState('');
  const [createImageUrl, setCreateImageUrl] = useState('');

  const [singleDate, setSingleDate] = useState(toISODate(today));
  const [weekday, setWeekday] = useState<number>(1);
  const [validFrom, setValidFrom] = useState(toISODate(today));
  const [validTo, setValidTo] = useState('');

  const [me, setMe] = useState<Me | null>(null);
  const [userEmail, setUserEmail] = useState('demo@example.com');

  const [errorMessage, setErrorMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');

  const selectedDesk = useMemo(() => desks.find((desk) => desk.id === selectedDeskId) ?? null, [desks, selectedDeskId]);
  const selectedDeskBookings = useMemo(
    () => bookings.filter((booking) => booking.deskId === selectedDeskId).sort((a, b) => a.date.localeCompare(b.date)),
    [bookings, selectedDeskId]
  );

  const from = toISODate(today);
  const to = toISODate(addDays(today, 14));

  const handleApiError = (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 409) {
        setErrorMessage('Konflikt: bereits gebucht oder durch wiederkehrende Buchung blockiert.');
        return;
      }
      setErrorMessage(error.message);
      return;
    }
    setErrorMessage('Netzwerkfehler beim Laden der Daten.');
  };

  const loadFloorplans = async () => {
    try {
      const data = await get<Floorplan[]>('/floorplans');
      setFloorplans(data);
    } catch (error) {
      handleApiError(error);
    }
  };

  const loadFloorplanDetail = async (floorplanId: string) => {
    try {
      const [floorplan, floorplanDesks, floorplanBookings] = await Promise.all([
        get<Floorplan>(`/floorplans/${floorplanId}`),
        get<Desk[]>(`/floorplans/${floorplanId}/desks`),
        get<Booking[]>(`/bookings?from=${from}&to=${to}&floorplanId=${floorplanId}`)
      ]);
      setSelectedFloorplan(floorplan);
      setDesks(floorplanDesks);
      setBookings(floorplanBookings);
    } catch (error) {
      handleApiError(error);
    }
  };

  useEffect(() => {
    loadFloorplans();
    get<Me>('/me')
      .then((meData) => {
        setMe(meData);
        setUserEmail(meData.email || 'demo@example.com');
      })
      .catch(() => {
        setUserEmail('demo@example.com');
      });
  }, []);

  useEffect(() => {
    if (selectedFloorplanId) {
      setErrorMessage('');
      setInfoMessage('');
      loadFloorplanDetail(selectedFloorplanId);
    }
  }, [selectedFloorplanId]);

  const createFloorplan = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage('');
    setInfoMessage('');
    try {
      const created = await post<Floorplan>('/floorplans', { name: createName, imageUrl: createImageUrl });
      setCreateName('');
      setCreateImageUrl('');
      await loadFloorplans();
      setSelectedFloorplanId(created.id);
      setInfoMessage(`Floorplan "${created.name}" erstellt.`);
    } catch (error) {
      handleApiError(error);
    }
  };

  const createDeskAtPosition = async (event: MouseEvent<HTMLDivElement>) => {
    if (!selectedFloorplan) return;

    const target = event.target as HTMLElement;
    if (target.dataset.pin === 'desk-pin') {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    const defaultName = `Desk ${desks.length + 1}`;
    const enteredName = window.prompt('Desk-Name eingeben', defaultName);
    if (enteredName === null) return;
    const name = enteredName.trim() || defaultName;

    setErrorMessage('');
    setInfoMessage('');
    try {
      await post<Desk>(`/floorplans/${selectedFloorplan.id}/desks`, { name, x, y });
      const floorplanDesks = await get<Desk[]>(`/floorplans/${selectedFloorplan.id}/desks`);
      setDesks(floorplanDesks);
      setInfoMessage(`Desk "${name}" erstellt.`);
    } catch (error) {
      handleApiError(error);
    }
  };

  const createSingleBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedDesk) return;

    setErrorMessage('');
    setInfoMessage('');
    try {
      await post('/bookings', { deskId: selectedDesk.id, userEmail, date: singleDate });
      const floorplanBookings = await get<Booking[]>(
        `/bookings?from=${from}&to=${to}&floorplanId=${selectedFloorplanId}`
      );
      setBookings(floorplanBookings);
      setInfoMessage('Einzeltag-Buchung erfolgreich erstellt.');
    } catch (error) {
      handleApiError(error);
    }
  };

  const createRecurringBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedDesk) return;

    setErrorMessage('');
    setInfoMessage('');
    try {
      await post('/recurring-bookings', {
        deskId: selectedDesk.id,
        userEmail,
        weekday,
        validFrom,
        validTo: validTo || undefined
      });
      const floorplanBookings = await get<Booking[]>(
        `/bookings?from=${from}&to=${to}&floorplanId=${selectedFloorplanId}`
      );
      setBookings(floorplanBookings);
      setInfoMessage('Wiederkehrende Buchung erfolgreich erstellt.');
    } catch (error) {
      handleApiError(error);
    }
  };

  return (
    <main style={{ fontFamily: 'Arial, sans-serif', padding: '1rem' }}>
      <h1>RB-MS Floorplan MVP</h1>
      <p style={{ marginTop: 0 }}>API: {API_BASE}</p>
      {me && <p>Aktueller User: {me.email}</p>}
      {errorMessage && <p style={{ color: '#b00020', fontWeight: 700 }}>{errorMessage}</p>}
      {infoMessage && <p style={{ color: '#0a7a32', fontWeight: 700 }}>{infoMessage}</p>}

      <section style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1rem', alignItems: 'start' }}>
        <aside style={{ border: '1px solid #ddd', borderRadius: 8, padding: '0.75rem' }}>
          <h2>Floorplans</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {floorplans.map((floorplan) => (
              <li key={floorplan.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>{floorplan.name}</span>
                <button type="button" onClick={() => setSelectedFloorplanId(floorplan.id)}>
                  Open
                </button>
              </li>
            ))}
          </ul>

          <h3 style={{ marginTop: '1rem' }}>Floorplan erstellen</h3>
          <form onSubmit={createFloorplan} style={{ display: 'grid', gap: 8 }}>
            <input
              required
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="Name"
            />
            <input
              required
              value={createImageUrl}
              onChange={(event) => setCreateImageUrl(event.target.value)}
              placeholder="Image URL"
            />
            <button type="submit">Create</button>
          </form>
        </aside>

        <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: '0.75rem' }}>
          {!selectedFloorplan && <p>Bitte links einen Floorplan öffnen.</p>}

          {selectedFloorplan && (
            <>
              <h2>{selectedFloorplan.name}</h2>
              <p>Klick ins Bild, um einen Desk-Pin zu setzen.</p>
              <div
                onClick={createDeskAtPosition}
                style={{ position: 'relative', display: 'inline-block', border: '1px solid #bbb', maxWidth: '100%' }}
              >
                <img src={selectedFloorplan.imageUrl} alt={selectedFloorplan.name} style={{ maxWidth: '100%', display: 'block' }} />
                {desks.map((desk) => (
                  <button
                    key={desk.id}
                    data-pin="desk-pin"
                    type="button"
                    title={desk.name}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedDeskId(desk.id);
                    }}
                    style={{
                      position: 'absolute',
                      left: `${desk.x * 100}%`,
                      top: `${desk.y * 100}%`,
                      transform: 'translate(-50%, -50%)',
                      width: 16,
                      height: 16,
                      borderRadius: '50%',
                      border: selectedDeskId === desk.id ? '2px solid #111' : '2px solid #fff',
                      background: selectedDeskId === desk.id ? '#ff9800' : '#1e88e5',
                      cursor: 'pointer'
                    }}
                  />
                ))}
              </div>

              {selectedDesk && (
                <div style={{ marginTop: '1rem', borderTop: '1px solid #ddd', paddingTop: '0.75rem' }}>
                  <h3>Desk: {selectedDesk.name}</h3>

                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <button type="button" onClick={() => setTab('single')} disabled={tab === 'single'}>
                      Einzeltag
                    </button>
                    <button type="button" onClick={() => setTab('recurring')} disabled={tab === 'recurring'}>
                      Wiederkehrend
                    </button>
                  </div>

                  <label style={{ display: 'block', marginBottom: 8 }}>
                    User Email
                    <input
                      style={{ marginLeft: 8 }}
                      value={userEmail}
                      onChange={(event) => setUserEmail(event.target.value)}
                    />
                  </label>

                  {tab === 'single' && (
                    <form onSubmit={createSingleBooking} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label>
                        Datum
                        <input
                          type="date"
                          value={singleDate}
                          onChange={(event) => setSingleDate(event.target.value)}
                          style={{ marginLeft: 8 }}
                        />
                      </label>
                      <button type="submit">Buchen</button>
                    </form>
                  )}

                  {tab === 'recurring' && (
                    <form onSubmit={createRecurringBooking} style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
                      <label>
                        Wochentag
                        <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} style={{ marginLeft: 8 }}>
                          {WEEKDAYS.map((day) => (
                            <option key={day.label} value={day.value}>
                              {day.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Valid From
                        <input
                          type="date"
                          value={validFrom}
                          onChange={(event) => setValidFrom(event.target.value)}
                          style={{ marginLeft: 8 }}
                        />
                      </label>
                      <label>
                        Valid To (optional)
                        <input
                          type="date"
                          value={validTo}
                          onChange={(event) => setValidTo(event.target.value)}
                          style={{ marginLeft: 8 }}
                        />
                      </label>
                      <button type="submit">Wiederkehrend buchen</button>
                    </form>
                  )}

                  <h4 style={{ marginTop: '1rem' }}>Buchungen (nächste 14 Tage)</h4>
                  {selectedDeskBookings.length === 0 ? (
                    <p>Keine Buchungen vorhanden.</p>
                  ) : (
                    <ul>
                      {selectedDeskBookings.map((booking) => (
                        <li key={booking.id}>
                          {booking.date} – {booking.userEmail}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </section>
    </main>
  );
}
