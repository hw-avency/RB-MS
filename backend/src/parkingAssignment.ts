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
  const chargeWindowCandidates = [
    { startMinute, endMinute: startMinute + resolvedChargingMinutes, chargeAtStart: true },
    { startMinute: endMinute - resolvedChargingMinutes, endMinute, chargeAtStart: false }
  ].filter((candidate, index, all) => (
    candidate.endMinute > candidate.startMinute
    && all.findIndex((entry) => entry.startMinute === candidate.startMinute && entry.endMinute === candidate.endMinute) === index
  ));

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

    if (candidate.chargeAtStart) {
      const restWindow = { startMinute: candidate.endMinute, endMinute };
      const regularSpot = findFreeSpot(spots, bookings, restWindow, (spot) => !spot.hasCharger);
      if (regularSpot) {
        return {
          type: 'split',
          bookings: [
            { deskId: chargerSpot.id, startMinute, endMinute: candidate.endMinute, hasCharger: true },
            { deskId: regularSpot.id, startMinute: candidate.endMinute, endMinute, hasCharger: regularSpot.hasCharger }
          ],
          usedFallbackChargerFullWindow: false
        };
      }
    } else {
      const restWindow = { startMinute, endMinute: candidate.startMinute };
      const regularSpot = findFreeSpot(spots, bookings, restWindow, (spot) => !spot.hasCharger);
      if (regularSpot) {
        return {
          type: 'split',
          bookings: [
            { deskId: regularSpot.id, startMinute, endMinute: candidate.startMinute, hasCharger: regularSpot.hasCharger },
            { deskId: chargerSpot.id, startMinute: candidate.startMinute, endMinute, hasCharger: true }
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
