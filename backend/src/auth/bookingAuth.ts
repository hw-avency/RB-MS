export type CancelActor = {
  employeeId: string;
  email: string;
  isAdmin: boolean;
};

export type CancelBooking = {
  bookedFor: 'SELF' | 'GUEST';
  userEmail?: string | null;
  createdByEmployeeId: string;
};

export const canCancelBooking = ({ booking, actor }: { booking: CancelBooking; actor: CancelActor }): boolean => {
  const normalizedActorEmail = actor.email.trim().toLowerCase();
  const normalizedBookingUserEmail = booking.userEmail?.trim().toLowerCase() ?? null;

  return actor.isAdmin === true
    || (booking.bookedFor === 'SELF' && normalizedBookingUserEmail === normalizedActorEmail)
    || (booking.bookedFor === 'GUEST' && booking.createdByEmployeeId === actor.employeeId);
};
