import type { RingSegment } from '../lib/bookingWindows';
import { BUSINESS_START_ANGLE_DEGREES, BUSINESS_SWEEP_DEGREES, GAP_SWEEP_DEGREES, progressToBusinessAngleDegrees, toBusinessAngleDegrees } from '../lib/roomBusinessDayRing';

type RingTick = 'start' | 'twelve' | 'end';

const VIEWBOX_SIZE = 100;
const CENTER = VIEWBOX_SIZE / 2;
const RADIUS = 42;

const polarToCartesian = (deg: number, radius: number): { x: number; y: number } => {
  const radians = (deg * Math.PI) / 180;
  return {
    x: CENTER + radius * Math.cos(radians),
    y: CENTER + radius * Math.sin(radians)
  };
};

const arcPath = (startDeg: number, endDeg: number, radius = RADIUS): string => {
  const start = polarToCartesian(startDeg, radius);
  const end = polarToCartesian(endDeg, radius);
  const sweep = endDeg - startDeg;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${radius.toFixed(3)} ${radius.toFixed(3)} 0 ${largeArc} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
};

const TICK_ANGLES = {
  start: BUSINESS_START_ANGLE_DEGREES,
  twelve: toBusinessAngleDegrees(12 * 60),
  end: toBusinessAngleDegrees(18 * 60)
} satisfies Record<RingTick, number>;

export function RoomBusinessDayRing({
  segments,
  label = 'Raumbelegung im Geschäftsfenster 07:00 bis 18:00',
  className,
  strokeWidth = 10,
  showTicks = true,
  debugTitle
}: {
  segments: RingSegment[];
  label?: string;
  className?: string;
  strokeWidth?: number;
  showTicks?: boolean;
  debugTitle?: string;
}) {
  const businessStart = BUSINESS_START_ANGLE_DEGREES;
  const businessEnd = businessStart + BUSINESS_SWEEP_DEGREES;
  const gapStart = businessEnd;
  const gapEnd = gapStart + GAP_SWEEP_DEGREES;

  return (
    <svg className={className} viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`} aria-label={label} role="img" shapeRendering="geometricPrecision">
      {debugTitle ? <title>{debugTitle}</title> : null}
      <path
        d={arcPath(businessStart, businessEnd)}
        className="room-business-ring-track"
        style={{ strokeWidth }}
        aria-hidden="true"
      />
      <path
        d={arcPath(gapStart, gapEnd)}
        className="room-business-ring-gap"
        style={{ strokeWidth }}
        aria-hidden="true"
      />
      {segments.map((segment) => (
        <path
          key={`${segment.p0.toFixed(4)}-${segment.p1.toFixed(4)}`}
          d={arcPath(progressToBusinessAngleDegrees(segment.p0), progressToBusinessAngleDegrees(segment.p1))}
          className="room-business-ring-booked"
          style={{ strokeWidth }}
          aria-hidden="true"
        />
      ))}
      {showTicks && (Object.entries(TICK_ANGLES) as Array<[RingTick, number]>).map(([tick, deg]) => {
        const outer = polarToCartesian(deg, RADIUS + strokeWidth * 0.45);
        const inner = polarToCartesian(deg, RADIUS - strokeWidth * 0.45);
        return (
          <line
            key={tick}
            x1={outer.x}
            y1={outer.y}
            x2={inner.x}
            y2={inner.y}
            className="room-business-ring-tick"
            aria-hidden="true"
          />
        );
      })}
    </svg>
  );
}
