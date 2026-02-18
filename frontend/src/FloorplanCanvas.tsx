import { CSSProperties, memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeDaySlotBookings, normalizeDaySlotBookingsPerEntry } from './daySlotBookings';
import { resourceKindLabel } from './resourceKinds';
import { BOOKABLE_END, BOOKABLE_START, ROOM_WINDOW_TOTAL_MINUTES } from './lib/bookingWindows';
import { formatMinutes } from './lib/bookingWindows';
import { computeRoomBusySegments, computeRoomOccupancy } from './lib/roomOccupancy';
import { FloorplanFlatRenderer, FloorplanRect, ResolvedFlatResource } from './FloorplanFlatRenderer';
import { NonRoomDaySlotRing } from './components/NonRoomDaySlotRing';
import { RoomBusinessDayRing } from './components/RoomBusinessDayRing';

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
  xPct?: number | null;
  yPct?: number | null;
  status: 'free' | 'booked';
  booking: FloorplanBooking | null;
  bookings?: FloorplanBooking[];
  isCurrentUsersDesk?: boolean;
  isHighlighted?: boolean;
  isSelected?: boolean;
  isBookableForMe?: boolean;
};
const PIN_HITBOX_SIZE = 44;
const PIN_VISUAL_SIZE = 36;
const RING_WIDTH = 5;
const CENTER_SIZE = 28;
const ROOM_RING_WIDTH = 8;
const MAX_ROOM_MARKER_LABEL_LENGTH = 4;


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
  if (desk.kind === 'RAUM') return normalizeDaySlotBookingsPerEntry(bookings);
  return normalizeDaySlotBookings(bookings);
};

const slotFromBooking = (booking: FloorplanBooking): 'AM' | 'PM' | 'FULL' | null => {
  if (booking.daySlot === 'FULL' || booking.slot === 'FULL_DAY') return 'FULL';
  if (booking.daySlot === 'AM' || booking.slot === 'MORNING') return 'AM';
  if (booking.daySlot === 'PM' || booking.slot === 'AFTERNOON') return 'PM';
  return null;
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
  onDisplayedRectChange?: (rect: FloorplanRect) => void;
  containImageOnly?: boolean;
  debugEnabled?: boolean;
  style?: CSSProperties;
};

