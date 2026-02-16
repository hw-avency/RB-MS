export type CancelActor = {
  userId: string;
  isAdmin: boolean;
};

export type CancelBooking = {
  bookedFor: 'SELF' | 'GUEST';
  userId: string | null;
  createdByUserId: string;
};

export const canCancelBooking = ({ booking, actor }: { booking: CancelBooking; actor: CancelActor }): boolean => {
  return actor.isAdmin === true
    || (booking.bookedFor === 'SELF' && booking.userId === actor.userId)
    || (booking.bookedFor === 'GUEST' && booking.createdByUserId === actor.userId);
};
