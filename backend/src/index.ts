import cors from 'cors';
import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

app.get('/me', (_req, res) => {
  res.status(200).json({
    id: 'demo-user',
    email: 'demo@example.com',
    displayName: 'Demo User',
    role: 'user'
  });
});

app.post('/floorplans', async (req, res) => {
  const { name, imageUrl } = req.body as { name?: string; imageUrl?: string };

  if (!name || !imageUrl) {
    res.status(400).json({ error: 'validation', message: 'name and imageUrl are required' });
    return;
  }

  const floorplan = await prisma.floorplan.create({
    data: { name, imageUrl }
  });

  res.status(201).json(floorplan);
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

app.delete('/floorplans/:id', async (req, res) => {
  try {
    await prisma.floorplan.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
      return;
    }

    throw error;
  }
});

app.post('/floorplans/:id/desks', async (req, res) => {
  const { name, x, y } = req.body as { name?: string; x?: number; y?: number };

  if (!name || typeof x !== 'number' || typeof y !== 'number') {
    res.status(400).json({ error: 'validation', message: 'name, x and y are required' });
    return;
  }

  const floorplan = await prisma.floorplan.findUnique({ where: { id: req.params.id } });
  if (!floorplan) {
    res.status(404).json({ error: 'not_found', message: 'Floorplan not found' });
    return;
  }

  const desk = await prisma.desk.create({
    data: {
      floorplanId: req.params.id,
      name,
      x,
      y
    }
  });

  res.status(201).json(desk);
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
    validTo?: string;
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

app.listen(port, '0.0.0.0', () => {
  console.log(`API listening on ${port}`);
});
