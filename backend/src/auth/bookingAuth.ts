export type CancelActor = {
  userId?: string | null;
  email: string;
  isAdmin: boolean;
};

export type CancelBooking = {
  bookedFor: 'SELF' | 'GUEST';
  userId?: string | null;
  userEmail?: string | null;
  createdByUserId?: string | null;
  createdByEmail?: string | null;
};

export const canCancelBooking = ({ booking, actor }: { booking: CancelBooking; actor: CancelActor }): boolean => {
  const normalizedActorEmail = actor.email.trim().toLowerCase();
  const normalizedBookingUserEmail = booking.userEmail?.trim().toLowerCase() ?? null;
  const normalizedCreatorEmail = booking.createdByEmail?.trim().toLowerCase() ?? null;

  return actor.isAdmin === true
    || (booking.bookedFor === 'SELF' && normalizedBookingUserEmail === normalizedActorEmail)
    || (booking.bookedFor === 'GUEST' && normalizedCreatorEmail === normalizedActorEmail);
};
