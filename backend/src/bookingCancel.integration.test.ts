import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { app } from './index';
import { prisma } from './prisma';

type BookingFixture = {
  id: string;
  bookedFor: 'SELF' | 'GUEST';
  userEmail: string | null;
  employeeId: string | null;
  createdByEmployeeId: string;
  recurringBookingId?: string | null;
  recurringGroupId?: string | null;
  desk: { kind: 'RAUM' | 'TISCH' | 'PARKPLATZ' | 'SONSTIGES' };
};

const bookings = new Map<string, BookingFixture>();
beforeEach(() => {
  bookings.clear();

  bookings.set('booking-b-self', {
    id: 'booking-b-self',
    bookedFor: 'SELF',
    userEmail: 'user-b@example.com',
    employeeId: 'user-b',
    createdByEmployeeId: 'user-b',
    desk: { kind: 'RAUM' }
  });

  bookings.set('booking-a-guest', {
    id: 'booking-a-guest',
    bookedFor: 'GUEST',
    userEmail: null,
    employeeId: null,
    createdByEmployeeId: 'user-a',
    desk: { kind: 'RAUM' }
  });

  bookings.set('booking-series-a-1', {
    id: 'booking-series-a-1',
    bookedFor: 'SELF',
    userEmail: 'user-a@example.com',
    employeeId: 'user-a',
    createdByEmployeeId: 'user-a',
    recurringBookingId: 'series-a',
    recurringGroupId: 'group-a',
    desk: { kind: 'TISCH' }
  });

  bookings.set('booking-series-a-2', {
    id: 'booking-series-a-2',
    bookedFor: 'SELF',
    userEmail: 'user-a@example.com',
    employeeId: 'user-a',
    createdByEmployeeId: 'user-a',
    recurringBookingId: 'series-a',
    recurringGroupId: 'group-a',
    desk: { kind: 'PARKPLATZ' }
  });

  (prisma.booking.findUnique as unknown) = async ({ where: { id } }: { where: { id: string } }) => bookings.get(id) ?? null;
  (prisma.booking.delete as unknown) = async ({ where: { id } }: { where: { id: string } }) => {
    const booking = bookings.get(id);
    if (!booking) throw new Error('booking not found');
    bookings.delete(id);
    return booking;
  };
  (prisma.booking.findMany as unknown) = async ({ where }: { where: { OR?: Array<{ recurringBookingId?: string; recurringGroupId?: string }> } }) => {
    const clauses = where?.OR ?? [];
    return Array.from(bookings.values())
      .filter((booking) => clauses.some((clause) => (
        (clause.recurringBookingId && booking.recurringBookingId === clause.recurringBookingId)
        || (clause.recurringGroupId && booking.recurringGroupId === clause.recurringGroupId)
      )))
      .map((booking) => ({ recurringBookingId: booking.recurringBookingId ?? null }));
  };
  (prisma.booking.deleteMany as unknown) = async ({ where }: { where: { OR?: Array<{ recurringBookingId?: string; recurringGroupId?: string }> } }) => {
    const clauses = where?.OR ?? [];
    let count = 0;
    for (const [id, booking] of Array.from(bookings.entries())) {
      const matches = clauses.some((clause) => (
        (clause.recurringBookingId && booking.recurringBookingId === clause.recurringBookingId)
        || (clause.recurringGroupId && booking.recurringGroupId === clause.recurringGroupId)
      ));
      if (matches) {
        bookings.delete(id);
        count += 1;
      }
    }
    return { count };
  };
  (prisma.recurringBooking.deleteMany as unknown) = async () => ({ count: 1 });
  (prisma.$transaction as unknown) = async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma);
});

const cancelAs = async ({ bookingId, userId, email, role = 'user', scope = 'single' }: { bookingId: string; userId: string; email: string; role?: 'user' | 'admin'; scope?: 'single' | 'series' }) => {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/bookings/${bookingId}?scope=${scope}`, {
      method: 'DELETE',
      headers: {
        'x-dev-user': userId,
        'x-dev-user-id': userId,
        'x-dev-user-email': email,
        'x-dev-user-role': role
      }
    });

    return response;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

test('A cancels B_SELF -> 403', async () => {
  const response = await cancelAs({ bookingId: 'booking-b-self', userId: 'user-a', email: 'user-a@example.com' });
  assert.equal(response.status, 403);
  assert.equal(bookings.has('booking-b-self'), true);
});

test('B cancels B_SELF -> 200', async () => {
  const response = await cancelAs({ bookingId: 'booking-b-self', userId: 'user-b', email: 'user-b@example.com' });
  assert.equal(response.status, 200);
  assert.equal(bookings.has('booking-b-self'), false);
});

test('B cancels A_GUEST -> 403', async () => {
  const response = await cancelAs({ bookingId: 'booking-a-guest', userId: 'user-b', email: 'user-b@example.com' });
  assert.equal(response.status, 403);
  assert.equal(bookings.has('booking-a-guest'), true);
});

test('A cancels A_GUEST -> 200', async () => {
  const response = await cancelAs({ bookingId: 'booking-a-guest', userId: 'user-a', email: 'user-a@example.com' });
  assert.equal(response.status, 200);
  assert.equal(bookings.has('booking-a-guest'), false);
});

test('Admin cancels B_SELF -> 200', async () => {
  const response = await cancelAs({ bookingId: 'booking-b-self', userId: 'admin-user', email: 'admin@example.com', role: 'admin' });
  assert.equal(response.status, 200);
  assert.equal(bookings.has('booking-b-self'), false);
});


test('Series cancel deletes all occurrences for non-room resources', async () => {
  const response = await cancelAs({ bookingId: 'booking-series-a-1', userId: 'user-a', email: 'user-a@example.com', scope: 'series' });
  assert.equal(response.status, 200);
  assert.equal(bookings.has('booking-series-a-1'), false);
  assert.equal(bookings.has('booking-series-a-2'), false);
});

test('Single cancel keeps remaining series occurrences', async () => {
  const response = await cancelAs({ bookingId: 'booking-series-a-1', userId: 'user-a', email: 'user-a@example.com', scope: 'single' });
  assert.equal(response.status, 200);
  assert.equal(bookings.has('booking-series-a-1'), false);
  assert.equal(bookings.has('booking-series-a-2'), true);
});
