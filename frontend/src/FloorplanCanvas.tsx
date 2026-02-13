import { MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type FloorplanDesk = {
  id: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
};

type OverlayRect = { left: number; top: number; width: number; height: number };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const toNormalizedCoordinate = (rawValue: number, renderedSize: number): number => {
  if (!Number.isFinite(rawValue)) return 0;
  if (rawValue >= 0 && rawValue <= 1) return rawValue;
  if (rawValue > 1 && rawValue <= 100) return clamp01(rawValue / 100);
  if (renderedSize > 0) return clamp01(rawValue / renderedSize);
  return 0;
};

const toNormalizedDesk = (desk: FloorplanDesk, rect: OverlayRect) => ({
  xPct: toNormalizedCoordinate(desk.x, rect.width),
  yPct: toNormalizedCoordinate(desk.y, rect.height)
});

type FloorplanCanvasProps = {
  imageUrl: string;
  imageAlt: string;
  desks: FloorplanDesk[];
  selectedDeskId: string;
  hoveredDeskId: string;
  repositionMode?: boolean;
  onHoverDesk: (deskId: string) => void;
  onSelectDesk: (deskId: string, anchorRect: DOMRect) => void;
  onCanvasClick?: (coords: { xPct: number; yPct: number }) => void;
};

export function FloorplanCanvas({
  imageUrl,
  imageAlt,
  desks,
  selectedDeskId,
  hoveredDeskId,
  repositionMode = false,
  onHoverDesk,
  onSelectDesk,
  onCanvasClick
}: FloorplanCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const [overlayRect, setOverlayRect] = useState<OverlayRect>({ left: 0, top: 0, width: 1, height: 1 });

  const debugMode = useMemo(() => import.meta.env.DEV && localStorage.getItem('floorplanDebug') === '1', []);

  const syncOverlayRect = () => {
    if (!containerRef.current || !imgRef.current || !overlayRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const imgRect = imgRef.current.getBoundingClientRect();

    const nextRect: OverlayRect = {
      left: imgRect.left - containerRect.left,
      top: imgRect.top - containerRect.top,
      width: imgRect.width,
      height: imgRect.height
    };

    overlayRef.current.style.left = `${nextRect.left}px`;
    overlayRef.current.style.top = `${nextRect.top}px`;
    overlayRef.current.style.width = `${nextRect.width}px`;
    overlayRef.current.style.height = `${nextRect.height}px`;

    if (debugMode) {
      overlayRef.current.style.outline = '1px solid #ff4d4f';
    } else {
      overlayRef.current.style.outline = 'none';
    }

    setOverlayRect(nextRect);
  };

  const scheduleOverlaySync = () => {
    if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      syncOverlayRect();
    }, 50);
  };

  useLayoutEffect(() => {
    syncOverlayRect();
  }, [imageUrl]);

  useEffect(() => {
    scheduleOverlaySync();

    const container = containerRef.current;
    const image = imgRef.current;
    if (!container || !image) return;

    const observer = new ResizeObserver(() => scheduleOverlaySync());
    observer.observe(container);
    observer.observe(image);

    const onResize = () => scheduleOverlaySync();
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    };
  }, [imageUrl]);

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onCanvasClick || !imgRef.current) return;

    const imgRect = imgRef.current.getBoundingClientRect();
    const x = clamp01((event.clientX - imgRect.left) / imgRect.width);
    const y = clamp01((event.clientY - imgRect.top) / imgRect.height);

    if (debugMode) {
      console.info('[FloorplanCanvas] place desk', { imgRect, clientX: event.clientX, clientY: event.clientY, xPct: x, yPct: y });
    }

    onCanvasClick({ xPct: x, yPct: y });
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full floorplan-canvas ${repositionMode ? 'reposition-mode' : ''}`}
      role="presentation"
      onClick={handleCanvasClick}
    >
      <img ref={imgRef} src={imageUrl} alt={imageAlt} className="block w-full h-auto" onLoad={scheduleOverlaySync} />
      <div ref={overlayRef} className="absolute pointer-events-none">
        {desks.map((desk) => {
          const normalizedDesk = toNormalizedDesk(desk, overlayRect);
          return (
            <button
              key={desk.id}
              data-pin="desk-pin"
              type="button"
              className={`desk-pin ${desk.status} ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''}`}
              onMouseEnter={() => onHoverDesk(desk.id)}
              onMouseLeave={() => onHoverDesk('')}
              onClick={(event) => {
                event.stopPropagation();
                onSelectDesk(desk.id, event.currentTarget.getBoundingClientRect());
              }}
              style={{ left: `${normalizedDesk.xPct * overlayRect.width}px`, top: `${normalizedDesk.yPct * overlayRect.height}px` }}
            />
          );
        })}
      </div>
    </div>
  );
}
