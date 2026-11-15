export interface OnlineCoverCandidate {
  id: string;
  title: string;
  artist: string;
  album: string;
  thumbnailUrl: string;
  coverUrl: string;
  source: string;
}

const ALLOWED_ARTWORK_HOST_PATTERNS = [
  /(^|\.)mzstatic\.com$/i,
  /(^|\.)coverartarchive\.org$/i,
  /(^|\.)archive\.org$/i,
  /(^|\.)music\.126\.net$/i,
  /(^|\.)itunes\.apple\.com$/i,
];

export function isAllowedCoverHost(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return ALLOWED_ARTWORK_HOST_PATTERNS.some((re) => re.test(parsed.hostname));
  } catch {
    return false;
  }
}

async function searchItunesCovers(
  query: string
): Promise<OnlineCoverCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
      query
    )}&entity=song,album&limit=8`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        collectionId?: number;
        trackId?: number;
        trackName?: string;
        collectionName?: string;
        artistName?: string;
        artworkUrl100?: string;
      }>;
    };

    const seen = new Set<string>();
    const list: OnlineCoverCandidate[] = [];

    for (const item of data.results || []) {
      const thumb = item.artworkUrl100;
      if (!thumb) continue;
      const hiRes = thumb
        .replace(/\/\d+x\d+bb\./, '/800x800bb.')
        .replace(/^http:\/\//i, 'https://');
      if (seen.has(hiRes)) continue;
      seen.add(hiRes);

      list.push({
        id: `itunes-${item.collectionId || item.trackId || list.length}`,
        title: item.trackName || item.collectionName || query,
        artist: item.artistName || '',
        album: item.collectionName || '',
        thumbnailUrl: thumb.replace(/^http:\/\//i, 'https://'),
        coverUrl: hiRes,
        source: 'Apple Music / iTunes',
      });
    }
    return list;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchMusicBrainzCovers(
  title: string,
  artist: string
): Promise<OnlineCoverCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const qParts: string[] = [];
    if (title) qParts.push(`release:"${title.replace(/"/g, '')}"`);
    if (artist) qParts.push(`artist:"${artist.replace(/"/g, '')}"`);
    const q = qParts.join(' AND ') || title || artist;
    if (!q) return [];

    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(
      q
    )}&fmt=json&limit=5`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LUMINA-MUSIC/1.0 (https://github.com)',
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      releases?: Array<{
        id: string;
        title?: string;
        'artist-credit'?: Array<{ name?: string }>;
      }>;
    };

    const candidates: OnlineCoverCandidate[] = [];
    for (const rel of (data.releases || []).slice(0, 4)) {
      const coverUrl = `https://coverartarchive.org/release/${rel.id}/front-500`;
      candidates.push({
        id: `mb-${rel.id}`,
        title: rel.title || title,
        artist:
          rel['artist-credit']?.map((a) => a.name).filter(Boolean).join(' / ') ||
          artist,
        album: rel.title || '',
        thumbnailUrl: `https://coverartarchive.org/release/${rel.id}/front-250`,
        coverUrl,
        source: 'Cover Art Archive',
      });
    }
    return candidates;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchOnlineCovers(
  title: string,
  artist?: string
): Promise<OnlineCoverCandidate[]> {
  const cleanTitle = (title || '').trim();
  const cleanArtist = (artist || '').trim();
  const query = [cleanTitle, cleanArtist].filter(Boolean).join(' ').trim();
  if (!query) return [];

  const [itunesRes, mbRes] = await Promise.allSettled([
    searchItunesCovers(query),
    searchMusicBrainzCovers(cleanTitle, cleanArtist),
  ]);

  const primary = itunesRes.status === 'fulfilled' ? itunesRes.value : [];
  const secondary = mbRes.status === 'fulfilled' ? mbRes.value : [];
  return [...primary, ...secondary].slice(0, 12);
}

export async function proxyCoverImageBytes(rawUrl: string): Promise<{
  buffer: ArrayBuffer;
  contentType: string;
}> {
  if (!isAllowedCoverHost(rawUrl)) {
    throw new Error('不支持代理该封面图片域名');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(rawUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'LUMINA-MUSIC/1.0',
      },
    });
    if (!res.ok) {
      throw new Error(`获取封面图片失败 (HTTP ${res.status})`);
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      throw new Error('目标地址返回的不是有效图片');
    }
    const buffer = await res.arrayBuffer();
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}
