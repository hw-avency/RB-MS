import { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ViewTransform = {
  zoom: number;
  tx: number;
  ty: number;
  fitZoom: number;
};

type FloorplanViewportProps = {
  naturalWidth: number;
  naturalHeight: number;
  className?: string;
  style?: CSSProperties;
  children: (state: {
    transform: ViewTransform;
    containerSize: { width: number; height: number };
  }) => ReactNode;
  onTransformChange?: (state: ViewTransform & { containerWidth: number; containerHeight: number }) => void;
  onDoubleTap?: (world: { x: number; y: number }) => void;
};

type Point = { x: number; y: number };

const MIN_DIMENSION = 1;
const MAX_ZOOM_MULTIPLIER = 4;
const DOUBLE_TAP_MS = 260;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export function FloorplanViewport({ naturalWidth, naturalHeight, className, style, children, onTransformChange, onDoubleTap }: FloorplanViewportProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; startTx: number; startTy: number } | null>(null);
  const pinchStateRef = useRef<{ distance: number; startZoom: number; center: Point } | null>(null);
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null);

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const fitZoom = useMemo(() => {
    const width = Math.max(containerSize.width, MIN_DIMENSION);
    const height = Math.max(containerSize.height, MIN_DIMENSION);
    const fit = Math.min(width / Math.max(naturalWidth, MIN_DIMENSION), height / Math.max(naturalHeight, MIN_DIMENSION));
    return Number.isFinite(fit) && fit > 0 ? fit : 1;
  }, [containerSize.height, containerSize.width, naturalHeight, naturalWidth]);

  const [transform, setTransform] = useState<ViewTransform>({ zoom: 1, tx: 0, ty: 0, fitZoom: 1 });

  const clampTransform = useCallback((next: ViewTransform): ViewTransform => {
    const width = Math.max(containerSize.width, MIN_DIMENSION);
    const height = Math.max(containerSize.height, MIN_DIMENSION);
    const scaledWidth = naturalWidth * next.zoom;
    const scaledHeight = naturalHeight * next.zoom;

    const minTx = scaledWidth <= width ? (width - scaledWidth) / 2 : width - scaledWidth;
    const maxTx = scaledWidth <= width ? (width - scaledWidth) / 2 : 0;
    const minTy = scaledHeight <= height ? (height - scaledHeight) / 2 : height - scaledHeight;
    const maxTy = scaledHeight <= height ? (height - scaledHeight) / 2 : 0;

    return {
      ...next,
      tx: clamp(next.tx, minTx, maxTx),
      ty: clamp(next.ty, minTy, maxTy),
    };
  }, [containerSize.height, containerSize.width, naturalHeight, naturalWidth]);

  useEffect(() => {
    if (!viewportRef.current) return;
    const update = () => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      setContainerSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const width = Math.max(containerSize.width, MIN_DIMENSION);
    const height = Math.max(containerSize.height, MIN_DIMENSION);
    if (width <= 0 || height <= 0) return;
    const tx = (width - naturalWidth * fitZoom) / 2;
    const ty = (height - naturalHeight * fitZoom) / 2;
    setTransform(clampTransform({ zoom: fitZoom, tx, ty, fitZoom }));
  }, [clampTransform, containerSize.height, containerSize.width, fitZoom, naturalHeight, naturalWidth]);

  useEffect(() => {
    onTransformChange?.({ ...transform, containerWidth: containerSize.width, containerHeight: containerSize.height });
  }, [containerSize.height, containerSize.width, onTransformChange, transform]);

  const zoomAt = useCallback((factor: number, center: Point) => {
    setTransform((current) => {
      const minZoom = current.fitZoom;
      const maxZoom = current.fitZoom * MAX_ZOOM_MULTIPLIER;
      const nextZoom = clamp(current.zoom * factor, minZoom, maxZoom);
      if (nextZoom === current.zoom) return current;
      const worldX = (center.x - current.tx) / Math.max(current.zoom, 0.0001);
      const worldY = (center.y - current.ty) / Math.max(current.zoom, 0.0001);
      const next = {
        ...current,
        zoom: nextZoom,
        tx: center.x - worldX * nextZoom,
        ty: center.y - worldY * nextZoom,
      };
      return clampTransform(next);
    });
  }, [clampTransform]);

  const clientToLocal = (clientX: number, clientY: number, target: HTMLDivElement): Point => {
    const rect = target.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const pointerToLocal = (event: ReactPointerEvent<HTMLDivElement>): Point => clientToLocal(event.clientX, event.clientY, event.currentTarget);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const local = pointerToLocal(event);
    pointersRef.current.set(event.pointerId, local);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointersRef.current.size === 1) {
      dragStateRef.current = { pointerId: event.pointerId, startX: local.x, startY: local.y, startTx: transform.tx, startTy: transform.ty };
    }
    if (pointersRef.current.size === 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      pinchStateRef.current = { distance: distance(a, b), startZoom: transform.zoom, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      dragStateRef.current = null;
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const local = pointerToLocal(event);
    pointersRef.current.set(event.pointerId, local);

    if (pointersRef.current.size === 2 && pinchStateRef.current) {
      const [a, b] = Array.from(pointersRef.current.values());
      const nextDistance = distance(a, b);
      const factor = nextDistance / Math.max(pinchStateRef.current.distance, 0.0001);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setTransform((current) => {
        const minZoom = current.fitZoom;
        const maxZoom = current.fitZoom * MAX_ZOOM_MULTIPLIER;
        const nextZoom = clamp(pinchStateRef.current!.startZoom * factor, minZoom, maxZoom);
        const worldX = (center.x - current.tx) / Math.max(current.zoom, 0.0001);
        const worldY = (center.y - current.ty) / Math.max(current.zoom, 0.0001);
        return clampTransform({ ...current, zoom: nextZoom, tx: center.x - worldX * nextZoom, ty: center.y - worldY * nextZoom });
      });
      return;
    }

    if (dragStateRef.current && dragStateRef.current.pointerId === event.pointerId) {
      const deltaX = local.x - dragStateRef.current.startX;
      const deltaY = local.y - dragStateRef.current.startY;
      setTransform((current) => clampTransform({ ...current, tx: dragStateRef.current!.startTx + deltaX, ty: dragStateRef.current!.startTy + deltaY }));
    }
  };

  const clearPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointersRef.current.size < 2) pinchStateRef.current = null;
    if (dragStateRef.current?.pointerId === event.pointerId) dragStateRef.current = null;
  };

  const handleDoubleTapZoom = (event: ReactPointerEvent<HTMLDivElement>) => {
    const local = pointerToLocal(event);
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && now - last.at <= DOUBLE_TAP_MS && distance({ x: last.x, y: last.y }, local) < 20) {
      zoomAt(1.45, local);
      const world = { x: (local.x - transform.tx) / Math.max(transform.zoom, 0.0001), y: (local.y - transform.ty) / Math.max(transform.zoom, 0.0001) };
      onDoubleTap?.(world);
      lastTapRef.current = null;
      return;
    }
    lastTapRef.current = { at: now, x: local.x, y: local.y };
  };

  return (
    <div
      ref={viewportRef}
      className={`floorplan-viewport ${className ?? ''}`.trim()}
      style={style}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearPointer}
      onPointerCancel={clearPointer}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') clearPointer(event);
      }}
      onPointerDownCapture={handleDoubleTapZoom}
      onDoubleClick={(event) => zoomAt(1.45, clientToLocal(event.clientX, event.clientY, event.currentTarget))}
      onWheel={(event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        const rect = event.currentTarget.getBoundingClientRect();
        zoomAt(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      }}
    >
      {children({ transform, containerSize })}
    </div>
  );
}
