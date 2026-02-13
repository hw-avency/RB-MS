import { FormEvent, MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE, ApiError, del, get, patch, post, setAuthTokenProvider } from './api';
import { entraScope, getActiveAccount, msalInstance } from './auth';
import microsoftLogo from './assets/microsoft.svg';

type Floorplan = { id: string; name: string; imageUrl: string; createdAt: string };
type OccupancyDesk = {
  id: string;
  name: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { id?: string; userEmail: string; userDisplayName?: string; deskName?: string; type: 'single' | 'recurring' } | null;
};
type OccupancyPerson = { email: string; userEmail: string; displayName?: string; deskName?: string; deskId?: string };
type OccupancyResponse = { date: string; floorplanId: string; desks: OccupancyDesk[]; people: OccupancyPerson[] };
type Employee = { id: string; email: string; displayName: string; isActive: boolean; isAdmin: boolean; photoBase64?: string | null };
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
type MeResponse = { employeeId: string; email: string; displayName: string; isAdmin: boolean; authProvider: 'breakglass' | 'entra'; isActive: boolean; photoBase64?: string | null; created?: boolean };
type BookingMode = 'single' | 'range' | 'series';
type BootstrapState = 'initializing' | 'backend_down' | 'unauthenticated' | 'authenticated';

const today = new Date().toISOString().slice(0, 10);
const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const jsToApiWeekday = [1, 2, 3, 4, 5, 6, 0];

const endOfYear = (date = new Date()): string => new Date(Date.UTC(date.getUTCFullYear(), 11, 31)).toISOString().slice(0, 10);

const countRangeDays = (from: string, to: string): number => {
  if (!from || !to) return 0;
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
};

