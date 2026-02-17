import { CSSProperties, useEffect, useMemo, useState } from 'react';
import { resolveApiUrl } from '../api';

type AvatarProps = {
  displayName?: string;
  email?: string;
  photoUrl?: string | null;
  size?: number;
};

const extractInitials = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '??';

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  }

  const compact = trimmed.replace(/[^\p{L}\p{N}]/gu, '');
  return (compact.slice(0, 2) || trimmed.slice(0, 2)).toUpperCase();
};

const buildInitials = (displayName?: string, email?: string): string => {
  if (displayName && displayName.trim()) {
    return extractInitials(displayName);
  }

  if (email && email.trim()) {
    const [localPart = email] = email.split('@');
    return extractInitials(localPart);
  }

  return '??';
};

export function Avatar({ displayName, email, photoUrl, size = 24 }: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const initials = useMemo(() => buildInitials(displayName, email), [displayName, email]);
  const resolvedPhotoUrl = useMemo(() => resolveApiUrl(photoUrl), [photoUrl]);

  useEffect(() => {
    setImageFailed(false);
  }, [resolvedPhotoUrl]);

  const showImage = Boolean(resolvedPhotoUrl) && !imageFailed;
  const style = {
    width: size,
    height: size,
    fontSize: Math.max(10, Math.floor(size * 0.38))
  } satisfies CSSProperties;

  return (
    <span className={`app-avatar ${showImage ? '' : 'app-avatar--fallback'}`.trim()} style={style} aria-hidden>
      {showImage && <img src={resolvedPhotoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />}
      {!showImage && <span>{initials}</span>}
    </span>
  );
}
