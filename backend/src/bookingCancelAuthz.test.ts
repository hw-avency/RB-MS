import test from 'node:test';
import assert from 'node:assert/strict';
import { canCancelBooking } from './auth/bookingAuth';

test('User A cancels A SELF -> allowed', () => {
  const allowed = canCancelBooking({
    booking: { bookedFor: 'SELF', userEmail: 'user-a@example.com', createdByEmployeeId: 'emp-a' },
    actor: { employeeId: 'emp-a', email: 'user-a@example.com', isAdmin: false }
  });
  assert.equal(allowed, true);
});

test('User A cancels B SELF -> forbidden', () => {
  const allowed = canCancelBooking({
    booking: { bookedFor: 'SELF', userEmail: 'user-b@example.com', createdByEmployeeId: 'emp-b' },
    actor: { employeeId: 'emp-a', email: 'user-a@example.com', isAdmin: false }
  });
  assert.equal(allowed, false);
});

test('User A cancels A GUEST (created by A) -> allowed', () => {
  const allowed = canCancelBooking({
    booking: { bookedFor: 'GUEST', userEmail: null, createdByEmployeeId: 'emp-a' },
    actor: { employeeId: 'emp-a', email: 'user-a@example.com', isAdmin: false }
  });
  assert.equal(allowed, true);
});

test('User A cancels B GUEST (created by B) -> forbidden', () => {
  const allowed = canCancelBooking({
    booking: { bookedFor: 'GUEST', userEmail: null, createdByEmployeeId: 'emp-b' },
    actor: { employeeId: 'emp-a', email: 'user-a@example.com', isAdmin: false }
  });
  assert.equal(allowed, false);
});

test('Admin cancels any booking -> allowed', () => {
  const selfAllowed = canCancelBooking({
    booking: { bookedFor: 'SELF', userEmail: 'user-b@example.com', createdByEmployeeId: 'emp-b' },
    actor: { employeeId: 'emp-admin', email: 'admin@example.com', isAdmin: true }
  });
  const guestAllowed = canCancelBooking({
    booking: { bookedFor: 'GUEST', userEmail: null, createdByEmployeeId: 'emp-b' },
    actor: { employeeId: 'emp-admin', email: 'admin@example.com', isAdmin: true }
  });

  assert.equal(selfAllowed, true);
  assert.equal(guestAllowed, true);
});
