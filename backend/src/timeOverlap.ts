export const overlapsHalfOpenIntervals = (
  leftStartMinute: number,
  leftEndMinute: number,
  rightStartMinute: number,
  rightEndMinute: number
): boolean => {
  if (leftEndMinute <= leftStartMinute || rightEndMinute <= rightStartMinute) return false;
  return leftStartMinute < rightEndMinute && rightStartMinute < leftEndMinute;
};
