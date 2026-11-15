export type MvPlayableType = 'video' | 'embed' | 'external_only';

export interface OnlineMvSearchCandidate {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number; // seconds
  thumbnailUrl: string;
  sourceName: string;
  sourceUrl: string;
  playableType: MvPlayableType;
  playableUrl?: string;
  embedProvider?: 'youtube' | 'vimeo' | 'dailymotion';
  supportsWebPlayback: boolean;
  supportsPreciseSync: boolean;
  isOfficial?: boolean;
  isPreviewClip?: boolean;
  notice?: string;
  matchScore?: number;
}

export interface MvSearchQueryInput {
  q?: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
}

interface CacheEntry {
  results: OnlineMvSearchCandidate[];
  expiresAt: number;
}

const MV_CACHE_TTL_MS = 5 * 60 * 1000;
const MV_EMPTY_CACHE_TTL_MS = 30 * 1000;
const MV_CACHE_MAX = 150;
const mvSearchCache = new Map<string, CacheEntry>();

function normalizeText(s: string): string {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(s: string): string {
  return (s || '')
    .replace(/\.(mp3|flac|wav|aac|m4a|ogg|opus)$/i, '')
    .replace(
      /\s*[\(\[【（](?:explicit|clean|remaster(?:ed)?(?:\s*\d{4})?|deluxe(?:\s*edition)?|official\s*(?:audio|video|mv|m\/v|music\s*video)|lyric\s*video|hd|4k)[\)\]】）]/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function diceSimilarity(a: string, b: string): number {
  const s1 = a.replace(/\s+/g, '');
  const s2 = b.replace(/\s+/g, '');
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) {
    return s1.includes(s2) || s2.includes(s1) ? 0.6 : 0;
  }
  const map = new Map<string, number>();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.slice(i, i + 2);
    map.set(bg, (map.get(bg) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.slice(i, i + 2);
    const cnt = map.get(bg) || 0;
    if (cnt > 0) {
      map.set(bg, cnt - 1);
      hits++;
    }
  }
  return (2 * hits) / (s1.length - 1 + (s2.length - 1));
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchItunesMusicVideos(
  query: string
): Promise<OnlineMvSearchCandidate[]> {
  if (!query) return [];
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
    query
  )}&entity=musicVideo&limit=8`;
  const data = await fetchJsonWithTimeout<{
    results?: Array<{
      trackId?: number;
      trackName?: string;
      artistName?: string;
      collectionName?: string;
      trackTimeMillis?: number;
      previewUrl?: string;
      trackViewUrl?: string;
      artworkUrl100?: string;
    }>;
  }>(url, 3200, { Accept: 'application/json' });

  const out: OnlineMvSearchCandidate[] = [];
  for (const item of data?.results || []) {
    if (!item.trackName || !item.trackViewUrl) continue;
    const preview = (item.previewUrl || '').replace(/^http:\/\//i, 'https://');
    const isDirectVideo = Boolean(preview && /^https:\/\//i.test(preview));
    const thumb = (item.artworkUrl100 || '')
      .replace(/\/\d+x\d+bb\./, '/600x600bb.')
      .replace(/^http:\/\//i, 'https://');

    out.push({
      id: `itunes-mv-${item.trackId || out.length}`,
      title: item.trackName,
      artist: item.artistName || '',
      album: item.collectionName || '',
      duration: Math.round((item.trackTimeMillis || 0) / 1000),
      thumbnailUrl: thumb,
      sourceName: 'Apple Music 官方 MV',
      sourceUrl: item.trackViewUrl,
      playableType: isDirectVideo ? 'video' : 'external_only',
      playableUrl: isDirectVideo ? preview : undefined,
      supportsWebPlayback: isDirectVideo,
      supportsPreciseSync: isDirectVideo,
      isOfficial: true,
      isPreviewClip: isDirectVideo,
      notice: isDirectVideo
        ? '官方高清 H.264 视频流预览片段（支持毫秒级音画同步，可启用循环）'
        : '该条目未提供网页直链视频流，请前往 Apple Music 查看',
    });
  }
  return out;
}

async function searchDailymotionVideos(
  query: string
): Promise<OnlineMvSearchCandidate[]> {
  if (!query) return [];
  const url = `https://api.dailymotion.com/videos?search=${encodeURIComponent(
    query
  )}&fields=id,title,duration,thumbnail_480_url,url,embed_url,owner.screenname,owner.verified,allow_embed&limit=10`;

  const data = await fetchJsonWithTimeout<{
    list?: Array<{
      id?: string;
      title?: string;
      duration?: number;
      thumbnail_480_url?: string;
      url?: string;
      embed_url?: string;
      'owner.screenname'?: string;
      'owner.verified'?: boolean;
      allow_embed?: boolean;
    }>;
  }>(url, 3200, { Accept: 'application/json' });

  const out: OnlineMvSearchCandidate[] = [];
  for (const item of data?.list || []) {
    if (!item.id || !item.title) continue;
    const allowEmbed = Boolean(item.allow_embed);
    const embedUrl = allowEmbed
      ? `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(
          item.id
        )}&mute=true&controls=false`
      : undefined;

    out.push({
      id: `dm-${item.id}`,
      title: item.title,
      artist: item['owner.screenname'] || 'Dailymotion',
      duration: Math.round(item.duration || 0),
      thumbnailUrl: (item.thumbnail_480_url || '').replace(/^http:\/\//i, 'https://'),
      sourceName: item['owner.verified'] ? 'Dailymotion 官方认证' : 'Dailymotion',
      sourceUrl: item.url || `https://www.dailymotion.com/video/${item.id}`,
      playableType: allowEmbed ? 'embed' : 'external_only',
      playableUrl: embedUrl,
      embedProvider: allowEmbed ? 'dailymotion' : undefined,
      supportsWebPlayback: allowEmbed,
      supportsPreciseSync: false,
      isOfficial: Boolean(item['owner.verified']),
      isPreviewClip: false,
      notice: allowEmbed
        ? '允许嵌入完整 MV（受跨源嵌入式播放器限制，支持联动启停与跳转；如需 0.05s 帧同步建议使用原生视频流或本地上传）'
        : '该视频发布者禁用了网页嵌入播放，请点击来源链接前往原平台观看',
    });
  }
  return out;
}

