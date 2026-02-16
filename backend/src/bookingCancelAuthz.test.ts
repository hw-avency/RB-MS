import test from 'node:test';
import assert from 'node:assert/strict';
import { canCancelBooking } from './auth/bookingAuth';

test('User A cancels A SELF -> allowed', () => {
  const allowed = canCancelBooking({
    booking: { bookedFor: 'SELF', userId: 'user-a', createdByUserId: 'user-a' },
    actor: { userId: 'user-a', isAdmin: false }
  });
  assert.equal(allowed, true);
});

test('User A cancels B SELF -> forbidden', () => {
  const allowed = canCancelBooking({
    booking: { bookedFor: 'SELF', userId: 'user-b', createdByUserId: 'user-a' },
    actor: { userId: 'user-a', isAdmin: false }
  });
  assert.equal(allowed, false);
});

test('User A cancels A GUEST (created by A) -> allowed', () => {
  const allowed = canCancelBooking({
    booking: { bookedFor: 'GUEST', userId: null, createdByUserId: 'user-a' },
    actor: { userId: 'user-a', isAdmin: false }
  });
  assert.equal(allowed, true);
});

test('User A cancels B GUEST (created by B) -> forbidden', () => {
  const allowed = canCancelBooking({
    booking: { bookedFor: 'GUEST', userId: null, createdByUserId: 'user-b' },
    actor: { userId: 'user-a', isAdmin: false }
  });
  assert.equal(allowed, false);
});

test('Admin cancels any booking -> allowed', () => {
  const selfAllowed = canCancelBooking({
    booking: { bookedFor: 'SELF', userId: 'user-b', createdByUserId: 'user-b' },
    actor: { userId: 'admin-user', isAdmin: true }
  });
  const guestAllowed = canCancelBooking({
    booking: { bookedFor: 'GUEST', userId: null, createdByUserId: 'user-b' },
    actor: { userId: 'admin-user', isAdmin: true }
  });

  assert.equal(selfAllowed, true);
  assert.equal(guestAllowed, true);
});
