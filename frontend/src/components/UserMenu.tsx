import { useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api';

type UserInfo = { id?: string; name?: string; displayName?: string; email: string; role: 'admin' | 'user' };

const getInitials = (user: UserInfo): string => {
  const source = (user.name ?? user.displayName ?? user.email).trim();
  if (!source) return 'U';

  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  }

  return source.slice(0, 2).toUpperCase();
};

export function UserMenu({ user, onLogout, onOpenAdmin, showAdminAction = false }: {
  user: UserInfo;
  onLogout: () => Promise<void>;
  onOpenAdmin?: () => void;
  showAdminAction?: boolean;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const initials = useMemo(() => getInitials(user), [user]);
  const displayName = user.name ?? user.displayName ?? user.email;
  const userKey = user.id ?? user.email;

  useEffect(() => {
    setPhotoFailed(false);
  }, [userKey]);

  return (
    <details className="user-menu">
      <summary className="user-chip" aria-label={`Angemeldet als ${displayName}`}>
        <span className="avatar" aria-hidden>
          {!photoFailed && <img key={userKey} src={`${API_BASE}/user/me/photo?v=${encodeURIComponent(userKey)}`} alt="Profilbild" onError={() => setPhotoFailed(true)} />}
          {photoFailed && <span>{initials}</span>}
        </span>
        <span className="user-chip-text">
          <small className="muted">Angemeldet als</small>
          <strong>{displayName}</strong>
        </span>
      </summary>
      <div className="user-menu-content">
        <p className="muted user-menu-email">{user.email}</p>
        {showAdminAction && user.role === 'admin' && onOpenAdmin && (
          <button className="btn btn-ghost" onClick={onOpenAdmin}>Admin</button>
        )}
        <button className="btn btn-outline" onClick={() => void onLogout()}>Logout</button>
      </div>
    </details>
  );
}
