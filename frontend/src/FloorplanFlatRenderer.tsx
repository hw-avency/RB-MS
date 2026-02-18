import { CSSProperties, MouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type FloorplanFlatResource = {
  id: string;
  x?: number | null;
  y?: number | null;
  xPct?: number | null;
  yPct?: number | null;
};

export type FloorplanRect = { left: number; top: number; width: number; height: number };
type FloorplanNaturalSize = { width: number; height: number };

export type ResolvedFlatResource<T extends FloorplanFlatResource> = {
  resource: T;
  xPct: number;
  yPct: number;
  leftPx: number;
  topPx: number;
};

type FloorplanFlatRendererProps<T extends FloorplanFlatResource> = {
  imageSrc: string;
  imageAlt: string;
  resources: T[];
  renderMarkers: (resources: ResolvedFlatResource<T>[]) => ReactNode;
  onCanvasClick?: (coords: { xPct: number; yPct: number; x: number; y: number; imageWidth: number; imageHeight: number }) => void;
  onImageLoad?: (payload: { width: number; height: number; src: string }) => void;
  onImageError?: (payload: { src: string; message: string }) => void;
  onImageRenderSizeChange?: (size: { width: number; height: number }) => void;
  onDisplayedRectChange?: (rect: FloorplanRect) => void;
  containImageOnly?: boolean;
  className?: string;
  style?: CSSProperties;
};

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

const resolvePosition = (resource: FloorplanFlatResource, naturalSize: FloorplanNaturalSize): { xPct: number; yPct: number } | null => {
  if (Number.isFinite(resource.xPct) && Number.isFinite(resource.yPct)) {
    return { xPct: clampPct(Number(resource.xPct)), yPct: clampPct(Number(resource.yPct)) };
  }
  if (!Number.isFinite(resource.x) || !Number.isFinite(resource.y) || naturalSize.width <= 0 || naturalSize.height <= 0) return null;

  const rawX = Number(resource.x);
  const rawY = Number(resource.y);
  const legacyPercent = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
  if (legacyPercent) return { xPct: clampPct(rawX * 100), yPct: clampPct(rawY * 100) };

  return { xPct: clampPct((rawX / naturalSize.width) * 100), yPct: clampPct((rawY / naturalSize.height) * 100) };
};

export function FloorplanFlatRenderer<T extends FloorplanFlatResource>({ imageSrc, imageAlt, resources, renderMarkers, onCanvasClick, onImageLoad, onImageError, onImageRenderSizeChange, onDisplayedRectChange, containImageOnly = false, className, style }: FloorplanFlatRendererProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<FloorplanNaturalSize | null>(null);
  const [displayedRect, setDisplayedRect] = useState<FloorplanRect | null>(null);

  useEffect(() => {
    setNaturalSize(null);
    setDisplayedRect(null);
  }, [imageSrc]);

  const syncDisplayedRect = useCallback(() => {
    if (!containerRef.current || !naturalSize) return;
    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;
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
  }, [naturalSize, onDisplayedRectChange, onImageRenderSizeChange]);

  useEffect(() => {
    if (!containerRef.current || !naturalSize) return;
    syncDisplayedRect();
    const observer = new ResizeObserver(syncDisplayedRect);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [naturalSize, syncDisplayedRect]);

  const resolvedResources = useMemo<ResolvedFlatResource<T>[]>(() => {
    if (!naturalSize || !displayedRect) return [];
    return resources.flatMap((resource) => {
      const normalized = resolvePosition(resource, naturalSize);
      if (!normalized) return [];
      return [{
        resource,
        xPct: normalized.xPct,
        yPct: normalized.yPct,
        leftPx: displayedRect.left + (normalized.xPct / 100) * displayedRect.width,
        topPx: displayedRect.top + (normalized.yPct / 100) * displayedRect.height,
      }];
    });
  }, [displayedRect, naturalSize, resources]);

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onCanvasClick || !containerRef.current || !displayedRect || !naturalSize) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const localX = event.clientX - containerRect.left;
    const localY = event.clientY - containerRect.top;
    const xPct = clampPct(((localX - displayedRect.left) / Math.max(displayedRect.width, 1)) * 100);
    const yPct = clampPct(((localY - displayedRect.top) / Math.max(displayedRect.height, 1)) * 100);
    onCanvasClick({ xPct, yPct, x: (xPct / 100) * naturalSize.width, y: (yPct / 100) * naturalSize.height, imageWidth: naturalSize.width, imageHeight: naturalSize.height });
  };

  return (
    <div ref={containerRef} className={`floorplan-canvas ${containImageOnly ? 'floorplan-canvas-contain' : ''} ${className ?? ''}`.trim()} role="presentation" onClick={handleCanvasClick} style={style}>
      <img
        src={imageSrc}
        alt={imageAlt}
        className={`floorplan-image ${containImageOnly ? 'floorplan-image-contain' : ''}`}
        draggable={false}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight, currentSrc } = event.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) {
            setNaturalSize({ width: naturalWidth, height: naturalHeight });
            onImageLoad?.({ width: naturalWidth, height: naturalHeight, src: currentSrc || imageSrc });
          }
        }}
        onError={(event) => {
          const target = event.currentTarget;
          onImageError?.({ src: target.currentSrc || imageSrc, message: `Failed to load image: ${target.currentSrc || imageSrc}` });
        }}
      />
      {!containImageOnly && displayedRect && (
        <div className="floorplan-marker-overlay" style={{ left: `${displayedRect.left}px`, top: `${displayedRect.top}px`, width: `${displayedRect.width}px`, height: `${displayedRect.height}px` }}>
          {renderMarkers(resolvedResources)}
        </div>
      )}
    </div>
  );
}
