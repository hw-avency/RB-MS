import { Fragment, MouseEvent, RefObject, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resourceKindLabel } from './resourceKinds';

type FloorplanDesk = {
  id: string;
  name: string;
  kind?: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { employeeId?: string; userDisplayName?: string; userEmail: string; userPhotoUrl?: string } | null;
  isCurrentUsersDesk?: boolean;
  isHighlighted?: boolean;
  isSelected?: boolean;
};

type PinState = 'FREE' | 'MINE' | 'TAKEN';

type OverlayRect = { left: number; top: number; width: number; height: number };
type PixelPoint = { x: number; y: number };

const PIN_GEOMETRY = {
  AVATAR_DIAMETER: 30,
  INNER_GAP: 2,
  RING_THICKNESS: 3,
  OUTER_PADDING: 2,
} as const;

const RING_INNER_DIAMETER = PIN_GEOMETRY.AVATAR_DIAMETER + 2 * PIN_GEOMETRY.INNER_GAP;
const RING_OUTER_DIAMETER = RING_INNER_DIAMETER + 2 * PIN_GEOMETRY.RING_THICKNESS;
const PIN_CONTAINER_SIZE = RING_OUTER_DIAMETER + 2 * PIN_GEOMETRY.OUTER_PADDING;

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

const isDeskPinDebugEnabled = (): boolean => {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('deskPinDebug') === '1' || window.localStorage.getItem('desk-pin-debug') === '1';
};

const getInitials = (name?: string, email?: string): string => {
  const source = (name?.trim() || email?.split('@')[0] || '??').replace(/[^\p{L}\s]/gu, ' ');
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

const getDeskLabel = (desk: Pick<FloorplanDesk, 'id' | 'name'>): string => {
  const label = desk.name?.toString().trim();
  return label || desk.id;
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
};

const FloorplanImage = memo(function FloorplanImage({ imageUrl, imageAlt, imgRef, onLoad }: { imageUrl: string; imageAlt: string; imgRef: RefObject<HTMLImageElement>; onLoad: () => void }) {
  return <img ref={imgRef} src={imageUrl} alt={imageAlt} className="floorplan-image" onLoad={onLoad} />;
});

const DeskOverlay = memo(function DeskOverlay({ desks, selectedDeskId, hoveredDeskId, selectedDate, overlayRect, onHoverDesk, onSelectDesk, onDeskDoubleClick, onDeskAnchorChange }: { desks: FloorplanDesk[]; selectedDeskId: string; hoveredDeskId: string; selectedDate?: string; overlayRect: OverlayRect; onHoverDesk: (deskId: string) => void; onSelectDesk: (deskId: string, anchorEl?: HTMLElement) => void; onDeskDoubleClick?: (deskId: string) => void; onDeskAnchorChange?: (deskId: string, element: HTMLElement | null) => void; }) {
  const [imageStates, setImageStates] = useState<Record<string, boolean>>({});
  const [tooltip, setTooltip] = useState<{ deskId: string; left: number; top: number } | null>(null);
  const showDebugCross = isDeskPinDebugEnabled();

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
          const deskLabel = getDeskLabel(desk);
          const initials = getInitials(desk.booking?.userDisplayName, desk.booking?.userEmail);
          const hasPhoto = Boolean(desk.booking?.userPhotoUrl);
          const imgOk = hasPhoto && (imageStates[desk.id] ?? true);
          const pinState: PinState = !desk.booking
            ? 'FREE'
            : desk.isCurrentUsersDesk
              ? 'MINE'
              : 'TAKEN';
          const isClickable = pinState !== 'TAKEN';

          if (import.meta.env.DEV && desk.status === 'booked') {
            console.log('pin employee', desk.booking?.employeeId, desk.booking?.userDisplayName, desk.booking?.userPhotoUrl);
          }

          return (
            <Fragment key={desk.id}>
              <button
                ref={(element) => {
                  onDeskAnchorChange?.(desk.id, element);
                }}
                type="button"
                data-desk-id={desk.id}
                className={`desk-pin ${desk.status} ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''} ${desk.isCurrentUsersDesk ? 'is-own-desk' : ''} ${desk.isHighlighted ? 'is-highlighted' : ''} ${desk.isSelected ? 'is-selected' : ''} ${!isClickable ? 'is-click-disabled' : ''} ${showDebugCross ? 'debug-outline' : ''}`}
                style={{
                  left: `${point.x - PIN_CONTAINER_SIZE / 2}px`,
                  top: `${point.y - PIN_CONTAINER_SIZE / 2}px`,
                  ['--pin-avatar-diameter' as string]: `${PIN_GEOMETRY.AVATAR_DIAMETER}px`,
                  ['--pin-ring-inner-diameter' as string]: `${RING_INNER_DIAMETER}px`,
                  ['--pin-ring-outer-diameter' as string]: `${RING_OUTER_DIAMETER}px`,
                  ['--pin-container-size' as string]: `${PIN_CONTAINER_SIZE}px`,
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
                  if (!isClickable) return;
                  onSelectDesk(desk.id, event.currentTarget);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (!isClickable) return;
                  onDeskDoubleClick?.(desk.id);
                }}
                tabIndex={isClickable ? 0 : -1}
                aria-label={`${resourceKindLabel(desk.kind)}: ${deskLabel} · ${pinState === 'FREE' ? 'Frei' : pinState === 'MINE' ? 'Eigene Buchung' : desk.booking?.userDisplayName ?? desk.booking?.userEmail ?? 'Belegt'}`}
              >
                <span className={`pin-ring ${showDebugCross ? 'debug-outline' : ''}`} aria-hidden="true" />
                <span className={`pin-avatar-clip ${showDebugCross ? 'debug-outline' : ''}`}>
                  {desk.status === 'booked' ? (
                    <>
                      {hasPhoto && (
                        <img
                          src={desk.booking?.userPhotoUrl}
                          alt={desk.booking?.userDisplayName ?? desk.booking?.userEmail ?? 'Mitarbeiter'}
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
                {showDebugCross && <span className="desk-pin-debug-center" aria-hidden="true" />}
              </button>
            </Fragment>
          );
        })}
      </div>
      {tooltip && tooltipDesk && createPortal(
        <div className="desk-tooltip" style={{ left: tooltip.left, top: tooltip.top }} role="tooltip">
          <strong>{tooltipDesk.booking?.userDisplayName ?? tooltipDesk.booking?.userEmail ?? 'Freier Platz'}</strong>
          <span>{resourceKindLabel(tooltipDesk.kind)}: {getDeskLabel(tooltipDesk)}</span>
          <span>{new Date(`${selectedDate ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).toLocaleDateString('de-DE')}</span>
        </div>,
        document.body
      )}
    </>
  );
});

export function FloorplanCanvas({ imageUrl, imageAlt, desks, selectedDeskId, hoveredDeskId, selectedDate, onHoverDesk, onSelectDesk, onCanvasClick, onDeskDoubleClick, onDeskAnchorChange }: FloorplanCanvasProps) {
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
      <DeskOverlay desks={desks} selectedDeskId={selectedDeskId} hoveredDeskId={hoveredDeskId} selectedDate={selectedDate} overlayRect={overlayRect} onHoverDesk={onHoverDesk} onSelectDesk={onSelectDesk} onDeskDoubleClick={onDeskDoubleClick} onDeskAnchorChange={onDeskAnchorChange} />
    </div>
  );
}
