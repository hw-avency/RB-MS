import cors from 'cors';
import express from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

const app = express();
const port = Number(process.env.PORT ?? 3000);

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD env var is required');
}

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET env var is required');
}

app.use(cors());
app.use(express.json());

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type AdminJwtPayload = { email: string; role: 'admin'; exp: number };
type EmployeeRole = 'admin' | 'user';

const toBase64Url = (value: string) => Buffer.from(value).toString('base64url');
const fromBase64Url = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const createAdminToken = (email: string): string => {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({
      email,
      role: 'admin',
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8
    })
  );
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
};

const verifyAdminToken = (token: string): AdminJwtPayload | null => {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) {
    return null;
  }

  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  if (expected !== signature) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as AdminJwtPayload;
    if (parsed.role !== 'admin' || typeof parsed.exp !== 'number' || parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const requireAdmin: express.RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing bearer token' });
    return;
  }

  const token = authorization.slice(7);

  const payload = verifyAdminToken(token);
  if (!payload) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    return;
  }

  if (payload.email === ADMIN_EMAIL) {
    (req as express.Request & { adminEmail?: string }).adminEmail = payload.email;
    next();
    return;
  }

  const employee = await prisma.employee.findUnique({
    where: { email: normalizeEmail(payload.email) },
    select: { role: true, isActive: true }
  });

  if (!employee?.isActive || employee.role !== 'admin') {
    res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
    return;
  }

  (req as express.Request & { adminEmail?: string }).adminEmail = normalizeEmail(payload.email);
  next();
};

const toDateOnly = (value: string): Date | null => {
  if (!DATE_PATTERN.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

const toISODateOnly = (value: Date): string => value.toISOString().slice(0, 10);

const endOfCurrentYear = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), 11, 31));
};

const datesInRange = (from: Date, to: Date): Date[] => {
  const dates: Date[] = [];
  const cursor = new Date(from);

  while (cursor <= to) {
    dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
};

const isDateWithinRange = (date: Date, start: Date, end?: Date | null): boolean => {
  if (date < start) {
    return false;
  }

  if (end && date > end) {
    return false;
  }

  return true;
};

const getRouteId = (value: string | string[] | undefined): string | null => {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
};

const sendConflict = (res: express.Response, message: string, details: Record<string, unknown>) => {
  res.status(409).json({
    error: 'conflict',
    message,
    details
  });
};

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const isValidEmailInput = (value: string): boolean => value.includes('@');

const isValidEmployeeRole = (value: string): value is EmployeeRole => value === 'admin' || value === 'user';

const getRequestUserEmail = (req: express.Request): string | null => {
  const headerEmail = req.header('x-user-email');
  if (!headerEmail) return null;
  return normalizeEmail(headerEmail);
};

const employeeSelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true
} satisfies Prisma.EmployeeSelect;

const getActiveEmployeesByEmail = async (emails: string[]) => {
  if (emails.length === 0) {
    return new Map<string, { displayName: string }>();
  }

  const uniqueEmails = Array.from(new Set(emails.map((email) => normalizeEmail(email))));
  const employees = await prisma.employee.findMany({
    where: {
      isActive: true,
      email: { in: uniqueEmails }
    },
    select: {
      email: true,
      displayName: true
    }
  });

  return new Map(employees.map((employee) => [employee.email, { displayName: employee.displayName }]));
};

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch {
    res.status(500).json({ status: 'error' });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch {
    res.status(500).json({ status: 'error' });
  }
});

app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'validation', message: 'email and password are required' });
    return;
  }

  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
    return;
  }

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail !== ADMIN_EMAIL) {
    const employee = await prisma.employee.findUnique({
      where: { email: normalizedEmail },
      select: { role: true, isActive: true }
    });

    if (!employee?.isActive || employee.role !== 'admin') {
      res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
      return;
    }
  }

  const token = createAdminToken(normalizedEmail);
  res.status(200).json({ token });
});

