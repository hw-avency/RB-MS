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

const PIN_CONTAINER_SIZE = 40;
const RING_RADIUS = 19;
const RING_WIDTH = 4;
const CENTER_SIZE = 28;

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

const arcPath = (startDeg: number, endDeg: number, radius: number): string => {
  const startRad = (startDeg - 90) * (Math.PI / 180);
  const endRad = (endDeg - 90) * (Math.PI / 180);
  const x1 = 20 + radius * Math.cos(startRad);
  const y1 = 20 + radius * Math.sin(startRad);
  const x2 = 20 + radius * Math.cos(endRad);
  const y2 = 20 + radius * Math.sin(endRad);
  const sweep = endDeg - startDeg;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
};

type FloorplanCanvasProps = {
  imageUrl: string;
  imageAlt: string;
  desks: FloorplanDesk[];
  selectedDeskId: string;
  hoveredDeskId: string;
  selectedDate?: string;
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

const DeskOverlay = memo(function DeskOverlay({ desks, selectedDeskId, hoveredDeskId, selectedDate, overlayRect, onHoverDesk, onSelectDesk, onDeskDoubleClick, onDeskAnchorChange, disablePulseAnimation = false }: { desks: FloorplanDesk[]; selectedDeskId: string; hoveredDeskId: string; selectedDate?: string; overlayRect: OverlayRect; onHoverDesk: (deskId: string) => void; onSelectDesk: (deskId: string, anchorEl?: HTMLElement) => void; onDeskDoubleClick?: (deskId: string) => void; onDeskAnchorChange?: (deskId: string, element: HTMLElement | null) => void; disablePulseAnimation?: boolean; }) {
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
      <div className="desk-overlay" style={{ left: overlayRect.left, top: overlayRect.top, width: overlayRect.width, height: overlayRect.height }}>
        {desks.map((desk) => {
          const point = toPixelPoint(desk, overlayRect);
          const bookings = normalizeBookings(desk);
          const isRoom = desk.kind === 'RAUM';
          const amBooking = bookings.find((booking) => {
            const slot = slotFromBooking(booking);
            return slot === 'AM' || slot === 'FULL';
          });
          const pmBooking = bookings.find((booking) => {
            const slot = slotFromBooking(booking);
            return slot === 'PM' || slot === 'FULL';
          });
          const fullBooking = bookings.find((booking) => slotFromBooking(booking) === 'FULL');
          const isInteracting = selectedDeskId === desk.id || hoveredDeskId === desk.id || Boolean(desk.isSelected);
          const shouldShowPulse = bookings.length === 0 && !isInteracting && !disablePulseAnimation;
          const isClickable = !(amBooking && pmBooking && !bookings.some((booking) => booking.isCurrentUser));

          const centerBooking = fullBooking ?? bookings[0];
          const initials = getInitials(centerBooking?.userDisplayName, centerBooking?.userEmail);
          const hasPhoto = Boolean(centerBooking?.userPhotoUrl);
          const imgOk = hasPhoto && (imageStates[desk.id] ?? true);

          const slotColor = (booking?: FloorplanBooking): string => {
            if (!booking) return '#cbd5e1';
            if (booking.isCurrentUser) return '#a855f7';
            return 'hsl(var(--primary))';
          };

          const roomArcs = bookings.flatMap((booking) => {
            const startMinutes = hhmmToMinutes(booking.startTime);
            const endMinutes = hhmmToMinutes(booking.endTime);
            if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return [];
            const angleStart = (startMinutes / 1440) * 360;
            const angleEnd = (endMinutes / 1440) * 360;
            return [{ id: `${booking.id ?? booking.userEmail}-${angleStart}`, d: arcPath(angleStart, angleEnd, RING_RADIUS), color: slotColor(booking) }];
          });

          return (
            <button
              key={desk.id}
              ref={(element) => onDeskAnchorChange?.(desk.id, element)}
              type="button"
              data-desk-id={desk.id}
              className={`desk-pin ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''} ${desk.isCurrentUsersDesk ? 'is-own-desk' : ''} ${desk.isHighlighted ? 'is-highlighted' : ''} ${desk.isSelected ? 'is-selected' : ''} ${!isClickable ? 'is-click-disabled' : ''}`}
              style={{ left: `${point.x - PIN_CONTAINER_SIZE / 2}px`, top: `${point.y - PIN_CONTAINER_SIZE / 2}px` }}
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
              aria-label={`${resourceKindLabel(desk.kind)}: ${getDeskLabel(desk)}`}
            >
              {shouldShowPulse && <span className="resource-pulse-ring" aria-hidden="true" />}
              <svg className="pin-ring-svg" viewBox="0 0 40 40" aria-hidden="true">
                {isRoom ? (
                  <>
                    <circle cx="20" cy="20" r={RING_RADIUS} className="pin-ring-track" />
                    {roomArcs.map((arc) => <path key={arc.id} d={arc.d} className="pin-ring-arc" style={{ stroke: arc.color }} />)}
                  </>
                ) : (
                  <>
                    <path d={arcPath(0, 180, RING_RADIUS)} className="pin-ring-arc" style={{ stroke: slotColor(amBooking) }} />
                    <path d={arcPath(180, 360, RING_RADIUS)} className="pin-ring-arc" style={{ stroke: slotColor(pmBooking) }} />
                  </>
                )}
              </svg>

              <span className="pin-center" style={{ width: CENTER_SIZE, height: CENTER_SIZE }}>
                {isRoom ? (
                  <span className="room-center-label">🏢<small>{getDeskLabel(desk).slice(0, 3).toUpperCase()}</small></span>
                ) : bookings.length === 2 && !fullBooking ? (
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
                    <span className={`desk-pin-initials ${imgOk ? 'is-hidden' : ''}`}>{initials || '•'}</span>
                  </>
                ) : (
                  <span className="desk-pin-free-dot" aria-hidden="true" />
                )}
              </span>
            </button>
          );
        })}
      </div>
      {tooltip && tooltipDesk && createPortal(
        <div className="desk-tooltip" style={{ left: tooltip.left, top: tooltip.top }} role="tooltip">
          <strong>{resourceKindLabel(tooltipDesk.kind)}: {getDeskLabel(tooltipDesk)}</strong>
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
                  <span>AM: {am?.userDisplayName ?? am?.userEmail ?? 'frei'}</span>
                  <span>PM: {pm?.userDisplayName ?? pm?.userEmail ?? 'frei'}</span>
                  {full && <span>Ganztag: {full.userDisplayName ?? full.userEmail}</span>}
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

export function FloorplanCanvas({ imageUrl, imageAlt, desks, selectedDeskId, hoveredDeskId, selectedDate, onHoverDesk, onSelectDesk, onCanvasClick, onDeskDoubleClick, onDeskAnchorChange, disablePulseAnimation = false }: FloorplanCanvasProps) {
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
      <DeskOverlay desks={desks} selectedDeskId={selectedDeskId} hoveredDeskId={hoveredDeskId} selectedDate={selectedDate} overlayRect={overlayRect} onHoverDesk={onHoverDesk} onSelectDesk={onSelectDesk} onDeskDoubleClick={onDeskDoubleClick} onDeskAnchorChange={onDeskAnchorChange} disablePulseAnimation={disablePulseAnimation} />
    </div>
  );
}
