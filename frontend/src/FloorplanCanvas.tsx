import { MouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

type FloorplanDesk = {
  id: string;
  name: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
  booking: { userDisplayName?: string; userEmail: string } | null;
};

type OverlayRect = { left: number; top: number; width: number; height: number };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const normalized = (raw: number, size: number) => (raw > 1 ? clamp01(raw / Math.max(size, 100)) : clamp01(raw));

type FloorplanCanvasProps = {
  imageUrl: string;
  imageAlt: string;
  desks: FloorplanDesk[];
  selectedDeskId: string;
  hoveredDeskId: string;
  onHoverDesk: (deskId: string) => void;
  onSelectDesk: (deskId: string) => void;
  onCanvasClick?: (coords: { xPct: number; yPct: number }) => void;
};

export function FloorplanCanvas({ imageUrl, imageAlt, desks, selectedDeskId, hoveredDeskId, onHoverDesk, onSelectDesk, onCanvasClick }: FloorplanCanvasProps) {
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
    const imgRect = imgRef.current.getBoundingClientRect();
    onCanvasClick({ xPct: clamp01((event.clientX - imgRect.left) / imgRect.width), yPct: clamp01((event.clientY - imgRect.top) / imgRect.height) });
  };

  return (
    <div ref={containerRef} className="floorplan-canvas" role="presentation" onClick={handleCanvasClick}>
      <img ref={imgRef} src={imageUrl} alt={imageAlt} className="floorplan-image" onLoad={sync} />
      <div className="desk-overlay" style={{ left: overlayRect.left, top: overlayRect.top, width: overlayRect.width, height: overlayRect.height }}>
        {desks.map((desk) => (
          <button
            key={desk.id}
            type="button"
            className={`desk-pin ${desk.status} ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''}`}
            style={{ left: `${normalized(desk.x, overlayRect.width) * overlayRect.width}px`, top: `${normalized(desk.y, overlayRect.height) * overlayRect.height}px` }}
            title={`${desk.name} · ${desk.status === 'free' ? 'Frei' : desk.booking?.userDisplayName ?? desk.booking?.userEmail}`}
            onMouseEnter={() => onHoverDesk(desk.id)}
            onMouseLeave={() => onHoverDesk('')}
            onClick={(event) => {
              event.stopPropagation();
              onSelectDesk(desk.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}
