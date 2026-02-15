export const createMutationRequestId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `mut-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const logMutation = (event: string, payload: Record<string, unknown>): void => {
  console.log(`[MUT] ${event}`, payload);
};

export const toBodySnippet = (body: unknown): string => {
  if (typeof body === 'string') return body.slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body).slice(0, 300);
  }
};
