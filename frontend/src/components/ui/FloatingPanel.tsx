import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type FloatingPanelProps = {
  open: boolean;
  onClose: () => void;
  anchorElement?: HTMLElement | null;
  anchorRect?: DOMRect;
  className?: string;
  repositionKey?: string | number;
  children: ReactNode;
};

type PositionResult = { left: number; top: number; maxHeight: number; width: number; maxWidth: number };

const VIEWPORT_PADDING = 8;
const OFFSET = 8;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const computePosition = (anchor: DOMRect, floatingRect: DOMRect): PositionResult => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const availableWidth = Math.max(280, viewportWidth - VIEWPORT_PADDING * 2);
  const availableHeight = Math.max(240, viewportHeight - VIEWPORT_PADDING * 2);

  const baseWidth = Math.max(320, Math.min(560, anchor.width || 560));
  const maxWidth = Math.max(320, Math.min(560, availableWidth));
  const width = Math.min(baseWidth, maxWidth);
  const height = floatingRect.height;

  const placements: Array<{ left: number; top: number }> = [
    { left: anchor.right + OFFSET, top: anchor.top },
    { left: anchor.left - width - OFFSET, top: anchor.top },
    { left: anchor.left, top: anchor.bottom + OFFSET },
    { left: anchor.left, top: anchor.top - height - OFFSET }
  ];

  const fit = placements.map((candidate) => {
    const left = clamp(candidate.left, VIEWPORT_PADDING, viewportWidth - width - VIEWPORT_PADDING);
    const top = clamp(candidate.top, VIEWPORT_PADDING, viewportHeight - Math.min(height, availableHeight) - VIEWPORT_PADDING);
    const overflow = Math.max(0, VIEWPORT_PADDING - candidate.left)
      + Math.max(0, candidate.left + width - (viewportWidth - VIEWPORT_PADDING))
      + Math.max(0, VIEWPORT_PADDING - candidate.top)
      + Math.max(0, candidate.top + Math.min(height, availableHeight) - (viewportHeight - VIEWPORT_PADDING));
    return { left, top, overflow };
  }).sort((a, b) => a.overflow - b.overflow)[0];

  return {
    left: fit.left,
    top: fit.top,
    maxHeight: Math.max(240, viewportHeight - fit.top - VIEWPORT_PADDING),
    width,
    maxWidth
  };
};

export function FloatingPanel({ open, onClose, anchorElement, anchorRect, className, repositionKey, children }: FloatingPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<PositionResult | null>(null);

  const referenceRect = useMemo(() => {
    if (anchorElement) return anchorElement.getBoundingClientRect();
    if (anchorRect) return anchorRect;
    return null;
  }, [anchorElement, anchorRect, repositionKey]);

  useEffect(() => {
    if (!open || !referenceRect || !panelRef.current) return;
    const next = computePosition(referenceRect, panelRef.current.getBoundingClientRect());
    setPosition(next);
  }, [open, referenceRect, repositionKey]);

  useEffect(() => {
    if (!open || !referenceRect) return;
    const update = () => {
      if (!panelRef.current) return;
      const anchor = anchorElement?.getBoundingClientRect() ?? anchorRect ?? referenceRect;
      setPosition(computePosition(anchor, panelRef.current.getBoundingClientRect()));
    };
    update();

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      onClose();
    };

    const observer = typeof ResizeObserver !== 'undefined' && panelRef.current ? new ResizeObserver(update) : null;
    if (observer && panelRef.current) observer.observe(panelRef.current);

    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('keydown', onEscape);
    window.addEventListener('pointerdown', onPointerDown, true);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('keydown', onEscape);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchorElement, anchorRect, onClose, open, referenceRect]);

  if (!open || !referenceRect) return null;

  return createPortal(
    <section
      ref={panelRef}
      className={className}
      style={{
        left: position?.left ?? referenceRect.left,
        top: position?.top ?? referenceRect.top,
        maxHeight: position?.maxHeight,
        width: position?.width,
        maxWidth: position?.maxWidth,
        visibility: position ? 'visible' : 'hidden'
      }}
      role="dialog"
      onWheelCapture={(event) => event.stopPropagation()}
      onPointerDownCapture={(event) => event.stopPropagation()}
    >
      {children}
    </section>,
    document.body
  );
}
