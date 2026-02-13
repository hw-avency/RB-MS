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
type ApiStatus = 'connecting' | 'connected' | 'error';

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

const dayName = (value: number) => WEEKDAYS.find((d) => d.value === value)?.label ?? 'Unbekannt';

function getTomorrow(base: string) {
  const date = new Date(`${base}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return toISODate(date);
}

function getNextMonday(base: string) {
  const date = new Date(`${base}T00:00:00`);
  const current = date.getDay();
  const delta = ((1 - current + 7) % 7) || 7;
  date.setDate(date.getDate() + delta);
  return toISODate(date);
}

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
  const [showCreateFloorplan, setShowCreateFloorplan] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Floorplan | null>(null);

  const [singleDate, setSingleDate] = useState(toISODate(today));
  const [weekday, setWeekday] = useState<number>(1);
  const [validFrom, setValidFrom] = useState(toISODate(today));
  const [validTo, setValidTo] = useState('');

  const [me, setMe] = useState<Me | null>(null);
  const [userEmail, setUserEmail] = useState('demo@example.com');

  const [apiStatus, setApiStatus] = useState<ApiStatus>('connecting');
  const [isLoadingFloorplans, setIsLoadingFloorplans] = useState(false);
  const [isLoadingOccupancy, setIsLoadingOccupancy] = useState(false);

  const [errorMessage, setErrorMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');

  const desks = occupancy?.desks ?? [];
  const peopleInOffice = useMemo(
    () =>
      [...new Set((occupancy?.people ?? []).map((person) => person.userEmail))]
        .sort((a, b) => a.localeCompare(b))
        .map((userEmail) => ({ userEmail })),
    [occupancy]
  );
  const selectedDesk = useMemo(() => desks.find((desk) => desk.id === selectedDeskId) ?? null, [desks, selectedDeskId]);

  useEffect(() => {
    setSingleDate(selectedDate);
  }, [selectedDate]);

  const handleApiError = (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 409) {
        setErrorMessage('Dieser Platz ist für die gewählte Zeit bereits belegt. Bitte wähle eine andere Option.');
        return;
      }
      setErrorMessage(error.message);
      return;
    }
    setErrorMessage('Netzwerkfehler beim Laden der Daten.');
  };

  const loadFloorplans = async () => {
    setIsLoadingFloorplans(true);
    try {
      const data = await get<Floorplan[]>('/floorplans');
      setFloorplans(data);
      setApiStatus('connected');
    } catch (error) {
      setApiStatus('error');
      handleApiError(error);
    } finally {
      setIsLoadingFloorplans(false);
    }
  };

  const loadFloorplanAndOccupancy = async (floorplanId: string, date: string) => {
    setIsLoadingOccupancy(true);
    try {
      const [floorplan, occupancyData] = await Promise.all([
        get<Floorplan>(`/floorplans/${floorplanId}`),
        get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`)
      ]);
      setSelectedFloorplan(floorplan);
      setOccupancy(occupancyData);
      setApiStatus('connected');
      setSelectedDeskId((currentDeskId) =>
        occupancyData.desks.some((desk) => desk.id === currentDeskId) ? currentDeskId : ''
      );
    } catch (error) {
      setApiStatus('error');
      handleApiError(error);
    } finally {
      setIsLoadingOccupancy(false);
    }
  };

  const refreshOccupancy = async () => {
    if (!selectedFloorplanId) {
      return;
    }

    setIsLoadingOccupancy(true);
    try {
      const occupancyData = await get<OccupancyResponse>(
        `/occupancy?floorplanId=${selectedFloorplanId}&date=${selectedDate}`
      );
      setOccupancy(occupancyData);
      setApiStatus('connected');
      setSelectedDeskId((currentDeskId) =>
        occupancyData.desks.some((desk) => desk.id === currentDeskId) ? currentDeskId : ''
      );
    } catch (error) {
      setApiStatus('error');
      handleApiError(error);
    } finally {
      setIsLoadingOccupancy(false);
    }
  };

  useEffect(() => {
    loadFloorplans();
    get<Me>('/me')
      .then((meData) => {
        setApiStatus('connected');
        setMe(meData);
        setUserEmail(meData.email || 'demo@example.com');
      })
      .catch(() => {
        setApiStatus('error');
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
    setErrorMessage('');
    setInfoMessage('');
    try {
      await del<void>(`/floorplans/${floorplan.id}`);
      setDeleteCandidate(null);
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
      setShowCreateFloorplan(false);
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
    <main className="app-shell">
      <div className="container">
        <header className="topbar card">
          <div>
            <p className="eyebrow">Desk Booking</p>
            <h1>RB-MS</h1>
            {me && <p className="muted">Angemeldet als {me.email}</p>}
          </div>
          <div className="topbar-controls">
            <label className="field">
              <span>Datum</span>
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </label>
            <div className={`status status-${apiStatus}`}>{apiStatus === 'connected' ? 'API connected' : apiStatus === 'error' ? 'API error' : 'API connecting'}</div>
          </div>
        </header>

        {!!errorMessage && <p className="toast toast-error">{errorMessage}</p>}
        {!!infoMessage && <p className="toast toast-success">{infoMessage}</p>}

        <section className="layout-grid">
          <aside className="card sidebar">
            <h2>Floorplans</h2>
            {isLoadingFloorplans ? (
              <p className="muted">Lade Floorplans…</p>
            ) : floorplans.length === 0 ? (
              <p className="muted">Noch kein Floorplan. Lege links einen an.</p>
            ) : (
              <ul className="floorplan-list">
                {floorplans.map((floorplan) => (
                  <li key={floorplan.id} className={`floorplan-item ${selectedFloorplanId === floorplan.id ? 'active' : ''}`}>
                    <span>{floorplan.name}</span>
                    <span className="actions">
                      <button type="button" className="btn btn-secondary" onClick={() => setSelectedFloorplanId(floorplan.id)}>
                        Öffnen
                      </button>
                      <button type="button" className="btn btn-danger" onClick={() => setDeleteCandidate(floorplan)}>
                        Löschen
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <button className="btn btn-secondary full" type="button" onClick={() => setShowCreateFloorplan((s) => !s)}>
              {showCreateFloorplan ? 'Formular schließen' : 'Create floorplan'}
            </button>

            {showCreateFloorplan && (
              <form onSubmit={createFloorplan} className="form-grid">
                <label className="field">
                  <span>Name</span>
                  <input required value={createName} onChange={(event) => setCreateName(event.target.value)} />
                </label>
                <label className="field">
                  <span>Image URL</span>
                  <input
                    required
                    value={createImageUrl}
                    onChange={(event) => setCreateImageUrl(event.target.value)}
                    placeholder="https://..."
                  />
                  <small>Direkter Link zum Floorplan-Bild.</small>
                </label>
                <button className="btn btn-primary" type="submit">
                  Erstellen
                </button>
              </form>
            )}
          </aside>

          <section className="card canvas-card">
            {!selectedFloorplan ? (
              <div className="empty-state">
                <h2>Kein Floorplan ausgewählt</h2>
                <p>Wähle links einen Floorplan aus, um Belegung und Desks zu sehen.</p>
              </div>
            ) : (
              <>
                <h2>{selectedFloorplan.name}</h2>
                <p className="muted">Klick auf freie Fläche, um einen neuen Desk-Pin zu setzen.</p>

                {isLoadingOccupancy ? <div className="skeleton">Belegung wird geladen…</div> : null}

                <div onClick={createDeskAtPosition} className="floorplan-canvas" role="presentation">
                  <img src={selectedFloorplan.imageUrl} alt={selectedFloorplan.name} />
                  {desks.map((desk) => (
                    <button
                      key={desk.id}
                      data-pin="desk-pin"
                      type="button"
                      className={`desk-pin ${desk.status} ${selectedDeskId === desk.id ? 'selected' : ''}`}
                      title={`${desk.name}\nStatus: ${desk.status === 'booked' ? 'belegt' : 'frei'}${
                        desk.booking
                          ? `\nUser: ${desk.booking.userEmail}\nTyp: ${desk.booking.type === 'single' ? 'single' : 'recurring'}`
                          : ''
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedDeskId(desk.id);
                      }}
                      style={{ left: `${desk.x * 100}%`, top: `${desk.y * 100}%` }}
                    />
                  ))}
                </div>
              </>
            )}
          </section>

          <aside className="right-panel">
            <section className="card">
              <h3>Im Büro am {selectedDate}</h3>
              <p className="muted">{peopleInOffice.length} Personen</p>
              {peopleInOffice.length === 0 ? (
                <p className="muted">Für dieses Datum gibt es aktuell keine Buchung.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>E-Mail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peopleInOffice.map((person) => (
                      <tr key={person.userEmail}>
                        <td>{person.userEmail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card">
              <h3>Desk booking</h3>
              {!selectedDesk ? (
                <p className="muted">Wähle einen Desk-Pin, um Details und Buchung zu öffnen.</p>
              ) : (
                <>
                  <p className="desk-title">{selectedDesk.name}</p>
                  <p className="muted">
                    Status: <strong>{selectedDesk.status === 'booked' ? 'Belegt' : 'Frei'}</strong>
                    {selectedDesk.booking ? ` · ${selectedDesk.booking.userEmail} (${selectedDesk.booking.type})` : ''}
                  </p>

                  <div className="tabs">
                    <button className={`tab ${tab === 'single' ? 'active' : ''}`} type="button" onClick={() => setTab('single')}>
                      Einzeltag
                    </button>
                    <button
                      className={`tab ${tab === 'recurring' ? 'active' : ''}`}
                      type="button"
                      onClick={() => setTab('recurring')}
                    >
                      Wiederkehrend
                    </button>
                  </div>

                  <label className="field">
                    <span>E-Mail</span>
                    <input value={userEmail} onChange={(event) => setUserEmail(event.target.value)} />
                    <small>Vorausgefüllt aus /me, bei Bedarf anpassbar.</small>
                  </label>

                  {tab === 'single' && (
                    <form onSubmit={createSingleBooking} className="form-grid">
                      <label className="field">
                        <span>Datum</span>
                        <input type="date" value={singleDate} onChange={(event) => setSingleDate(event.target.value)} />
                      </label>
                      <div className="quick-actions">
                        <button type="button" className="btn btn-secondary" onClick={() => setSingleDate(toISODate(new Date()))}>
                          Heute
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setSingleDate(getTomorrow(selectedDate))}>
                          Morgen
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setSingleDate(getNextMonday(selectedDate))}>
                          Nächster Mo
                        </button>
                      </div>
                      <button type="submit" className="btn btn-primary">
                        Buchen
                      </button>
                    </form>
                  )}

                  {tab === 'recurring' && (
                    <form onSubmit={createRecurringBooking} className="form-grid">
                      <label className="field">
                        <span>Wochentag</span>
                        <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
                          {WEEKDAYS.map((day) => (
                            <option key={day.label} value={day.value}>
                              {day.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Valid from</span>
                        <input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
                      </label>
                      <label className="field">
                        <span>Valid to (optional)</span>
                        <input type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
                      </label>
                      <p className="muted summary">
                        Wiederkehrende Buchung jeden {dayName(weekday)} ab {validFrom}
                        {validTo ? ` bis ${validTo}` : ' ohne Enddatum'}.
                      </p>
                      <button type="submit" className="btn btn-primary">
                        Wiederkehrend buchen
                      </button>
                    </form>
                  )}
                </>
              )}
            </section>
          </aside>
        </section>

        <p className="api-base">API: {API_BASE}</p>
      </div>

      {deleteCandidate && (
        <div className="modal-backdrop">
          <div className="modal card">
            <h3>Floorplan löschen?</h3>
            <p>Willst du „{deleteCandidate.name}“ wirklich entfernen?</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setDeleteCandidate(null)}>
                Abbrechen
              </button>
              <button className="btn btn-danger" type="button" onClick={() => deleteFloorplan(deleteCandidate)}>
                Löschen
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
