import { CSSProperties, MouseEvent, RefObject, memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeDaySlotBookings } from './daySlotBookings';
import { resourceKindLabel } from './resourceKinds';
import { BOOKABLE_END, BOOKABLE_START, ROOM_WINDOW_TOTAL_MINUTES } from './lib/bookingWindows';
import { computeRoomOccupancy } from './lib/roomOccupancy';
import { OccupancyRing } from './components/OccupancyRing';

type FloorplanBooking = {
  id?: string;
  employeeId?: string;
  userId?: string | null;
  userDisplayName?: string;
  userEmail?: string | null;
  userPhotoUrl?: string;
  bookedFor?: 'SELF' | 'GUEST';
  guestName?: string | null;
  createdBy?: { id?: string; displayName?: string | null; name?: string | null };
  createdByUserId?: string;
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
  x: number | null;
  y: number | null;
  status: 'free' | 'booked';
  booking: FloorplanBooking | null;
  bookings?: FloorplanBooking[];
  isCurrentUsersDesk?: boolean;
  isHighlighted?: boolean;
  isSelected?: boolean;
};

type PixelPoint = { x: number; y: number };
type DisplayedImageRect = { left: number; top: number; width: number; height: number };
type SlotKey = 'AM' | 'PM';

const PIN_HITBOX_SIZE = 44;
const PIN_VISUAL_SIZE = 36;
const RING_RADIUS = 14.5;
const RING_WIDTH = 5;
const CENTER_SIZE = 28;
const START_ANGLE = -90;
const MAX_ROOM_MARKER_LABEL_LENGTH = 4;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const toPixelPoint = (desk: Pick<FloorplanDesk, 'x' | 'y'>): PixelPoint | null => {
  if (!Number.isFinite(desk.x) || !Number.isFinite(desk.y)) return null;
  return { x: Number(desk.x), y: Number(desk.y) };
};

const isLegacyNormalizedPoint = (point: PixelPoint): boolean => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;

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

const getBookingPersonLabel = (booking?: FloorplanBooking): string => {
  if (!booking) return 'Unbekannt';
  if (booking.bookedFor === 'GUEST') return `Gast: ${booking.guestName?.trim() || 'Unbekannt'}`;
  return booking.userDisplayName ?? booking.userEmail ?? 'Unbekannt';
};

const normalizeBookings = (desk: FloorplanDesk): FloorplanBooking[] => {
  const bookings = desk.bookings && desk.bookings.length > 0 ? desk.bookings : desk.booking ? [desk.booking] : [];
  return normalizeDaySlotBookings(bookings);
};

const slotFromBooking = (booking: FloorplanBooking): 'AM' | 'PM' | 'FULL' | null => {
  if (booking.daySlot === 'FULL' || booking.slot === 'FULL_DAY') return 'FULL';
  if (booking.daySlot === 'AM' || booking.slot === 'MORNING') return 'AM';
  if (booking.daySlot === 'PM' || booking.slot === 'AFTERNOON') return 'PM';
  return null;
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
  onCanvasClick?: (coords: { xPct: number; yPct: number; x: number; y: number; imageWidth: number; imageHeight: number }) => void;
  onDeskDoubleClick?: (deskId: string) => void;
  onDeskAnchorChange?: (deskId: string, element: HTMLElement | null) => void;
  disablePulseAnimation?: boolean;
  onImageLoad?: (payload: { width: number; height: number; src: string }) => void;
  onImageError?: (payload: { src: string; message: string }) => void;
  onImageRenderSizeChange?: (size: { width: number; height: number }) => void;
  onDisplayedRectChange?: (rect: DisplayedImageRect) => void;
  containImageOnly?: boolean;
  debugEnabled?: boolean;
  style?: CSSProperties;
};

const FloorplanImage = memo(function FloorplanImage({ imageUrl, imageAlt, imgRef, onImageLoad, onImageError, containImageOnly = false }: { imageUrl: string; imageAlt: string; imgRef: RefObject<HTMLImageElement>; onImageLoad?: (payload: { width: number; height: number; src: string }) => void; onImageError?: (payload: { src: string; message: string }) => void; containImageOnly?: boolean }) {
  return (
    <img
      ref={imgRef}
      src={imageUrl}
      alt={imageAlt}
      className={`floorplan-image ${containImageOnly ? 'floorplan-image-contain' : ''}`}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight, currentSrc } = event.currentTarget;
        if (naturalWidth > 0 && naturalHeight > 0) onImageLoad?.({ width: naturalWidth, height: naturalHeight, src: currentSrc || imageUrl });
      }}
      onError={(event) => {
        const target = event.currentTarget;
        onImageError?.({ src: target.currentSrc || imageUrl, message: `Failed to load image: ${target.currentSrc || imageUrl}` });
      }}
    />
  );
});

