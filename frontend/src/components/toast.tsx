import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

type ToastVariant = 'success' | 'destructive';

type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
};

type ToastItem = ToastInput & {
  id: number;
  variant: ToastVariant;
};

type ToastContextValue = {
  toast: (input: ToastInput) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
};

const DEFAULT_DURATION_MS: Record<ToastVariant, number> = {
  success: 3000,
  destructive: 6000,
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((toastId: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = Date.now() + Math.floor(Math.random() * 10000);
    const variant = input.variant ?? 'success';
    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS[variant];

    setToasts((current) => [...current, { ...input, id, variant }]);

    window.setTimeout(() => {
      dismiss(id);
    }, durationMs);
  }, [dismiss]);

  const value = useMemo<ToastContextValue>(() => ({
    toast,
    success: (title: string, description?: string) => toast({ title, description, variant: 'success' }),
    error: (title: string, description?: string) => toast({ title, description, variant: 'destructive' }),
  }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <article key={item.id} className={`toast toast-${item.variant}`} role="status">
            <div className="toast-content">
              <strong>{item.title}</strong>
              {item.description && <p>{item.description}</p>}
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
