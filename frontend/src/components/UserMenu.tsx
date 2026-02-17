import { useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api';
import { Popover } from './ui/Popover';

type UserInfo = { id?: string; name?: string; displayName?: string; email: string; role: 'admin' | 'user' };

type IconProps = { size?: number; className?: string };

function ChevronDown({ size = 14, className }: IconProps) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>;
}

function Shield({ size = 16, className }: IconProps) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6l8-3 8 3z" /></svg>;
}

function LogOut({ size = 16, className }: IconProps) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M13 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8" /></svg>;
}

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
  }, [userKey, displayName, user.email]);

  return (
    <Popover
      trigger={
        <button type="button" className="user-chip" aria-label={`User-Menü für ${displayName}`}>
          <span className="avatar" aria-hidden>
            {!photoFailed && <img key={`${userKey}-${displayName}`} src={`${API_BASE}/user/me/photo?v=${encodeURIComponent(`${userKey}-${displayName}-${user.email}`)}`} alt="Profilbild" onError={() => setPhotoFailed(true)} />}
            {photoFailed && <span>{initials}</span>}
          </span>
          <strong className="user-chip-name">{displayName}</strong>
          <ChevronDown size={14} className="user-chip-chevron" />
        </button>
      }
      className="user-menu-content"
      placement="bottom-end"
      zIndex={2000}
    >
      {({ close }) => (
        <>
          <div className="user-menu-summary" aria-hidden>
            <span className="avatar avatar-sm">
              {!photoFailed && <img key={`summary-${userKey}-${displayName}`} src={`${API_BASE}/user/me/photo?v=${encodeURIComponent(`${userKey}-${displayName}-${user.email}`)}`} alt="Profilbild" onError={() => setPhotoFailed(true)} />}
              {photoFailed && <span>{initials}</span>}
            </span>
            <div className="user-menu-meta">
              <strong>{displayName}</strong>
              <span className="muted user-menu-email" title={user.email}>{user.email}</span>
            </div>
          </div>
          <hr className="user-menu-separator" />
          {showAdminAction && user.role === 'admin' && onOpenAdmin && (
            <button className="user-menu-item" role="menuitem" onClick={() => { close(); onOpenAdmin(); }}>
              <Shield size={16} />
              <span>Admin</span>
            </button>
          )}
          <button className="user-menu-item user-menu-item-danger" role="menuitem" onClick={() => { close(); void onLogout(); }}>
            <LogOut size={16} />
            <span>Logout</span>
          </button>
        </>
      )}
    </Popover>
  );
}
