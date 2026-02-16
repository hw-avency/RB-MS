export type BookingOwnershipInput = {
  bookedFor?: 'SELF' | 'GUEST';
  employeeId?: string | null;
  createdByEmployeeId?: string | null;
  guestName?: string | null;
  userDisplayName?: string | null;
  userEmail?: string | null;
  user?: { displayName?: string | null; name?: string | null; email?: string | null } | null;
};

export const isMineBooking = (booking: BookingOwnershipInput, meEmployeeId?: string | null): boolean => {
  if (!meEmployeeId) return false;
  if (booking.bookedFor === 'SELF') return booking.employeeId === meEmployeeId;
  if (booking.bookedFor === 'GUEST') return booking.createdByEmployeeId === meEmployeeId;
  return false;
};

export const canCancelBooking = (booking: BookingOwnershipInput, meEmployeeId?: string | null, isAdmin = false): boolean => (
  isAdmin || isMineBooking(booking, meEmployeeId)
);

export const bookingDisplayName = (booking: BookingOwnershipInput): string => {
  if (booking.bookedFor === 'GUEST') {
    return `Gast: ${booking.guestName?.trim() || 'Unbekannt'}`;
  }

  return booking.user?.displayName
    ?? booking.user?.name
    ?? booking.userDisplayName
    ?? booking.userEmail
    ?? booking.user?.email
    ?? 'Unbekannt';
};