app.get('/admin/me', requireAdmin, async (req, res) => {
  const adminEmail = (req as express.Request & { adminEmail?: string }).adminEmail ?? ADMIN_EMAIL;
  if (adminEmail === ADMIN_EMAIL) {
    res.status(200).json({
      email: ADMIN_EMAIL,
      displayName: 'Breakglass Admin',
      role: 'admin'
    });
    return;
  }

  const employee = await prisma.employee.findUnique({
    where: { email: adminEmail },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      isActive: true
    }
  });

  if (!employee || !employee.isActive || employee.role !== 'admin') {
    res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
    return;
  }

  res.status(200).json(employee);
});

app.get('/admin/employees', requireAdmin, async (_req, res) => {
  const employees = await prisma.employee.findMany({
    select: employeeSelect,
    orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }, { email: 'asc' }]
  });

  res.status(200).json(employees);
});

app.get('/employees', async (_req, res) => {
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: {
      id: true,
      email: true,
      displayName: true
    },
    orderBy: [{ displayName: 'asc' }, { email: 'asc' }]
  });

  res.status(200).json(employees);
});

app.post('/admin/employees', requireAdmin, async (req, res) => {
  const { email, displayName, role } = req.body as { email?: string; displayName?: string; role?: string };

  if (!email || !displayName) {
    res.status(400).json({ error: 'validation', message: 'email and displayName are required' });
    return;
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedDisplayName = displayName.trim();

  if (!isValidEmailInput(normalizedEmail)) {
    res.status(400).json({ error: 'validation', message: 'email must contain @' });
    return;
  }

  if (!normalizedDisplayName) {
    res.status(400).json({ error: 'validation', message: 'displayName must not be empty' });
    return;
  }

  if (typeof role !== 'undefined' && !isValidEmployeeRole(role)) {
    res.status(400).json({ error: 'validation', message: 'role must be admin or user' });
    return;
  }

  try {
    const employee = await prisma.employee.create({
      data: {
        email: normalizedEmail,
        displayName: normalizedDisplayName,
        role: role ?? 'user'
      },
      select: employeeSelect
    });

    res.status(201).json(employee);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      sendConflict(res, 'Employee email already exists', { email: normalizedEmail });
      return;
    }

    throw error;
  }
});

app.patch('/admin/employees/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { displayName, isActive, role } = req.body as { displayName?: string; isActive?: boolean; role?: string };
  if (typeof displayName === 'undefined' && typeof isActive === 'undefined' && typeof role === 'undefined') {
    res.status(400).json({ error: 'validation', message: 'displayName, isActive or role must be provided' });
    return;
  }

  const trimmedDisplayName = typeof displayName === 'string' ? displayName.trim() : undefined;
  if (typeof trimmedDisplayName === 'string' && !trimmedDisplayName) {
    res.status(400).json({ error: 'validation', message: 'displayName must not be empty' });
    return;
  }

  if (typeof role !== 'undefined' && !isValidEmployeeRole(role)) {
    res.status(400).json({ error: 'validation', message: 'role must be admin or user' });
    return;
  }

  const existing = await prisma.employee.findUnique({
    where: { id },
    select: { id: true, role: true, email: true, isActive: true }
  });

  if (!existing) {
    res.status(404).json({ error: 'not_found', message: 'Employee not found' });
    return;
  }

  const nextRole = role ?? existing.role;
  const nextIsActive = typeof isActive === 'boolean' ? isActive : existing.isActive;

  if (existing.role === 'admin' && (nextRole !== 'admin' || !nextIsActive)) {
    const adminCount = await prisma.employee.count({ where: { role: 'admin', isActive: true } });
    if (adminCount <= 1) {
      res.status(409).json({ error: 'conflict', message: 'Mindestens ein Admin muss erhalten bleiben.' });
      return;
    }
  }

  try {
    const updated = await prisma.employee.update({
      where: { id },
      data: {
        ...(typeof trimmedDisplayName === 'string' ? { displayName: trimmedDisplayName } : {}),
        ...(typeof isActive === 'boolean' ? { isActive } : {}),
        ...(typeof role === 'string' ? { role } : {})
      },
      select: employeeSelect
    });

    res.status(200).json(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Employee not found' });
      return;
    }

    throw error;
  }
});

app.delete('/admin/employees/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    const updated = await prisma.employee.update({
      where: { id },
      data: { isActive: false },
      select: employeeSelect
    });

    res.status(200).json(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Employee not found' });
      return;
    }

    throw error;
  }
});

