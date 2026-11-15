export interface OnlineCoverCandidate {
  id: string;
  title: string;
  artist: string;
  album: string;
  thumbnailUrl: string;
  coverUrl: string;
  source: string;
}

export async function searchOnlineCovers(
  title: string,
  artist?: string
): Promise<OnlineCoverCandidate[]> {
  const qs = new URLSearchParams();
  if (title.trim()) qs.set('title', title.trim());
  if (artist?.trim()) qs.set('artist', artist.trim());

  const res = await fetch(`/api/covers/search?${qs.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || `搜索专辑封面失败 (${res.status})`);
  }
  return Array.isArray(json.candidates) ? json.candidates : [];
}

export function getProxiedCoverUrl(url: string): string {
  return `/api/covers/proxy?url=${encodeURIComponent(url)}`;
}
