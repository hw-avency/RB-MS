import { MouseEvent, RefObject, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resourceKindLabel } from './resourceKinds';

type FloorplanBooking = {
  id?: string;
  employeeId?: string;
  userDisplayName?: string;
  userEmail: string;
  userPhotoUrl?: string;
  daySlot?: 'AM' | 'PM' | 'FULL';
  slot?: 'FULL_DAY' | 'MORNING' | 'AFTERNOON' | 'CUSTOM';
  startTime?: string;
  endTime?: string;
  isCurrentUser?: boolean;
};

type FloorplanDesk = {
  id: string;
  name: string;
  label?: string;
  shortLabel?: string;
  kind?: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: FloorplanBooking | null;
  bookings?: FloorplanBooking[];
  isCurrentUsersDesk?: boolean;
  isHighlighted?: boolean;
  isSelected?: boolean;
};

type OverlayRect = { left: number; top: number; width: number; height: number };
type PixelPoint = { x: number; y: number };
type SlotKey = 'AM' | 'PM';
type TimeInterval = { start: number; end: number };

const PIN_HITBOX_SIZE = 44;
const PIN_VISUAL_SIZE = 36;
const RING_RADIUS = 16;
const RING_WIDTH = 5;
const CENTER_SIZE = 28;
const START_ANGLE = -90;
const MAX_ROOM_MARKER_LABEL_LENGTH = 4;
const WORK_START = 7 * 60;
const WORK_END = 18 * 60;
const WORK_SPAN = WORK_END - WORK_START;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const toNormalized = (raw: number, size: number): number => {
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 1) return clamp01(raw);
  if (raw <= 100) return clamp01(raw / 100);
  return clamp01(raw / Math.max(size, 1));
};

const toPixelPoint = (desk: Pick<FloorplanDesk, 'x' | 'y'>, overlayRect: OverlayRect): PixelPoint => ({
  x: toNormalized(desk.x, overlayRect.width) * overlayRect.width,
  y: toNormalized(desk.y, overlayRect.height) * overlayRect.height,
});

const getInitials = (name?: string, email?: string): string => {
  const source = (name?.trim() || email?.split('@')[0] || '??').replace(/[^\p{L}\s]/gu, ' ');
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

const getDeskLabel = (desk: Pick<FloorplanDesk, 'id' | 'name'>): string => desk.name?.toString().trim() || desk.id;

const getRoomMarkerLabel = (desk: Pick<FloorplanDesk, 'label' | 'shortLabel'>): string | null => {
  const normalizedShortLabel = desk.shortLabel?.trim();
  if (normalizedShortLabel && normalizedShortLabel.length <= MAX_ROOM_MARKER_LABEL_LENGTH) return normalizedShortLabel;

  const normalizedLabel = desk.label?.trim();
  if (normalizedLabel && normalizedLabel.length <= MAX_ROOM_MARKER_LABEL_LENGTH) return normalizedLabel;

  return null;
};

const getRoomName = (desk: Pick<FloorplanDesk, 'id' | 'name' | 'label'>): string => desk.name?.trim() || desk.label?.trim() || desk.id;

const getResourceMarkerIcon = (kind?: string): string => {
  if (kind === 'PARKPLATZ') return 'P';
  if (kind === 'SONSTIGES') return '◼';
  return '⌨';
};

const getBookingPersonLabel = (booking?: FloorplanBooking): string => booking?.userDisplayName ?? booking?.userEmail ?? 'Unbekannt';

const normalizeBookings = (desk: FloorplanDesk): FloorplanBooking[] => {
  if (desk.bookings && desk.bookings.length > 0) return desk.bookings;
  return desk.booking ? [desk.booking] : [];
};

const slotFromBooking = (booking: FloorplanBooking): 'AM' | 'PM' | 'FULL' | null => {
  if (booking.daySlot === 'FULL' || booking.slot === 'FULL_DAY') return 'FULL';
  if (booking.daySlot === 'AM' || booking.slot === 'MORNING') return 'AM';
  if (booking.daySlot === 'PM' || booking.slot === 'AFTERNOON') return 'PM';
  return null;
};

const hhmmToMinutes = (value?: string): number | null => {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
};

const angleToPoint = (deg: number, radius: number): { x: number; y: number } => {
  const radians = (deg * Math.PI) / 180;
  return { x: PIN_VISUAL_SIZE / 2 + radius * Math.cos(radians), y: PIN_VISUAL_SIZE / 2 + radius * Math.sin(radians) };
};

const arcPath = (startDeg: number, endDeg: number, radius: number): string => {
  const start = angleToPoint(startDeg, radius);
  const end = angleToPoint(endDeg, radius);
  const sweep = endDeg - startDeg;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
};

const minuteToAngle = (minutes: number): number => {
  const clampedMinutes = Math.min(WORK_END, Math.max(WORK_START, minutes));
  const normalized = (clampedMinutes - WORK_START) / WORK_SPAN;
  return START_ANGLE + normalized * 360;
};

const clampToWorkWindow = (minutes: number): number => Math.min(WORK_END, Math.max(WORK_START, minutes));

const mergeIntervals = (intervals: TimeInterval[]): TimeInterval[] => {
  if (intervals.length <= 1) return intervals;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: TimeInterval[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = merged[merged.length - 1];
    const next = sorted[i];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
      continue;
    }
    merged.push(next);
  }
  return merged;
};