app.get('/me', async (req, res) => {
  const userEmail = getRequestUserEmail(req);

  if (userEmail) {
    const employee = await prisma.employee.findUnique({
      where: { email: userEmail },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true
      }
    });

    if (employee?.isActive) {
      res.status(200).json({
        id: employee.id,
        email: employee.email,
        displayName: employee.displayName,
        role: employee.role
      });
      return;
    }
  }

  res.status(200).json({
    id: 'demo-user',
    email: 'demo@example.com',
    displayName: 'Demo User',
    role: 'user'
  });
});

app.get('/floorplans', async (_req, res) => {
  const floorplans = await prisma.floorplan.findMany({ orderBy: { createdAt: 'desc' } });
  res.status(200).json(floorplans);
});

app.get('/floorplans/:id', async (req, res) => {
  const floorplan = await prisma.floorplan.findUnique({ where: { id: req.params.id } });

  if (!floorplan) {
    res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
    return;
  }

  res.status(200).json(floorplan);
});

app.get('/floorplans/:id/desks', async (req, res) => {
  const desks = await prisma.desk.findMany({
    where: { floorplanId: req.params.id },
    orderBy: { createdAt: 'asc' }
  });

  res.status(200).json(desks);
});

app.post('/bookings', async (req, res) => {
  const { deskId, userEmail, date } = req.body as { deskId?: string; userEmail?: string; date?: string };

  if (!deskId || !userEmail || !date) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail and date are required' });
    return;
  }

  const parsedDate = toDateOnly(date);
  if (!parsedDate) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const existingBooking = await prisma.booking.findUnique({
    where: {
      deskId_date: {
        deskId,
        date: parsedDate
      }
    }
  });

  if (existingBooking) {
    sendConflict(res, 'Desk is already booked for this date', {
      deskId,
      date,
      bookingId: existingBooking.id
    });
    return;
  }

  const recurringConflict = await prisma.recurringBooking.findFirst({
    where: {
      deskId,
      weekday: parsedDate.getUTCDay(),
      validFrom: { lte: parsedDate },
      OR: [{ validTo: null }, { validTo: { gte: parsedDate } }]
    }
  });

  if (recurringConflict) {
    sendConflict(res, 'Desk has a recurring booking conflict for this date', {
      deskId,
      date,
      recurringBookingId: recurringConflict.id
    });
    return;
  }

  const normalizedUserEmail = normalizeEmail(userEmail);
  const booking = await prisma.booking.create({
    data: {
      deskId,
      userEmail: normalizedUserEmail,
      date: parsedDate
    }
  });

  res.status(201).json(booking);
});

app.post('/bookings/range', async (req, res) => {
  const { deskId, userEmail, from, to, weekdaysOnly } = req.body as {
    deskId?: string;
    userEmail?: string;
    from?: string;
    to?: string;
    weekdaysOnly?: boolean;
  };

  if (!deskId || !userEmail || !from || !to) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail, from and to are required' });
    return;
  }

  const parsedFrom = toDateOnly(from);
  const parsedTo = toDateOnly(to);
  if (!parsedFrom || !parsedTo) {
    res.status(400).json({ error: 'validation', message: 'from/to must be in YYYY-MM-DD format' });
    return;
  }

  if (parsedTo < parsedFrom) {
    res.status(400).json({ error: 'validation', message: 'to must be on or after from' });
    return;
  }

  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const includeWeekdaysOnly = weekdaysOnly !== false;
  const targetDates = datesInRange(parsedFrom, parsedTo).filter((date) => {
    if (!includeWeekdaysOnly) {
      return true;
    }

    const day = date.getUTCDay();
    return day >= 1 && day <= 5;
  });

  if (targetDates.length === 0) {
    res.status(201).json({ createdCount: 0, dates: [] });
    return;
  }

  const [singleConflicts, recurringRules] = await Promise.all([
    prisma.booking.findMany({
      where: {
        deskId,
        date: { in: targetDates }
      },
      orderBy: { date: 'asc' }
    }),
    prisma.recurringBooking.findMany({
      where: {
        deskId,
        validFrom: { lte: parsedTo },
        OR: [{ validTo: null }, { validTo: { gte: parsedFrom } }]
      }
    })
  ]);

  const conflictDates = new Set(singleConflicts.map((booking) => toISODateOnly(booking.date)));
  for (const date of targetDates) {
    if (conflictDates.has(toISODateOnly(date))) {
      continue;
    }

    const recurringConflict = recurringRules.find(
      (rule) => rule.weekday === date.getUTCDay() && isDateWithinRange(date, rule.validFrom, rule.validTo)
    );
    if (recurringConflict) {
      conflictDates.add(toISODateOnly(date));
    }
  }

  if (conflictDates.size > 0) {
    const sortedConflicts = Array.from(conflictDates).sort();
    sendConflict(res, 'Range booking has conflicting dates', {
      deskId,
      from,
      to,
      weekdaysOnly: includeWeekdaysOnly,
      conflictingDates: sortedConflicts,
      conflictingDatesPreview: sortedConflicts.slice(0, 10)
    });
    return;
  }

  const normalizedUserEmail = normalizeEmail(userEmail);
  const created = await prisma.$transaction(async (tx) => {
    await tx.booking.createMany({
      data: targetDates.map((date) => ({ deskId, userEmail: normalizedUserEmail, date }))
    });

    return targetDates.map((date) => toISODateOnly(date));
  });

  res.status(201).json({ createdCount: created.length, dates: created });
});