const countRangeBookings = (from: string, to: string, weekdaysOnly: boolean): number => {
  if (!from || !to) return 0;
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;

  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (!weekdaysOnly || (day >= 1 && day <= 5)) {
      count += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return count;
};

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
  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');
  const [repositioningDeskId, setRepositioningDeskId] = useState('');
  const [popupAnchor, setPopupAnchor] = useState<{ left: number; top: number } | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number } | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const [me, setMe] = useState<MeResponse | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployeeEmail, setSelectedEmployeeEmail] = useState('');
  const [manualBookingEmail, setManualBookingEmail] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [bookingMode, setBookingMode] = useState<BookingMode>('single');
  const [rangeFrom, setRangeFrom] = useState(today);
  const [rangeTo, setRangeTo] = useState(today);
  const [rangeWeekdaysOnly, setRangeWeekdaysOnly] = useState(true);
  const [seriesWeekdays, setSeriesWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [seriesValidFrom, setSeriesValidFrom] = useState(today);
  const [seriesValidTo, setSeriesValidTo] = useState(endOfYear());
  const [bookingConflictDates, setBookingConflictDates] = useState<string[]>([]);

  const [breakglassToken, setBreakglassToken] = useState(localStorage.getItem('breakglassToken') ?? '');
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>('initializing');
  const [bootstrapError, setBootstrapError] = useState('');
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminEmail, setAdminEmail] = useState('admin@example.com');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminEmailError, setAdminEmailError] = useState('');
  const [adminPasswordError, setAdminPasswordError] = useState('');
  const [hasLoginAttempted, setHasLoginAttempted] = useState(false);
  const canAccessAdmin = me?.isAdmin === true;
  const [uiMode, setUiMode] = useState<'booking' | 'admin'>(() => (localStorage.getItem('uiMode') === 'admin' ? 'admin' : 'booking'));
  const isAdminMode = canAccessAdmin && uiMode === 'admin';
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
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [employeeSortKey, setEmployeeSortKey] = useState<'displayName' | 'email' | 'isActive' | 'isAdmin'>('displayName');
  const [employeeSortDirection, setEmployeeSortDirection] = useState<'asc' | 'desc'>('asc');
  const [employeePage, setEmployeePage] = useState(1);
  const [selectedAdminEmployeeId, setSelectedAdminEmployeeId] = useState('');
  const [editingEmployeeId, setEditingEmployeeId] = useState('');
  const [editingEmployeeName, setEditingEmployeeName] = useState('');
  const [editingBookingId, setEditingBookingId] = useState('');
  const [editBookingEmail, setEditBookingEmail] = useState('');
  const [editBookingDate, setEditBookingDate] = useState('');

  const adminHeaders = useMemo(() => (canAccessAdmin ? {} : undefined), [canAccessAdmin]);
  const selectedFloorplan = useMemo(
    () => floorplans.find((floorplan) => floorplan.id === selectedFloorplanId) ?? null,
    [floorplans, selectedFloorplanId]
  );
  const desks = occupancy?.desks ?? [];
  const activeDesk = useMemo(() => desks.find((desk) => desk.id === selectedDeskId) ?? null, [desks, selectedDeskId]);
  const activeEmployees = useMemo(() => employees.filter((employee) => employee.isActive), [employees]);
  const people = useMemo(() => {
    const source = occupancy?.people ?? [];
    return [...source].sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email, 'de'));
  }, [occupancy]);
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const isSeriesValid = seriesWeekdays.length > 0 && !!seriesValidFrom && !!seriesValidTo;
  const employeePageSize = 8;

  const filteredEmployees = useMemo(() => {
    const search = employeeSearch.trim().toLowerCase();
    const source = search
      ? employees.filter((employee) => (
        employee.displayName.toLowerCase().includes(search)
        || employee.email.toLowerCase().includes(search)
      ))
      : employees;

    return [...source].sort((a, b) => {
      if (employeeSortKey === 'isActive' || employeeSortKey === 'isAdmin') {
        const value = Number(a[employeeSortKey]) - Number(b[employeeSortKey]);
        if (value === 0) return a.displayName.localeCompare(b.displayName, 'de');
        return employeeSortDirection === 'asc' ? value : -value;
      }

      const value = a[employeeSortKey].localeCompare(b[employeeSortKey], 'de');
      return employeeSortDirection === 'asc' ? value : -value;
    });
  }, [employees, employeeSearch, employeeSortDirection, employeeSortKey]);

  const employeeTotalPages = Math.max(1, Math.ceil(filteredEmployees.length / employeePageSize));
  const pagedEmployees = useMemo(() => {
    const start = (employeePage - 1) * employeePageSize;
    return filteredEmployees.slice(start, start + employeePageSize);
  }, [employeePage, filteredEmployees]);
  const selectedAdminEmployee = useMemo(
    () => employees.find((employee) => employee.id === selectedAdminEmployeeId) ?? null,
    [employees, selectedAdminEmployeeId]
  );
  const activeAdminCount = useMemo(() => employees.filter((employee) => employee.isAdmin && employee.isActive).length, [employees]);

  const handleApiError = (error: unknown) => {
    if (error instanceof ApiError) {
      setErrorMessage(error.message);
      if (error.status === 401) {
        localStorage.removeItem('breakglassToken');
        setBreakglassToken('');
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
    const current = await get<MeResponse>('/me', undefined, 10000);
    setMe(current);
    setManualBookingEmail((prev) => prev || current.email);
    if (current.created) {
      setInfoMessage('Willkommen, Profil angelegt');
    }
  };

  const readEntraToken = (): string => localStorage.getItem('entraAccessToken') ?? '';

  const checkBackend = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${API_BASE}/health`, {
        method: 'GET',
        signal: controller.signal
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const toBootstrapError = (error: unknown): string => {
    if (error instanceof ApiError) {
      return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Unbekannter Fehler während der Anmeldung.';
  };

  const loadEmployees = async () => {
    try {
      const data = adminHeaders
        ? await get<Employee[]>('/admin/employees', adminHeaders)
        : (await get<BookingEmployee[]>('/employees')).map((employee) => ({ ...employee, isActive: true, isAdmin: false, photoBase64: null }));
      setEmployees(data);
    } catch (error) {
      handleApiError(error);
    }
  };

  const loadOccupancy = async (floorplanId: string, date: string) => {
    try {
      const occupancyData = await get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`);
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
    localStorage.setItem('uiMode', uiMode);
  }, [uiMode]);

  useEffect(() => {
    if (!canAccessAdmin && uiMode !== 'booking') {
      setUiMode('booking');
    }
  }, [canAccessAdmin, uiMode]);

  useEffect(() => {
    document.title = 'AVENCY Booking';

    setAuthTokenProvider(async () => {
      const breakglass = localStorage.getItem('breakglassToken');
      if (breakglass) return breakglass;

      return readEntraToken() || null;
    });

    let cancelled = false;
    let backendReachable = false;
    const watchdog = window.setTimeout(() => {
      if (cancelled) return;
      if (!backendReachable) {
        setBootstrapError(`Backend-Healthcheck fehlgeschlagen (${API_BASE}).`);
        setBootstrapState('backend_down');
      } else {
        setBootstrapError('Anmeldung hat zu lange gedauert. Bitte erneut anmelden.');
        setBootstrapState('unauthenticated');
        setHasLoginAttempted(true);
      }
    }, 8000);

    const bootstrap = async () => {
      const backendIsUp = await checkBackend();
      if (!backendIsUp) {
        if (!cancelled) {
          setBootstrapError(`Backend nicht erreichbar: ${API_BASE}`);
          setBootstrapState('backend_down');
        }
        return;
      }

      backendReachable = true;

      try {
        await msalInstance.initialize();
        const redirect = await msalInstance.handleRedirectPromise();
        if (redirect?.account) {
          msalInstance.setActiveAccount(redirect.account);
        } else {
          const account = getActiveAccount();
          if (account) msalInstance.setActiveAccount(account);
        }
      } catch (error) {
        if (!cancelled) {
          setBootstrapError(`Microsoft-Redirect fehlgeschlagen: ${toBootstrapError(error)}`);
          setBootstrapState('unauthenticated');
          setHasLoginAttempted(true);
        }
        return;
      }

      const breakglass = localStorage.getItem('breakglassToken');
      let tokenSource: 'breakglass' | 'entra' | null = null;

      if (breakglass) {
        tokenSource = 'breakglass';
      } else if (getActiveAccount()) {
        try {
          const token = await msalInstance.acquireTokenSilent();
          localStorage.setItem('entraAccessToken', token.accessToken);
          tokenSource = 'entra';
        } catch (error) {
          if (!cancelled) {
            setBootstrapError(`Microsoft-Token konnte nicht geladen werden: ${toBootstrapError(error)}`);
            setBootstrapState('unauthenticated');
            setHasLoginAttempted(true);
          }
          return;
        }
      }

      if (!tokenSource) {
        if (!cancelled) {
          setBootstrapError('');
          setBootstrapState('unauthenticated');
        }
        return;
      }

      try {
        await loadMe();
        if (!cancelled) {
          setBootstrapError('');
          setBootstrapState('authenticated');
        }
        await Promise.all([loadFloorplans(), loadEmployees()]);
      } catch (error) {
        if (tokenSource === 'breakglass') {
          localStorage.removeItem('breakglassToken');
          setBreakglassToken('');
        }
        if (tokenSource === 'entra') {
          localStorage.removeItem('entraAccessToken');
          localStorage.removeItem('entraAccessTokenExp');
        }

        if (!cancelled) {
          setMe(null);
          setBootstrapError(`Anmeldung fehlgeschlagen: ${toBootstrapError(error)}`);
          setBootstrapState('unauthenticated');
          setHasLoginAttempted(true);
        }
      }
    };

    bootstrap().finally(() => {
      window.clearTimeout(watchdog);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
    };
  }, []);

  useEffect(() => {
    if (!activeEmployees.length) {
      setSelectedEmployeeEmail('');
      return;
    }

    const meEmailNormalized = (me?.email ?? '').toLowerCase();
    const meMatch = activeEmployees.find((employee) => employee.email.toLowerCase() === meEmailNormalized)?.email;
    setSelectedEmployeeEmail((prev) => {
      if (prev && activeEmployees.some((employee) => employee.email === prev)) {
        return prev;
      }

      return meMatch ?? activeEmployees[0]?.email ?? '';
    });
  }, [activeEmployees, me?.email]);


  useEffect(() => {
    setEmployeePage(1);
  }, [employeeSearch]);

  useEffect(() => {
    setEmployeePage((prev) => Math.min(prev, employeeTotalPages));
  }, [employeeTotalPages]);

  useEffect(() => {
    if (!employees.length) {
      setSelectedAdminEmployeeId('');
      setEditingEmployeeId('');
      setEditingEmployeeName('');
      return;
    }

    if (!selectedAdminEmployeeId || !employees.some((employee) => employee.id === selectedAdminEmployeeId)) {
      setSelectedAdminEmployeeId(employees[0].id);
    }
  }, [employees, selectedAdminEmployeeId]);

  useEffect(() => {
    if (!selectedAdminEmployee) return;
    setEditingEmployeeId(selectedAdminEmployee.id);
    setEditingEmployeeName(selectedAdminEmployee.displayName);
  }, [selectedAdminEmployee?.id]);

  useEffect(() => {
    if (selectedFloorplanId) {
      loadOccupancy(selectedFloorplanId, selectedDate);
    }
  }, [selectedFloorplanId, selectedDate]);

  useEffect(() => {
    setSelectedDeskId('');
    setHoveredDeskId('');
    setPopupAnchor(null);
    setPopupPosition(null);
    setRepositioningDeskId('');
  }, [selectedDate, selectedFloorplanId]);


  useEffect(() => {
    setRangeFrom(selectedDate);
    setRangeTo(selectedDate);
    setSeriesValidFrom(selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    setBookingConflictDates([]);
  }, [selectedDeskId, bookingMode]);

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
  }, [popupAnchor, selectedDeskId]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (repositioningDeskId) {
        setRepositioningDeskId('');
        return;
      }
      if (selectedDeskId) {
        setSelectedDeskId('');
        setPopupAnchor(null);
      }
    };
    window.addEventListener('keydown', onEscape);
  
  return () => window.removeEventListener('keydown', onEscape);
  }, [repositioningDeskId, selectedDeskId]);

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
    if (adminTab !== 'desks' && repositioningDeskId) {
      setRepositioningDeskId('');
    }
  }, [adminTab, repositioningDeskId]);

  useEffect(() => {
    setFloorplanNameInput(selectedFloorplan?.name ?? '');
    setFloorplanImageInput(selectedFloorplan?.imageUrl ?? '');
    setFloorplanActionMessage('');
  }, [selectedFloorplan?.id]);

  const loginAdmin = async (event: FormEvent) => {
    event.preventDefault();
    setHasLoginAttempted(true);
    setErrorMessage('');
    const trimmedEmail = adminEmail.trim();
    const nextEmailError = trimmedEmail ? '' : 'Bitte E-Mail eingeben.';
    const nextPasswordError = adminPassword ? '' : 'Bitte Passwort eingeben.';
    setAdminEmailError(nextEmailError);
    setAdminPasswordError(nextPasswordError);

    if (nextEmailError || nextPasswordError) return;

    try {
      const data = await post<{ token: string }>('/auth/breakglass/login', { email: trimmedEmail, password: adminPassword });
      localStorage.setItem('breakglassToken', data.token);
      setBreakglassToken(data.token);
      await loadMe();
      setBootstrapState('authenticated');
      setShowAdminLogin(false);
      setAdminPassword('');
      setInfoMessage('Admin Mode aktiviert.');
    } catch (error) {
      handleApiError(error);
    }
  };

  const logoutAdmin = () => {
    localStorage.removeItem('breakglassToken');
    setBreakglassToken('');
    setMe(null);
    setBootstrapState('unauthenticated');
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
    if (!adminHeaders || !selectedFloorplan || adminTab !== 'desks' || !!repositioningDeskId) return;
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

  const repositionDesk = async (event: MouseEvent<HTMLDivElement>) => {
    if (!adminHeaders || !selectedFloorplan || !repositioningDeskId) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    try {
      await patch(`/admin/desks/${repositioningDeskId}`, { x, y }, adminHeaders);
      setRepositioningDeskId('');
      await Promise.all([loadOccupancy(selectedFloorplan.id, selectedDate), loadAdminLists()]);
    } catch (error) {
      handleApiError(error);
    }
  };

  const deleteDesk = async () => {
    if (!adminHeaders || !activeDesk) return;
    try {
      await del(`/admin/desks/${activeDesk.id}`, adminHeaders);
      await loadOccupancy(selectedFloorplanId, selectedDate);
      setSelectedDeskId('');
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

  const createBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeDesk || activeDesk.status !== 'free') return;

    const bookingEmail = activeEmployees.length ? selectedEmployeeEmail : manualBookingEmail.trim();
    if (!bookingEmail) {
      setErrorMessage('Bitte E-Mail für die Buchung angeben.');
      return;
    }

    setBookingConflictDates([]);

    try {
      if (bookingMode === 'single') {
        await post('/bookings', { deskId: activeDesk.id, userEmail: bookingEmail, date: selectedDate });
      } else if (bookingMode === 'range') {
        await post('/bookings/range', {
          deskId: activeDesk.id,
          userEmail: bookingEmail,
          from: rangeFrom,
          to: rangeTo,
          weekdaysOnly: rangeWeekdaysOnly
        });
      } else {
        await post('/recurring-bookings/bulk', {
          deskId: activeDesk.id,
          userEmail: bookingEmail,
          weekdays: seriesWeekdays,
          validFrom: seriesValidFrom,
          validTo: seriesValidTo
        });
      }

      setSelectedDeskId('');
      setPopupAnchor(null);
      await loadOccupancy(selectedFloorplanId, selectedDate);
      if (isAdminMode) await loadAdminLists();
      setInfoMessage('Buchung erstellt.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const payload = (error.details && typeof error.details === 'object' ? error.details : {}) as {
          details?: { conflictingDates?: string[]; conflictingDatesPreview?: string[] };
        };
        const conflictDates = payload.details?.conflictingDatesPreview ?? payload.details?.conflictingDates ?? [];
        setBookingConflictDates(conflictDates.slice(0, 5));
      }
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
      await patch(`/employees/${id}`, { displayName: editingEmployeeName }, adminHeaders);
      setEditingEmployeeId('');
      setEditingEmployeeName('');
      setEmployeeActionMessage('Mitarbeiter aktualisiert.');
      await loadEmployees();
    } catch (error) {
      handleEmployeeError(error);
    }
  };

  const toggleEmployeeAdmin = async (employee: Employee) => {
    if (!adminHeaders) return;
    setEmployeeErrorMessage('');

    try {
      await patch(`/employees/${employee.id}`, { isAdmin: !employee.isAdmin }, adminHeaders);
      setEmployeeActionMessage(employee.isAdmin ? 'Admin-Rolle entfernt.' : 'Admin-Rolle gesetzt.');
      await loadEmployees();
    } catch (error) {
      handleEmployeeError(error);
    }
  };

  const toggleEmployee = async (employee: Employee) => {
    if (!adminHeaders) return;
    setEmployeeErrorMessage('');

    try {
      await patch(`/employees/${employee.id}`, { isActive: !employee.isActive }, adminHeaders);
      setEmployeeActionMessage(employee.isActive ? 'Mitarbeiter deaktiviert.' : 'Mitarbeiter aktiviert.');
      await loadEmployees();
    } catch (error) {
      handleEmployeeError(error);
    }
  };

  const toggleEmployeeSort = (key: 'displayName' | 'email' | 'isActive' | 'isAdmin') => {
    if (employeeSortKey === key) {
      setEmployeeSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setEmployeeSortKey(key);
    setEmployeeSortDirection('asc');
  };

  const selectAdminEmployee = (employee: Employee) => {
    setSelectedAdminEmployeeId(employee.id);
    setEditingEmployeeId(employee.id);
    setEditingEmployeeName(employee.displayName);
  };

  const selectDay = (day: Date) => {
    const dayKey = toDateKey(day);
    setSelectedDate(dayKey);
    setVisibleMonth(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
  };

  const loginWithMicrosoft = async () => {
    setHasLoginAttempted(true);
    setErrorMessage('');
    try {
      await msalInstance.loginRedirect();
    } catch {
      setErrorMessage('Microsoft-Anmeldung fehlgeschlagen. Bitte erneut versuchen.');
    }
  };

  const retryBackendCheck = async () => {
    setBootstrapState('initializing');
    setBootstrapError('');
    const reachable = await checkBackend();
    if (!reachable) {
      setBootstrapError(`Backend nicht erreichbar: ${API_BASE}`);
      setBootstrapState('backend_down');
      return;
    }

    setBootstrapState(me ? 'authenticated' : 'unauthenticated');
  };

  if (bootstrapState === 'initializing') {
    return <div className="app-shell"><p>Lade Anmeldung…</p></div>;
  }

  if (bootstrapState === 'backend_down') {
    return (
      <div className="login-page app-shell">
        <div className="card login-card">
          <p className="eyebrow">AVENCY Booking</p>
          <h1>Backend nicht erreichbar</h1>
          <p className="muted">API-URL: {API_BASE}</p>
          {bootstrapError && (
            <div className="alert alert-error" role="alert" aria-live="polite">
              <p className="alert-message">{bootstrapError}</p>
            </div>
          )}
          <button type="button" className="btn btn-primary full" onClick={retryBackendCheck}>Erneut versuchen</button>
        </div>
      </div>
    );
  }

  if (bootstrapState === 'unauthenticated' || !me) {
    return (
      <div className="login-page app-shell">
        <div className="card login-card">
          <p className="eyebrow">AVENCY Booking</p>
          <h1>Login</h1>

          <button
            type="button"
            className="btn microsoft-btn full"
            onClick={loginWithMicrosoft}
            aria-label="Mit Microsoft anmelden"
          >
            <img src={microsoftLogo} alt="" aria-hidden="true" />
            <span>Mit Microsoft anmelden</span>
          </button>

          <div className="login-divider" role="separator" aria-label="oder">
            <span>oder</span>
          </div>

          <section className="form-grid gap-3">
            <div>
              <h2>Breakglass Admin</h2>
              <p className="muted">Nur für Notfallzugang (Admin).</p>
            </div>
            <form className="form-grid" onSubmit={loginAdmin} noValidate>
              <label className="field">
                Email
                <input
                  value={adminEmail}
                  onChange={(event) => {
                    setAdminEmail(event.target.value);
                    if (adminEmailError) setAdminEmailError('');
                  }}
                  aria-invalid={adminEmailError ? 'true' : 'false'}
                />
                {adminEmailError && <span className="field-error">{adminEmailError}</span>}
              </label>
              <label className="field">
                Passwort
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(event) => {
                    setAdminPassword(event.target.value);
                    if (adminPasswordError) setAdminPasswordError('');
                  }}
                  aria-invalid={adminPasswordError ? 'true' : 'false'}
                />
                {adminPasswordError && <span className="field-error">{adminPasswordError}</span>}
              </label>
              <button className="btn btn-primary full" type="submit">Breakglass anmelden</button>
            </form>
          </section>

          {hasLoginAttempted && (errorMessage || bootstrapError) && (
            <div className="alert alert-error" role="alert" aria-live="polite">
              <p className="alert-title">Anmeldung fehlgeschlagen</p>
              <p className="alert-message">{errorMessage || bootstrapError}</p>
            </div>
          )}
        </div>
      </div>
    );
  }


  return (
    <main className="app-shell">
      <div className="container">
        <header className="topbar card">
          <div>
            <p className="eyebrow">Desk Booking</p>
            <h1>AVENCY Booking</h1>
          </div>
          <div className="topbar-controls">
            {canAccessAdmin && (
              <div className="mode-switch" role="tablist" aria-label="Modus wechseln">
                <button className={`tab-btn ${uiMode === 'booking' ? 'active' : ''}`} role="tab" onClick={() => setUiMode('booking')}>Buchen</button>
                <button className={`tab-btn ${uiMode === 'admin' ? 'active' : ''}`} role="tab" onClick={() => setUiMode('admin')}>Admin</button>
              </div>
            )}
            {me && (
              <div className="user-chip">
                {me.photoBase64 ? <img className="avatar avatar-small" src={me.photoBase64} alt={me.displayName} /> : <span className="avatar avatar-fallback avatar-small">{(me.displayName[0] ?? '?').toUpperCase()}</span>}
                <span>{me.displayName}</span>
              </div>
            )}
            {breakglassToken ? (
              <button className="btn btn-secondary" onClick={logoutAdmin}>Logout</button>
            ) : !canAccessAdmin ? (
              <button className="btn btn-secondary" onClick={() => setShowAdminLogin(true)}>Admin</button>
            ) : null}
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
                {adminTab === 'employees' && (
                  <section className="form-grid employee-form-card">
                    <h3>Mitarbeiter hinzufügen</h3>
                    {!!employeeActionMessage && <p className="toast toast-success toast-inline">{employeeActionMessage}</p>}
                    {!!employeeErrorMessage && <p className="toast toast-error toast-inline">{employeeErrorMessage}</p>}
                    <form onSubmit={addEmployee} className="form-grid gap-3">
                      <input required placeholder="Name" value={newEmployeeDisplayName} onChange={(e) => setNewEmployeeDisplayName(e.target.value)} />
                      <input required placeholder="E-Mail" value={newEmployeeEmail} onChange={(e) => setNewEmployeeEmail(e.target.value)} />
                      <button className="btn btn-primary full" type="submit">Mitarbeiter hinzufügen</button>
                    </form>
                  </section>
                )}
              </aside>

              <section className="card canvas-card">
                {adminTab === 'employees' ? (
                  <div className="employee-table-panel">
                    <div className="employee-table-toolbar">
                      <h3>Mitarbeiter</h3>
                      <input
                        type="search"
                        placeholder="Suchen nach Name oder E-Mail"
                        value={employeeSearch}
                        onChange={(e) => setEmployeeSearch(e.target.value)}
                      />
                    </div>
                    <table className="employee-table">
                      <thead>
                        <tr>
                          <th>Avatar</th>
                          <th><button className="table-sort-btn" onClick={() => toggleEmployeeSort('displayName')}>Name</button></th>
                          <th><button className="table-sort-btn" onClick={() => toggleEmployeeSort('email')}>E-Mail</button></th>
                          <th><button className="table-sort-btn" onClick={() => toggleEmployeeSort('isAdmin')}>Admin</button></th>
                          <th><button className="table-sort-btn" onClick={() => toggleEmployeeSort('isActive')}>Status</button></th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedEmployees.map((employee) => {
                          const initials = employee.displayName.split(' ').map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase();
                          const isLastAdmin = employee.isAdmin && employee.isActive && activeAdminCount <= 1;
                          return (
                            <tr
                              key={employee.id}
                              className={selectedAdminEmployeeId === employee.id ? 'row-selected' : ''}
                              onClick={() => selectAdminEmployee(employee)}
                            >
                              <td>
                                {employee.photoBase64 ? (
                                  <img className="avatar" src={employee.photoBase64} alt={employee.displayName} />
                                ) : (
                                  <span className="avatar avatar-fallback">{initials || '?'}</span>
                                )}
                              </td>
                              <td>{employee.displayName}</td>
                              <td>{employee.email}</td>
                              <td>
                                <label title={isLastAdmin ? 'Mindestens ein Admin erforderlich' : ''}>
                                  <input
                                    type="checkbox"
                                    checked={employee.isAdmin}
                                    disabled={isLastAdmin}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={() => toggleEmployeeAdmin(employee)}
                                  />
                                </label>
                              </td>
                              <td>{employee.isActive ? 'Aktiv' : 'Inaktiv'}</td>
                            </tr>
                          );
                        })}
                        {!pagedEmployees.length && (
                          <tr>
                            <td colSpan={5} className="muted">Keine Mitarbeiter gefunden.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    <div className="employee-pagination">
                      <button className="btn btn-secondary" onClick={() => setEmployeePage((prev) => Math.max(1, prev - 1))} disabled={employeePage <= 1}>Zurück</button>
                      <span>Seite {employeePage} von {employeeTotalPages}</span>
                      <button className="btn btn-secondary" onClick={() => setEmployeePage((prev) => Math.min(employeeTotalPages, prev + 1))} disabled={employeePage >= employeeTotalPages}>Weiter</button>
                    </div>
                  </div>
                ) : (
                  !selectedFloorplan ? <p>Kein Floorplan ausgewählt.</p> : (
                    <>
                      <h2>{selectedFloorplan.name}</h2>
                      {adminTab === 'desks' && <p className="muted">{repositioningDeskId ? 'Klicke auf neue Position im Floorplan' : 'Klick auf freie Fläche, um einen Desk anzulegen.'}</p>}
                      {(adminTab === 'floorplans' || adminTab === 'desks' || adminTab === 'bookings') && (
                        <div
                          onClick={adminTab === 'desks' ? (repositioningDeskId ? repositionDesk : createDeskAtPosition) : undefined}
                          className={`floorplan-canvas ${repositioningDeskId ? 'reposition-mode' : ''}`}
                          role="presentation"
                        >
                          <img src={selectedFloorplan.imageUrl} alt={selectedFloorplan.name} />
                          {(adminTab === 'desks' || adminTab === 'bookings') && desks.map((desk) => (
                            <button
                              key={desk.id}
                              data-pin="desk-pin"
                              type="button"
                              className={`desk-pin ${desk.status} ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''}`}
                              onMouseEnter={() => setHoveredDeskId(desk.id)}
                              onMouseLeave={() => setHoveredDeskId('')}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (repositioningDeskId) return;
                                setSelectedDeskId(desk.id);
                              }}
                              style={{ left: `${desk.x * 100}%`, top: `${desk.y * 100}%` }}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )
                )}
              </section>

              <aside className="right-panel">
                {adminTab === 'floorplans' && (
                  !selectedFloorplan ? <section className="card"><p className="muted">Floorplan auswählen.</p></section> : (
                    <form onSubmit={saveFloorplan} className="card form-grid">
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
                  !activeDesk ? <section className="card"><p className="muted">Desk auswählen.</p></section> : (
                    <div className="card form-grid">
                      <h3>Desk Properties</h3>
                      <form onSubmit={renameDesk} className="form-grid">
                        <input value={deskNameInput} onChange={(e) => setDeskNameInput(e.target.value)} placeholder="Desk name" />
                        <button className="btn btn-primary" type="submit">Save</button>
                      </form>
                      <button className="btn btn-secondary" type="button" onClick={() => setRepositioningDeskId(activeDesk.id)}>Neu anordnen</button>
                      {repositioningDeskId && <button className="linkish" type="button" onClick={() => setRepositioningDeskId('')}>Abbrechen</button>}
                      <button className="btn btn-danger" onClick={deleteDesk}>Delete</button>
                    </div>
                  )
                )}
                {adminTab === 'bookings' && (
                  <section className="card table-scroll-wrap">
                    <table>
                      <thead><tr><th>Desk</th><th>Employee</th><th>Type</th><th>Edit</th><th>Delete</th></tr></thead>
                      <tbody>
                        {adminBookings.map((booking) => (
                          <tr
                            key={booking.id}
                            className={selectedDeskId === booking.desk.id ? 'row-selected' : ''}
                            onMouseEnter={() => setHoveredDeskId(booking.desk.id)}
                            onMouseLeave={() => setHoveredDeskId('')}
                            onClick={() => setSelectedDeskId(booking.desk.id)}
                          >
                            <td>{booking.desk.name}</td>
                            <td>{booking.userEmail}</td>
                            <td>Single</td>
                            <td><button className="btn btn-secondary" onClick={() => { setEditingBookingId(booking.id); setEditBookingEmail(booking.userEmail); setEditBookingDate(booking.date.slice(0, 10)); saveAdminBooking(booking.id); }}>{editingBookingId === booking.id ? 'Save' : 'Edit'}</button></td>
                            <td><button className="btn btn-danger" onClick={() => deleteAdminBooking(booking.id)}>Delete</button></td>
                          </tr>
                        ))}
                        {adminRecurring.map((booking) => (
                          <tr
                            key={booking.id}
                            className={selectedDeskId === booking.desk.id ? 'row-selected' : ''}
                            onMouseEnter={() => setHoveredDeskId(booking.desk.id)}
                            onMouseLeave={() => setHoveredDeskId('')}
                            onClick={() => setSelectedDeskId(booking.desk.id)}
                          >
                            <td>{booking.desk.name}</td><td>{booking.userEmail}</td><td>Recurring</td><td>-</td>
                            <td><button className="btn btn-danger" onClick={() => deleteAdminRecurring(booking.id)}>Delete</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )}
                {adminTab === 'employees' && (
                  <section className="card form-grid employee-detail-card">
                    <h3>Details</h3>
                    {!selectedAdminEmployee ? (
                      <p className="muted">Mitarbeiter in der Tabelle auswählen.</p>
                    ) : (
                      <>
                        <label className="field">
                          <span>Name</span>
                          <input value={editingEmployeeName} onChange={(e) => setEditingEmployeeName(e.target.value)} />
                        </label>
                        <label className="field">
                          <span>E-Mail</span>
                          <input value={selectedAdminEmployee.email} disabled />
                        </label>
                        <p className={`status-pill ${selectedAdminEmployee.isActive ? 'active' : 'inactive'}`}>
                          {selectedAdminEmployee.isActive ? 'Aktiv' : 'Inaktiv'}
                        </p>
                        <button className="btn btn-primary" onClick={() => saveEmployeeName(selectedAdminEmployee.id)}>Speichern</button>
                        <button className="btn btn-secondary" onClick={() => toggleEmployee(selectedAdminEmployee)}>
                          {selectedAdminEmployee.isActive ? 'Deaktivieren' : 'Aktivieren'}
                        </button>
                      </>
                    )}
                  </section>
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
                        className={`desk-pin ${desk.status} ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''}`}
                        onMouseEnter={() => setHoveredDeskId(desk.id)}
                        onMouseLeave={() => setHoveredDeskId('')}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedDeskId(desk.id);
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
                      <li
                        key={`${person.email}-${person.deskName ?? 'none'}`}
                        className={`person-item ${selectedDeskId === person.deskId ? 'row-selected' : ''}`}
                        onMouseEnter={() => setHoveredDeskId(person.deskId ?? '')}
                        onMouseLeave={() => setHoveredDeskId('')}
                        onClick={() => {
                          if (!person.deskId) return;
                          setSelectedDeskId(person.deskId);
                        }}
                      >
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
          <div className="booking-portal-backdrop" onClick={() => { setSelectedDeskId(''); setPopupAnchor(null); }} />
          <div ref={popupRef} className="booking-overlay card" style={{ left: popupPosition.left, top: popupPosition.top }} onClick={(event) => event.stopPropagation()}>
            <h3>{activeDesk.name}</h3>
            <p className="muted">{selectedDate}</p>
            {activeDesk.status === 'free' ? (
              <form onSubmit={createBooking} className="form-grid">
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

                <div className="field">
                  <span>Buchungstyp</span>
                  <div className="segmented-control">
                    <button type="button" className={`segment-btn ${bookingMode === 'single' ? 'active' : ''}`} onClick={() => setBookingMode('single')}>Einzeltag</button>
                    <button type="button" className={`segment-btn ${bookingMode === 'range' ? 'active' : ''}`} onClick={() => setBookingMode('range')}>Zeitraum</button>
                    <button type="button" className={`segment-btn ${bookingMode === 'series' ? 'active' : ''}`} onClick={() => setBookingMode('series')}>Serie</button>
                  </div>
                </div>

                {bookingMode === 'single' && <p className="muted">Datum: {selectedDate}</p>}

                {bookingMode === 'range' && (
                  <>
                    <label className="field">
                      <span>Von</span>
                      <input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
                    </label>
                    <label className="field">
                      <span>Bis</span>
                      <input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
                    </label>
                    <label className="toggle-row">
                      <input type="checkbox" checked={rangeWeekdaysOnly} onChange={(e) => setRangeWeekdaysOnly(e.target.checked)} />
                      <span>Nur Werktage</span>
                    </label>
                    <p className="muted">
                      {countRangeDays(rangeFrom, rangeTo)} Tage ({countRangeBookings(rangeFrom, rangeTo, rangeWeekdaysOnly)} Buchungen)
                    </p>
                  </>
                )}

                {bookingMode === 'series' && (
                  <>
                    <div className="field">
                      <span>Wochentage</span>
                      <div className="weekday-chips">
                        {weekdays.map((weekday, index) => {
                          const apiDay = jsToApiWeekday[index] as number;
                          const selected = seriesWeekdays.includes(apiDay);
                          return (
                            <button
                              key={weekday}
                              type="button"
                              className={`weekday-chip ${selected ? 'active' : ''}`}
                              onClick={() => {
                                setSeriesWeekdays((prev) =>
                                  prev.includes(apiDay) ? prev.filter((day) => day !== apiDay) : [...prev, apiDay].sort((a, b) => a - b)
                                );
                              }}
                            >
                              {weekday}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <label className="field">
                      <span>Gültig ab</span>
                      <input type="date" value={seriesValidFrom} onChange={(e) => setSeriesValidFrom(e.target.value)} />
                    </label>
                    <label className="field">
                      <span>Gültig bis</span>
                      <input type="date" value={seriesValidTo} onChange={(e) => setSeriesValidTo(e.target.value)} />
                    </label>
                    <button type="button" className="btn btn-secondary" onClick={() => setSeriesValidTo(endOfYear())}>bis Jahresende</button>
                  </>
                )}

                {!!bookingConflictDates.length && (
                  <div className="conflict-box">
                    <p>Konflikt mit bestehenden Buchungen:</p>
                    <ul>
                      {bookingConflictDates.map((date) => <li key={date}>{date}</li>)}
                    </ul>
                  </div>
                )}

                <button className="btn btn-primary" type="submit" disabled={bookingMode === 'series' && !isSeriesValid}>Buchen</button>
              </form>
            ) : (
              <p className="muted">Gebucht von {activeDesk.booking?.userDisplayName ?? activeDesk.booking?.userEmail}</p>
            )}
            <button className="btn btn-secondary" onClick={() => { setSelectedDeskId(''); setPopupAnchor(null); }}>Schließen</button>
          </div>
        </>,
        document.body
      )}
    </main>
  );
}
