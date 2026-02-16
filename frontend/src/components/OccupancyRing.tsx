import type { RingSegment } from '../lib/bookingWindows';

const toAngle = (position: number): string => `${(Math.max(0, Math.min(1, position)) * 360).toFixed(3)}deg`;

const ringBackground = (segments: RingSegment[]): string => {
  if (segments.length === 0) return 'conic-gradient(from 0deg, transparent 0deg 360deg)';

  const sorted = [...segments].sort((a, b) => a.p0 - b.p0);
  const stops: string[] = [];
  let cursor = 0;

  for (const segment of sorted) {
    if (segment.p0 > cursor) stops.push(`transparent ${toAngle(cursor)} ${toAngle(segment.p0)}`);
    stops.push(`var(--resource-busy) ${toAngle(segment.p0)} ${toAngle(segment.p1)}`);
    cursor = Math.max(cursor, segment.p1);
  }

  if (cursor < 1) stops.push(`transparent ${toAngle(cursor)} 360deg`);
  return `conic-gradient(from 0deg, ${stops.join(', ')})`;
};

export function OccupancyRing({ segments, label = 'Raumbelegung' }: { segments: RingSegment[]; label?: string }) {
  return (
    <span
      className="occupancy-ring"
      role="img"
      aria-label={label}
      style={{ ['--ring-gradient' as string]: ringBackground(segments) }}
    >
      <span className="occupancy-ring-track" aria-hidden="true" />
      <span className="occupancy-ring-fill" aria-hidden="true" />
      <span className="occupancy-ring-hole" aria-hidden="true" />
    </span>
  );
}
