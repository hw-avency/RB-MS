import { FormEvent, MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, del, get, patch, post } from './api';

type Floorplan = { id: string; name: string; imageUrl: string; createdAt: string };
type OccupancyDesk = {
  id: string;
  name: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { id?: string; userEmail: string; userDisplayName?: string; deskName?: string; type: 'single' | 'recurring' } | null;
};
type OccupancyPerson = { email: string; userEmail: string; displayName?: string; deskName?: string };
type OccupancyResponse = { date: string; floorplanId: string; desks: OccupancyDesk[]; people: OccupancyPerson[] };
type Employee = { id: string; email: string; displayName: string; isActive: boolean };
type BookingEmployee = { id: string; email: string; displayName: string };
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
type MeResponse = { email: string };

const today = new Date().toISOString().slice(0, 10);
const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

const toDateKey = (value: Date): string => value.toISOString().slice(0, 10);
const monthLabel = (monthStart: Date): string =>
  monthStart.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

const startOfMonth = (dateString: string): Date => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
};

const buildCalendarDays = (monthStart: Date): Date[] => {
  const firstWeekday = (monthStart.getUTCDay() + 6) % 7;
  const gridStart = new Date(monthStart);
  gridStart.setUTCDate(1 - firstWeekday);

  return Array.from({ length: 42 }).map((_, index) => {
    const day = new Date(gridStart);
    day.setUTCDate(gridStart.getUTCDate() + index);
    return day;
  });
};

