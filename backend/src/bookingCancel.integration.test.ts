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

  (prisma.booking.findUnique as unknown) = async ({ where: { id } }: { where: { id: string } }) => bookings.get(id) ?? null;
  (prisma.booking.delete as unknown) = async ({ where: { id } }: { where: { id: string } }) => {
    const booking = bookings.get(id);
    if (!booking) throw new Error('booking not found');
    bookings.delete(id);
    return booking;
  };
});

const cancelAs = async ({ bookingId, userId, email, role = 'user' }: { bookingId: string; userId: string; email: string; role?: 'user' | 'admin' }) => {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/bookings/${bookingId}`, {
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