app.get('/bookings', async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const where: Prisma.BookingWhereInput = {};

  if (from || to) {
    where.date = {};

    if (from) {
      const fromDate = toDateOnly(from);
      if (!fromDate) {
        res.status(400).json({ error: 'validation', message: 'from must be in YYYY-MM-DD format' });
        return;
      }
      where.date.gte = fromDate;
    }

    if (to) {
      const toDate = toDateOnly(to);
      if (!toDate) {
        res.status(400).json({ error: 'validation', message: 'to must be in YYYY-MM-DD format' });
        return;
      }
      where.date.lte = toDate;
    }
  }

  if (floorplanId) {
    where.desk = { floorplanId };
  }

  const bookings = await prisma.booking.findMany({
    where,
    select: {
      id: true,
      deskId: true,
      userEmail: true,
      date: true,
      createdAt: true
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
  });

  const employeesByEmail = await getActiveEmployeesByEmail(bookings.map((booking) => booking.userEmail));
  const enrichedBookings = bookings.map((booking) => ({
    ...booking,
    userDisplayName: employeesByEmail.get(normalizeEmail(booking.userEmail))?.displayName
  }));

  res.status(200).json(enrichedBookings);
});

app.get('/occupancy', async (req, res) => {
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;

  if (!floorplanId || !date) {
    res.status(400).json({ error: 'validation', message: 'floorplanId and date are required' });
    return;
  }

  const parsedDate = toDateOnly(date);
  if (!parsedDate) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const desks = await prisma.desk.findMany({
    where: { floorplanId },
    orderBy: { createdAt: 'asc' }
  });

  const deskIds = desks.map((desk) => desk.id);
  const weekday = parsedDate.getUTCDay();

  const [singleBookings, recurringBookings] = await Promise.all([
    prisma.booking.findMany({
      where: {
        date: parsedDate,
        deskId: { in: deskIds }
      }
    }),
    prisma.recurringBooking.findMany({
      where: {
        deskId: { in: deskIds },
        weekday,
        validFrom: { lte: parsedDate },
        OR: [{ validTo: null }, { validTo: { gte: parsedDate } }]
      },
      orderBy: { createdAt: 'asc' }
    })
  ]);

  const employeesByEmail = await getActiveEmployeesByEmail([
    ...singleBookings.map((booking) => booking.userEmail),
    ...recurringBookings.map((booking) => booking.userEmail)
  ]);

  const singleByDeskId = new Map(singleBookings.map((booking) => [booking.deskId, booking]));
  const recurringByDeskId = new Map(recurringBookings.map((booking) => [booking.deskId, booking]));

  const occupancyDesks = desks.map((desk) => {
    const single = singleByDeskId.get(desk.id);
    if (single) {
      return {
        id: desk.id,
        name: desk.name,
        x: desk.x,
        y: desk.y,
        status: 'booked' as const,
        booking: {
          id: single.id,
          userEmail: single.userEmail,
          userDisplayName: employeesByEmail.get(normalizeEmail(single.userEmail))?.displayName,
          deskName: desk.name,
        deskId: desk.id,
          type: 'single' as const
        }
      };
    }

    const recurring = recurringByDeskId.get(desk.id);
    if (recurring) {
      return {
        id: desk.id,
        name: desk.name,
        x: desk.x,
        y: desk.y,
        status: 'booked' as const,
        booking: {
          id: recurring.id,
          userEmail: recurring.userEmail,
          userDisplayName: employeesByEmail.get(normalizeEmail(recurring.userEmail))?.displayName,
          deskName: desk.name,
        deskId: desk.id,
          type: 'recurring' as const
        }
      };
    }

    return {
      id: desk.id,
      name: desk.name,
      x: desk.x,
      y: desk.y,
      status: 'free' as const,
      booking: null
    };
  });

  const uniquePeopleByEmail = new Map<string, { email: string; userEmail: string; displayName?: string; deskName?: string; deskId?: string }>();
  occupancyDesks
    .filter((desk) => desk.booking)
    .forEach((desk) => {
      const userEmail = desk.booking?.userEmail ?? '';
      const normalizedEmail = normalizeEmail(userEmail);
      if (!userEmail || uniquePeopleByEmail.has(normalizedEmail)) {
        return;
      }

      uniquePeopleByEmail.set(normalizedEmail, {
        email: userEmail,
        userEmail,
        displayName: employeesByEmail.get(normalizedEmail)?.displayName,
        deskName: desk.name,
        deskId: desk.id
      });
    });

  const people = Array.from(uniquePeopleByEmail.values())
    .sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email, 'de'));

  res.status(200).json({
    date: toISODateOnly(parsedDate),
    floorplanId,
    desks: occupancyDesks,
    people
  });
});

