import { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

type ToastVariant = 'success' | 'error';

type ToastInput = {
  message: string;
  variant?: ToastVariant;
  durationMs?: number;
};

type ToastItem = ToastInput & {
  id: number;
  variant: ToastVariant;
  expiresAt: number;
  remainingMs: number;
  isLeaving: boolean;
};

type ToastContextValue = {
  toast: (input: ToastInput) => void;
  success: (message: string) => void;
  error: (message: string) => void;
};

const EXIT_ANIMATION_MS = 180;

const DEFAULT_DURATION_MS: Record<ToastVariant, number> = {
  success: 2800,
  error: 6500,
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, number>>(new Map());

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

    setToasts((current) => [...current, {
      ...input,
      id,
      variant,
      expiresAt: now + durationMs,
      remainingMs: durationMs,
      isLeaving: false,
    }]);

    scheduleDismiss(id, durationMs);
  }, [scheduleDismiss]);

  const value = useMemo<ToastContextValue>(() => ({
    toast,
    success: (message: string) => toast({ message, variant: 'success' }),
    error: (message: string) => toast({ message, variant: 'error' }),
  }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <article
            key={item.id}
            className={`toast toast-${item.variant} ${item.isLeaving ? 'toast-leave' : 'toast-enter'}`}
            role="status"
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
      </div>
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
