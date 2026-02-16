export type CancelActor = {
  employeeId: string;
  email: string;
  isAdmin: boolean;
};

export type CancelBooking = {
  bookedFor: 'SELF' | 'GUEST';
  employeeId?: string | null;
  createdByEmployeeId: string;
};

export const canCancelBooking = ({ booking, actor }: { booking: CancelBooking; actor: CancelActor }): boolean => {
  return actor.isAdmin === true
    || (booking.bookedFor === 'SELF' && booking.employeeId === actor.employeeId)
    || (booking.bookedFor === 'GUEST' && booking.createdByEmployeeId === actor.employeeId);
};
