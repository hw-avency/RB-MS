import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, ensureCsrfCookie, get, post, resetClientCaches } from '../api';

export type AuthUser = { id: string; name: string; email: string; displayName?: string; role: 'admin' | 'user' };
type AuthMeResponse = { user: AuthUser };

type AuthContextValue = {
  user: AuthUser | null;
  loadingAuth: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<AuthUser | null>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);

  const refreshMe = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const response = await get<AuthMeResponse>('/auth/me');
      setUser(response.user);
      await ensureCsrfCookie();
      return response.user;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
        setUser(null);
        return null;
      }

      setUser(null);
      return null;
    }
  }, []);


  useEffect(() => {
    void (async () => {
      setLoadingAuth(true);
      try {
        await refreshMe();
      } finally {
        setLoadingAuth(false);
      }
    })();
  }, [refreshMe]);

  const login = useCallback(async (email: string, password: string) => {
    await post<AuthMeResponse>('/auth/login', { email, password });

    try {
      const meResponse = await get<AuthMeResponse>('/auth/me');
      setUser(meResponse.user);
      await ensureCsrfCookie();
      return;
    } catch (error) {
      setUser(null);
      if (error instanceof ApiError) {
        throw new ApiError({
          message: 'Login ok, aber Session fehlt.',
          status: error.status,
          code: error.code,
          kind: error.kind,
          details: error.details,
          backendCode: 'SESSION_MISSING',
          requestId: error.requestId,
          method: error.method,
          path: error.path
        });
      }

      throw new ApiError({
        message: 'Login ok, aber Session fehlt.',
        status: 401,
        code: 'UNAUTHORIZED',
        kind: 'HTTP_ERROR',
        backendCode: 'SESSION_MISSING',
        method: 'GET',
        path: '/auth/me'
      });
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout', {});
    } finally {
      setUser(null);
      resetClientCaches();
    }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loadingAuth,
    isAuthenticated: Boolean(user),
    isAdmin: user?.role === 'admin',
    login,
    logout,
    refreshMe
  }), [user, loadingAuth, login, logout, refreshMe]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