const NOISE_VIDEO_RE =
  /\b(reaction|reacts|review|karaoke|instrumental|8d|nightcore|sped\s*up|slowed|cover|tutorial|guitar\s*lesson|piano\s*cover|lyrics?\s*only|fancam|live\s*concert|teaser)\b|(?:反应|翻唱|教学|伴奏|纯音乐|饭拍|直拍|预告)/i;

const OFFICIAL_MV_RE =
  /\b(official\s*(?:music\s*)?video|m\/v|mv|official\s*mv)\b|(?:官方\s*mv|完整版\s*mv)/i;

function scoreMvCandidate(
  cand: OnlineMvSearchCandidate,
  queryTitle: string,
  queryArtist: string,
  queryCombined: string,
  durationSec?: number
): OnlineMvSearchCandidate {
  const ntQuery = normalizeText(cleanTitle(queryTitle || queryCombined));
  const ntCand = normalizeText(cleanTitle(cand.title));
  const naQuery = normalizeText(queryArtist);
  const naCand = normalizeText(cand.artist);

  let score = 0;

  if (ntQuery && ntCand) {
    if (ntCand === ntQuery) score += 42;
    else if (ntCand.includes(ntQuery)) score += 32;
    else score += Math.round(diceSimilarity(ntQuery, ntCand) * 35);
  }

  if (naQuery) {
    const combinedCand = `${ntCand} ${naCand}`;
    if (combinedCand.includes(naQuery)) score += 24;
    else if (diceSimilarity(naQuery, naCand) >= 0.65) score += 16;
    else score -= 10;
  }

  if (durationSec && durationSec > 0 && cand.duration > 0) {
    const diff = Math.abs(durationSec - cand.duration);
    if (diff <= 4) score += 20;
    else if (diff <= 12) score += 12;
    else if (diff <= 25) score += 4;
    else if (diff > 45) score -= 12;
  }

  if (cand.isOfficial) score += 14;
  if (OFFICIAL_MV_RE.test(cand.title)) score += 8;
  if (NOISE_VIDEO_RE.test(cand.title) && !NOISE_VIDEO_RE.test(queryCombined)) {
    score -= 24;
  }

  if (cand.playableType === 'video') score += 14;
  else if (cand.playableType === 'embed') score += 8;
  else score -= 18;

  return {
    ...cand,
    matchScore: Math.max(0, Math.min(100, Math.round(score))),
  };
}

