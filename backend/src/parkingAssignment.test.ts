import assert from 'node:assert/strict';
import test from 'node:test';
import { buildParkingAssignmentProposal, windowsOverlap } from './parkingAssignment';

test('parking time conflicts treat touching end/start as non-overlap', () => {
  assert.equal(windowsOverlap({ startMinute: 8 * 60, endMinute: 10 * 60 }, { startMinute: 10 * 60, endMinute: 12 * 60 }), false);
  assert.equal(windowsOverlap({ startMinute: 8 * 60, endMinute: 10 * 60 }, { startMinute: 9 * 60 + 59, endMinute: 12 * 60 }), true);
});

test('split assignment uses charger only for charging window', () => {
  const proposal = buildParkingAssignmentProposal({
    startMinute: 8 * 60,
    attendanceMinutes: 8 * 60,
    chargingMinutes: 2 * 60,
    spots: [
      { id: 'charger-1', hasCharger: true },
      { id: 'regular-1', hasCharger: false }
    ],
    bookings: []
  });

  assert.equal(proposal.type, 'split');
  if (proposal.type !== 'split') return;
  assert.equal(proposal.bookings.length, 2);
  assert.equal(proposal.bookings[0]?.deskId, 'charger-1');
  assert.equal(proposal.bookings[0]?.endMinute, 10 * 60);
  assert.equal(proposal.bookings[1]?.deskId, 'regular-1');
  assert.equal(proposal.usedFallbackChargerFullWindow, false);
});

test('fallback uses charger for full window when no regular rest slot is free', () => {
  const proposal = buildParkingAssignmentProposal({
    startMinute: 8 * 60,
    attendanceMinutes: 8 * 60,
    chargingMinutes: 2 * 60,
    spots: [
      { id: 'charger-1', hasCharger: true },
      { id: 'regular-1', hasCharger: false }
    ],
    bookings: [
      { deskId: 'regular-1', startMinute: 10 * 60, endMinute: 16 * 60 }
    ]
  });

  assert.equal(proposal.type, 'single');
  if (proposal.type !== 'single') return;
  assert.equal(proposal.bookings.length, 1);
  assert.equal(proposal.bookings[0]?.deskId, 'charger-1');
  assert.equal(proposal.usedFallbackChargerFullWindow, true);
});

test('no proposal when split and fallback are impossible', () => {
  const proposal = buildParkingAssignmentProposal({
    startMinute: 8 * 60,
    attendanceMinutes: 8 * 60,
    chargingMinutes: 2 * 60,
    spots: [
      { id: 'charger-1', hasCharger: true },
      { id: 'regular-1', hasCharger: false }
    ],
    bookings: [
      { deskId: 'charger-1', startMinute: 13 * 60, endMinute: 18 * 60 },
      { deskId: 'regular-1', startMinute: 10 * 60, endMinute: 16 * 60 }
    ]
  });

  assert.equal(proposal.type, 'none');
});
