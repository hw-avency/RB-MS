import { ChangeEvent, FormEvent, MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Alert,
  AlertIcon,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  CardBody,
  Center,
  Flex,
  FormControl,
  FormErrorMessage,
  FormLabel,
  Heading,
  HStack,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Radio,
  RadioGroup,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  ToastId,
  useDisclosure,
  useToast
} from '@chakra-ui/react';
import * as Saas from '@saas-ui/react';
import { API_BASE, ApiError, del, get, patch, post, setAuthTokenProvider } from './api';
import { getActiveAccount, msalInstance } from './auth';
import { FloorplanCanvas } from './FloorplanCanvas';
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
type Employee = { id: string; email: string; displayName: string; isActive: boolean; isAdmin?: boolean; photoUrl?: string | null; photoBase64?: string | null };
type BookingEmployee = { id: string; email: string; displayName: string };
type MeResponse = { employeeId: string; email: string; displayName: string; isAdmin: boolean; authProvider: 'breakglass' | 'entra' };
type BookingMode = 'single' | 'range' | 'series';
type BootstrapState = 'initializing' | 'backend_down' | 'unauthenticated' | 'authenticated';
type AppRoute = '/login' | '/booking' | '/admin' | '/admin/employees';

const today = new Date().toISOString().slice(0, 10);
const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const jsToApiWeekday = [1, 2, 3, 4, 5, 6, 0];
const employeePageSize = 10;

const AppShell = (Saas as any).AppShell ?? Box;
const Sidebar = (Saas as any).Sidebar ?? Box;
const NavGroup = (Saas as any).NavGroup ?? Box;
const NavItem = (Saas as any).NavItem ?? Button;
const SidebarToggleButton = (Saas as any).SidebarToggleButton ?? Button;
const Page = (Saas as any).Page ?? Stack;
const PageHeader = (Saas as any).PageHeader ?? Box;
const DataTable = (Saas as any).DataTable ?? (Saas as any).DataGrid;