type FloorplanCanvasProps = {
  imageUrl: string;
  imageAlt: string;
  desks: FloorplanDesk[];
  selectedDeskId: string;
  hoveredDeskId: string;
  selectedDate?: string;
  bookingVersion?: number;
  onHoverDesk: (deskId: string) => void;
  onSelectDesk: (deskId: string, anchorEl?: HTMLElement) => void;
  onCanvasClick?: (coords: { xPct: number; yPct: number }) => void;
  onDeskDoubleClick?: (deskId: string) => void;
  onDeskAnchorChange?: (deskId: string, element: HTMLElement | null) => void;
  disablePulseAnimation?: boolean;
};

const FloorplanImage = memo(function FloorplanImage({ imageUrl, imageAlt, imgRef, onLoad }: { imageUrl: string; imageAlt: string; imgRef: RefObject<HTMLImageElement>; onLoad: () => void }) {
  return <img ref={imgRef} src={imageUrl} alt={imageAlt} className="floorplan-image" onLoad={onLoad} />;
});

const DeskOverlay = memo(function DeskOverlay({ desks, selectedDeskId, hoveredDeskId, selectedDate, bookingVersion, overlayRect, onHoverDesk, onSelectDesk, onDeskDoubleClick, onDeskAnchorChange, disablePulseAnimation = false }: { desks: FloorplanDesk[]; selectedDeskId: string; hoveredDeskId: string; selectedDate?: string; bookingVersion?: number; overlayRect: OverlayRect; onHoverDesk: (deskId: string) => void; onSelectDesk: (deskId: string, anchorEl?: HTMLElement) => void; onDeskDoubleClick?: (deskId: string) => void; onDeskAnchorChange?: (deskId: string, element: HTMLElement | null) => void; disablePulseAnimation?: boolean; }) {
  const [imageStates, setImageStates] = useState<Record<string, boolean>>({});
  const [tooltip, setTooltip] = useState<{ deskId: string; left: number; top: number } | null>(null);

  useEffect(() => {
    if (!tooltip) return;
    const handleScrollOrResize = () => setTooltip(null);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [tooltip]);

  const tooltipDesk = desks.find((desk) => desk.id === tooltip?.deskId);

  return (
    <>
      <div className="desk-overlay" style={{ left: overlayRect.left, top: overlayRect.top, width: overlayRect.width, height: overlayRect.height }} data-version={bookingVersion}>
        {desks.map((desk) => {
          const point = toPixelPoint(desk, overlayRect);
          const bookings = normalizeBookings(desk);
          const isRoom = desk.kind === 'RAUM';
          const roomMarkerLabel = isRoom ? getRoomMarkerLabel(desk) : null;
          const fullBooking = bookings.find((booking) => slotFromBooking(booking) === 'FULL');
          const amBooking = fullBooking ?? bookings.find((booking) => slotFromBooking(booking) === 'AM');
          const pmBooking = fullBooking ?? bookings.find((booking) => slotFromBooking(booking) === 'PM');
          const isInteracting = selectedDeskId === desk.id || hoveredDeskId === desk.id || Boolean(desk.isSelected);
          const shouldShowPulse = bookings.length === 0 && !isInteracting && !disablePulseAnimation;
          const isClickable = !(amBooking && pmBooking && !bookings.some((booking) => booking.isCurrentUser));
          const centerBooking = fullBooking ?? bookings[0];
          const initials = getInitials(centerBooking?.userDisplayName, centerBooking?.userEmail);
          const hasPhoto = Boolean(centerBooking?.userPhotoUrl);
          const imgOk = hasPhoto && (imageStates[desk.id] ?? true);

          const slotColor = (booking?: FloorplanBooking): string => {
            if (!booking) return 'var(--resource-free)';
            if (booking.isCurrentUser) return 'var(--resource-own)';
            return 'var(--resource-booked)';
          };

          const roomIntervals = mergeIntervals(bookings.flatMap((booking) => {
            const startMinutes = hhmmToMinutes(booking.startTime);
            const endMinutes = hhmmToMinutes(booking.endTime);
            if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return [];
            const startInWindow = clampToWorkWindow(startMinutes);
            const endInWindow = clampToWorkWindow(endMinutes);
            if (endInWindow <= startInWindow) return [];
            return [{ start: startInWindow, end: endInWindow }];
          }));
          const roomCoverage = roomIntervals.reduce((total, interval) => total + (interval.end - interval.start), 0);
          const isRoomFullyBooked = roomCoverage >= WORK_SPAN - 1;

          return (
            <button
              key={`${desk.id}-${bookingVersion ?? 0}`}
              ref={(element) => onDeskAnchorChange?.(desk.id, element)}
              type="button"
              data-desk-id={desk.id}
              className={`desk-pin ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''} ${desk.isCurrentUsersDesk ? 'is-own-desk' : ''} ${desk.isHighlighted ? 'is-highlighted' : ''} ${desk.isSelected ? 'is-selected' : ''} ${!isClickable ? 'is-click-disabled' : ''}`}
              style={{ left: `${point.x - PIN_HITBOX_SIZE / 2}px`, top: `${point.y - PIN_HITBOX_SIZE / 2}px` }}
              onMouseEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setTooltip({ deskId: desk.id, left: rect.left + rect.width / 2, top: rect.top - 10 });
                onHoverDesk(desk.id);
              }}
              onMouseLeave={() => {
                setTooltip(null);
                onHoverDesk('');
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectDesk(desk.id, event.currentTarget);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onDeskDoubleClick?.(desk.id);
              }}
              tabIndex={0}
              title={bookings.length === 2 && !fullBooking ? '2 Buchungen' : undefined}
              aria-label={`${resourceKindLabel(desk.kind)}: ${getDeskLabel(desk)}`}
            >
              {shouldShowPulse && <span className="resource-pulse-ring" aria-hidden="true" />}
              <svg className="pin-ring-svg" viewBox={`0 0 ${PIN_VISUAL_SIZE} ${PIN_VISUAL_SIZE}`} aria-hidden="true">
                {isRoom ? (
                  <>
                    <circle cx={PIN_VISUAL_SIZE / 2} cy={PIN_VISUAL_SIZE / 2} r={RING_RADIUS} className="pin-ring-track" />
                    {isRoomFullyBooked
                      ? <circle cx={PIN_VISUAL_SIZE / 2} cy={PIN_VISUAL_SIZE / 2} r={RING_RADIUS} className="pin-ring-arc" style={{ stroke: 'var(--resource-booked)', strokeWidth: RING_WIDTH, strokeLinecap: 'butt' }} />
                      : roomIntervals.map((interval, index) => <path key={`${desk.id}-${interval.start}-${interval.end}-${index}`} d={arcPath(minuteToAngle(interval.start), minuteToAngle(interval.end), RING_RADIUS)} className="pin-ring-arc" style={{ stroke: 'var(--resource-booked)', strokeWidth: RING_WIDTH }} />)}
                  </>
                ) : (
                  <>
                    <path d={arcPath(START_ANGLE, START_ANGLE + 180, RING_RADIUS)} className="pin-ring-arc" style={{ stroke: slotColor(amBooking), strokeWidth: RING_WIDTH }} />
                    <path d={arcPath(START_ANGLE + 180, START_ANGLE + 360, RING_RADIUS)} className="pin-ring-arc" style={{ stroke: slotColor(pmBooking), strokeWidth: RING_WIDTH }} />
                  </>
                )}
              </svg>

              <span className="pin-center" style={{ width: CENTER_SIZE, height: CENTER_SIZE }}>
                {isRoom ? (
                  <span className="room-center-label">
                    <span className="room-center-icon" aria-hidden="true">⌂</span>
                    {roomMarkerLabel && <small>{roomMarkerLabel}</small>}
                  </span>
                ) : bookings.length >= 2 && !fullBooking ? (
                  <span className="desk-pin-count">2</span>
                ) : centerBooking ? (
                  <>
                    {hasPhoto && (
                      <img
                        src={centerBooking.userPhotoUrl}
                        alt={centerBooking.userDisplayName ?? centerBooking.userEmail ?? 'Mitarbeiter'}
                        className="desk-pin-avatar-img"
                        onLoad={() => setImageStates((current) => ({ ...current, [desk.id]: true }))}
                        onError={() => setImageStates((current) => ({ ...current, [desk.id]: false }))}
                        referrerPolicy="no-referrer"
                      />
                    )}
                    <span className={`desk-pin-initials ${imgOk ? 'is-hidden' : ''}`}>{initials || getResourceMarkerIcon(desk.kind)}</span>
                  </>
                ) : (
                  <span className="desk-pin-kind-icon" aria-hidden="true">{getResourceMarkerIcon(desk.kind)}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {tooltip && tooltipDesk && createPortal(
        <div className="desk-tooltip" style={{ left: tooltip.left, top: tooltip.top }} role="tooltip">
          <strong>{tooltipDesk.kind === 'RAUM' ? `Raum: ${getRoomName(tooltipDesk)}` : `${resourceKindLabel(tooltipDesk.kind)}: ${getDeskLabel(tooltipDesk)}`}</strong>
          {tooltipDesk.kind === 'RAUM' ? (
            normalizeBookings(tooltipDesk).map((booking) => (
              <span key={booking.id ?? `${booking.userEmail}-${booking.startTime}`}>{`${booking.startTime ?? '--:--'}-${booking.endTime ?? '--:--'}: ${booking.userDisplayName ?? booking.userEmail}`}</span>
            ))
          ) : (
            (() => {
              const bookings = normalizeBookings(tooltipDesk);
              const full = bookings.find((booking) => slotFromBooking(booking) === 'FULL');
              const am = full ?? bookings.find((booking) => slotFromBooking(booking) === 'AM');
              const pm = full ?? bookings.find((booking) => slotFromBooking(booking) === 'PM');
              return (
                <>
                  {full ? (
                    <span>Ganztägig: {getBookingPersonLabel(full)}</span>
                  ) : (
                    <>
                      {am && <span>Vormittag: {getBookingPersonLabel(am)}</span>}
                      {pm && <span>Nachmittag: {getBookingPersonLabel(pm)}</span>}
                    </>
                  )}
                </>
              );
            })()
          )}
          <span>{new Date(`${selectedDate ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).toLocaleDateString('de-DE')}</span>
        </div>,
        document.body
      )}
    </>
  );
});

export function FloorplanCanvas({ imageUrl, imageAlt, desks, selectedDeskId, hoveredDeskId, selectedDate, bookingVersion, onHoverDesk, onSelectDesk, onCanvasClick, onDeskDoubleClick, onDeskAnchorChange, disablePulseAnimation = false }: FloorplanCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [overlayRect, setOverlayRect] = useState<OverlayRect>({ left: 0, top: 0, width: 1, height: 1 });

  const sync = () => {
    if (!containerRef.current || !imgRef.current) return;
    const c = containerRef.current.getBoundingClientRect();
    const i = imgRef.current.getBoundingClientRect();
    setOverlayRect({ left: i.left - c.left, top: i.top - c.top, width: i.width, height: i.height });
  };

  useLayoutEffect(sync, [imageUrl]);
  useEffect(() => {
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [imageUrl]);

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onCanvasClick || !imgRef.current) return;
    const clickedLayerRect = imgRef.current.getBoundingClientRect();
    const localX = event.clientX - clickedLayerRect.left;
    const localY = event.clientY - clickedLayerRect.top;
    const xNorm = clamp01(localX / clickedLayerRect.width);
    const yNorm = clamp01(localY / clickedLayerRect.height);
    onCanvasClick({ xPct: xNorm, yPct: yNorm });
  };

  return (
    <div ref={containerRef} className="floorplan-canvas" role="presentation" onClick={handleCanvasClick}>
      <FloorplanImage imageUrl={imageUrl} imageAlt={imageAlt} imgRef={imgRef} onLoad={sync} />
      <DeskOverlay desks={desks} selectedDeskId={selectedDeskId} hoveredDeskId={hoveredDeskId} selectedDate={selectedDate} bookingVersion={bookingVersion} overlayRect={overlayRect} onHoverDesk={onHoverDesk} onSelectDesk={onSelectDesk} onDeskDoubleClick={onDeskDoubleClick} onDeskAnchorChange={onDeskAnchorChange} disablePulseAnimation={disablePulseAnimation} />
    </div>
  );
}
