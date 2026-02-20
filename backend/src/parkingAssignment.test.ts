import assert from 'node:assert/strict';
import test from 'node:test';
import { buildParkingAssignmentProposal, windowsOverlap } from './parkingAssignment';

test('parking time conflicts treat touching end/start as non-overlap', () => {
  assert.equal(windowsOverlap({ startMinute: 8 * 60, endMinute: 10 * 60 }, { startMinute: 10 * 60, endMinute: 12 * 60 }), false);
  assert.equal(windowsOverlap({ startMinute: 8 * 60, endMinute: 10 * 60 }, { startMinute: 9 * 60 + 59, endMinute: 12 * 60 }), true);
});



test('when no charging is needed it prefers a regular spot over a charger', () => {
  const proposal = buildParkingAssignmentProposal({
    startMinute: 8 * 60,
    attendanceMinutes: 8 * 60,
    chargingMinutes: 0,
    spots: [
      { id: 'charger-1', hasCharger: true },
      { id: 'regular-1', hasCharger: false }
    ],
    bookings: []
  });

  assert.equal(proposal.type, 'single');
  if (proposal.type !== 'single') return;
  assert.equal(proposal.bookings[0]?.deskId, 'regular-1');
  assert.equal(proposal.bookings[0]?.hasCharger, false);
});

test('when no charging is needed it can propose a split without charging', () => {
  const proposal = buildParkingAssignmentProposal({
    startMinute: 8 * 60,
    attendanceMinutes: 8 * 60,
    chargingMinutes: 0,
    spots: [
      { id: 'regular-1', hasCharger: false },
      { id: 'regular-2', hasCharger: false }
    ],
    bookings: [
      { deskId: 'regular-1', startMinute: 12 * 60, endMinute: 16 * 60 },
      { deskId: 'regular-2', startMinute: 8 * 60, endMinute: 12 * 60 }
    ]
  });

  assert.equal(proposal.type, 'split');
  if (proposal.type !== 'split') return;
  assert.equal(proposal.bookings.length, 2);
  assert.equal(proposal.bookings[0]?.deskId, 'regular-1');
  assert.equal(proposal.bookings[0]?.startMinute, 8 * 60);
  assert.equal(proposal.bookings[0]?.endMinute, 12 * 60);
  assert.equal(proposal.bookings[1]?.deskId, 'regular-2');
  assert.equal(proposal.bookings[1]?.startMinute, 12 * 60);
  assert.equal(proposal.bookings[1]?.endMinute, 16 * 60);
});

test('when no charging is needed it returns none if more than two switches would be required', () => {
  const proposal = buildParkingAssignmentProposal({
    startMinute: 8 * 60,
    attendanceMinutes: 8 * 60,
    chargingMinutes: 0,
    spots: [
      { id: 'regular-1', hasCharger: false },
      { id: 'regular-2', hasCharger: false }
    ],
    bookings: [
      { deskId: 'regular-1', startMinute: 10 * 60, endMinute: 12 * 60 },
      { deskId: 'regular-1', startMinute: 14 * 60, endMinute: 16 * 60 },
      { deskId: 'regular-2', startMinute: 8 * 60, endMinute: 10 * 60 },
      { deskId: 'regular-2', startMinute: 12 * 60, endMinute: 14 * 60 }
    ]
  });

  assert.equal(proposal.type, 'none');
  if (proposal.type !== 'none') return;
  assert.equal(proposal.reason, 'NO_PARKING');
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


test('split assignment can place charging window at the end when start is blocked', () => {
  const proposal = buildParkingAssignmentProposal({
    startMinute: 8 * 60,
    attendanceMinutes: 4 * 60,
    chargingMinutes: 2 * 60,
    spots: [
      { id: 'charger-1', hasCharger: true },
      { id: 'regular-1', hasCharger: false }
    ],
    bookings: [
      { deskId: 'charger-1', startMinute: 8 * 60, endMinute: 10 * 60 }
    ]
  });

  assert.equal(proposal.type, 'split');
  if (proposal.type !== 'split') return;
  assert.equal(proposal.bookings.length, 2);
  assert.equal(proposal.bookings[0]?.deskId, 'regular-1');
  assert.equal(proposal.bookings[0]?.startMinute, 8 * 60);
  assert.equal(proposal.bookings[0]?.endMinute, 10 * 60);
  assert.equal(proposal.bookings[1]?.deskId, 'charger-1');
  assert.equal(proposal.bookings[1]?.startMinute, 10 * 60);
  assert.equal(proposal.bookings[1]?.endMinute, 12 * 60);
});

test('split assignment can use a free full-hour charging window in the middle of attendance', () => {
  const proposal = buildParkingAssignmentProposal({
    startMinute: 8 * 60,
    attendanceMinutes: 8 * 60,
    chargingMinutes: 2 * 60,
    spots: [
      { id: 'charger-1', hasCharger: true },
      { id: 'regular-1', hasCharger: false }
    ],
    bookings: [
      { deskId: 'charger-1', startMinute: 8 * 60, endMinute: 12 * 60 },
      { deskId: 'charger-1', startMinute: 14 * 60, endMinute: 18 * 60 }
    ]
  });

  assert.equal(proposal.type, 'split');
  if (proposal.type !== 'split') return;
  assert.equal(proposal.bookings.length, 3);
  assert.equal(proposal.bookings[0]?.deskId, 'regular-1');
  assert.equal(proposal.bookings[0]?.startMinute, 8 * 60);
  assert.equal(proposal.bookings[0]?.endMinute, 12 * 60);
  assert.equal(proposal.bookings[1]?.deskId, 'charger-1');
  assert.equal(proposal.bookings[1]?.startMinute, 12 * 60);
  assert.equal(proposal.bookings[1]?.endMinute, 14 * 60);
  assert.equal(proposal.bookings[2]?.deskId, 'regular-1');
  assert.equal(proposal.bookings[2]?.startMinute, 14 * 60);
  assert.equal(proposal.bookings[2]?.endMinute, 16 * 60);
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
