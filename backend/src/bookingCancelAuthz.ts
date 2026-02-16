export type BookingCancelAuthzUser = {
  id: string;
  role?: string | null;
};

export type BookingCancelAuthzBooking = {
  bookedFor: 'SELF' | 'GUEST';
  userId: string | null;
  createdByUserId: string;
};

export const canCancelBooking = (booking: BookingCancelAuthzBooking, actor: BookingCancelAuthzUser): boolean => {
  const isAdmin = actor.role === 'admin';
  if (isAdmin) return true;

  if (booking.bookedFor === 'SELF') {
    return Boolean(booking.userId && booking.userId === actor.id);
  }

  return booking.createdByUserId === actor.id;
};