export function App() {
  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(today));
  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [activeDeskId, setActiveDeskId] = useState('');
  const [popupAnchor, setPopupAnchor] = useState<{ left: number; top: number } | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number } | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const [meEmail, setMeEmail] = useState('demo@example.com');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployeeEmail, setSelectedEmployeeEmail] = useState('');
  const [manualBookingEmail, setManualBookingEmail] = useState('demo@example.com');
  const [errorMessage, setErrorMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');

  const [adminToken, setAdminToken] = useState(localStorage.getItem('adminToken') ?? '');
  const isAdminMode = !!adminToken;
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminEmail, setAdminEmail] = useState('admin@example.com');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminTab, setAdminTab] = useState<'floorplans' | 'desks' | 'bookings' | 'employees'>('floorplans');

  const [createName, setCreateName] = useState('');
  const [createImageUrl, setCreateImageUrl] = useState('');
  const [floorplanActionMessage, setFloorplanActionMessage] = useState('');
  const [floorplanNameInput, setFloorplanNameInput] = useState('');
  const [floorplanImageInput, setFloorplanImageInput] = useState('');
  const [deskNameInput, setDeskNameInput] = useState('');
  const [deskActionMessage, setDeskActionMessage] = useState('');

  const [adminBookings, setAdminBookings] = useState<AdminBooking[]>([]);
  const [adminRecurring, setAdminRecurring] = useState<AdminRecurringBooking[]>([]);
  const [newEmployeeEmail, setNewEmployeeEmail] = useState('');
  const [newEmployeeDisplayName, setNewEmployeeDisplayName] = useState('');
  const [employeeActionMessage, setEmployeeActionMessage] = useState('');
  const [employeeErrorMessage, setEmployeeErrorMessage] = useState('');
  const [editingEmployeeId, setEditingEmployeeId] = useState('');
  const [editingEmployeeName, setEditingEmployeeName] = useState('');
  const [editingBookingId, setEditingBookingId] = useState('');
  const [editBookingEmail, setEditBookingEmail] = useState('');
  const [editBookingDate, setEditBookingDate] = useState('');

  const adminHeaders = useMemo(() => (adminToken ? { Authorization: `Bearer ${adminToken}` } : undefined), [adminToken]);
  const selectedFloorplan = useMemo(
    () => floorplans.find((floorplan) => floorplan.id === selectedFloorplanId) ?? null,
    [floorplans, selectedFloorplanId]
  );
  const desks = occupancy?.desks ?? [];
  const activeDesk = useMemo(() => desks.find((desk) => desk.id === activeDeskId) ?? null, [desks, activeDeskId]);
  const activeEmployees = useMemo(() => employees.filter((employee) => employee.isActive), [employees]);
  const people = useMemo(() => {
    const source = occupancy?.people ?? [];
    return [...source].sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email, 'de'));
  }, [occupancy]);
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);

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

  const handleEmployeeError = (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 409) {
        setEmployeeErrorMessage('Diese E-Mail ist bereits vorhanden.');
        return;
      }

      if (error.status === 400) {
        setEmployeeErrorMessage(error.message);
        return;
      }
    }

    setEmployeeErrorMessage('Mitarbeiter-Aktion fehlgeschlagen. Bitte erneut versuchen.');
  };

  const loadFloorplans = async () => {
    try {
      const data = await get<Floorplan[]>('/floorplans');
      setFloorplans(data);
      setSelectedFloorplanId((prev) => prev || data[0]?.id || '');
    } catch (error) {
      handleApiError(error);
    }
  };

  const loadMe = async () => {
    try {
      const me = await get<MeResponse>('/me');
      if (me.email) {
        setMeEmail(me.email);
        setManualBookingEmail(me.email);
      }
    } catch {
      // ignore /me failures and keep default
    }
  };

  const loadEmployees = async () => {
    try {
      const data = adminHeaders
        ? await get<Employee[]>('/admin/employees', adminHeaders)
        : (await get<BookingEmployee[]>('/employees')).map((employee) => ({ ...employee, isActive: true }));
      setEmployees(data);
    } catch (error) {
      handleApiError(error);
    }
  };

  const loadOccupancy = async (floorplanId: string, date: string) => {
    try {
      const occupancyData = await get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`);
      setOccupancy(occupancyData);
      setActiveDeskId((prev) => (occupancyData.desks.some((desk) => desk.id === prev) ? prev : ''));
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
    loadMe();
    loadEmployees();
  }, []);

  useEffect(() => {
    if (!activeEmployees.length) {
      setSelectedEmployeeEmail('');
      return;
    }

    const meEmailNormalized = meEmail.toLowerCase();
    const meMatch = activeEmployees.find((employee) => employee.email.toLowerCase() === meEmailNormalized)?.email;
    setSelectedEmployeeEmail((prev) => {
      if (prev && activeEmployees.some((employee) => employee.email === prev)) {
        return prev;
      }

      return meMatch ?? activeEmployees[0]?.email ?? '';
    });
  }, [activeEmployees, meEmail]);

  useEffect(() => {
    if (selectedFloorplanId) {
      loadOccupancy(selectedFloorplanId, selectedDate);
    }
  }, [selectedFloorplanId, selectedDate]);

  useEffect(() => {
    setActiveDeskId('');
    setPopupAnchor(null);
    setPopupPosition(null);
  }, [selectedDate, selectedFloorplanId]);

  useLayoutEffect(() => {
    if (!popupAnchor || !popupRef.current) {
      setPopupPosition(popupAnchor);
      return;
    }
    const margin = 10;
    const { width, height } = popupRef.current.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - margin;
    const maxTop = window.innerHeight - height - margin;
    setPopupPosition({
      left: Math.min(Math.max(popupAnchor.left, margin), Math.max(maxLeft, margin)),
      top: Math.min(Math.max(popupAnchor.top, margin), Math.max(maxTop, margin))
    });
  }, [popupAnchor, activeDeskId]);

  useEffect(() => {
    if (!activeDeskId) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveDeskId('');
        setPopupAnchor(null);
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [activeDeskId]);

  useEffect(() => {
    if (isAdminMode) {
      loadAdminLists();
      loadEmployees();
    } else {
      setAdminBookings([]);
      setAdminRecurring([]);
      loadEmployees();
    }
  }, [isAdminMode, selectedDate, selectedFloorplanId]);

  useEffect(() => {
    setDeskNameInput(activeDesk?.name ?? '');
    setDeskActionMessage('');
  }, [activeDesk?.id]);

  useEffect(() => {
    setFloorplanNameInput(selectedFloorplan?.name ?? '');
    setFloorplanImageInput(selectedFloorplan?.imageUrl ?? '');
    setFloorplanActionMessage('');
  }, [selectedFloorplan?.id]);

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

  const saveFloorplan = async (event: FormEvent) => {
    event.preventDefault();
    if (!adminHeaders || !selectedFloorplan) return;
    try {
      await patch(`/admin/floorplans/${selectedFloorplan.id}`, { name: floorplanNameInput, imageUrl: floorplanImageInput }, adminHeaders);
      await loadFloorplans();
      setFloorplanActionMessage('Floorplan gespeichert.');
    } catch (error) {
      handleApiError(error);
    }
  };

  const deleteFloorplan = async (id: string) => {
    if (!adminHeaders) return;
    try {
      await del(`/admin/floorplans/${id}`, adminHeaders);
      await loadFloorplans();
      if (selectedFloorplanId === id) {
        setSelectedFloorplanId('');
        setOccupancy(null);
      }
    } catch (error) {
      handleApiError(error);
    }
  };

  const createDeskAtPosition = async (event: MouseEvent<HTMLDivElement>) => {
    if (!adminHeaders || !selectedFloorplan || adminTab !== 'desks') return;
    const target = event.target as HTMLElement;
    if (target.dataset.pin === 'desk-pin') return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const name = `Desk ${desks.length + 1}`;

    try {
      await post(`/admin/floorplans/${selectedFloorplan.id}/desks`, { name, x, y }, adminHeaders);
      await loadOccupancy(selectedFloorplan.id, selectedDate);
    } catch (error) {
      handleApiError(error);
    }
  };

  const deleteDesk = async () => {
    if (!adminHeaders || !activeDesk) return;
    try {
      await del(`/admin/desks/${activeDesk.id}`, adminHeaders);
      await loadOccupancy(selectedFloorplanId, selectedDate);
      setActiveDeskId('');
    } catch (error) {
      handleApiError(error);
    }
  };

  const renameDesk = async (event: FormEvent) => {
    event.preventDefault();
    if (!adminHeaders || !activeDesk) return;
    try {
      await patch(`/admin/desks/${activeDesk.id}`, { name: deskNameInput }, adminHeaders);
      await Promise.all([loadOccupancy(selectedFloorplanId, selectedDate), loadAdminLists()]);
      setDeskActionMessage('Desk umbenannt.');
    } catch (error) {
      handleApiError(error);
    }
  };

  const createSingleBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeDesk || activeDesk.status !== 'free') return;

    const bookingEmail = activeEmployees.length ? selectedEmployeeEmail : manualBookingEmail.trim();
    if (!bookingEmail) {
      setErrorMessage('Bitte E-Mail für die Buchung angeben.');
      return;
    }

    try {
      await post('/bookings', { deskId: activeDesk.id, userEmail: bookingEmail, date: selectedDate });
      setActiveDeskId('');
      setPopupAnchor(null);
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

  const addEmployee = async (event: FormEvent) => {
    event.preventDefault();
    if (!adminHeaders) return;
    setEmployeeErrorMessage('');

    try {
      await post('/admin/employees', { email: newEmployeeEmail, displayName: newEmployeeDisplayName }, adminHeaders);
      setNewEmployeeEmail('');
      setNewEmployeeDisplayName('');
      setEmployeeActionMessage('Mitarbeiter hinzugefügt.');
      await loadEmployees();
    } catch (error) {
      handleEmployeeError(error);
    }
  };

  const saveEmployeeName = async (id: string) => {
    if (!adminHeaders) return;
    setEmployeeErrorMessage('');

    try {
      await patch(`/admin/employees/${id}`, { displayName: editingEmployeeName }, adminHeaders);
      setEditingEmployeeId('');
      setEditingEmployeeName('');
      setEmployeeActionMessage('Mitarbeiter aktualisiert.');
      await loadEmployees();
    } catch (error) {
      handleEmployeeError(error);
    }
  };

  const toggleEmployee = async (employee: Employee) => {
    if (!adminHeaders) return;
    setEmployeeErrorMessage('');

    try {
      await patch(`/admin/employees/${employee.id}`, { isActive: !employee.isActive }, adminHeaders);
      setEmployeeActionMessage(employee.isActive ? 'Mitarbeiter deaktiviert.' : 'Mitarbeiter aktiviert.');
      await loadEmployees();
    } catch (error) {
      handleEmployeeError(error);
    }
  };

  const selectDay = (day: Date) => {
    const dayKey = toDateKey(day);
    setSelectedDate(dayKey);
    setVisibleMonth(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
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

        {isAdminMode ? (
          <>
            <nav className="card admin-tabs">
              <button className={`tab-btn ${adminTab === 'floorplans' ? 'active' : ''}`} onClick={() => setAdminTab('floorplans')}>Floorplans</button>
              <button className={`tab-btn ${adminTab === 'desks' ? 'active' : ''}`} onClick={() => setAdminTab('desks')}>Desks</button>
              <button className={`tab-btn ${adminTab === 'bookings' ? 'active' : ''}`} onClick={() => setAdminTab('bookings')}>Buchungen</button>
              <button className={`tab-btn ${adminTab === 'employees' ? 'active' : ''}`} onClick={() => setAdminTab('employees')}>Mitarbeiter</button>
            </nav>
            <section className="layout-grid admin-editor-layout">
              <aside className="card sidebar">
                {adminTab === 'floorplans' && (
                  <div className="form-grid">
                    <h3>Floorplan list</h3>
                    <ul className="floorplan-list">
                      {floorplans.map((floorplan) => (
                        <li key={floorplan.id} className={`floorplan-item ${selectedFloorplanId === floorplan.id ? 'active' : ''}`}>
                          <button className="linkish" onClick={() => setSelectedFloorplanId(floorplan.id)}>{floorplan.name}</button>
                        </li>
                      ))}
                    </ul>
                    <form onSubmit={createFloorplan} className="form-grid">
                      <input required placeholder="Name" value={createName} onChange={(e) => setCreateName(e.target.value)} />
                      <input required placeholder="Image URL" value={createImageUrl} onChange={(e) => setCreateImageUrl(e.target.value)} />
                      <button className="btn btn-primary" type="submit">New floorplan</button>
                    </form>
                  </div>
                )}
                {(adminTab === 'desks' || adminTab === 'bookings') && (
                  <label className="field">
                    <span>Floorplan</span>
                    <select value={selectedFloorplanId} onChange={(e) => setSelectedFloorplanId(e.target.value)}>
                      <option value="">Bitte wählen</option>
                      {floorplans.map((floorplan) => (
                        <option key={floorplan.id} value={floorplan.id}>{floorplan.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {adminTab === 'bookings' && (
                  <label className="field">
                    <span>Datum</span>
                    <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
                  </label>
                )}
              </aside>

              <section className="card canvas-card">
                {!selectedFloorplan ? <p>Kein Floorplan ausgewählt.</p> : (
                  <>
                    <h2>{selectedFloorplan.name}</h2>
                    {adminTab === 'desks' && <p className="muted">Klick auf freie Fläche, um einen Desk anzulegen.</p>}
                    {(adminTab === 'floorplans' || adminTab === 'desks' || adminTab === 'bookings') && (
                      <div onClick={adminTab === 'desks' ? createDeskAtPosition : undefined} className="floorplan-canvas" role="presentation">
                        <img src={selectedFloorplan.imageUrl} alt={selectedFloorplan.name} />
                        {(adminTab === 'desks' || adminTab === 'bookings') && desks.map((desk) => (
                          <button
                            key={desk.id}
                            data-pin="desk-pin"
                            type="button"
                            className={`desk-pin ${desk.status} ${activeDeskId === desk.id ? 'selected' : ''}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setActiveDeskId(desk.id);
                            }}
                            style={{ left: `${desk.x * 100}%`, top: `${desk.y * 100}%` }}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </section>

              <aside className="card right-panel">
                {adminTab === 'floorplans' && (
                  !selectedFloorplan ? <p className="muted">Floorplan auswählen.</p> : (
                    <form onSubmit={saveFloorplan} className="form-grid">
                      <h3>Properties</h3>
                      {!!floorplanActionMessage && <p className="muted">{floorplanActionMessage}</p>}
                      <input value={floorplanNameInput} onChange={(e) => setFloorplanNameInput(e.target.value)} placeholder="name" />
                      <input value={floorplanImageInput} onChange={(e) => setFloorplanImageInput(e.target.value)} placeholder="imageUrl" />
                      <button className="btn btn-primary" type="submit">Save</button>
                      <button className="btn btn-danger" type="button" onClick={() => deleteFloorplan(selectedFloorplan.id)}>Delete</button>
                    </form>
                  )
                )}
                {adminTab === 'desks' && (
                  !activeDesk ? <p className="muted">Desk auswählen.</p> : (
                    <div className="form-grid">
                      <h3>Desk Properties</h3>
                      <form onSubmit={renameDesk} className="form-grid">
                        <input value={deskNameInput} onChange={(e) => setDeskNameInput(e.target.value)} placeholder="Desk name" />
                        <input readOnly value={activeDesk.x.toFixed(3)} />
                        <input readOnly value={activeDesk.y.toFixed(3)} />
                        <button className="btn btn-primary" type="submit">Save</button>
                      </form>
                      <button className="btn btn-danger" onClick={deleteDesk}>Delete</button>
                    </div>
                  )
                )}
                {adminTab === 'bookings' && (
                  <table>
                    <thead><tr><th>Desk</th><th>Employee</th><th>Type</th><th>Edit</th><th>Delete</th></tr></thead>
                    <tbody>
                      {adminBookings.map((booking) => (
                        <tr key={booking.id}>
                          <td>{booking.desk.name}</td>
                          <td>{booking.userEmail}</td>
                          <td>Single</td>
                          <td><button className="btn btn-secondary" onClick={() => { setEditingBookingId(booking.id); setEditBookingEmail(booking.userEmail); setEditBookingDate(booking.date.slice(0, 10)); saveAdminBooking(booking.id); }}>{editingBookingId === booking.id ? 'Save' : 'Edit'}</button></td>
                          <td><button className="btn btn-danger" onClick={() => deleteAdminBooking(booking.id)}>Delete</button></td>
                        </tr>
                      ))}
                      {adminRecurring.map((booking) => (
                        <tr key={booking.id}>
                          <td>{booking.desk.name}</td><td>{booking.userEmail}</td><td>Recurring</td><td>-</td>
                          <td><button className="btn btn-danger" onClick={() => deleteAdminRecurring(booking.id)}>Delete</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {adminTab === 'employees' && (
                  <div className="form-grid">
                    <form onSubmit={addEmployee} className="form-grid">
                      <input required placeholder="Name" value={newEmployeeDisplayName} onChange={(e) => setNewEmployeeDisplayName(e.target.value)} />
                      <input required placeholder="E-Mail" value={newEmployeeEmail} onChange={(e) => setNewEmployeeEmail(e.target.value)} />
                      <button className="btn btn-primary" type="submit">Mitarbeiter hinzufügen</button>
                    </form>
                    {!!employeeErrorMessage && <p className="toast toast-error">{employeeErrorMessage}</p>}
                    {!!employeeActionMessage && <p className="toast toast-success">{employeeActionMessage}</p>}
                    <table>
                      <thead><tr><th>Name</th><th>E-Mail</th><th>Status</th><th>Aktionen</th></tr></thead>
                      <tbody>
                        {employees.map((employee) => (
                          <tr key={employee.id}>
                            <td>{editingEmployeeId === employee.id ? <input value={editingEmployeeName} onChange={(e) => setEditingEmployeeName(e.target.value)} /> : employee.displayName}</td>
                            <td>{employee.email}</td>
                            <td>{employee.isActive ? 'Aktiv' : 'Inaktiv'}</td>
                            <td className="inline-actions">
                              {editingEmployeeId === employee.id ? (
                                <button className="btn btn-primary" onClick={() => saveEmployeeName(employee.id)}>Speichern</button>
                              ) : (
                                <button className="btn btn-secondary" onClick={() => { setEditingEmployeeId(employee.id); setEditingEmployeeName(employee.displayName); }}>Umbenennen</button>
                              )}
                              <button className="btn btn-secondary" onClick={() => toggleEmployee(employee)}>{employee.isActive ? 'Deaktivieren' : 'Aktivieren'}</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </aside>
            </section>
          </>
        ) : (
          <section className="layout-grid">
            <aside className="card sidebar sticky-sidebar">
              <section className="calendar-panel">
                <div className="calendar-header">
                  <button className="btn btn-secondary" onClick={() => setVisibleMonth((prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)))}>‹</button>
                  <strong>{monthLabel(visibleMonth)}</strong>
                  <button className="btn btn-secondary" onClick={() => setVisibleMonth((prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1)))}>›</button>
                </div>
                <button className="btn btn-primary full" onClick={() => selectDay(new Date())}>Heute</button>
                <div className="calendar-grid" role="grid" aria-label="Monatsansicht">
                  {weekdays.map((weekday) => <span key={weekday} className="weekday-label">{weekday}</span>)}
                  {calendarDays.map((day) => {
                    const dayKey = toDateKey(day);
                    const inVisibleMonth = day.getUTCMonth() === visibleMonth.getUTCMonth();
                    const isSelected = dayKey === selectedDate;
                    const isToday = dayKey === today;
                    return (
                      <button key={dayKey} className={`day-btn ${inVisibleMonth ? '' : 'outside'} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}`} onClick={() => selectDay(day)}>
                        {day.getUTCDate()}
                      </button>
                    );
                  })}
                </div>
              </section>
            </aside>
            <section className="card canvas-card">
              {!selectedFloorplan ? <p>Kein Floorplan ausgewählt.</p> : (
                <>
                  <h2>{selectedFloorplan.name}</h2>
                  <div className="floorplan-canvas" role="presentation">
                    <img src={selectedFloorplan.imageUrl} alt={selectedFloorplan.name} />
                    {desks.map((desk) => (
                      <button
                        key={desk.id}
                        data-pin="desk-pin"
                        type="button"
                        className={`desk-pin ${desk.status} ${activeDeskId === desk.id ? 'selected' : ''}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveDeskId(desk.id);
                          const rect = event.currentTarget.getBoundingClientRect();
                          setPopupAnchor({ left: rect.left + rect.width + 10, top: rect.top });
                        }}
                        style={{ left: `${desk.x * 100}%`, top: `${desk.y * 100}%` }}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
            <aside className="right-panel sticky-sidebar">
              <section className="card">
                <h3>Im Büro am {new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</h3>
                <p className="muted">{people.length} {people.length === 1 ? 'Person' : 'Personen'}</p>
                <ul className="people-list">
                  {people.map((person) => {
                    const fallbackName = person.email.split('@')[0] || person.email;
                    const primaryName = person.displayName?.trim() || fallbackName;
                    return (
                      <li key={`${person.email}-${person.deskName ?? 'none'}`} className="person-item">
                        <div>
                          <p className="person-primary">{primaryName}</p>
                          <p className="people-meta">{person.email}</p>
                        </div>
                        <p className="person-desk">{person.deskName ?? '—'}</p>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </aside>
          </section>
        )}

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

      {!isAdminMode && activeDesk && popupPosition && createPortal(
        <>
          <div className="booking-portal-backdrop" onClick={() => { setActiveDeskId(''); setPopupAnchor(null); }} />
          <div ref={popupRef} className="booking-overlay card" style={{ left: popupPosition.left, top: popupPosition.top }} onClick={(event) => event.stopPropagation()}>
            <h3>{activeDesk.name}</h3>
            <p className="muted">{selectedDate}</p>
            {activeDesk.status === 'free' ? (
              <form onSubmit={createSingleBooking} className="form-grid">
                <label className="field">
                  <span>Für wen buchen?</span>
                  {activeEmployees.length ? (
                    <select value={selectedEmployeeEmail} onChange={(e) => setSelectedEmployeeEmail(e.target.value)}>
                      {activeEmployees.map((employee) => (
                        <option key={employee.id} value={employee.email}>{employee.displayName} ({employee.email})</option>
                      ))}
                    </select>
                  ) : (
                    <input value={manualBookingEmail} onChange={(e) => setManualBookingEmail(e.target.value)} placeholder="E-Mail" />
                  )}
                </label>
                <button className="btn btn-primary" type="submit">Buchen</button>
              </form>
            ) : (
              <p className="muted">Gebucht von {activeDesk.booking?.userDisplayName ?? activeDesk.booking?.userEmail}</p>
            )}
            <button className="btn btn-secondary" onClick={() => { setActiveDeskId(''); setPopupAnchor(null); }}>Schließen</button>
          </div>
        </>,
        document.body
      )}
    </main>
  );
}