const DeskOverlay = memo(function DeskOverlay({ desks, selectedDeskId, hoveredDeskId, selectedDate, bookingVersion, onHoverDesk, onSelectDesk, onDeskDoubleClick, onDeskAnchorChange, disablePulseAnimation = false, debugEnabled = false, displayedRect, imageSize }: { desks: FloorplanDesk[]; selectedDeskId: string; hoveredDeskId: string; selectedDate?: string; bookingVersion?: number; onHoverDesk: (deskId: string) => void; onSelectDesk: (deskId: string, anchorEl?: HTMLElement) => void; onDeskDoubleClick?: (deskId: string) => void; onDeskAnchorChange?: (deskId: string, element: HTMLElement | null) => void; disablePulseAnimation?: boolean; debugEnabled?: boolean; displayedRect: DisplayedImageRect | null; imageSize: { width: number; height: number } | null; }) {
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
  const mapPoint = useMemo(() => {
    if (!displayedRect || !imageSize || imageSize.width <= 0 || imageSize.height <= 0) return null;
    const sx = displayedRect.width / imageSize.width;
    const sy = displayedRect.height / imageSize.height;
    return (point: PixelPoint): PixelPoint => ({
      x: displayedRect.left + point.x * sx,
      y: displayedRect.top + point.y * sy,
    });
  }, [displayedRect, imageSize]);

  return (
    <>
      <div className="desk-overlay" data-version={bookingVersion}>
        {desks.map((desk) => {
          const rawPoint = toPixelPoint(desk);
          if (!rawPoint) return null;
          const isLegacyPoint = isLegacyNormalizedPoint(rawPoint);
          if (!mapPoint || (isLegacyPoint && !imageSize)) return null;
          const point = isLegacyPoint && imageSize
            ? { x: rawPoint.x * imageSize.width, y: rawPoint.y * imageSize.height }
            : rawPoint;
          const displayPoint = mapPoint(point);
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
          const initials = getInitials(centerBooking?.userDisplayName, centerBooking?.userEmail ?? undefined);
          const hasPhoto = Boolean(centerBooking?.userPhotoUrl);
          const imgOk = hasPhoto && (imageStates[desk.id] ?? true);

          const slotColor = (booking?: FloorplanBooking): string => {
            if (!booking) return 'var(--resource-free)';
            if (booking.isCurrentUser) return 'var(--resource-own)';
            return 'var(--resource-busy)';
          };

          const roomOccupancy = isRoom ? computeRoomOccupancy(bookings, selectedDate, BOOKABLE_START, BOOKABLE_END) : null;
          const roomIntervals = roomOccupancy?.intervals ?? [];
          const roomSegments = roomOccupancy?.segments ?? [];
          const roomCoverage = roomOccupancy?.occupiedMinutes ?? 0;
          const isRoomFullyBooked = roomCoverage >= ROOM_WINDOW_TOTAL_MINUTES - 1;
          const amColor = slotColor(amBooking);
          const pmColor = slotColor(pmBooking);
          const hasUniformHalfDayColor = amColor === pmColor;
          const shouldUseButtCap = hasUniformHalfDayColor && amColor === 'var(--resource-busy)';

          return (
            <button
              key={`${desk.id}-${bookingVersion ?? 0}`}
              ref={(element) => onDeskAnchorChange?.(desk.id, element)}
              type="button"
              data-desk-id={desk.id}
              className={`desk-pin ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''} ${desk.isCurrentUsersDesk ? 'is-own-desk' : ''} ${desk.isHighlighted ? 'is-highlighted' : ''} ${desk.isSelected ? 'is-selected' : ''} ${!isClickable ? 'is-click-disabled' : ''}`}
              data-free={shouldShowPulse ? 'true' : 'false'}
              style={{ left: `${displayPoint.x - PIN_HITBOX_SIZE / 2}px`, top: `${displayPoint.y - PIN_HITBOX_SIZE / 2}px` }}
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
                if (!isClickable) {
                  return;
                }
                onSelectDesk(desk.id, event.currentTarget);
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onDeskDoubleClick?.(desk.id);
              }}
              tabIndex={0}
              aria-disabled={!isClickable}
              title={bookings.length === 2 && !fullBooking ? '2 Buchungen' : undefined}
              data-debug-state={debugEnabled ? JSON.stringify({
                resourceId: desk.id,
                type: desk.kind ?? 'SONSTIGES',
                bookingsForResourceCount: bookings.length,
                occupancyState: isRoom ? (isRoomFullyBooked ? 'full' : roomIntervals.length > 0 ? 'partial' : 'free') : fullBooking ? 'full-day' : amBooking || pmBooking ? 'half-day' : 'free'
              }) : undefined}
              aria-label={`${resourceKindLabel(desk.kind)}: ${getDeskLabel(desk)}`}
            >
              {shouldShowPulse && <div className="pulseHalo" aria-hidden="true" />}
              {isRoom && <OccupancyRing segments={roomSegments} className="pin-room-ring" label={`Raumbelegung ${getRoomName(desk)}`} />}
              <svg className="pin-ring-svg" viewBox={`0 0 ${PIN_VISUAL_SIZE} ${PIN_VISUAL_SIZE}`} shapeRendering="geometricPrecision" aria-hidden="true">
                {isRoom ? null : hasUniformHalfDayColor ? (
                  <circle cx={PIN_VISUAL_SIZE / 2} cy={PIN_VISUAL_SIZE / 2} r={RING_RADIUS} className="pin-ring-arc" style={{ stroke: amColor, strokeWidth: RING_WIDTH, strokeLinecap: shouldUseButtCap ? 'butt' : 'round' }} />
                ) : (
                  <>
                    <path d={arcPath(START_ANGLE, START_ANGLE + 180, RING_RADIUS)} className="pin-ring-arc" style={{ stroke: amColor, strokeWidth: RING_WIDTH, strokeLinecap: 'round' }} />
                    <path d={arcPath(START_ANGLE + 180, START_ANGLE + 360, RING_RADIUS)} className="pin-ring-arc" style={{ stroke: pmColor, strokeWidth: RING_WIDTH, strokeLinecap: 'round' }} />
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
              <span key={booking.id ?? `${booking.userEmail ?? 'unknown'}-${booking.startTime}`}>{`${booking.startTime ?? '--:--'}-${booking.endTime ?? '--:--'}: ${getBookingPersonLabel(booking)}${booking.bookedFor === 'GUEST' ? ` · gebucht von ${booking.createdBy?.displayName ?? booking.createdBy?.name ?? 'Unbekannt'}` : ''}`}</span>
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
                    <span>Ganztägig: {getBookingPersonLabel(full)}{full.bookedFor === 'GUEST' ? ` · gebucht von ${full.createdBy?.displayName ?? full.createdBy?.name ?? 'Unbekannt'}` : ''}</span>
                  ) : (
                    <>
                      {am && <span>Vormittag: {getBookingPersonLabel(am)}{am.bookedFor === 'GUEST' ? ` · gebucht von ${am.createdBy?.displayName ?? am.createdBy?.name ?? 'Unbekannt'}` : ''}</span>}
                      {pm && <span>Nachmittag: {getBookingPersonLabel(pm)}{pm.bookedFor === 'GUEST' ? ` · gebucht von ${pm.createdBy?.displayName ?? pm.createdBy?.name ?? 'Unbekannt'}` : ''}</span>}
                    </>
                  )}
                </>
              );
            })()
          )}
          <span>{new Date(`${selectedDate ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).toLocaleDateString('de-DE')}</span>
          {debugEnabled && (() => {
            const tooltipBookings = normalizeBookings(tooltipDesk);
            const full = tooltipBookings.find((booking) => slotFromBooking(booking) === 'FULL');
            const am = full ?? tooltipBookings.find((booking) => slotFromBooking(booking) === 'AM');
            const pm = full ?? tooltipBookings.find((booking) => slotFromBooking(booking) === 'PM');
            if (tooltipDesk.kind === 'RAUM') {
              const roomDebug = computeRoomOccupancy(tooltipBookings, selectedDate, BOOKABLE_START, BOOKABLE_END);
              return <span className="muted">debug: resourceId={tooltipDesk.id}; type={tooltipDesk.kind ?? 'SONSTIGES'}; bookingsForResourceCount={tooltipBookings.length}; occupancy={roomDebug.segments.length > 0 ? 'occupied-segments' : 'free'}; segments={roomDebug.segments.length}; occupiedMinutes={roomDebug.occupiedMinutes}; percentOccupied={(roomDebug.occupiedRatio * 100).toFixed(1)}%</span>;
            }
            const state = full ? 'full-day' : am || pm ? 'half-day' : 'free';
            return <span className="muted">debug: resourceId={tooltipDesk.id}; type={tooltipDesk.kind ?? 'SONSTIGES'}; bookingsForResourceCount={tooltipBookings.length}; occupancy={state}</span>;
          })()}
        </div>,
        document.body
      )}
    </>
  );
});

export function FloorplanCanvas({ imageUrl, imageAlt, desks, selectedDeskId, hoveredDeskId, selectedDate, bookingVersion, onHoverDesk, onSelectDesk, onCanvasClick, onDeskDoubleClick, onDeskAnchorChange, disablePulseAnimation = false, onImageLoad, onImageError, onImageRenderSizeChange, onDisplayedRectChange, containImageOnly = false, debugEnabled = false, style }: FloorplanCanvasProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [displayedRect, setDisplayedRect] = useState<DisplayedImageRect | null>(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [imageUrl]);

  const syncDisplayedRect = useMemo(() => {
    return () => {
      if (!canvasRef.current || !naturalSize) return;
      const containerWidth = canvasRef.current.clientWidth;
      const containerHeight = canvasRef.current.clientHeight;
      if (containerWidth <= 0 || containerHeight <= 0 || naturalSize.width <= 0 || naturalSize.height <= 0) return;

      const scale = Math.min(containerWidth / naturalSize.width, containerHeight / naturalSize.height);
      const width = naturalSize.width * scale;
      const height = naturalSize.height * scale;
      const left = (containerWidth - width) / 2;
      const top = (containerHeight - height) / 2;
      const nextRect = { left, top, width, height };
      setDisplayedRect(nextRect);
      onImageRenderSizeChange?.({ width, height });
      onDisplayedRectChange?.(nextRect);
    };
  }, [naturalSize, onDisplayedRectChange, onImageRenderSizeChange]);

  useEffect(() => {
    if (!canvasRef.current || !naturalSize) return;
    syncDisplayedRect();
    const observer = new ResizeObserver(syncDisplayedRect);
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [naturalSize, syncDisplayedRect]);

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onCanvasClick || !canvasRef.current || !displayedRect || !naturalSize) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const localX = event.clientX - canvasRect.left;
    const localY = event.clientY - canvasRect.top;
    const xNorm = clamp01((localX - displayedRect.left) / Math.max(displayedRect.width, 1));
    const yNorm = clamp01((localY - displayedRect.top) / Math.max(displayedRect.height, 1));
    const imageWidth = naturalSize.width;
    const imageHeight = naturalSize.height;
    onCanvasClick({
      xPct: xNorm,
      yPct: yNorm,
      x: xNorm * imageWidth,
      y: yNorm * imageHeight,
      imageWidth,
      imageHeight
    });
  };

  return (
    <div ref={canvasRef} className={`floorplan-canvas ${containImageOnly ? 'floorplan-canvas-contain' : ''}`} role="presentation" onClick={handleCanvasClick} style={style}>
      <FloorplanImage
        imageUrl={imageUrl}
        imageAlt={imageAlt}
        imgRef={imgRef}
        onImageLoad={(payload) => {
          setNaturalSize({ width: payload.width, height: payload.height });
          onImageLoad?.(payload);
        }}
        onImageError={onImageError}
        containImageOnly={containImageOnly}
      />
      {!containImageOnly && <DeskOverlay desks={desks} selectedDeskId={selectedDeskId} hoveredDeskId={hoveredDeskId} selectedDate={selectedDate} bookingVersion={bookingVersion} onHoverDesk={onHoverDesk} onSelectDesk={onSelectDesk} onDeskDoubleClick={onDeskDoubleClick} onDeskAnchorChange={onDeskAnchorChange} disablePulseAnimation={disablePulseAnimation} debugEnabled={debugEnabled} displayedRect={displayedRect} imageSize={naturalSize} />}
    </div>
  );
}
