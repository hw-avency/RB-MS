import test from 'node:test';
import assert from 'node:assert/strict';
import { canCancelBooking } from './bookingCancelAuthz';

test('User A cancels A SELF -> allowed', () => {
  const allowed = canCancelBooking({ bookedFor: 'SELF', userId: 'user-a', createdByUserId: 'user-a' }, { id: 'user-a', role: 'user' });
  assert.equal(allowed, true);
});

test('User A cancels B SELF -> forbidden', () => {
  const allowed = canCancelBooking({ bookedFor: 'SELF', userId: 'user-b', createdByUserId: 'user-a' }, { id: 'user-a', role: 'user' });
  assert.equal(allowed, false);
});

test('User A cancels A GUEST (created by A) -> allowed', () => {
  const allowed = canCancelBooking({ bookedFor: 'GUEST', userId: 'user-b', createdByUserId: 'user-a' }, { id: 'user-a', role: 'user' });
  assert.equal(allowed, true);
});

test('User A cancels B GUEST (created by B) -> forbidden', () => {
  const allowed = canCancelBooking({ bookedFor: 'GUEST', userId: 'user-b', createdByUserId: 'user-b' }, { id: 'user-a', role: 'user' });
  assert.equal(allowed, false);
});

test('Admin cancels any booking -> allowed', () => {
  const selfAllowed = canCancelBooking({ bookedFor: 'SELF', userId: 'user-b', createdByUserId: 'user-b' }, { id: 'admin-user', role: 'admin' });
  const guestAllowed = canCancelBooking({ bookedFor: 'GUEST', userId: 'user-b', createdByUserId: 'user-b' }, { id: 'admin-user', role: 'admin' });

  assert.equal(selfAllowed, true);
  assert.equal(guestAllowed, true);
});