app.post('/recurring-bookings', async (req, res) => {
  const { deskId, userEmail, weekday, validFrom, validTo } = req.body as {
    deskId?: string;
    userEmail?: string;
    weekday?: number;
    validFrom?: string;
    validTo?: string | null;
  };

  if (!deskId || !userEmail || typeof weekday !== 'number' || !validFrom) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail, weekday and validFrom are required' });
    return;
  }

  if (weekday < 0 || weekday > 6) {
    res.status(400).json({ error: 'validation', message: 'weekday must be between 0 and 6' });
    return;
  }

  const parsedValidFrom = toDateOnly(validFrom);
  const parsedValidTo = validTo ? toDateOnly(validTo) : null;

  if (!parsedValidFrom || (validTo && !parsedValidTo)) {
    res.status(400).json({ error: 'validation', message: 'validFrom/validTo must be in YYYY-MM-DD format' });
    return;
  }


  if (parsedValidTo && parsedValidTo < parsedValidFrom) {
    res.status(400).json({ error: 'validation', message: 'validTo must be on or after validFrom' });
    return;
  }

  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const existingBookings = await prisma.booking.findMany({
    where: {
      deskId,
      date: {
        gte: parsedValidFrom,
        ...(parsedValidTo ? { lte: parsedValidTo } : {})
      }
    },
    orderBy: { date: 'asc' }
  });

  const conflictingBooking = existingBookings.find((booking) => {
    return booking.date.getUTCDay() === weekday && isDateWithinRange(booking.date, parsedValidFrom, parsedValidTo);
  });

  if (conflictingBooking) {
    sendConflict(res, 'Recurring booking conflicts with an existing single-day booking', {
      deskId,
      weekday,
      validFrom,
      validTo: validTo ?? null,
      bookingId: conflictingBooking.id,
      bookingDate: conflictingBooking.date.toISOString().slice(0, 10)
    });
    return;
  }

  const normalizedUserEmail = normalizeEmail(userEmail);

  const recurringBooking = await prisma.recurringBooking.create({
    data: {
      deskId,
      userEmail: normalizedUserEmail,
      weekday,
      validFrom: parsedValidFrom,
      validTo: parsedValidTo
    }
  });

  res.status(201).json(recurringBooking);
});

