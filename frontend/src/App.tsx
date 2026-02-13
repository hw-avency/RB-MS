import { FormEvent, MouseEvent, useEffect, useMemo, useState } from 'react';
import { API_BASE, ApiError, del, get, post } from './api';

type Me = { id: string; email: string; displayName: string; role: string };
type Floorplan = { id: string; name: string; imageUrl: string; createdAt: string; updatedAt: string };
type OccupancyDesk = {
  id: string;
  name: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { userEmail: string; type: 'single' | 'recurring' } | null;
};
type OccupancyResponse = {
  date: string;
  floorplanId: string;
  desks: OccupancyDesk[];
  people: { userEmail: string }[];
};

type Tab = 'single' | 'recurring';

const today = new Date();
const toISODate = (date: Date) => date.toISOString().slice(0, 10);

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
  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [selectedDeskId, setSelectedDeskId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('single');

  const [selectedDate, setSelectedDate] = useState(toISODate(today));
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

  const desks = occupancy?.desks ?? [];
  const peopleInOffice = useMemo(
    () => [...(occupancy?.people ?? [])].sort((a, b) => a.userEmail.localeCompare(b.userEmail)),
    [occupancy]
  );
  const selectedDesk = useMemo(() => desks.find((desk) => desk.id === selectedDeskId) ?? null, [desks, selectedDeskId]);

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

  const loadFloorplanAndOccupancy = async (floorplanId: string, date: string) => {
    try {
      const [floorplan, occupancyData] = await Promise.all([
        get<Floorplan>(`/floorplans/${floorplanId}`),
        get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`)
      ]);
      setSelectedFloorplan(floorplan);
      setOccupancy(occupancyData);
      setSelectedDeskId((currentDeskId) =>
        occupancyData.desks.some((desk) => desk.id === currentDeskId) ? currentDeskId : ''
      );
    } catch (error) {
      handleApiError(error);
    }
  };

  const refreshOccupancy = async () => {
    if (!selectedFloorplanId) {
      return;
    }

    try {
      const occupancyData = await get<OccupancyResponse>(
        `/occupancy?floorplanId=${selectedFloorplanId}&date=${selectedDate}`
      );
      setOccupancy(occupancyData);
      setSelectedDeskId((currentDeskId) =>
        occupancyData.desks.some((desk) => desk.id === currentDeskId) ? currentDeskId : ''
      );
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
      loadFloorplanAndOccupancy(selectedFloorplanId, selectedDate);
    }
  }, [selectedFloorplanId, selectedDate]);

  const deleteFloorplan = async (floorplan: Floorplan) => {
    const confirmed = window.confirm(`Floorplan "${floorplan.name}" wirklich löschen?`);
    if (!confirmed) {
      return;
    }

    setErrorMessage('');
    setInfoMessage('');
    try {
      await del<void>(`/floorplans/${floorplan.id}`);
      await loadFloorplans();

      if (selectedFloorplanId === floorplan.id) {
        setSelectedFloorplanId('');
        setSelectedFloorplan(null);
        setOccupancy(null);
        setSelectedDeskId('');
      }

      setInfoMessage(`Floorplan "${floorplan.name}" gelöscht.`);
    } catch (error) {
      handleApiError(error);
    }
  };

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
      await post(`/floorplans/${selectedFloorplan.id}/desks`, { name, x, y });
      await refreshOccupancy();
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
      await refreshOccupancy();
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
      await refreshOccupancy();
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

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: '1rem' }}>
        Datum
        <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
      </label>

      {errorMessage && <p style={{ color: '#b00020', fontWeight: 700 }}>{errorMessage}</p>}
      {infoMessage && <p style={{ color: '#0a7a32', fontWeight: 700 }}>{infoMessage}</p>}

      <section style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1rem', alignItems: 'start' }}>
        <aside style={{ border: '1px solid #ddd', borderRadius: 8, padding: '0.75rem' }}>
          <h2>Floorplans</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {floorplans.map((floorplan) => (
              <li key={floorplan.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                <span>{floorplan.name}</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setSelectedFloorplanId(floorplan.id)}>
                    Open
                  </button>
                  <button type="button" onClick={() => deleteFloorplan(floorplan)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <h3 style={{ marginTop: '1rem' }}>Floorplan erstellen</h3>
          <form onSubmit={createFloorplan} style={{ display: 'grid', gap: 8 }}>
            <input required value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Name" />
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

              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: '1rem', alignItems: 'start' }}>
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
                      title={`${desk.name}\nStatus: ${desk.status}${
                        desk.booking
                          ? `\nUser: ${desk.booking.userEmail}\nTyp: ${desk.booking.type === 'single' ? 'single' : 'recurring'}`
                          : ''
                      }`}
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
                        background: desk.status === 'booked' ? '#d32f2f' : '#2e7d32',
                        cursor: 'pointer'
                      }}
                    />
                  ))}
                </div>

                <aside style={{ border: '1px solid #ddd', borderRadius: 8, padding: '0.75rem' }}>
                  <h3 style={{ marginTop: 0 }}>Im Büro am {selectedDate}</h3>
                  <p style={{ marginTop: 0 }}>Anzahl: {peopleInOffice.length}</p>
                  {peopleInOffice.length === 0 ? (
                    <p>Niemand eingetragen.</p>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', paddingBottom: 6 }}>User Email</th>
                        </tr>
                      </thead>
                      <tbody>
                        {peopleInOffice.map((person) => (
                          <tr key={person.userEmail}>
                            <td style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>{person.userEmail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </aside>
              </div>

              {selectedDesk && (
                <div style={{ marginTop: '1rem', borderTop: '1px solid #ddd', paddingTop: '0.75rem' }}>
                  <h3>Desk: {selectedDesk.name}</h3>
                  <p style={{ marginTop: 0 }}>
                    Status am {selectedDate}: <strong>{selectedDesk.status}</strong>
                    {selectedDesk.booking && (
                      <>
                        {' '}
                        – {selectedDesk.booking.userEmail} ({selectedDesk.booking.type})
                      </>
                    )}
                  </p>

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
                    <input style={{ marginLeft: 8 }} value={userEmail} onChange={(event) => setUserEmail(event.target.value)} />
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
                </div>
              )}
            </>
          )}
        </section>
      </section>
    </main>
  );
}
