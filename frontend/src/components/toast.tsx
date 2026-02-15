import { createContext, CSSProperties, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type ToastVariant = 'success' | 'error';

type ToastInput = {
  message: string;
  variant?: ToastVariant;
  durationMs?: number;
  deskId?: string;
  anchorRect?: DOMRect;
  fallbackRect?: DOMRect;
  placement?: ToastPlacement;
};

type ToastPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

type NormalizedRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
  durationMs?: number;
  placement: ToastPlacement;
  anchorRect?: NormalizedRect;
  expiresAt: number;
  remainingMs: number;
  isLeaving: boolean;
};

type ToastContextValue = {
  toast: (input: ToastInput) => void;
  success: (message: string, options?: Omit<ToastInput, 'message' | 'variant'>) => void;
  error: (message: string, options?: Omit<ToastInput, 'message' | 'variant'>) => void;
  registerDeskAnchor: (deskId: string, element: HTMLElement | null) => void;
  getDeskAnchorRect: (deskId: string) => DOMRect | null;
};

const EXIT_ANIMATION_MS = 180;
const EDGE_PADDING = 8;
const TOAST_OFFSET = 12;
const STACK_GAP = 8;
const FALLBACK_TOP = 76;
const FALLBACK_RIGHT = 16;
const DEFAULT_TOAST_WIDTH = 320;
const DEFAULT_TOAST_HEIGHT = 64;

