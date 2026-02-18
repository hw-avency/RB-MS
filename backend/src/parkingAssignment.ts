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

  const chargeEndMinute = Math.min(endMinute, startMinute + chargingMinutes);
  const chargeWindow = { startMinute, endMinute: chargeEndMinute };
  const chargerSpot = findFreeSpot(spots, bookings, chargeWindow, (spot) => spot.hasCharger);
  if (!chargerSpot) return { type: 'none', reason: 'NO_CHARGER_WINDOW' };

  if (chargeEndMinute >= endMinute) {
    return {
      type: 'single',
      bookings: [{ deskId: chargerSpot.id, startMinute, endMinute, hasCharger: true }],
      usedFallbackChargerFullWindow: false
    };
  }

  const restWindow = { startMinute: chargeEndMinute, endMinute };
  const regularSpot = findFreeSpot(spots, bookings, restWindow, (spot) => !spot.hasCharger);
  if (regularSpot) {
    return {
      type: 'split',
      bookings: [
        { deskId: chargerSpot.id, startMinute, endMinute: chargeEndMinute, hasCharger: true },
        { deskId: regularSpot.id, startMinute: chargeEndMinute, endMinute, hasCharger: regularSpot.hasCharger }
      ],
      usedFallbackChargerFullWindow: false
    };
  }

  const fullWindowCharger = findFreeSpot(spots, bookings, fullWindow, (spot) => spot.hasCharger);
  if (fullWindowCharger) {
    return {
      type: 'single',
      bookings: [{ deskId: fullWindowCharger.id, startMinute, endMinute, hasCharger: true }],
      usedFallbackChargerFullWindow: true
    };
  }

  return { type: 'none', reason: 'NO_SPLIT_AND_NO_FALLBACK' };
};