export async function searchOnlineMvs(
  input: MvSearchQueryInput
): Promise<OnlineMvSearchCandidate[]> {
  const title = cleanTitle((input.title || '').trim());
  const artist =
    input.artist &&
    input.artist !== '未知艺术家' &&
    input.artist !== 'Unknown Artist' &&
    input.artist !== 'Lumina Acoustic Ensemble'
      ? input.artist.trim()
      : '';
  const album = (input.album || '').trim();
  const customQ = (input.q || '').trim();
  const durationSec =
    typeof input.duration === 'number' &&
    Number.isFinite(input.duration) &&
    input.duration > 0
      ? Math.round(input.duration)
      : undefined;

  const baseQuery = customQ || [artist, title].filter(Boolean).join(' ').trim();
  if (!baseQuery) return [];

  const cacheKey = `${normalizeText(baseQuery)}|${normalizeText(title)}|${normalizeText(
    artist
  )}|${durationSec || 0}`;
  const cached = mvSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.results;
  }

  const dmQuery = /\bmv\b|music\s*video/i.test(baseQuery)
    ? baseQuery
    : `${baseQuery} MV`;

  const [itunesRes, dmRes] = await Promise.allSettled([
    searchItunesMusicVideos([title, artist].filter(Boolean).join(' ') || baseQuery),
    searchDailymotionVideos(dmQuery),
  ]);

  const raw: OnlineMvSearchCandidate[] = [
    ...(itunesRes.status === 'fulfilled' ? itunesRes.value : []),
    ...(dmRes.status === 'fulfilled' ? dmRes.value : []),
  ];

  const scored = raw.map((c) =>
    scoreMvCandidate(c, title || customQ, artist, `${baseQuery} ${album}`, durationSec)
  );

  scored.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

  const deduped: OnlineMvSearchCandidate[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
    if (deduped.length >= 16) break;
  }

  if (mvSearchCache.size >= MV_CACHE_MAX) {
    const oldest = mvSearchCache.keys().next().value;
    if (oldest !== undefined) mvSearchCache.delete(oldest);
  }
  mvSearchCache.set(cacheKey, {
    results: deduped,
    expiresAt:
      Date.now() + (deduped.length > 0 ? MV_CACHE_TTL_MS : MV_EMPTY_CACHE_TTL_MS),
  });

  return deduped;
}

function isDisallowedLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local')
  ) {
    return true;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function extractYoutubeId(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'youtu.be') {
    const seg = parsed.pathname.split('/').filter(Boolean)[0];
    return seg && /^[\w-]{6,20}$/.test(seg) ? seg : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = parsed.searchParams.get('v');
    if (v && /^[\w-]{6,20}$/.test(v)) return v;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'embed' || parts[0] === 'shorts') && parts[1]) {
      return /^[\w-]{6,20}$/.test(parts[1]) ? parts[1] : null;
    }
  }
  return null;
}

function extractDailymotionId(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'dai.ly') {
    const seg = parsed.pathname.split('/').filter(Boolean)[0];
    return seg || null;
  }
  if (host === 'dailymotion.com' || host === 'geo.dailymotion.com') {
    const m = parsed.pathname.match(/\/video\/([a-zA-Z0-9]+)/);
    if (m) return m[1];
    const qv = parsed.searchParams.get('video');
    if (qv) return qv;
  }
  return null;
}

