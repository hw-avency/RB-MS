export type BookingOwnershipInput = {
  bookedFor?: 'SELF' | 'GUEST';
  employeeId?: string | null;
  userId?: string | null;
  createdByEmployeeId?: string | null;
  createdByUserId?: string | null;
  isCurrentUser?: boolean;
  guestName?: string | null;
  userDisplayName?: string | null;
  userEmail?: string | null;
  user?: { displayName?: string | null; name?: string | null; email?: string | null } | null;
};

export const isMineBooking = (booking: BookingOwnershipInput, meEmployeeId?: string | null): boolean => {
  if (!meEmployeeId) return false;
  const ownBookingMatch = booking.employeeId === meEmployeeId || booking.userId === meEmployeeId;
  const guestBookingMatch = booking.createdByEmployeeId === meEmployeeId || booking.createdByUserId === meEmployeeId;

  if (booking.bookedFor === 'SELF') return ownBookingMatch;
  if (booking.bookedFor === 'GUEST') return guestBookingMatch;

  if (booking.isCurrentUser) return true;
  if (guestBookingMatch) return true;
  if (ownBookingMatch) return true;

  return false;
};

export const canCancelBooking = (booking: BookingOwnershipInput, meEmployeeId?: string | null, _isAdmin = false): boolean => (
  isMineBooking(booking, meEmployeeId)
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