app.post('/recurring-bookings/bulk', async (req, res) => {
  const { deskId, userEmail, weekdays, validFrom, validTo } = req.body as {
    deskId?: string;
    userEmail?: string;
    weekdays?: number[];
    validFrom?: string;
    validTo?: string;
  };

  if (!deskId || !userEmail || !Array.isArray(weekdays) || !validFrom) {
    res.status(400).json({ error: 'validation', message: 'deskId, userEmail, weekdays and validFrom are required' });
    return;
  }

  const uniqueWeekdays = Array.from(new Set(weekdays));
  if (uniqueWeekdays.length !== weekdays.length || uniqueWeekdays.length === 0) {
    res.status(400).json({ error: 'validation', message: 'weekdays must be unique and non-empty' });
    return;
  }

  if (uniqueWeekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6)) {
    res.status(400).json({ error: 'validation', message: 'weekdays must contain values between 0 and 6' });
    return;
  }

  const parsedValidFrom = toDateOnly(validFrom);
  const parsedValidTo = validTo ? toDateOnly(validTo) : endOfCurrentYear();
  if (!parsedValidFrom || !parsedValidTo) {
    res.status(400).json({ error: 'validation', message: 'validFrom/validTo must be in YYYY-MM-DD format' });
    return;
  }

  if (parsedValidTo < parsedValidFrom) {
    res.status(400).json({ error: 'validation', message: 'validTo must be on or after validFrom' });
    return;
  }

  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) {
    res.status(404).json({ error: 'not_found', message: 'Desk not found' });
    return;
  }

  const overlappingRecurring = await prisma.recurringBooking.findMany({
    where: {
      deskId,
      weekday: { in: uniqueWeekdays },
      validFrom: { lte: parsedValidTo },
      OR: [{ validTo: null }, { validTo: { gte: parsedValidFrom } }]
    },
    orderBy: [{ weekday: 'asc' }, { validFrom: 'asc' }]
  });

  if (overlappingRecurring.length > 0) {
    sendConflict(res, 'Recurring series conflicts with existing recurring booking', {
      deskId,
      weekdays: uniqueWeekdays,
      validFrom,
      validTo: toISODateOnly(parsedValidTo),
      conflicts: overlappingRecurring.slice(0, 10).map((conflict) => ({
        id: conflict.id,
        weekday: conflict.weekday,
        validFrom: toISODateOnly(conflict.validFrom),
        validTo: conflict.validTo ? toISODateOnly(conflict.validTo) : null
      }))
    });
    return;
  }

  const targetDates = datesInRange(parsedValidFrom, parsedValidTo).filter((date) => uniqueWeekdays.includes(date.getUTCDay()));
  const conflictingSingles = await prisma.booking.findMany({
    where: {
      deskId,
      date: { in: targetDates }
    },
    orderBy: { date: 'asc' }
  });

  if (conflictingSingles.length > 0) {
    const conflictingDates = conflictingSingles.map((booking) => toISODateOnly(booking.date));
    sendConflict(res, 'Recurring series conflicts with existing single-day bookings', {
      deskId,
      weekdays: uniqueWeekdays,
      validFrom,
      validTo: toISODateOnly(parsedValidTo),
      conflictingDates,
      conflictingDatesPreview: conflictingDates.slice(0, 10)
    });
    return;
  }

  const normalizedUserEmail = normalizeEmail(userEmail);
  const recurringBookings = await prisma.$transaction(
    uniqueWeekdays.map((weekday) =>
      prisma.recurringBooking.create({
        data: {
          deskId,
          userEmail: normalizedUserEmail,
          weekday,
          validFrom: parsedValidFrom,
          validTo: parsedValidTo
        }
      })
    )
  );

  res.status(201).json(recurringBookings);
});

app.get('/recurring-bookings', async (req, res) => {
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const recurringBookings = await prisma.recurringBooking.findMany({
    where: floorplanId ? { desk: { floorplanId } } : undefined,
    orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }]
  });

  res.status(200).json(recurringBookings);
});