const DEFAULT_DURATION_MS: Record<ToastVariant, number> = {
  success: 2800,
  error: 6500,
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [positions, setPositions] = useState<Record<number, CSSProperties>>({});
  const timersRef = useRef<Map<number, number>>(new Map());
  const elementsRef = useRef<Map<number, HTMLElement>>(new Map());
  const deskAnchorMap = useRef(new Map<string, HTMLElement>());

  const normalizeRect = useCallback((rect?: DOMRect): NormalizedRect | undefined => {
    if (!rect) return undefined;
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }, []);

  const registerDeskAnchor = useCallback((deskId: string, element: HTMLElement | null) => {
    if (!element) {
      deskAnchorMap.current.delete(deskId);
      return;
    }
    deskAnchorMap.current.set(deskId, element);
  }, []);

  const getDeskAnchorRect = useCallback((deskId: string): DOMRect | null => {
    const element = deskAnchorMap.current.get(deskId);
    return element ? element.getBoundingClientRect() : null;
  }, []);

  const resolveDeskAnchorRect = useCallback((deskId: string, retries = 3): Promise<DOMRect | null> => new Promise((resolve) => {
    let attempts = 0;

    const tryResolve = () => {
      const rect = getDeskAnchorRect(deskId);
      if (rect || attempts >= retries) {
        resolve(rect);
        return;
      }

      attempts += 1;
      window.requestAnimationFrame(tryResolve);
    };

    tryResolve();
  }), [getDeskAnchorRect]);

  const clearTimer = useCallback((toastId: number) => {
    const timer = timersRef.current.get(toastId);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(toastId);
    }
  }, []);

  const removeToast = useCallback((toastId: number) => {
    clearTimer(toastId);
    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, [clearTimer]);

  const dismiss = useCallback((toastId: number) => {
    clearTimer(toastId);
    setToasts((current) => current.map((toast) => (
      toast.id === toastId ? { ...toast, isLeaving: true } : toast
    )));
    window.setTimeout(() => {
      removeToast(toastId);
    }, EXIT_ANIMATION_MS);
  }, [clearTimer, removeToast]);

  const scheduleDismiss = useCallback((toastId: number, delayMs: number) => {
    clearTimer(toastId);
    const timer = window.setTimeout(() => dismiss(toastId), Math.max(0, delayMs));
    timersRef.current.set(toastId, timer);
  }, [clearTimer, dismiss]);

  const pauseDismiss = useCallback((toastId: number) => {
    clearTimer(toastId);
    setToasts((current) => current.map((toast) => {
      if (toast.id !== toastId || toast.isLeaving) return toast;
      return { ...toast, remainingMs: Math.max(0, toast.expiresAt - Date.now()) };
    }));
  }, [clearTimer]);

  const resumeDismiss = useCallback((toastId: number) => {
    let nextDelay = 0;
    setToasts((current) => current.map((toast) => {
      if (toast.id !== toastId || toast.isLeaving) return toast;
      nextDelay = toast.remainingMs;
      return { ...toast, expiresAt: Date.now() + toast.remainingMs };
    }));
    scheduleDismiss(toastId, nextDelay);
  }, [scheduleDismiss]);

  const toast = useCallback((input: ToastInput) => {
    const id = Date.now() + Math.floor(Math.random() * 10000);
    const variant = input.variant ?? 'success';
    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS[variant];
    const now = Date.now();

    const enqueueToast = (anchorRect?: DOMRect | null) => {
      setToasts((current) => [...current, {
        message: input.message,
        id,
        variant,
        placement: input.placement ?? 'auto',
        anchorRect: normalizeRect(anchorRect ?? input.anchorRect ?? input.fallbackRect),
        expiresAt: now + durationMs,
        remainingMs: durationMs,
        isLeaving: false,
      }]);

      scheduleDismiss(id, durationMs);
    };

    if (input.deskId) {
      void resolveDeskAnchorRect(input.deskId).then((resolvedAnchorRect) => {
        enqueueToast(resolvedAnchorRect ?? input.fallbackRect ?? input.anchorRect);
      });
      return;
    }

    enqueueToast(input.anchorRect ?? input.fallbackRect);
  }, [normalizeRect, resolveDeskAnchorRect, scheduleDismiss]);

  const value = useMemo<ToastContextValue>(() => ({
    toast,
    success: (message: string, options) => toast({ message, variant: 'success', ...options }),
    error: (message: string, options) => toast({ message, variant: 'error', ...options }),
    registerDeskAnchor,
    getDeskAnchorRect,
  }), [getDeskAnchorRect, registerDeskAnchor, toast]);

  useEffect(() => {
    if (toasts.length === 0) {
      setPositions({});
      return;
    }

    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const nextPositions: Record<number, CSSProperties> = {};
    const stackAnchors: Array<{ x: number; y: number; left: number; top: number; height: number; }> = [];

    const placeToast = (toastItem: ToastItem, width: number, height: number) => {
      const maxLeft = Math.max(EDGE_PADDING, viewportWidth - width - EDGE_PADDING);
      const maxTop = Math.max(EDGE_PADDING, viewportHeight - height - EDGE_PADDING);

      if (!toastItem.anchorRect) {
        return {
          left: clamp(viewportWidth - width - FALLBACK_RIGHT, EDGE_PADDING, maxLeft),
          top: clamp(FALLBACK_TOP, EDGE_PADDING, maxTop),
        };
      }

      const rect = toastItem.anchorRect;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const candidates = {
        right: { left: rect.right + TOAST_OFFSET, top: centerY - (height / 2) },
        bottom: { left: centerX - (width / 2), top: rect.bottom + TOAST_OFFSET },
        top: { left: centerX - (width / 2), top: rect.top - height - TOAST_OFFSET },
        left: { left: rect.left - width - TOAST_OFFSET, top: centerY - (height / 2) }
      };

      const fits = (candidate: { left: number; top: number }) => (
        candidate.left >= EDGE_PADDING
        && candidate.top >= EDGE_PADDING
        && candidate.left + width <= viewportWidth - EDGE_PADDING
        && candidate.top + height <= viewportHeight - EDGE_PADDING
      );

      const order: Array<Exclude<ToastPlacement, 'auto'>> = toastItem.placement === 'auto'
        ? ['right', 'bottom', 'top', 'left']
        : [toastItem.placement];

      const selected = order.find((placement) => fits(candidates[placement])) ?? order[0];
      const candidate = candidates[selected];

      return {
        left: clamp(candidate.left, EDGE_PADDING, maxLeft),
        top: clamp(candidate.top, EDGE_PADDING, maxTop),
        centerX,
        centerY
      };
    };

    toasts.forEach((toastItem) => {
      const element = elementsRef.current.get(toastItem.id);
      const width = Math.min(element?.offsetWidth ?? DEFAULT_TOAST_WIDTH, DEFAULT_TOAST_WIDTH);
      const height = element?.offsetHeight ?? DEFAULT_TOAST_HEIGHT;
      const basePosition = placeToast(toastItem, width, height);
      let { left, top } = basePosition;

      if (typeof basePosition.centerX === 'number' && typeof basePosition.centerY === 'number') {
        const stackWith = stackAnchors.find((anchor) => (
          Math.abs(anchor.x - basePosition.centerX!) < 36
          && Math.abs(anchor.y - basePosition.centerY!) < 36
        ));

        if (stackWith) {
          left = stackWith.left;
          top = clamp(stackWith.top + stackWith.height + STACK_GAP, EDGE_PADDING, Math.max(EDGE_PADDING, viewportHeight - height - EDGE_PADDING));
          stackWith.top = top;
          stackWith.height = height;
        } else {
          stackAnchors.push({ x: basePosition.centerX, y: basePosition.centerY, left, top, height });
        }
      }

      nextPositions[toastItem.id] = { left: `${left}px`, top: `${top}px` };
    });

    setPositions(nextPositions);
  }, [toasts]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const recalculate = () => {
      setToasts((current) => [...current]);
    };
    window.addEventListener('resize', recalculate);
    window.addEventListener('scroll', recalculate, true);
    return () => {
      window.removeEventListener('resize', recalculate);
      window.removeEventListener('scroll', recalculate, true);
    };
  }, [toasts.length]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-viewport" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <article
            key={item.id}
            className={`toast toast-${item.variant} ${item.isLeaving ? 'toast-leave' : 'toast-enter'}`}
            role="status"
            style={positions[item.id]}
            ref={(node) => {
              if (node) {
                elementsRef.current.set(item.id, node);
                return;
              }
              elementsRef.current.delete(item.id);
            }}
            onMouseEnter={() => pauseDismiss(item.id)}
            onMouseLeave={() => resumeDismiss(item.id)}
          >
            <div className="toast-message-wrap">
              <span className="toast-icon" aria-hidden="true">{item.variant === 'success' ? '✓' : '!'}</span>
              <p className="toast-message">{item.message}</p>
            </div>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(item.id)}
              aria-label="Meldung schließen"
            >
              ✕
            </button>
          </article>
        ))}
      </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}