const endOfYear = (): string => new Date(Date.UTC(new Date().getUTCFullYear(), 11, 31)).toISOString().slice(0, 10);
const toDateKey = (value: Date): string => value.toISOString().slice(0, 10);
const startOfMonth = (dateString: string): Date => new Date(Date.UTC(new Date(`${dateString}T00:00:00.000Z`).getUTCFullYear(), new Date(`${dateString}T00:00:00.000Z`).getUTCMonth(), 1));
const monthLabel = (monthStart: Date): string => monthStart.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
const normalizeRoute = (pathname: string): AppRoute => {
  if (pathname === '/admin' || pathname === '/admin/employees' || pathname === '/booking' || pathname === '/login') return pathname;
  return '/booking';
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
  const floorplanDebug = import.meta.env.DEV && localStorage.getItem('floorplan-debug') === '1';
  const toast = useToast();
  const toastRef = useRef<ToastId | null>(null);
  const [route, setRoute] = useState<AppRoute>(normalizeRoute(window.location.pathname));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>('initializing');
  const [bootstrapError, setBootstrapError] = useState('');
  const [hasLoginAttempted, setHasLoginAttempted] = useState(false);

  const [me, setMe] = useState<MeResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');

  const [adminEmail, setAdminEmail] = useState('admin@example.com');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminEmailError, setAdminEmailError] = useState('');
  const [adminPasswordError, setAdminPasswordError] = useState('');

  const [floorplans, setFloorplans] = useState<Floorplan[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(today));
  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [selectedDeskId, setSelectedDeskId] = useState('');
  const [hoveredDeskId, setHoveredDeskId] = useState('');

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployeeEmail, setSelectedEmployeeEmail] = useState('');
  const [manualBookingEmail, setManualBookingEmail] = useState('');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [employeeSortKey, setEmployeeSortKey] = useState<'displayName' | 'email'>('displayName');
  const [employeeSortDirection, setEmployeeSortDirection] = useState<'asc' | 'desc'>('asc');
  const [employeePage, setEmployeePage] = useState(1);

  const [bookingMode, setBookingMode] = useState<BookingMode>('single');
  const [rangeFrom, setRangeFrom] = useState(today);
  const [rangeTo, setRangeTo] = useState(today);
  const [rangeWeekdaysOnly, setRangeWeekdaysOnly] = useState(true);
  const [seriesWeekdays, setSeriesWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [seriesValidFrom, setSeriesValidFrom] = useState(today);
  const [seriesValidTo, setSeriesValidTo] = useState(endOfYear());

  const [popupAnchor, setPopupAnchor] = useState<{ left: number; top: number } | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number } | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const renameDisclosure = useDisclosure();
  const confirmDisclosure = useDisclosure();
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [editingEmployeeName, setEditingEmployeeName] = useState('');
  const [employeeActionTarget, setEmployeeActionTarget] = useState<Employee | null>(null);

  const isAdminMode = me?.isAdmin === true;
  const selectedFloorplan = useMemo(() => floorplans.find((f) => f.id === selectedFloorplanId) ?? null, [floorplans, selectedFloorplanId]);
  const desks = occupancy?.desks ?? [];
  const people = useMemo(() => [...(occupancy?.people ?? [])].sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email, 'de')), [occupancy]);
  const activeDesk = useMemo(() => desks.find((d) => d.id === selectedDeskId) ?? null, [desks, selectedDeskId]);
  const activeEmployees = useMemo(() => employees.filter((e) => e.isActive), [employees]);
  const adminCount = useMemo(() => employees.filter((e) => e.isAdmin).length, [employees]);
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);

  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    const source = q ? employees.filter((e) => e.displayName.toLowerCase().includes(q) || e.email.toLowerCase().includes(q)) : employees;
    return [...source].sort((a, b) => {
      const v = a[employeeSortKey].localeCompare(b[employeeSortKey], 'de');
      return employeeSortDirection === 'asc' ? v : -v;
    });
  }, [employees, employeeSearch, employeeSortDirection, employeeSortKey]);
  const employeeTotalPages = Math.max(1, Math.ceil(filteredEmployees.length / employeePageSize));
  const pagedEmployees = useMemo(() => filteredEmployees.slice((employeePage - 1) * employeePageSize, employeePage * employeePageSize), [filteredEmployees, employeePage]);

  const adminHeaders = useMemo(() => (isAdminMode ? {} : undefined), [isAdminMode]);

  const navigate = (next: AppRoute, replace = false) => {
    if (window.location.pathname !== next) {
      window.history[replace ? 'replaceState' : 'pushState']({}, '', next);
    }
    setRoute(next);
  };

  useEffect(() => {
    const onPop = () => setRoute(normalizeRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (toastRef.current) toast.close(toastRef.current);
    if (errorMessage) {
      toastRef.current = toast({ status: 'error', title: errorMessage });
    } else if (infoMessage) {
      toastRef.current = toast({ status: 'success', title: infoMessage });
    }
  }, [errorMessage, infoMessage, toast]);

  useEffect(() => {
    setAuthTokenProvider(async () => localStorage.getItem('breakglassToken') || localStorage.getItem('entraAccessToken') || null);
  }, []);

  useEffect(() => {
    setEmployeePage((p) => Math.min(p, employeeTotalPages));
  }, [employeeTotalPages]);

  useLayoutEffect(() => {
    if (!popupAnchor || !popupRef.current) {
      setPopupPosition(popupAnchor);
      return;
    }
    const margin = 12;
    const rect = popupRef.current.getBoundingClientRect();
    setPopupPosition({
      left: Math.min(Math.max(popupAnchor.left, margin), Math.max(window.innerWidth - rect.width - margin, margin)),
      top: Math.min(Math.max(popupAnchor.top, margin), Math.max(window.innerHeight - rect.height - margin, margin))
    });
  }, [popupAnchor, selectedDeskId]);

  useEffect(() => {
    if (!activeEmployees.length) return;
    const fallback = activeEmployees.find((e) => e.email === me?.email)?.email ?? activeEmployees[0].email;
    setSelectedEmployeeEmail((prev) => prev || fallback);
  }, [activeEmployees, me?.email]);

  const checkBackend = async (): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/health`);
      return response.ok;
    } catch {
      return false;
    }
  };

  const handleApiError = (error: unknown) => {
    if (error instanceof ApiError) {
      setErrorMessage(error.message);
      if (error.status === 401) void logout();
      return;
    }
    setErrorMessage('Netzwerkfehler.');
  };

  const loadMe = async () => {
    const data = await get<MeResponse>('/me', undefined, 10000);
    setMe(data);
    setManualBookingEmail((prev) => prev || data.email);
  };

  const loadFloorplans = async () => {
    const data = await get<Floorplan[]>('/floorplans');
    setFloorplans(data);
    setSelectedFloorplanId((prev) => prev || data[0]?.id || '');
  };

  const loadOccupancy = async (floorplanId: string, date: string) => {
    const data = await get<OccupancyResponse>(`/occupancy?floorplanId=${floorplanId}&date=${date}`);
    setOccupancy(data);
  };

  const loadEmployees = async () => {
    const data = adminHeaders ? await get<Employee[]>('/admin/employees', adminHeaders) : (await get<BookingEmployee[]>('/employees')).map((e) => ({ ...e, isActive: true }));
    setEmployees(data);
  };

  const bootstrap = async () => {
    setBootstrapState('initializing');
    setBootstrapError('');
    if (!(await checkBackend())) {
      setBootstrapState('backend_down');
      setBootstrapError(`Backend nicht erreichbar: ${API_BASE}`);
      return;
    }
    try {
      await msalInstance.initialize();
      const redirect = await msalInstance.handleRedirectPromise();
      if (redirect?.account) msalInstance.setActiveAccount(redirect.account);
      const hasBreakglass = !!localStorage.getItem('breakglassToken');
      const hasEntra = !!localStorage.getItem('entraAccessToken') || !!getActiveAccount();
      if (!hasBreakglass && hasEntra) {
        const token = await msalInstance.acquireTokenSilent();
        localStorage.setItem('entraAccessToken', token.accessToken);
      }
      if (!hasBreakglass && !hasEntra) {
        setBootstrapState('unauthenticated');
        navigate('/login', true);
        return;
      }
      await Promise.all([loadMe(), loadFloorplans(), loadEmployees()]);
      setBootstrapState('authenticated');
      if (window.location.pathname === '/login') navigate('/booking', true);
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : 'Anmeldung fehlgeschlagen.');
      setBootstrapState('unauthenticated');
      navigate('/login', true);
    }
  };

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (selectedFloorplanId) {
      loadOccupancy(selectedFloorplanId, selectedDate).catch(handleApiError);
    }
  }, [selectedFloorplanId, selectedDate]);

  useEffect(() => {
    loadEmployees().catch(handleApiError);
  }, [isAdminMode]);

  const logout = async () => {
    localStorage.removeItem('breakglassToken');
    localStorage.removeItem('entraAccessToken');
    localStorage.removeItem('entraAccessTokenExp');
    localStorage.removeItem('uiMode');
    localStorage.removeItem('cachedMe');
    setMe(null);
    setBootstrapState('unauthenticated');
    setSelectedDeskId('');
    setPopupAnchor(null);
    try {
      if (getActiveAccount() || localStorage.getItem('entraAccessToken')) {
        await msalInstance.logoutRedirect({ postLogoutRedirectUri: `${window.location.origin}/login` });
        return;
      }
    } catch {
      // noop, local cleanup already done
    }
    navigate('/login', true);
  };

  const loginAdmin = async (event: FormEvent) => {
    event.preventDefault();
    setHasLoginAttempted(true);
    const emailError = adminEmail.trim() ? '' : 'Bitte E-Mail eingeben.';
    const passwordError = adminPassword ? '' : 'Bitte Passwort eingeben.';
    setAdminEmailError(emailError);
    setAdminPasswordError(passwordError);
    if (emailError || passwordError) return;
    try {
      const data = await post<{ token: string }>('/auth/breakglass/login', { email: adminEmail.trim(), password: adminPassword });
      localStorage.setItem('breakglassToken', data.token);
      await bootstrap();
      setAdminPassword('');
      setInfoMessage('Breakglass angemeldet.');
    } catch (error) {
      handleApiError(error);
    }
  };

  const loginWithMicrosoft = async () => {
    setHasLoginAttempted(true);
    try {
      await msalInstance.loginRedirect();
    } catch {
      setErrorMessage('Microsoft-Anmeldung fehlgeschlagen.');
    }
  };

  const createBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeDesk) return;
    const email = selectedEmployeeEmail || manualBookingEmail;
    try {
      if (bookingMode === 'single') {
        await post('/bookings', { deskId: activeDesk.id, userEmail: email, date: selectedDate });
      } else if (bookingMode === 'range') {
        await post('/bookings/range', { deskId: activeDesk.id, userEmail: email, from: rangeFrom, to: rangeTo, weekdaysOnly: rangeWeekdaysOnly });
      } else {
        await post('/bookings/series', { deskId: activeDesk.id, userEmail: email, weekdays: seriesWeekdays, validFrom: seriesValidFrom, validTo: seriesValidTo });
      }
      await loadOccupancy(selectedFloorplanId, selectedDate);
      setInfoMessage('Buchung gespeichert.');
      setSelectedDeskId('');
      setPopupAnchor(null);
    } catch (error) {
      handleApiError(error);
    }
  };

  const toggleEmployeeAdmin = async (employee: Employee, isAdmin: boolean) => {
    if (!adminHeaders) return;
    try {
      await patch(`/admin/employees/${employee.id}`, { isAdmin }, adminHeaders);
      setInfoMessage(isAdmin ? 'Admin aktiviert.' : 'Admin entfernt.');
      await loadEmployees();
    } catch (error) {
      handleApiError(error);
    }
  };

  const saveEmployeeName = async () => {
    if (!adminHeaders || !editingEmployee) return;
    try {
      await patch(`/admin/employees/${editingEmployee.id}`, { displayName: editingEmployeeName }, adminHeaders);
      renameDisclosure.onClose();
      setInfoMessage('Mitarbeiter aktualisiert.');
      await loadEmployees();
    } catch (error) {
      handleApiError(error);
    }
  };

  const toggleEmployee = async (employee: Employee) => {
    if (!adminHeaders) return;
    try {
      await patch(`/admin/employees/${employee.id}`, { isActive: !employee.isActive }, adminHeaders);
      confirmDisclosure.onClose();
      setInfoMessage(employee.isActive ? 'Mitarbeiter deaktiviert.' : 'Mitarbeiter aktiviert.');
      await loadEmployees();
    } catch (error) {
      handleApiError(error);
    }
  };

  if (bootstrapState === 'initializing') return <Center h="100vh"><Text>Lade Anmeldung…</Text></Center>;
  if (bootstrapState === 'backend_down') {
    return <Center h="100vh"><Card maxW="lg"><CardBody><Stack><Heading size="md">Backend nicht erreichbar</Heading><Text>{bootstrapError}</Text><Button onClick={() => void bootstrap()}>Erneut versuchen</Button></Stack></CardBody></Card></Center>;
  }

  if (bootstrapState === 'unauthenticated' || !me || route === '/login') {
    return (
      <Center minH="100vh" px={6}>
        <Card w="full" maxW="lg">
          <CardBody>
            <Stack spacing={4}>
              <Heading size="lg">AVENCY Booking Login</Heading>
              <Button variant="outline" leftIcon={<img src={microsoftLogo} alt="" style={{ width: 18, height: 18 }} />} onClick={loginWithMicrosoft}>Mit Microsoft anmelden</Button>
              <form onSubmit={loginAdmin}>
                <Stack spacing={3}>
                  <FormControl isInvalid={!!adminEmailError}><FormLabel>Email</FormLabel><Input value={adminEmail} onChange={(e: ChangeEvent<HTMLInputElement>) => setAdminEmail(e.target.value)} /><FormErrorMessage>{adminEmailError}</FormErrorMessage></FormControl>
                  <FormControl isInvalid={!!adminPasswordError}><FormLabel>Passwort</FormLabel><Input type="password" value={adminPassword} onChange={(e: ChangeEvent<HTMLInputElement>) => setAdminPassword(e.target.value)} /><FormErrorMessage>{adminPasswordError}</FormErrorMessage></FormControl>
                  <Button colorScheme="blue" type="submit">Breakglass anmelden</Button>
                </Stack>
              </form>
              {hasLoginAttempted && (errorMessage || bootstrapError) && <Alert status="error"><AlertIcon />{errorMessage || bootstrapError}</Alert>}
            </Stack>
          </CardBody>
        </Card>
      </Center>
    );
  }

  const employeeColumns = [
    { accessor: 'avatar', Header: 'Avatar' },
    { accessor: 'displayName', Header: 'Name' },
    { accessor: 'email', Header: 'E-Mail' },
    { accessor: 'status', Header: 'Status' },
    { accessor: 'isAdmin', Header: 'Admin' },
    { accessor: 'actions', Header: 'Aktionen' }
  ];

  const employeeRows = pagedEmployees.map((employee) => ({
    avatar: <Avatar size="sm" name={employee.displayName} src={employee.photoUrl ?? employee.photoBase64 ?? undefined} />,
    displayName: employee.displayName,
    email: employee.email,
    status: <Badge colorScheme={employee.isActive ? 'green' : 'gray'}>{employee.isActive ? 'Aktiv' : 'Inaktiv'}</Badge>,
    isAdmin: <Switch isChecked={employee.isAdmin} isDisabled={employee.isAdmin && adminCount === 1} onChange={(e: ChangeEvent<HTMLInputElement>) => void toggleEmployeeAdmin(employee, e.target.checked)} />,
    actions: (
      <Menu>
        <MenuButton as={Button} variant="ghost">⋮</MenuButton>
        <MenuList>
          <MenuItem onClick={() => { setEditingEmployee(employee); setEditingEmployeeName(employee.displayName); renameDisclosure.onOpen(); }}>Rename</MenuItem>
          <MenuItem onClick={() => { setEmployeeActionTarget(employee); confirmDisclosure.onOpen(); }}>{employee.isActive ? 'Deactivate' : 'Activate'}</MenuItem>
        </MenuList>
      </Menu>
    )
  }));

  return (
    <AppShell height="$100vh" minH="100vh">
      <Flex h="100vh" overflow="hidden">
        <Sidebar w={{ base: sidebarOpen ? '260px' : '0px', md: '260px' }} borderRightWidth="1px" p={4} overflow="hidden">
          <Stack spacing={4}>
            <Heading size="sm">Navigation</Heading>
            <NavGroup>
              <NavItem onClick={() => navigate('/booking')} variant={route === '/booking' ? 'solid' : 'ghost'} width="full" justifyContent="flex-start">Buchen</NavItem>
              {isAdminMode && <NavItem onClick={() => navigate('/admin')} variant={route === '/admin' ? 'solid' : 'ghost'} width="full" justifyContent="flex-start">Admin</NavItem>}
              {isAdminMode && <NavItem onClick={() => navigate('/admin/employees')} variant={route === '/admin/employees' ? 'solid' : 'ghost'} width="full" justifyContent="flex-start">Mitarbeiter</NavItem>}
            </NavGroup>
          </Stack>
        </Sidebar>

        <Box flex="1" overflow="auto">
          <Flex px={6} py={4} borderBottomWidth="1px" align="center" justify="space-between" gap={3}>
            <HStack>
              <SidebarToggleButton onClick={() => setSidebarOpen((v: boolean) => !v)}>☰</SidebarToggleButton>
              <Heading size="md">AVENCY Booking</Heading>
            </HStack>
            <HStack>
              <Avatar size="sm" name={me.displayName} src={me.authProvider === 'entra' ? undefined : undefined} />
              <Text>{me.displayName}</Text>
              <Button onClick={() => void logout()} colorScheme="red" variant="outline">Logout</Button>
            </HStack>
          </Flex>

          <Box p={6}>
            {route === '/booking' && (
              <Stack spacing={4}>
                <Heading size="lg">Buchen</Heading>
                <SimpleGrid columns={{ base: 1, xl: 3 }} spacing={4} alignItems="start">
                  <Card><CardBody><Stack spacing={3}><Heading size="sm">Kalender</Heading><HStack><Button size="sm" onClick={() => setVisibleMonth((p) => new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth() - 1, 1)))}>‹</Button><Text flex="1" textAlign="center" textTransform="capitalize">{monthLabel(visibleMonth)}</Text><Button size="sm" onClick={() => setVisibleMonth((p) => new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth() + 1, 1)))}>›</Button></HStack><Button onClick={() => setSelectedDate(today)}>Heute</Button><SimpleGrid columns={7} spacing={1}>{weekdays.map((w) => <Text key={w} fontSize="sm" color="gray.500" textAlign="center">{w}</Text>)}{calendarDays.map((day) => { const key = toDateKey(day); return <Button key={key} size="sm" variant={key === selectedDate ? 'solid' : 'outline'} colorScheme={key === selectedDate ? 'blue' : undefined} onClick={() => setSelectedDate(key)}>{day.getUTCDate()}</Button>; })}</SimpleGrid></Stack></CardBody></Card>
                  <Card><CardBody><Stack spacing={3}><HStack><Heading size="sm" flex="1">Floorplan</Heading><Select value={selectedFloorplanId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setSelectedFloorplanId(e.target.value)}>{floorplans.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></HStack>{selectedFloorplan && <FloorplanCanvas imageUrl={selectedFloorplan.imageUrl} imageAlt={selectedFloorplan.name} desks={desks} selectedDeskId={selectedDeskId} hoveredDeskId={hoveredDeskId} debug={floorplanDebug} onDeskMouseEnter={(id) => setHoveredDeskId(id)} onDeskMouseLeave={() => setHoveredDeskId('')} onDeskClick={(deskId, event) => { event.stopPropagation(); setSelectedDeskId(deskId); const rect = event.currentTarget.getBoundingClientRect(); setPopupAnchor({ left: rect.left + rect.width + 12, top: rect.top }); }} />}</Stack></CardBody></Card>
                  <Card><CardBody><Stack spacing={2}><Heading size="sm">Anwesenheit</Heading><Text color="gray.500">{people.length} Personen am {new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('de-DE')}</Text>{people.map((person) => <HStack key={`${person.email}-${person.deskId ?? 'none'}`} justify="space-between" p={2} borderWidth="1px" borderRadius="md" cursor={person.deskId ? 'pointer' : 'default'} onClick={() => person.deskId && setSelectedDeskId(person.deskId)}><Text>{person.displayName || person.email}</Text><Text color="gray.500">{person.deskName ?? '—'}</Text></HStack>)}</Stack></CardBody></Card>
                </SimpleGrid>
              </Stack>
            )}

            {route === '/admin' && isAdminMode && (
              <Stack spacing={4}>
                <Heading size="lg">Admin</Heading>
                <Card><CardBody><Text>Verwaltungsbereich</Text></CardBody></Card>
              </Stack>
            )}

            {route === '/admin/employees' && isAdminMode && (
              <Page>
                <Stack spacing={5}>
                  <PageHeader>
                    <Heading size="lg">Mitarbeiter</Heading>
                    <Text color="gray.500" mt={1}>Verwalte Benutzerstatus, Berechtigungen und Kontodetails.</Text>
                  </PageHeader>

                  <Card>
                    <CardBody>
                      <Stack spacing={4}>
                        <HStack justify="space-between" align="center">
                          <HStack spacing={3}>
                            <Input type="search" placeholder="Suche nach Name oder E-Mail" value={employeeSearch} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmployeeSearch(e.target.value)} maxW="380px" />
                            <Button variant="outline" onClick={() => setEmployeeSortKey((prev) => (prev === 'displayName' ? 'email' : 'displayName'))}>Sortierung: {employeeSortKey === 'displayName' ? 'Name' : 'E-Mail'}</Button>
                            <Button variant="outline" onClick={() => setEmployeeSortDirection((p) => (p === 'asc' ? 'desc' : 'asc'))}>{employeeSortDirection === 'asc' ? '↑ Aufsteigend' : '↓ Absteigend'}</Button>
                          </HStack>
                          <Button colorScheme="blue">Mitarbeiter hinzufügen</Button>
                        </HStack>

                        {DataTable && <DataTable columns={employeeColumns} data={employeeRows} />}

                        <HStack justify="space-between">
                          <Text>Seite {employeePage} / {employeeTotalPages}</Text>
                          <HStack>
                            <Button onClick={() => setEmployeePage((p) => Math.max(1, p - 1))}>Zurück</Button>
                            <Button onClick={() => setEmployeePage((p) => Math.min(employeeTotalPages, p + 1))}>Weiter</Button>
                          </HStack>
                        </HStack>
                      </Stack>
                    </CardBody>
                  </Card>
                </Stack>
              </Page>
            )}
          </Box>
        </Box>
      </Flex>

      {activeDesk && popupPosition && createPortal(
        <>
          <Box className="booking-portal-backdrop" onClick={() => { setSelectedDeskId(''); setPopupAnchor(null); }} />
          <Card ref={popupRef} className="booking-overlay" style={{ left: popupPosition.left, top: popupPosition.top }} onClick={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}>
            <CardBody>
              <Stack spacing={3}>
                <Heading size="sm">{activeDesk.name}</Heading>
                {activeDesk.status === 'free' ? (
                  <form onSubmit={createBooking}>
                    <Stack spacing={3}>
                      <FormControl><FormLabel>Für wen buchen?</FormLabel>{activeEmployees.length ? <Select value={selectedEmployeeEmail} onChange={(e: ChangeEvent<HTMLSelectElement>) => setSelectedEmployeeEmail(e.target.value)}>{activeEmployees.map((employee) => <option key={employee.id} value={employee.email}>{employee.displayName} ({employee.email})</option>)}</Select> : <Input value={manualBookingEmail} onChange={(e: ChangeEvent<HTMLInputElement>) => setManualBookingEmail(e.target.value)} />}</FormControl>
                      <FormControl><FormLabel>Buchungstyp</FormLabel><RadioGroup value={bookingMode} onChange={(value: string) => setBookingMode(value as BookingMode)}><HStack><Radio value="single">Einzeltag</Radio><Radio value="range">Zeitraum</Radio><Radio value="series">Serie</Radio></HStack></RadioGroup></FormControl>
                      {bookingMode === 'range' && <><Input type="date" value={rangeFrom} onChange={(e: ChangeEvent<HTMLInputElement>) => setRangeFrom(e.target.value)} /><Input type="date" value={rangeTo} onChange={(e: ChangeEvent<HTMLInputElement>) => setRangeTo(e.target.value)} /><HStack><Switch isChecked={rangeWeekdaysOnly} onChange={(e: ChangeEvent<HTMLInputElement>) => setRangeWeekdaysOnly(e.target.checked)} /><Text>Nur Werktage</Text></HStack></>}
                      {bookingMode === 'series' && <><HStack>{weekdays.map((weekday, index) => { const apiDay = jsToApiWeekday[index]; const selected = seriesWeekdays.includes(apiDay); return <Button key={weekday} size="sm" variant={selected ? 'solid' : 'outline'} onClick={() => setSeriesWeekdays((prev) => prev.includes(apiDay) ? prev.filter((d) => d !== apiDay) : [...prev, apiDay].sort((a, b) => a - b))}>{weekday}</Button>; })}</HStack><Input type="date" value={seriesValidFrom} onChange={(e: ChangeEvent<HTMLInputElement>) => setSeriesValidFrom(e.target.value)} /><Input type="date" value={seriesValidTo} onChange={(e: ChangeEvent<HTMLInputElement>) => setSeriesValidTo(e.target.value)} /></>}
                      <Button colorScheme="blue" type="submit">Buchen</Button>
                    </Stack>
                  </form>
                ) : <Text>Gebucht von {activeDesk.booking?.userDisplayName ?? activeDesk.booking?.userEmail}</Text>}
                <Button variant="outline" onClick={() => { setSelectedDeskId(''); setPopupAnchor(null); }}>Schließen</Button>
              </Stack>
            </CardBody>
          </Card>
        </>, document.body
      )}

      <Modal isOpen={renameDisclosure.isOpen} onClose={renameDisclosure.onClose}>
        <ModalOverlay /><ModalContent><ModalHeader>Mitarbeiter umbenennen</ModalHeader><ModalCloseButton /><ModalBody><FormControl><FormLabel>Name</FormLabel><Input value={editingEmployeeName} onChange={(e: ChangeEvent<HTMLInputElement>) => setEditingEmployeeName(e.target.value)} /></FormControl></ModalBody><ModalFooter><Button mr={3} onClick={renameDisclosure.onClose}>Abbrechen</Button><Button colorScheme="blue" onClick={() => void saveEmployeeName()}>Speichern</Button></ModalFooter></ModalContent>
      </Modal>

      <Modal isOpen={confirmDisclosure.isOpen} onClose={confirmDisclosure.onClose}>
        <ModalOverlay /><ModalContent><ModalHeader>Status ändern</ModalHeader><ModalCloseButton /><ModalBody><Text>{employeeActionTarget?.displayName} {employeeActionTarget?.isActive ? 'deaktivieren' : 'aktivieren'}?</Text></ModalBody><ModalFooter><Button mr={3} onClick={confirmDisclosure.onClose}>Abbrechen</Button><Button colorScheme="red" onClick={() => employeeActionTarget && void toggleEmployee(employeeActionTarget)}>Bestätigen</Button></ModalFooter></ModalContent>
      </Modal>
    </AppShell>
  );
}
