import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type OverlayRect = { left: number; top: number; width: number; height: number };

type DeskPin = {
  id: string;
  x: number;
  y: number;
  status: 'free' | 'booked';
};

type FloorplanCanvasProps = {
  imageUrl: string;
  imageAlt: string;
  desks: DeskPin[];
  selectedDeskId: string;
  hoveredDeskId: string;
  repositionMode?: boolean;
  interactive?: boolean;
  debug?: boolean;
  onDeskMouseEnter?: (deskId: string) => void;
  onDeskMouseLeave?: () => void;
  onDeskClick?: (deskId: string, event: MouseEvent<HTMLButtonElement>) => void;
  onCanvasPoint?: (point: { xPct: number; yPct: number; event: MouseEvent<HTMLDivElement> }) => void;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function FloorplanCanvas({
  imageUrl,
  imageAlt,
  desks,
  selectedDeskId,
  hoveredDeskId,
  repositionMode = false,
  interactive = false,
  debug = false,
  onDeskMouseEnter,
  onDeskMouseLeave,
  onDeskClick,
  onCanvasPoint
}: FloorplanCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [overlayRect, setOverlayRect] = useState<OverlayRect>({ left: 0, top: 0, width: 0, height: 0 });

  const updateOverlayRect = useCallback(() => {
    if (!containerRef.current || !imgRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const imgRect = imgRef.current.getBoundingClientRect();
    setOverlayRect({
      left: imgRect.left - containerRect.left,
      top: imgRect.top - containerRect.top,
      width: imgRect.width,
      height: imgRect.height
    });
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedUpdate = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(updateOverlayRect, 50);
    };

    const resizeObserver = new ResizeObserver(debouncedUpdate);
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    if (imgRef.current) resizeObserver.observe(imgRef.current);

    window.addEventListener('resize', debouncedUpdate);
    debouncedUpdate();

    return () => {
      if (timer) window.clearTimeout(timer);
      resizeObserver.disconnect();
      window.removeEventListener('resize', debouncedUpdate);
    };
  }, [updateOverlayRect, imageUrl]);

  const toImageRelativePoint = useCallback((clientX: number, clientY: number) => {
    const imgRect = imgRef.current?.getBoundingClientRect();
    if (!imgRect || imgRect.width <= 0 || imgRect.height <= 0) return null;

    const xPct = clamp01((clientX - imgRect.left) / imgRect.width);
    const yPct = clamp01((clientY - imgRect.top) / imgRect.height);

    if (debug) {
      // eslint-disable-next-line no-console
      console.info('Floorplan debug rect', {
        imgRect: { left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height },
        xPct,
        yPct
      });
    }

    return { xPct, yPct };
  }, [debug]);

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!interactive || !onCanvasPoint) return;
    const point = toImageRelativePoint(event.clientX, event.clientY);
    if (!point) return;
    onCanvasPoint({ ...point, event });
  };

  const normalizedDesks = useMemo(() => {
    if (overlayRect.width <= 0 || overlayRect.height <= 0) return desks.map((desk) => ({ ...desk, xPct: clamp01(desk.x), yPct: clamp01(desk.y) }));

    return desks.map((desk) => {
      const xPct = desk.x > 1 ? clamp01(desk.x / overlayRect.width) : clamp01(desk.x);
      const yPct = desk.y > 1 ? clamp01(desk.y / overlayRect.height) : clamp01(desk.y);
      return { ...desk, xPct, yPct };
    });
  }, [desks, overlayRect.height, overlayRect.width]);

  return (
    <div
      ref={containerRef}
      className={`floorplan-canvas relative w-full h-full ${repositionMode ? 'reposition-mode' : ''}`}
      onClick={interactive ? handleCanvasClick : undefined}
      role="presentation"
    >
      <img ref={imgRef} src={imageUrl} alt={imageAlt} className="block w-full h-auto" onLoad={updateOverlayRect} />
      <div
        ref={overlayRef}
        className="absolute pointer-events-none"
        style={{
          position: 'absolute',
          pointerEvents: 'none',
          left: overlayRect.left,
          top: overlayRect.top,
          width: overlayRect.width,
          height: overlayRect.height,
          outline: debug ? '1px solid #2266ee' : 'none'
        }}
      >
        {normalizedDesks.map((desk) => (
          <button
            key={desk.id}
            data-pin="desk-pin"
            type="button"
            className={`desk-pin ${desk.status} ${selectedDeskId === desk.id ? 'selected' : ''} ${hoveredDeskId === desk.id ? 'hovered' : ''}`}
            onMouseEnter={() => onDeskMouseEnter?.(desk.id)}
            onMouseLeave={() => onDeskMouseLeave?.()}
            onClick={(event) => onDeskClick?.(desk.id, event)}
            style={{
              left: desk.xPct * overlayRect.width,
              top: desk.yPct * overlayRect.height
            }}
          />
        ))}
      </div>
    </div>
  );
}