function extractVimeoId(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = parsed.pathname.match(/(\d{5,15})/);
    return m ? m[1] : null;
  }
  return null;
}

export async function resolveOnlineMvUrl(
  rawUrl: string
): Promise<OnlineMvSearchCandidate> {
  const trimmed = (rawUrl || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('请输入有效的 http(s) 视频或网页链接');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('仅支持 http 或 https 协议的视频链接');
  }
  if (isDisallowedLocalHost(parsed.hostname)) {
    throw new Error('生产环境禁止使用 localhost 或内网地址作为在线 MV 来源');
  }

  // 1. YouTube official oEmbed check + official IFrame JS API embed
  const ytId = extractYoutubeId(parsed);
  if (ytId) {
    const watchUrl = `https://www.youtube.com/watch?v=${ytId}`;
    const oembed = await fetchJsonWithTimeout<{
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    }>(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      3200
    );
    if (!oembed) {
      return {
        id: `yt-${ytId}`,
        title: `YouTube 视频 (${ytId})`,
        artist: 'YouTube',
        duration: 0,
        thumbnailUrl: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
        sourceName: 'YouTube',
        sourceUrl: watchUrl,
        playableType: 'external_only',
        supportsWebPlayback: false,
        supportsPreciseSync: false,
        notice: '该 YouTube 视频不允许外部嵌入或已被限制，请点击链接前往 YouTube 原页面观看',
      };
    }
    return {
      id: `yt-${ytId}`,
      title: oembed.title || `YouTube MV (${ytId})`,
      artist: oembed.author_name || 'YouTube',
      duration: 0,
      thumbnailUrl:
        oembed.thumbnail_url || `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
      sourceName: 'YouTube 官方嵌入',
      sourceUrl: watchUrl,
      playableType: 'embed',
      playableUrl: `https://www.youtube.com/embed/${ytId}?enablejsapi=1&mute=1&controls=0&rel=0&playsinline=1&modestbranding=1`,
      embedProvider: 'youtube',
      supportsWebPlayback: true,
      supportsPreciseSync: true,
      isOfficial: true,
      notice: 'YouTube 官方嵌入式播放器已就绪（支持自动静音联动播放、暂停与时间跳转）',
    };
  }

  // 2. Dailymotion API check
  const dmId = extractDailymotionId(parsed);
  if (dmId) {
    const dmInfo = await fetchJsonWithTimeout<{
      id?: string;
      title?: string;
      duration?: number;
      thumbnail_480_url?: string;
      url?: string;
      'owner.screenname'?: string;
      'owner.verified'?: boolean;
      allow_embed?: boolean;
    }>(
      `https://api.dailymotion.com/video/${encodeURIComponent(
        dmId
      )}?fields=id,title,duration,thumbnail_480_url,url,owner.screenname,owner.verified,allow_embed`,
      3200
    );
    const allowEmbed = Boolean(dmInfo?.allow_embed);
    return {
      id: `dm-${dmId}`,
      title: dmInfo?.title || `Dailymotion 视频 (${dmId})`,
      artist: dmInfo?.['owner.screenname'] || 'Dailymotion',
      duration: Math.round(dmInfo?.duration || 0),
      thumbnailUrl: dmInfo?.thumbnail_480_url || '',
      sourceName: dmInfo?.['owner.verified'] ? 'Dailymotion 官方认证' : 'Dailymotion',
      sourceUrl: dmInfo?.url || parsed.toString(),
      playableType: allowEmbed ? 'embed' : 'external_only',
      playableUrl: allowEmbed
        ? `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(
            dmId
          )}&mute=true&controls=false`
        : undefined,
      embedProvider: allowEmbed ? 'dailymotion' : undefined,
      supportsWebPlayback: allowEmbed,
      supportsPreciseSync: false,
      isOfficial: Boolean(dmInfo?.['owner.verified']),
      notice: allowEmbed
        ? 'Dailymotion 官方嵌入式播放器已就绪'
        : '该视频不允许外部网页嵌入播放，请前往原平台观看',
    };
  }

  // 3. Vimeo oEmbed check
  const vimeoId = extractVimeoId(parsed);
  if (vimeoId) {
    const vimeoUrl = `https://vimeo.com/${vimeoId}`;
    const oembed = await fetchJsonWithTimeout<{
      title?: string;
      author_name?: string;
      duration?: number;
      thumbnail_url?: string;
    }>(
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(vimeoUrl)}`,
      3200
    );
    if (!oembed) {
      return {
        id: `vimeo-${vimeoId}`,
        title: `Vimeo 视频 (${vimeoId})`,
        artist: 'Vimeo',
        duration: 0,
        thumbnailUrl: '',
        sourceName: 'Vimeo',
        sourceUrl: vimeoUrl,
        playableType: 'external_only',
        supportsWebPlayback: false,
        supportsPreciseSync: false,
        notice: '该 Vimeo 视频不允许外部嵌入播放，请点击跳转至原页面',
      };
    }
    return {
      id: `vimeo-${vimeoId}`,
      title: oembed.title || `Vimeo MV (${vimeoId})`,
      artist: oembed.author_name || 'Vimeo',
      duration: Math.round(oembed.duration || 0),
      thumbnailUrl: oembed.thumbnail_url || '',
      sourceName: 'Vimeo 官方嵌入',
      sourceUrl: vimeoUrl,
      playableType: 'embed',
      playableUrl: `https://player.vimeo.com/video/${vimeoId}?muted=1&controls=0&background=1`,
      embedProvider: 'vimeo',
      supportsWebPlayback: true,
      supportsPreciseSync: true,
      notice: 'Vimeo 官方嵌入式播放器已就绪',
    };
  }

  // 4. Direct video stream validation (never treat arbitrary HTML pages as playable video!)
  const hasVideoExt = /\.(mp4|webm|m4v|mov|ogv)(\?|$)/i.test(parsed.pathname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const headRes = await fetch(parsed.toString(), {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    const contentType = (headRes.headers.get('content-type') || '').toLowerCase();
    if (headRes.ok && (contentType.startsWith('video/') || (hasVideoExt && !contentType.includes('text/html')))) {
      return {
        id: `direct-${Date.now()}`,
        title: decodeURIComponent(parsed.pathname.split('/').pop() || '自定义直链 MV'),
        artist: parsed.hostname,
        duration: 0,
        thumbnailUrl: '',
        sourceName: '直链视频流',
        sourceUrl: parsed.toString(),
        playableType: 'video',
        playableUrl: parsed.toString(),
        supportsWebPlayback: true,
        supportsPreciseSync: true,
        notice: '检测到可原生播放的视频流，支持 0.05s 精细音画同步',
      };
    }
  } catch {
    // If HEAD blocked by CORS/CDN but URL explicitly ends with .mp4/.webm/.m4v, still let browser <video> probe
    if (hasVideoExt && parsed.protocol === 'https:') {
      return {
        id: `direct-${Date.now()}`,
        title: decodeURIComponent(parsed.pathname.split('/').pop() || '自定义视频流'),
        artist: parsed.hostname,
        duration: 0,
        thumbnailUrl: '',
        sourceName: '直链视频流',
        sourceUrl: parsed.toString(),
        playableType: 'video',
        playableUrl: parsed.toString(),
        supportsWebPlayback: true,
        supportsPreciseSync: true,
        notice: '直接视频文件地址（播放能力将由浏览器原生播放器验证）',
      };
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    id: `ext-${Date.now()}`,
    title: parsed.hostname,
    artist: '外部网页来源',
    duration: 0,
    thumbnailUrl: '',
    sourceName: parsed.hostname,
    sourceUrl: parsed.toString(),
    playableType: 'external_only',
    supportsWebPlayback: false,
    supportsPreciseSync: false,
    notice: '该链接为普通网页或受版权/防盗链保护的平台页面，不允许在站内直接播放，请跳转原页面观看或上传本地 MP4/WebM 视频',
  };
}