app.post('/admin/floorplans', requireAdmin, async (req, res) => {
  const { name, imageUrl } = req.body as { name?: string; imageUrl?: string };

  if (!name || !imageUrl) {
    res.status(400).json({ error: 'validation', message: 'name and imageUrl are required' });
    return;
  }

  const floorplan = await prisma.floorplan.create({ data: { name, imageUrl } });
  res.status(201).json(floorplan);
});

app.patch('/admin/floorplans/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { name, imageUrl } = req.body as { name?: string; imageUrl?: string };
  if (typeof name === 'undefined' && typeof imageUrl === 'undefined') {
    res.status(400).json({ error: 'validation', message: 'name or imageUrl must be provided' });
    return;
  }

  if (typeof name === 'string' && name.trim().length === 0) {
    res.status(400).json({ error: 'validation', message: 'name must not be empty' });
    return;
  }

  try {
    const updatedFloorplan = await prisma.floorplan.update({
      where: { id },
      data: {
        ...(typeof name === 'string' ? { name: name.trim() } : {}),
        ...(typeof imageUrl === 'string' ? { imageUrl } : {})
      }
    });
    res.status(200).json(updatedFloorplan);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
      return;
    }
    throw error;
  }
});

app.delete('/admin/floorplans/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    await prisma.floorplan.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
      return;
    }

    throw error;
  }
});

app.post('/admin/floorplans/:id/desks', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { name, x, y } = req.body as { name?: string; x?: number; y?: number };

  if (!name || typeof x !== 'number' || typeof y !== 'number') {
    res.status(400).json({ error: 'validation', message: 'name, x and y are required' });
    return;
  }

  const floorplan = await prisma.floorplan.findUnique({ where: { id } });
  if (!floorplan) {
    res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
    return;
  }

  const desk = await prisma.desk.create({ data: { floorplanId: id, name, x, y } });
  res.status(201).json(desk);
});

app.delete('/admin/desks/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    await prisma.desk.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Desk not found' });
      return;
    }
    throw error;
  }
});

app.patch('/admin/desks/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { name, x, y } = req.body as { name?: string; x?: number; y?: number };
  const hasName = typeof name !== 'undefined';
  const hasX = typeof x !== 'undefined';
  const hasY = typeof y !== 'undefined';

  if (!hasName && !hasX && !hasY) {
    res.status(400).json({ error: 'validation', message: 'name, x or y must be provided' });
    return;
  }

  if (hasName && name.trim().length === 0) {
    res.status(400).json({ error: 'validation', message: 'name must not be empty' });
    return;
  }

  if (hasX && typeof x !== 'number') {
    res.status(400).json({ error: 'validation', message: 'x must be a number' });
    return;
  }

  if (hasY && typeof y !== 'number') {
    res.status(400).json({ error: 'validation', message: 'y must be a number' });
    return;
  }

  const data: { name?: string; x?: number; y?: number } = {};
  if (hasName) data.name = name.trim();
  if (hasX) data.x = x;
  if (hasY) data.y = y;

  try {
    const updatedDesk = await prisma.desk.update({ where: { id }, data });
    res.status(200).json(updatedDesk);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Desk not found' });
      return;
    }
    throw error;
  }
});

app.get('/admin/bookings', requireAdmin, async (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  if (!date) {
    res.status(400).json({ error: 'validation', message: 'date is required' });
    return;
  }

  const parsedDate = toDateOnly(date);
  if (!parsedDate) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const bookings = await prisma.booking.findMany({
    where: {
      date: parsedDate,
      ...(floorplanId ? { desk: { floorplanId } } : {})
    },
    include: {
      desk: {
        select: {
          id: true,
          name: true,
          floorplanId: true
        }
      }
    },
    orderBy: [{ createdAt: 'asc' }]
  });

  res.status(200).json(bookings);
});

app.delete('/admin/bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    await prisma.booking.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Booking not found' });
      return;
    }
    throw error;
  }
});