const DeskOverlay = memo(function DeskOverlay({ markers, selectedDeskId, hoveredDeskId, selectedDate, bookingVersion, onHoverDesk, onSelectDesk, onDeskDoubleClick, onDeskAnchorChange, disablePulseAnimation = false, debugEnabled = false }: { markers: ResolvedFlatResource<FloorplanDesk>[]; selectedDeskId: string; hoveredDeskId: string; selectedDate?: string; bookingVersion?: number; onHoverDesk: (deskId: string) => void; onSelectDesk: (deskId: string, anchorEl?: HTMLElement) => void; onDeskDoubleClick?: (deskId: string) => void; onDeskAnchorChange?: (deskId: string, element: HTMLElement | null) => void; disablePulseAnimation?: boolean; debugEnabled?: boolean; }) {
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

  const tooltipDesk = markers.find((entry) => entry.resource.id === tooltip?.deskId)?.resource;

  return (
    <>
      <div className="desk-overlay" data-version={bookingVersion}>
        {markers.map(({ resource: desk, xPct, yPct }) => {
          const bookings = normalizeBookings(desk);
          const isRoom = desk.kind === 'RAUM';
          const roomMarkerLabel = isRoom ? getRoomMarkerLabel(desk) : null;
          const fullBooking = bookings.find((booking) => slotFromBooking(booking) === 'FULL');
          const amBooking = fullBooking ?? bookings.find((booking) => slotFromBooking(booking) === 'AM');
          const pmBooking = fullBooking ?? bookings.find((booking) => slotFromBooking(booking) === 'PM');
          const isInteracting = selectedDeskId === desk.id || hoveredDeskId === desk.id || Boolean(desk.isSelected);
          const isOccupiedByOthers = amBooking && pmBooking && !bookings.some((booking) => booking.isCurrentUser);
          const isTenantBlocked = desk.isBookableForMe === false;
          const isClickable = isRoom ? true : (isTenantBlocked ? true : !isOccupiedByOthers);
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
          const roomSegments = isRoom
            ? computeRoomBusySegments(bookings, {
                day: selectedDate,
                start: BOOKABLE_START,
                end: BOOKABLE_END,
                isOwnBooking: (booking) => Boolean(booking.isCurrentUser)
              })
            : [];
          const roomFreeSegments = roomOccupancy?.freeSegments ?? [];
          const roomCoverage = roomOccupancy?.occupiedMinutes ?? 0;
          const roomFreeMinutes = roomOccupancy?.freeMinutes ?? 0;
          const shouldShowPulse = (isRoom ? roomFreeMinutes >= 60 : bookings.length === 0) && !isInteracting && !disablePulseAnimation;
          const isRoomFullyBooked = roomCoverage >= ROOM_WINDOW_TOTAL_MINUTES - 1;
          const roomRingDebugTitle = debugEnabled && roomOccupancy
            ? [
                `business minutes booked: ${roomOccupancy.occupiedMinutes}`,
                `business minutes free: ${roomOccupancy.freeMinutes}`,
                `segments: ${roomOccupancy.intervals.length > 0 ? roomOccupancy.intervals.map((interval) => `${formatMinutes(interval.startMin)}–${formatMinutes(interval.endMin)}`).join(', ') : '—'}`,
                `percent booked: ${(roomOccupancy.occupiedRatio * 100).toFixed(1)}%`
              ].join('\n')
            : undefined;
          const amColor = slotColor(amBooking);
          const pmColor = slotColor(pmBooking);
          const isFullDay = Boolean(fullBooking);
          const nonRoomPeriod = isFullDay ? 'FULL' : amBooking && !pmBooking ? 'AM' : pmBooking && !amBooking ? 'PM' : 'MIXED';

          return (
            <button
              key={`${desk.id}-${bookingVersion ?? 0}`}
              ref={(element) => onDeskAnchorChange?.(desk.id, element)}
              type="button"
              data-desk-id={desk.id}
              className={`desk-pin ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''} ${desk.isCurrentUsersDesk ? 'is-own-desk' : ''} ${desk.isHighlighted ? 'is-highlighted' : ''} ${desk.isSelected ? 'is-selected' : ''} ${!isClickable ? 'is-click-disabled' : ''} ${isTenantBlocked ? 'is-not-bookable' : ''}`}
              data-free={shouldShowPulse ? 'true' : 'false'}
              style={{
                left: `${xPct}%`,
                top: `${yPct}%`
              }}
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
              aria-disabled={!isClickable || isTenantBlocked}
              title={bookings.length === 2 && !fullBooking ? '2 Buchungen' : undefined}
              data-debug-state={debugEnabled ? JSON.stringify({
                resourceId: desk.id,
                type: desk.kind ?? 'SONSTIGES',
                bookingsForResourceCount: bookings.length,
                occupancyState: isRoom ? (isRoomFullyBooked ? 'full' : roomIntervals.length > 0 ? 'partial' : 'free') : fullBooking ? 'full-day' : amBooking || pmBooking ? 'half-day' : 'free',
                period: nonRoomPeriod,
                amSide: 'left',
                roomFreeMinutes,
                roomCoverage
              }) : undefined}
              aria-label={`${resourceKindLabel(desk.kind)}: ${getDeskLabel(desk)}`}
            >
              {shouldShowPulse && <div className="pulseHalo" aria-hidden="true" />}
              {isRoom ? (
                <>
                  <RoomBusinessDayRing
                    segments={roomSegments}
                    freeSegments={roomFreeSegments}
                    className="room-marker-ring"
                    strokeWidth={ROOM_RING_WIDTH}
                    debugTitle={roomRingDebugTitle}
                  />
                </>
              ) : (
                <svg className="pin-ring-svg" viewBox={`0 0 ${PIN_VISUAL_SIZE} ${PIN_VISUAL_SIZE}`} shapeRendering="geometricPrecision" aria-hidden="true">
                  <NonRoomDaySlotRing isFullDay={isFullDay} amColor={amColor} pmColor={pmColor} strokeWidth={RING_WIDTH} />
                </svg>
              )}

              <span className="pin-center" style={{ width: CENTER_SIZE, height: CENTER_SIZE }}>
                {isRoom ? (
                  <span className="room-center-label">
                    <span className="room-center-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                        <circle cx="12" cy="12" r="7" fill="none" />
                        <path d="M12 8.5V12l2.5 1.75" fill="none" />
                      </svg>
                    </span>
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
            return <span className="muted">debug: resourceId={tooltipDesk.id}; type={tooltipDesk.kind ?? 'SONSTIGES'}; bookingsForResourceCount={tooltipBookings.length}; occupancy={state}; AM side: left</span>;
          })()}
        </div>,
        document.body
      )}
    </>
  );
});

export function FloorplanCanvas({ imageUrl, imageAlt, desks, selectedDeskId, hoveredDeskId, selectedDate, bookingVersion, onHoverDesk, onSelectDesk, onCanvasClick, onDeskDoubleClick, onDeskAnchorChange, disablePulseAnimation = false, onImageLoad, onImageError, onImageRenderSizeChange, onDisplayedRectChange, containImageOnly = false, debugEnabled = false, style }: FloorplanCanvasProps) {
  return (
    <FloorplanFlatRenderer
      imageSrc={imageUrl}
      imageAlt={imageAlt}
      resources={desks}
      onCanvasClick={onCanvasClick}
      onImageLoad={onImageLoad}
      onImageError={onImageError}
      onImageRenderSizeChange={onImageRenderSizeChange}
      onDisplayedRectChange={onDisplayedRectChange}
      containImageOnly={containImageOnly}
      style={style}
      renderMarkers={(markers) => (!containImageOnly ? (
        <DeskOverlay
          markers={markers}
          selectedDeskId={selectedDeskId}
          hoveredDeskId={hoveredDeskId}
          selectedDate={selectedDate}
          bookingVersion={bookingVersion}
          onHoverDesk={onHoverDesk}
          onSelectDesk={onSelectDesk}
          onDeskDoubleClick={onDeskDoubleClick}
          onDeskAnchorChange={onDeskAnchorChange}
          disablePulseAnimation={disablePulseAnimation}
          debugEnabled={debugEnabled}
        />
      ) : null)}
    />
  );
}
