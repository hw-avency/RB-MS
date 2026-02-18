import { CSSProperties, MouseEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { FloorplanViewport, ViewTransform } from './FloorplanViewport';

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
  worldX: number;
  worldY: number;
  leftPx: number;
  topPx: number;
};

export type FloorplanViewportInfo = {
  zoom: number;
  fitZoom: number;
  tx: number;
  ty: number;
  containerWidth: number;
  containerHeight: number;
  naturalWidth: number;
  naturalHeight: number;
};

type FloorplanFlatRendererProps<T extends FloorplanFlatResource> = {
  imageSrc: string;
  imageAlt: string;
  resources: T[];
  renderMarkers: (resources: ResolvedFlatResource<T>[], viewport: FloorplanViewportInfo) => ReactNode;
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

const toViewportInfo = (transform: ViewTransform, size: { width: number; height: number }, naturalSize: FloorplanNaturalSize): FloorplanViewportInfo => ({
  zoom: transform.zoom,
  fitZoom: transform.fitZoom,
  tx: transform.tx,
  ty: transform.ty,
  containerWidth: size.width,
  containerHeight: size.height,
  naturalWidth: naturalSize.width,
  naturalHeight: naturalSize.height,
});

export function FloorplanFlatRenderer<T extends FloorplanFlatResource>({ imageSrc, imageAlt, resources, renderMarkers, onCanvasClick, onImageLoad, onImageError, onImageRenderSizeChange, onDisplayedRectChange, containImageOnly = false, className, style }: FloorplanFlatRendererProps<T>) {
  const [naturalSize, setNaturalSize] = useState<FloorplanNaturalSize | null>(null);
  const [viewportInfo, setViewportInfo] = useState<FloorplanViewportInfo>({ zoom: 1, fitZoom: 1, tx: 0, ty: 0, containerWidth: 0, containerHeight: 0, naturalWidth: 1, naturalHeight: 1 });

  useEffect(() => {
    setNaturalSize(null);
  }, [imageSrc]);

  const resolvedResources = useMemo<ResolvedFlatResource<T>[]>(() => {
    if (!naturalSize) return [];
    return resources.flatMap((resource) => {
      const normalized = resolvePosition(resource, naturalSize);
      if (!normalized) return [];
      const worldX = (normalized.xPct / 100) * naturalSize.width;
      const worldY = (normalized.yPct / 100) * naturalSize.height;
      return [{
        resource,
        xPct: normalized.xPct,
        yPct: normalized.yPct,
        worldX,
        worldY,
        leftPx: viewportInfo.tx + worldX * viewportInfo.zoom,
        topPx: viewportInfo.ty + worldY * viewportInfo.zoom,
      }];
    });
  }, [naturalSize, resources, viewportInfo.tx, viewportInfo.ty, viewportInfo.zoom]);

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onCanvasClick || !naturalSize) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const worldX = (localX - viewportInfo.tx) / Math.max(viewportInfo.zoom, 0.0001);
    const worldY = (localY - viewportInfo.ty) / Math.max(viewportInfo.zoom, 0.0001);
    const xPct = clampPct((worldX / naturalSize.width) * 100);
    const yPct = clampPct((worldY / naturalSize.height) * 100);
    onCanvasClick({ xPct, yPct, x: (xPct / 100) * naturalSize.width, y: (yPct / 100) * naturalSize.height, imageWidth: naturalSize.width, imageHeight: naturalSize.height });
  };

  return (
    <div className={`floorplan-canvas ${containImageOnly ? 'floorplan-canvas-contain' : ''} ${className ?? ''}`.trim()} role="presentation" onClick={handleCanvasClick} style={style}>
      {naturalSize ? (
        <FloorplanViewport
          naturalWidth={naturalSize.width}
          naturalHeight={naturalSize.height}
          style={{ width: '100%', height: '100%' }}
          onTransformChange={(state) => {
            const nextViewport = toViewportInfo(state, { width: state.containerWidth, height: state.containerHeight }, naturalSize);
            setViewportInfo(nextViewport);
            const rect = { left: state.tx, top: state.ty, width: naturalSize.width * state.zoom, height: naturalSize.height * state.zoom };
            onImageRenderSizeChange?.({ width: rect.width, height: rect.height });
            onDisplayedRectChange?.(rect);
          }}
        >
          {({ transform }) => (
            <div
              className="floorplan-world"
              style={{
                width: `${naturalSize.width}px`,
                height: `${naturalSize.height}px`,
                transform: `translate3d(${transform.tx}px, ${transform.ty}px, 0) scale(${transform.zoom})`,
              }}
            >
              <img src={imageSrc} alt={imageAlt} className={`floorplan-image ${containImageOnly ? 'floorplan-image-contain' : ''}`} draggable={false} />
              {!containImageOnly && (
                <div className="floorplan-marker-overlay">
                  {renderMarkers(resolvedResources, viewportInfo)}
                </div>
              )}
            </div>
          )}
        </FloorplanViewport>
      ) : (
        <img
          src={imageSrc}
          alt={imageAlt}
          className={`floorplan-image ${containImageOnly ? 'floorplan-image-contain' : ''}`}
          draggable={false}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight, currentSrc } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              const next = { width: naturalWidth, height: naturalHeight };
              setNaturalSize(next);
              setViewportInfo((current) => ({ ...current, naturalWidth: naturalWidth, naturalHeight: naturalHeight }));
              onImageLoad?.({ width: naturalWidth, height: naturalHeight, src: currentSrc || imageSrc });
            }
          }}
          onError={(event) => {
            const target = event.currentTarget;
            onImageError?.({ src: target.currentSrc || imageSrc, message: `Failed to load image: ${target.currentSrc || imageSrc}` });
          }}
        />
      )}
    </div>
  );
}
