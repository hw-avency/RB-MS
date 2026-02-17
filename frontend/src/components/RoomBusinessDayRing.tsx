import type { RingSegment } from '../lib/bookingWindows';
import { BUSINESS_START_ANGLE_DEGREES, BUSINESS_SWEEP_DEGREES, NIGHT_SWEEP_DEGREES, progressToBusinessAngleDegrees, toBusinessAngleDegrees } from '../lib/roomBusinessDayRing';

type BusySegment = RingSegment & { tone?: 'own' | 'other' };

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

const segmentPath = (startDeg: number, endDeg: number, radius = RADIUS): string => {
  const normalizedStart = ((startDeg % 360) + 360) % 360;
  let normalizedEnd = ((endDeg % 360) + 360) % 360;
  if (normalizedEnd <= normalizedStart) normalizedEnd += 360;
  return arcPath(normalizedStart, normalizedEnd, radius);
};

const FULL_SEGMENT_EPSILON = 0.0001;
const isFullSegment = (segment: RingSegment): boolean => (segment.p1 - segment.p0) >= (1 - FULL_SEGMENT_EPSILON);

const TICK_ANGLES = {
  start: BUSINESS_START_ANGLE_DEGREES,
  twelve: toBusinessAngleDegrees(12 * 60),
  end: toBusinessAngleDegrees(18 * 60)
} satisfies Record<RingTick, number>;

export function RoomBusinessDayRing({
  segments,
  freeSegments,
  label = 'Raumbelegung im Geschäftsfenster 06:00 bis 18:00',
  className,
  strokeWidth = 10,
  showTicks = true,
  debugTitle
}: {
  segments: BusySegment[];
  freeSegments?: RingSegment[];
  label?: string;
  className?: string;
  strokeWidth?: number;
  showTicks?: boolean;
  debugTitle?: string;
}) {
  const bookedStrokeColor = (_segment: BusySegment): string => 'var(--resource-busy)';

  const businessStart = BUSINESS_START_ANGLE_DEGREES;
  const businessEnd = businessStart + BUSINESS_SWEEP_DEGREES;
  const nightStart = businessEnd;
  const nightEnd = nightStart + NIGHT_SWEEP_DEGREES;

  return (
    <svg className={className} viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`} aria-label={label} role="img" shapeRendering="geometricPrecision">
      {debugTitle ? <title>{debugTitle}</title> : null}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        className="room-business-ring-track"
        style={{ strokeWidth }}
        stroke="hsl(var(--muted))"
        aria-hidden="true"
      />
      {NIGHT_SWEEP_DEGREES > 0.1 ? (
        <path
          d={segmentPath(nightStart, nightEnd)}
          className="room-business-ring-night"
          style={{ strokeWidth }}
          stroke="hsl(var(--muted-foreground) / 0.3)"
          aria-hidden="true"
        />
      ) : null}
      {(freeSegments ?? []).map((segment) => {
        const key = `free-${segment.p0.toFixed(4)}-${segment.p1.toFixed(4)}`;
        if (isFullSegment(segment)) {
          return (
            <circle
              key={key}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              className="room-business-ring-free"
              style={{ strokeWidth }}
              stroke="var(--resource-free)"
              aria-hidden="true"
            />
          );
        }
        return (
          <path
            key={key}
            d={segmentPath(progressToBusinessAngleDegrees(segment.p0), progressToBusinessAngleDegrees(segment.p1))}
            className="room-business-ring-free"
            style={{ strokeWidth }}
            stroke="var(--resource-free)"
            aria-hidden="true"
          />
        );
      })}
      {segments.map((segment) => {
        const key = `${segment.p0.toFixed(4)}-${segment.p1.toFixed(4)}`;
        if (isFullSegment(segment)) {
          return (
            <circle
              key={key}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              className="room-business-ring-booked"
              style={{ strokeWidth }}
              stroke={bookedStrokeColor(segment)}
              aria-hidden="true"
            />
          );
        }
        return (
          <path
            key={key}
            d={segmentPath(progressToBusinessAngleDegrees(segment.p0), progressToBusinessAngleDegrees(segment.p1))}
            className="room-business-ring-booked"
            style={{ strokeWidth }}
            stroke={bookedStrokeColor(segment)}
            aria-hidden="true"
          />
        );
      })}
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
            stroke="hsl(var(--muted-foreground) / 0.45)"
            aria-hidden="true"
          />
        );
      })}
    </svg>
  );
}
