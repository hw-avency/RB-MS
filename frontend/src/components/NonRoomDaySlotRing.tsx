import { RING_TOP_ANGLE_DEGREES } from '../lib/ringOrientation';

const VIEWBOX_SIZE = 36;
const CENTER = VIEWBOX_SIZE / 2;
const RADIUS = 14.5;

const angleToPoint = (deg: number): { x: number; y: number } => {
  const radians = (deg * Math.PI) / 180;
  return {
    x: CENTER + RADIUS * Math.cos(radians),
    y: CENTER + RADIUS * Math.sin(radians)
  };
};

const arcPath = (startDeg: number, endDeg: number): string => {
  const start = angleToPoint(startDeg);
  const end = angleToPoint(endDeg);
  return `M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 0 1 ${end.x} ${end.y}`;
};

const LEFT_HALF_START = RING_TOP_ANGLE_DEGREES + 180;
const RIGHT_HALF_START = RING_TOP_ANGLE_DEGREES;

export function NonRoomDaySlotRing({
  isFullDay,
  amColor,
  pmColor,
  strokeWidth
}: {
  isFullDay: boolean;
  amColor: string;
  pmColor: string;
  strokeWidth: number;
}) {
  if (isFullDay) {
    return <circle cx={CENTER} cy={CENTER} r={RADIUS} className="pin-ring-arc" style={{ stroke: amColor, strokeWidth, strokeLinecap: 'butt' }} />;
  }

  return (
    <>
      <path d={arcPath(LEFT_HALF_START, LEFT_HALF_START + 180)} className="pin-ring-arc" style={{ stroke: amColor, strokeWidth, strokeLinecap: 'round' }} />
      <path d={arcPath(RIGHT_HALF_START, RIGHT_HALF_START + 180)} className="pin-ring-arc" style={{ stroke: pmColor, strokeWidth, strokeLinecap: 'round' }} />
    </>
  );
}