app.patch('/admin/bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { userEmail, date } = req.body as { userEmail?: string; date?: string };

  if (!userEmail && !date) {
    res.status(400).json({ error: 'validation', message: 'userEmail or date must be provided' });
    return;
  }

  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'not_found', message: 'Booking not found' });
    return;
  }

  const nextDateValue = date ? toDateOnly(date) : existing.date;
  if (date && !nextDateValue) {
    res.status(400).json({ error: 'validation', message: 'date must be in YYYY-MM-DD format' });
    return;
  }

  const nextDate = nextDateValue as Date;

  if (nextDate.getTime() !== existing.date.getTime()) {
    const conflictingBooking = await prisma.booking.findFirst({
      where: {
        id: { not: existing.id },
        deskId: existing.deskId,
        date: nextDate
      }
    });

    if (conflictingBooking) {
      sendConflict(res, 'Desk is already booked for this date', {
        deskId: existing.deskId,
        date,
        bookingId: conflictingBooking.id
      });
      return;
    }

    const recurringConflict = await prisma.recurringBooking.findFirst({
      where: {
        deskId: existing.deskId,
        weekday: nextDate.getUTCDay(),
        validFrom: { lte: nextDate },
        OR: [{ validTo: null }, { validTo: { gte: nextDate } }]
      }
    });

    if (recurringConflict) {
      sendConflict(res, 'Desk has a recurring booking conflict for this date', {
        deskId: existing.deskId,
        date,
        recurringBookingId: recurringConflict.id
      });
      return;
    }
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: {
      ...(userEmail ? { userEmail: normalizeEmail(userEmail) } : {}),
      ...(date ? { date: nextDate } : {})
    }
  });

  res.status(200).json(updated);
});

app.get('/admin/recurring-bookings', requireAdmin, async (req, res) => {
  const floorplanId = typeof req.query.floorplanId === 'string' ? req.query.floorplanId : undefined;

  const recurringBookings = await prisma.recurringBooking.findMany({
    where: floorplanId ? { desk: { floorplanId } } : undefined,
    include: {
      desk: {
        select: {
          id: true,
          name: true,
          floorplanId: true
        }
      }
    },
    orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }]
  });

  res.status(200).json(recurringBookings);
});

app.delete('/admin/recurring-bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  try {
    await prisma.recurringBooking.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Recurring booking not found' });
      return;
    }
    throw error;
  }
});

app.patch('/admin/recurring-bookings/:id', requireAdmin, async (req, res) => {
  const id = getRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'validation', message: 'id is required' });
    return;
  }

  const { userEmail, weekday, validFrom, validTo } = req.body as {
    userEmail?: string;
    weekday?: number;
    validFrom?: string;
    validTo?: string | null;
  };

  if (!userEmail && typeof weekday !== 'number' && !validFrom && typeof validTo === 'undefined') {
    res.status(400).json({ error: 'validation', message: 'No fields to update' });
    return;
  }

  const existing = await prisma.recurringBooking.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'not_found', message: 'Recurring booking not found' });
    return;
  }

  if (typeof weekday === 'number' && (weekday < 0 || weekday > 6)) {
    res.status(400).json({ error: 'validation', message: 'weekday must be between 0 and 6' });
    return;
  }

  const parsedValidFromValue = validFrom ? toDateOnly(validFrom) : existing.validFrom;
  const parsedValidTo =
    typeof validTo === 'undefined' ? existing.validTo : validTo === null || validTo === '' ? null : toDateOnly(validTo);

  if ((validFrom && !parsedValidFromValue) || (typeof validTo === 'string' && validTo !== '' && !parsedValidTo)) {
    res.status(400).json({ error: 'validation', message: 'validFrom/validTo must be in YYYY-MM-DD format' });
    return;
  }

  const parsedValidFrom = parsedValidFromValue as Date;

  if (parsedValidTo && parsedValidTo < parsedValidFrom) {
    res.status(400).json({ error: 'validation', message: 'validTo must be on or after validFrom' });
    return;
  }

  const updated = await prisma.recurringBooking.update({
    where: { id },
    data: {
      ...(userEmail ? { userEmail: normalizeEmail(userEmail) } : {}),
      ...(typeof weekday === 'number' ? { weekday } : {}),
      ...(validFrom ? { validFrom: parsedValidFrom } : {}),
      ...(typeof validTo !== 'undefined' ? { validTo: parsedValidTo } : {})
    }
  });

  res.status(200).json(updated);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`API listening on ${port}`);
});
