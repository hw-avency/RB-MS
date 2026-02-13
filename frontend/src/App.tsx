import { FormEvent, MouseEvent, useEffect, useMemo, useState } from 'react';
import { API_BASE, ApiError, del, get, patch, post } from './api';

type Floorplan = { id: string; name: string; imageUrl: string; createdAt: string };
type OccupancyDesk = {
  id: string;
  name: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { userEmail: string; type: 'single' | 'recurring' } | null;
};
type OccupancyResponse = { date: string; floorplanId: string; desks: OccupancyDesk[]; people: { userEmail: string }[] };
type AdminBooking = {
  id: string;
  deskId: string;
  userEmail: string;
  date: string;
  desk: { id: string; name: string; floorplanId: string };
};
type AdminRecurringBooking = {
  id: string;
  userEmail: string;
  weekday: number;
  validFrom: string;
  validTo: string | null;
  desk: { id: string; name: string; floorplanId: string };
};

const today = new Date().toISOString().slice(0, 10);
const weekdays = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export function App() {
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState('');
  const [selectedFloorplan, setSelectedFloorplan] = useState<Floorplan | null>(null);
  const [selectedDate, setSelectedDate] = useState(today);
  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [selectedDeskId, setSelectedDeskId] = useState('');

  const [userEmail, setUserEmail] = useState('demo@example.com');
  const [singleDate, setSingleDate] = useState(today);
  const [errorMessage, setErrorMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');

  const [adminToken, setAdminToken] = useState(localStorage.getItem('adminToken') ?? '');
  const isAdminMode = !!adminToken;
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminEmail, setAdminEmail] = useState('admin@example.com');
  const [adminPassword, setAdminPassword] = useState('');
  const [addDeskMode, setAddDeskMode] = useState(false);

  const [createName, setCreateName] = useState('');
  const [createImageUrl, setCreateImageUrl] = useState('');
  const [deleteCandidate, setDeleteCandidate] = useState<Floorplan | null>(null);

  const [adminBookings, setAdminBookings] = useState<AdminBooking[]>([]);
  const [adminRecurring, setAdminRecurring] = useState<AdminRecurringBooking[]>([]);
  const [editingBookingId, setEditingBookingId] = useState('');
  const [editBookingEmail, setEditBookingEmail] = useState('');
  const [editBookingDate, setEditBookingDate] = useState('');

  const adminHeaders = useMemo(() => (adminToken ? { Authorization: `Bearer ${adminToken}` } : undefined), [adminToken]);
  const desks = occupancy?.desks ?? [];
  const selectedDesk = useMemo(() => desks.find((desk) => desk.id === selectedDeskId) ?? null, [desks, selectedDeskId]);
  const people = occupancy?.people ?? [];

  const handleApiError = (error: unknown) => {
    if (error instanceof ApiError) {
      setErrorMessage(error.message);
      if (error.status === 401) {
        localStorage.removeItem('adminToken');
        setAdminToken('');
      }
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

  const loadOccupancy = async (floorplanId: string, date: string) => {
    try {
      const [floorplan, occupancyData] = await Promise.all([
        get<Floorplan>(`/floorplans/${floorplanId}`),
        get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`)
      ]);
      setSelectedFloorplan(floorplan);
      setOccupancy(occupancyData);
      setSelectedDeskId((prev) => (occupancyData.desks.some((desk) => desk.id === prev) ? prev : ''));
    } catch (error) {
      handleApiError(error);
    }
  };

  const loadAdminLists = async () => {
    if (!adminHeaders) return;
    try {
      const [bookings, recurring] = await Promise.all([
        get<AdminBooking[]>(`/admin/bookings?date=${selectedDate}${selectedFloorplanId ? `&floorplanId=${selectedFloorplanId}` : ''}`, adminHeaders),
        get<AdminRecurringBooking[]>(`/admin/recurring-bookings${selectedFloorplanId ? `?floorplanId=${selectedFloorplanId}` : ''}`, adminHeaders)
      ]);
      setAdminBookings(bookings);
      setAdminRecurring(recurring);
    } catch (error) {
      handleApiError(error);
    }
  };

  useEffect(() => {
    document.title = 'AVENCY Booking';
    loadFloorplans();
  }, []);

  useEffect(() => {
    if (selectedFloorplanId) {
      loadOccupancy(selectedFloorplanId, selectedDate);
    }
  }, [selectedFloorplanId, selectedDate]);

  useEffect(() => {
    if (isAdminMode) {
      loadAdminLists();
    } else {
      setAdminBookings([]);
      setAdminRecurring([]);
    }
  }, [isAdminMode, selectedDate, selectedFloorplanId]);

  const loginAdmin = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage('');
    try {
      const data = await post<{ token: string }>('/admin/login', { email: adminEmail, password: adminPassword });
      localStorage.setItem('adminToken', data.token);
      setAdminToken(data.token);
      setShowAdminLogin(false);
      setAdminPassword('');
      setInfoMessage('Admin Mode aktiviert.');
    } catch (error) {
      handleApiError(error);
    }
  };

  const logoutAdmin = () => {
    localStorage.removeItem('adminToken');
    setAdminToken('');
    setAddDeskMode(false);
    setInfoMessage('Zurück im Booking Mode.');
  };

  const createFloorplan = async (event: FormEvent) => {
    event.preventDefault();
    if (!adminHeaders) return;
    try {
      const created = await post<Floorplan>('/admin/floorplans', { name: createName, imageUrl: createImageUrl }, adminHeaders);
      setCreateName('');
      setCreateImageUrl('');
      await loadFloorplans();
      setSelectedFloorplanId(created.id);
    } catch (error) {
      handleApiError(error);
    }
  };

  const deleteFloorplan = async (id: string) => {
    if (!adminHeaders) return;
    try {
      await del(`/admin/floorplans/${id}`, adminHeaders);
      setDeleteCandidate(null);
      await loadFloorplans();
      if (selectedFloorplanId === id) {
        setSelectedFloorplanId('');
        setSelectedFloorplan(null);
        setOccupancy(null);
      }
    } catch (error) {
      handleApiError(error);
    }
  };

  const createDeskAtPosition = async (event: MouseEvent<HTMLDivElement>) => {
    if (!adminHeaders || !addDeskMode || !selectedFloorplan) return;
    const target = event.target as HTMLElement;
    if (target.dataset.pin === 'desk-pin') return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const name = window.prompt('Desk-Name', `Desk ${desks.length + 1}`) || `Desk ${desks.length + 1}`;

    try {
      await post(`/admin/floorplans/${selectedFloorplan.id}/desks`, { name, x, y }, adminHeaders);
      await loadOccupancy(selectedFloorplan.id, selectedDate);
    } catch (error) {
      handleApiError(error);
    }
  };

  const deleteDesk = async () => {
    if (!adminHeaders || !selectedDesk) return;
    try {
      await del(`/admin/desks/${selectedDesk.id}`, adminHeaders);
      await loadOccupancy(selectedFloorplanId, selectedDate);
      setSelectedDeskId('');
    } catch (error) {
      handleApiError(error);
    }
  };

  const createSingleBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedDesk || selectedDesk.status !== 'free') return;
    try {
      await post('/bookings', { deskId: selectedDesk.id, userEmail, date: singleDate });
      await loadOccupancy(selectedFloorplanId, selectedDate);
      if (isAdminMode) await loadAdminLists();
      setInfoMessage('Buchung erstellt.');
    } catch (error) {
      handleApiError(error);
    }
  };

  const deleteAdminBooking = async (id: string) => {
    if (!adminHeaders) return;
    try {
      await del(`/admin/bookings/${id}`, adminHeaders);
      await Promise.all([loadOccupancy(selectedFloorplanId, selectedDate), loadAdminLists()]);
    } catch (error) {
      handleApiError(error);
    }
  };

  const saveAdminBooking = async (id: string) => {
    if (!adminHeaders) return;
    try {
      await patch(`/admin/bookings/${id}`, { userEmail: editBookingEmail || undefined, date: editBookingDate || undefined }, adminHeaders);
      setEditingBookingId('');
      await Promise.all([loadOccupancy(selectedFloorplanId, selectedDate), loadAdminLists()]);
    } catch (error) {
      handleApiError(error);
    }
  };

  const deleteAdminRecurring = async (id: string) => {
    if (!adminHeaders) return;
    try {
      await del(`/admin/recurring-bookings/${id}`, adminHeaders);
      await Promise.all([loadOccupancy(selectedFloorplanId, selectedDate), loadAdminLists()]);
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
            <h1>AVENCY Booking</h1>
          </div>
          <div className="topbar-controls">
            <label className="field">
              <span>Datum</span>
              <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
            </label>
            {isAdminMode ? (
              <>
                <span className="status status-connected">Admin Mode</span>
                <button className="btn btn-secondary" onClick={logoutAdmin}>Logout</button>
              </>
            ) : (
              <button className="btn btn-secondary" onClick={() => setShowAdminLogin(true)}>Admin</button>
            )}
          </div>
        </header>

        {!!errorMessage && <p className="toast toast-error">{errorMessage}</p>}
        {!!infoMessage && <p className="toast toast-success">{infoMessage}</p>}

        <section className="layout-grid">
          <aside className="card sidebar">
            <h2>Floorplans</h2>
            <ul className="floorplan-list">
              {floorplans.map((floorplan) => (
                <li key={floorplan.id} className={`floorplan-item ${selectedFloorplanId === floorplan.id ? 'active' : ''}`}>
                  <button className="linkish" onClick={() => setSelectedFloorplanId(floorplan.id)}>{floorplan.name}</button>
                  {isAdminMode && <button className="btn btn-danger" onClick={() => setDeleteCandidate(floorplan)}>Löschen</button>}
                </li>
              ))}
            </ul>
            {isAdminMode && (
              <form onSubmit={createFloorplan} className="form-grid">
                <h3>Floorplan erstellen</h3>
                <input required placeholder="Name" value={createName} onChange={(e) => setCreateName(e.target.value)} />
                <input required placeholder="Image URL" value={createImageUrl} onChange={(e) => setCreateImageUrl(e.target.value)} />
                <button className="btn btn-primary" type="submit">Erstellen</button>
              </form>
            )}
          </aside>

          <section className="card canvas-card">
            {!selectedFloorplan ? <p>Kein Floorplan ausgewählt.</p> : (
              <>
                <h2>{selectedFloorplan.name}</h2>
                <p className="muted">{isAdminMode && addDeskMode ? 'Klick auf Bild, um Desk hinzuzufügen.' : 'Desk auswählen, um Details zu sehen.'}</p>
                {isAdminMode && <button className="btn btn-secondary" onClick={() => setAddDeskMode((v) => !v)}>{addDeskMode ? 'Desk hinzufügen beenden' : 'Desk hinzufügen'}</button>}
                <div onClick={createDeskAtPosition} className="floorplan-canvas" role="presentation">
                  <img src={selectedFloorplan.imageUrl} alt={selectedFloorplan.name} />
                  {desks.map((desk) => (
                    <button
                      key={desk.id}
                      data-pin="desk-pin"
                      type="button"
                      className={`desk-pin ${desk.status} ${selectedDeskId === desk.id ? 'selected' : ''}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedDeskId(desk.id);
                      }}
                      style={{ left: `${desk.x * 100}%`, top: `${desk.y * 100}%` }}
                      title={`${desk.name} - ${desk.status === 'free' ? 'frei' : `belegt durch ${desk.booking?.userEmail}`}`}
                    />
                  ))}
                </div>
                {isAdminMode && selectedDesk && <button className="btn btn-danger" onClick={deleteDesk}>Delete desk</button>}
              </>
            )}
          </section>

          <aside className="right-panel">
            <section className="card">
              <h3>Im Büro am {selectedDate}</h3>
              <table><tbody>{people.map((p) => <tr key={p.userEmail}><td>{p.userEmail}</td></tr>)}</tbody></table>
            </section>
            <section className="card">
              <h3>Booking</h3>
              {!selectedDesk ? <p className="muted">Wähle einen Desk.</p> : (
                <>
                  <p className="desk-title">{selectedDesk.name}</p>
                  <p className="muted">Status: {selectedDesk.status === 'free' ? 'Frei' : `Belegt von ${selectedDesk.booking?.userEmail}`}</p>
                  {selectedDesk.status === 'free' ? (
                    <form onSubmit={createSingleBooking} className="form-grid">
                      <input value={userEmail} onChange={(e) => setUserEmail(e.target.value)} placeholder="E-Mail" />
                      <input type="date" value={singleDate} onChange={(e) => setSingleDate(e.target.value)} />
                      <button className="btn btn-primary" type="submit">Buchen</button>
                    </form>
                  ) : <p className="muted">In Booking Mode nur read-only für belegte Desks.</p>}
                </>
              )}
            </section>

            {isAdminMode && (
              <section className="card">
                <h3>Buchungen am {selectedDate}</h3>
                {adminBookings.map((booking) => (
                  <div key={booking.id} className="admin-row">
                    <strong>{booking.desk.name}</strong> · {booking.userEmail}
                    {editingBookingId === booking.id ? (
                      <div className="form-grid">
                        <input value={editBookingEmail} onChange={(e) => setEditBookingEmail(e.target.value)} placeholder="userEmail" />
                        <input type="date" value={editBookingDate} onChange={(e) => setEditBookingDate(e.target.value)} />
                        <button className="btn btn-primary" onClick={() => saveAdminBooking(booking.id)}>Speichern</button>
                      </div>
                    ) : (
                      <button className="btn btn-secondary" onClick={() => { setEditingBookingId(booking.id); setEditBookingEmail(booking.userEmail); setEditBookingDate(booking.date.slice(0,10)); }}>Edit</button>
                    )}
                    <button className="btn btn-danger" onClick={() => deleteAdminBooking(booking.id)}>Delete</button>
                  </div>
                ))}

                <h3>Recurring bookings</h3>
                {adminRecurring.map((booking) => (
                  <div key={booking.id} className="admin-row">
                    <span>{booking.desk.name}: {booking.userEmail} · {weekdays[booking.weekday]}</span>
                    <button className="btn btn-danger" onClick={() => deleteAdminRecurring(booking.id)}>Delete</button>
                  </div>
                ))}
              </section>
            )}
          </aside>
        </section>

        <p className="api-base">API: {API_BASE}</p>
      </div>

      {showAdminLogin && (
        <div className="modal-backdrop">
          <div className="modal card">
            <h3>Admin Login</h3>
            <form onSubmit={loginAdmin} className="form-grid">
              <input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="Email" />
              <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Passwort" />
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAdminLogin(false)}>Abbrechen</button>
                <button className="btn btn-primary" type="submit">Login</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteCandidate && (
        <div className="modal-backdrop">
          <div className="modal card">
            <h3>Floorplan löschen?</h3>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeleteCandidate(null)}>Abbrechen</button>
              <button className="btn btn-danger" onClick={() => deleteFloorplan(deleteCandidate.id)}>Löschen</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
