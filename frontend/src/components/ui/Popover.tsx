import { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement, ReactNode, cloneElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
type PopoverChildren = ReactNode | ((context: { close: () => void }) => ReactNode);

export function Popover({ trigger, children, placement = 'bottom-start', offset = 6, matchWidth = false, zIndex = 2000, className, style, onOpenChange }: {
  trigger: ReactElement;
  children: PopoverChildren;
  placement?: Placement;
  offset?: number;
  matchWidth?: boolean;
  zIndex?: number;
  className?: string;
  style?: CSSProperties;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !panelRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const panelRect = panelRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 8;

    const alignEnd = placement.endsWith('end');
    const preferredTop = placement.startsWith('top');
    const availableBelow = viewportHeight - triggerRect.bottom - padding - offset;
    const availableAbove = triggerRect.top - padding - offset;
    const shouldOpenTop = preferredTop || (availableBelow < Math.min(panelRect.height, 220) && availableAbove > availableBelow);
    const maxHeight = Math.max(120, shouldOpenTop ? availableAbove : availableBelow);
    const top = shouldOpenTop ? triggerRect.top - Math.min(panelRect.height, maxHeight) - offset : triggerRect.bottom + offset;
    const preferredLeft = alignEnd ? triggerRect.right - panelRect.width : triggerRect.left;
    const clampedLeft = Math.min(Math.max(preferredLeft, padding), viewportWidth - panelRect.width - padding);

    setPanelStyle({
      position: 'fixed',
      top: Math.max(padding, Math.min(top, viewportHeight - padding - Math.min(panelRect.height, maxHeight))),
      left: clampedLeft,
      maxHeight,
      width: matchWidth ? triggerRect.width : undefined,
      zIndex
    });
  }, [matchWidth, offset, placement, zIndex]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updatePosition()) : null;
    if (resizeObserver) {
      if (triggerRef.current) resizeObserver.observe(triggerRef.current);
      if (panelRef.current) resizeObserver.observe(panelRef.current);
    }

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [close, open, updatePosition]);

  const triggerWithProps = useMemo(() => cloneElement(trigger, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const originalRef = (trigger as unknown as { ref?: ((instance: HTMLElement | null) => void) | { current: HTMLElement | null } }).ref;
      if (typeof originalRef === 'function') originalRef(node);
      else if (originalRef && typeof originalRef === 'object') originalRef.current = node;
    },
    'aria-expanded': open,
    'aria-haspopup': 'menu',
    onClick: (event: ReactMouseEvent) => {
      (trigger.props as { onClick?: (e: ReactMouseEvent) => void }).onClick?.(event);
      setOpen((current) => {
        const next = !current;
        onOpenChange?.(next);
        return next;
      });
    }
  }), [onOpenChange, open, trigger]);

  return (
    <>
      {triggerWithProps}
      {open && createPortal(
        <div
          ref={panelRef}
          className={className}
          style={{ ...panelStyle, ...style, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', pointerEvents: 'auto' }}
          onPointerDownCapture={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {typeof children === 'function' ? children({ close }) : children}
        </div>,
        document.body
      )}
    </>
  );
}
