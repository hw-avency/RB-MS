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

const requireAdmin: express.RequestHandler = (req, res, next) => {
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

  if (payload.role !== 'admin') {
    res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
    return;
  }

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

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch {
    res.status(500).json({ status: 'error' });
  }
});

app.post('/admin/login', (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'validation', message: 'email and password are required' });
    return;
  }

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
    return;
  }

  const token = createAdminToken(email);
  res.status(200).json({ token });
});

app.get('/me', (_req, res) => {
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

  const booking = await prisma.booking.create({
    data: {
      deskId,
      userEmail,
      date: parsedDate
    }
  });

  res.status(201).json(booking);
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

  res.status(200).json(bookings);
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

  const floorplan = await prisma.floorplan.findUnique({ where: { id: floorplanId } });
  if (!floorplan) {
    res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
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
          userEmail: single.userEmail,
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
          userEmail: recurring.userEmail,
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

  const people = Array.from(
    new Set(occupancyDesks.filter((desk) => desk.booking).map((desk) => desk.booking?.userEmail ?? ''))
  )
    .filter((userEmail) => userEmail.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .map((userEmail) => ({ userEmail }));

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

  const recurringBooking = await prisma.recurringBooking.create({
    data: {
      deskId,
      userEmail,
      weekday,
      validFrom: parsedValidFrom,
      validTo: parsedValidTo
    }
  });

  res.status(201).json(recurringBooking);
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
      ...(userEmail ? { userEmail } : {}),
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
      ...(userEmail ? { userEmail } : {}),
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
