export type ParkingWindow = { startMinute: number; endMinute: number };
export type ParkingSpot = { id: string; hasCharger: boolean };
export type ParkingBooking = { deskId: string; startMinute: number; endMinute: number };

export type ParkingAssignmentProposal = {
  type: 'none';
  reason: 'NO_CHARGER_WINDOW' | 'NO_SPLIT_AND_NO_FALLBACK' | 'NO_PARKING';
} | {
  type: 'single' | 'split';
  bookings: Array<{ deskId: string; startMinute: number; endMinute: number; hasCharger: boolean }>;
  usedFallbackChargerFullWindow: boolean;
};

export const windowsOverlap = (left: ParkingWindow, right: ParkingWindow): boolean => left.startMinute < right.endMinute && right.startMinute < left.endMinute;

const isSpotFree = (spotId: string, window: ParkingWindow, bookings: ParkingBooking[]): boolean => (
  bookings.filter((booking) => booking.deskId === spotId).every((booking) => !windowsOverlap(window, booking))
);

const findFreeSpot = (
  spots: ParkingSpot[],
  bookings: ParkingBooking[],
  window: ParkingWindow,
  predicate: (spot: ParkingSpot) => boolean
): ParkingSpot | null => spots.find((spot) => predicate(spot) && isSpotFree(spot.id, window, bookings)) ?? null;

const pushUniqueCandidate = (
  list: Array<{ startMinute: number; endMinute: number; chargeAtStart: boolean }>,
  candidate: { startMinute: number; endMinute: number; chargeAtStart: boolean }
): void => {
  if (candidate.endMinute <= candidate.startMinute) return;
  if (list.some((entry) => entry.startMinute === candidate.startMinute && entry.endMinute === candidate.endMinute)) return;
  list.push(candidate);
};

export const buildParkingAssignmentProposal = ({
  startMinute,
  attendanceMinutes,
  chargingMinutes,
  spots,
  bookings
}: {
  startMinute: number;
  attendanceMinutes: number;
  chargingMinutes: number;
  spots: ParkingSpot[];
  bookings: ParkingBooking[];
}): ParkingAssignmentProposal => {
  const endMinute = startMinute + attendanceMinutes;
  if (attendanceMinutes <= 0 || endMinute > 24 * 60) return { type: 'none', reason: 'NO_PARKING' };

  const fullWindow = { startMinute, endMinute };

  if (chargingMinutes <= 0) {
    const regularSpot = findFreeSpot(spots, bookings, fullWindow, (spot) => !spot.hasCharger);
    const freeSpot = regularSpot ?? findFreeSpot(spots, bookings, fullWindow, (spot) => spot.hasCharger);
    if (!freeSpot) return { type: 'none', reason: 'NO_PARKING' };
    return {
      type: 'single',
      bookings: [{ deskId: freeSpot.id, startMinute, endMinute, hasCharger: freeSpot.hasCharger }],
      usedFallbackChargerFullWindow: false
    };
  }

  const resolvedChargingMinutes = Math.min(attendanceMinutes, Math.max(0, chargingMinutes));
  const chargeWindowCandidates: Array<{ startMinute: number; endMinute: number; chargeAtStart: boolean }> = [];
  pushUniqueCandidate(chargeWindowCandidates, { startMinute, endMinute: startMinute + resolvedChargingMinutes, chargeAtStart: true });
  pushUniqueCandidate(chargeWindowCandidates, { startMinute: endMinute - resolvedChargingMinutes, endMinute, chargeAtStart: false });

  const firstWholeHourStart = Math.ceil(startMinute / 60) * 60;
  const latestWholeHourStart = endMinute - resolvedChargingMinutes;
  for (let candidateStart = firstWholeHourStart; candidateStart <= latestWholeHourStart; candidateStart += 60) {
    const candidateEnd = candidateStart + resolvedChargingMinutes;
    if (candidateEnd > endMinute) continue;
    pushUniqueCandidate(chargeWindowCandidates, {
      startMinute: candidateStart,
      endMinute: candidateEnd,
      chargeAtStart: candidateStart === startMinute
    });
  }

  let chargerWindowFound = false;

  for (const candidate of chargeWindowCandidates) {
    const chargeWindow = { startMinute: candidate.startMinute, endMinute: candidate.endMinute };
    const chargerSpot = findFreeSpot(spots, bookings, chargeWindow, (spot) => spot.hasCharger);
    if (!chargerSpot) continue;

    chargerWindowFound = true;

    if (candidate.startMinute === startMinute && candidate.endMinute === endMinute) {
      return {
        type: 'single',
        bookings: [{ deskId: chargerSpot.id, startMinute, endMinute, hasCharger: true }],
        usedFallbackChargerFullWindow: false
      };
    }

    const beforeWindow = { startMinute, endMinute: candidate.startMinute };
    const afterWindow = { startMinute: candidate.endMinute, endMinute };
    const hasBefore = beforeWindow.endMinute > beforeWindow.startMinute;
    const hasAfter = afterWindow.endMinute > afterWindow.startMinute;

    if (!hasBefore && hasAfter) {
      const regularAfter = findFreeSpot(spots, bookings, afterWindow, (spot) => !spot.hasCharger);
      if (regularAfter) {
        return {
          type: 'split',
          bookings: [
            { deskId: chargerSpot.id, startMinute, endMinute: candidate.endMinute, hasCharger: true },
            { deskId: regularAfter.id, startMinute: candidate.endMinute, endMinute, hasCharger: regularAfter.hasCharger }
          ],
          usedFallbackChargerFullWindow: false
        };
      }
      continue;
    }

    if (hasBefore && !hasAfter) {
      const regularBefore = findFreeSpot(spots, bookings, beforeWindow, (spot) => !spot.hasCharger);
      if (regularBefore) {
        return {
          type: 'split',
          bookings: [
            { deskId: regularBefore.id, startMinute, endMinute: candidate.startMinute, hasCharger: regularBefore.hasCharger },
            { deskId: chargerSpot.id, startMinute: candidate.startMinute, endMinute, hasCharger: true }
          ],
          usedFallbackChargerFullWindow: false
        };
      }
      continue;
    }

    if (hasBefore && hasAfter) {
      const regularBefore = findFreeSpot(spots, bookings, beforeWindow, (spot) => !spot.hasCharger);
      const regularAfter = findFreeSpot(spots, bookings, afterWindow, (spot) => !spot.hasCharger);
      if (regularBefore && regularAfter) {
        return {
          type: 'split',
          bookings: [
            { deskId: regularBefore.id, startMinute, endMinute: candidate.startMinute, hasCharger: regularBefore.hasCharger },
            { deskId: chargerSpot.id, startMinute: candidate.startMinute, endMinute: candidate.endMinute, hasCharger: true },
            { deskId: regularAfter.id, startMinute: candidate.endMinute, endMinute, hasCharger: regularAfter.hasCharger }
          ],
          usedFallbackChargerFullWindow: false
        };
      }
    }
  }

  const fullWindowCharger = findFreeSpot(spots, bookings, fullWindow, (spot) => spot.hasCharger);
  if (fullWindowCharger) {
    return {
      type: 'single',
      bookings: [{ deskId: fullWindowCharger.id, startMinute, endMinute, hasCharger: true }],
      usedFallbackChargerFullWindow: true
    };
  }

  return { type: 'none', reason: chargerWindowFound ? 'NO_SPLIT_AND_NO_FALLBACK' : 'NO_CHARGER_WINDOW' };
};
