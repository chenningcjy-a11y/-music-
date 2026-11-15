import {
  MvEndBehavior,
  OnlineMvResult,
  TrackMvConfig,
} from '../types/music';

export const DEFAULT_MV_VISUAL_SETTINGS: Pick<
  TrackMvConfig,
  | 'displayMode'
  | 'scale'
  | 'cropX'
  | 'cropY'
  | 'brightness'
  | 'blurPx'
  | 'overlayOpacity'
  | 'endBehavior'
> = {
  displayMode: 'cover',
  scale: 1,
  cropX: 0,
  cropY: 0,
  brightness: 0.62,
  blurPx: 0,
  overlayOpacity: 0.45,
  endBehavior: 'stop',
};

export interface MvTargetSyncState {
  targetTime: number;
  waitingOffset: boolean;
  ended: boolean;
}

/**
 * Computes the expected MV playback timestamp anchored to the music master clock.
 *
 * Formula: targetMvTime = musicTimeSec + syncOffsetSec
 * - syncOffsetSec > 0: MV leads ahead of music (e.g. music 30s -> MV 32s when +2s)
 * - syncOffsetSec < 0: MV lags behind music (pauses MV at 0.00s until musicTime >= -syncOffsetSec)
 */
export function computeMvTargetState(
  musicTimeSec: number,
  syncOffsetSec: number,
  mvDurationSec: number,
  endBehavior: MvEndBehavior
): MvTargetSyncState {
  const safeMusic = Number.isFinite(musicTimeSec) && musicTimeSec > 0 ? musicTimeSec : 0;
  const safeOffset = Number.isFinite(syncOffsetSec) ? syncOffsetSec : 0;
  const rawTarget = safeMusic + safeOffset;

  if (rawTarget < 0) {
    return {
      targetTime: 0,
      waitingOffset: true,
      ended: false,
    };
  }

  const hasValidDur = Number.isFinite(mvDurationSec) && mvDurationSec > 0.25;
  if (hasValidDur && rawTarget >= mvDurationSec - 0.05) {
    if (endBehavior === 'loop') {
      const wrapped = rawTarget % mvDurationSec;
      return {
        targetTime: Math.max(0, Math.min(mvDurationSec - 0.05, wrapped)),
        waitingOffset: false,
        ended: false,
      };
    }
    return {
      targetTime: mvDurationSec,
      waitingOffset: false,
      ended: true,
    };
  }

  return {
    targetTime: rawTarget,
    waitingOffset: false,
    ended: false,
  };
}

export interface ProbedLocalVideoInfo {
  fileName: string;
  mimeType: string;
  fileSize: number;
  duration: number;
  width: number;
  height: number;
}

const MV_CLIENT_CACHE_TTL_MS = 3 * 60 * 1000;
const clientMvSearchCache = new Map<
  string,
  { results: OnlineMvResult[]; expiresAt: number }
>();

function inferVideoMimeFromName(name: string): string {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.m4v')) return 'video/x-m4v';
  if (lower.endsWith('.ogv')) return 'video/ogg';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  return 'video/mp4';
}

export async function probeLocalVideoFile(file: File): Promise<ProbedLocalVideoInfo> {
  if (!file || file.size === 0) {
    throw new Error('所选视频文件为空，请重新选择有效的视频文件');
  }

  const mime = file.type || inferVideoMimeFromName(file.name);
  const probeEl = document.createElement('video');
  probeEl.muted = true;
  probeEl.playsInline = true;
  probeEl.preload = 'metadata';

  const canPlay = file.type ? probeEl.canPlayType(file.type) : 'maybe';
  if (canPlay === '' && /\.(avi|rmvb|rm|wmv|flv|f4v)$/i.test(file.name)) {
    throw new Error(
      `当前浏览器不支持 ${file.name.split('.').pop()?.toUpperCase() || '该'} 视频封装格式，请上传 MP4 (H.264) 或 WebM 视频`
    );
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const info = await new Promise<ProbedLocalVideoInfo>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('读取视频元信息超时，请检查文件是否损坏或更换为 MP4 (H.264) / WebM 格式'));
      }, 6500);

      const cleanupListeners = () => {
        window.clearTimeout(timer);
        probeEl.onloadedmetadata = null;
        probeEl.onerror = null;
      };

      probeEl.onloadedmetadata = () => {
        if (settled) return;
        const w = probeEl.videoWidth || 0;
        const h = probeEl.videoHeight || 0;
        const dur = probeEl.duration;
        if (w <= 0 || h <= 0) {
          settled = true;
          cleanupListeners();
          reject(
            new Error(
              '无法解码该视频的视频画面流（常见于 HEVC/H.265 或纯音频容器），请使用 MP4 (H.264) 或 WebM 格式'
            )
          );
          return;
        }
        if (!Number.isFinite(dur) || dur <= 0) {
          settled = true;
          cleanupListeners();
          reject(new Error('无法读取该视频的有效时长，文件可能不完整'));
          return;
        }
        settled = true;
        cleanupListeners();
        resolve({
          fileName: file.name,
          mimeType: mime,
          fileSize: file.size,
          duration: dur,
          width: w,
          height: h,
        });
      };

      probeEl.onerror = () => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        reject(
          new Error(
            '当前设备浏览器无法解码该视频编码，请优先选择通用 H.264 编码的 MP4 或 VP9/VP8 WebM 视频'
          )
        );
      };

      probeEl.src = objectUrl;
    });

    return info;
  } finally {
    probeEl.removeAttribute('src');
    probeEl.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function fallbackBrowserMvSearch(
  title: string,
  artist: string,
  customQuery?: string,
  signal?: AbortSignal
): Promise<OnlineMvResult[]> {
  const baseQuery = (customQuery || `${artist} ${title}`).trim();
  if (!baseQuery) return [];
  const results: OnlineMvResult[] = [];

  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
      customQuery || `${title} ${artist}`.trim()
    )}&entity=musicVideo&limit=6`;
    const res = await fetch(itunesUrl, { signal });
    if (res.ok) {
      const json = (await res.json()) as {
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
      };
      for (const item of json.results || []) {
        if (!item.trackName || !item.trackViewUrl) continue;
        const preview = (item.previewUrl || '').replace(/^http:\/\//i, 'https://');
        const hasVideo = Boolean(preview && /^https:\/\//i.test(preview));
        results.push({
          id: `itunes-mv-${item.trackId || results.length}`,
          title: item.trackName,
          artist: item.artistName || artist,
          album: item.collectionName || '',
          duration: Math.round((item.trackTimeMillis || 0) / 1000),
          thumbnailUrl: (item.artworkUrl100 || '')
            .replace(/\/\d+x\d+bb\./, '/600x600bb.')
            .replace(/^http:\/\//i, 'https://'),
          sourceName: 'Apple Music 官方 MV',
          sourceUrl: item.trackViewUrl,
          playableType: hasVideo ? 'video' : 'external_only',
          playableUrl: hasVideo ? preview : undefined,
          supportsWebPlayback: hasVideo,
          supportsPreciseSync: hasVideo,
          isOfficial: true,
          isPreviewClip: hasVideo,
          notice: hasVideo
            ? '官方高清 H.264 视频流预览片段（支持毫秒级音画同步，可启用循环）'
            : '该条目未提供网页直链视频流，请前往 Apple Music 查看',
        });
      }
    }
  } catch {
    // ignore fallback error
  }

  try {
    const dmQuery = /\bmv\b|music\s*video/i.test(baseQuery)
      ? baseQuery
      : `${baseQuery} MV`;
    const dmUrl = `https://api.dailymotion.com/videos?search=${encodeURIComponent(
      dmQuery
    )}&fields=id,title,duration,thumbnail_480_url,url,owner.screenname,owner.verified,allow_embed&limit=8`;
    const res = await fetch(dmUrl, { signal });
    if (res.ok) {
      const json = (await res.json()) as {
        list?: Array<{
          id?: string;
          title?: string;
          duration?: number;
          thumbnail_480_url?: string;
          url?: string;
          'owner.screenname'?: string;
          'owner.verified'?: boolean;
          allow_embed?: boolean;
        }>;
      };
      for (const item of json.list || []) {
        if (!item.id || !item.title) continue;
        const allowEmbed = Boolean(item.allow_embed);
        results.push({
          id: `dm-${item.id}`,
          title: item.title,
          artist: item['owner.screenname'] || 'Dailymotion',
          duration: Math.round(item.duration || 0),
          thumbnailUrl: (item.thumbnail_480_url || '').replace(/^http:\/\//i, 'https://'),
          sourceName: item['owner.verified'] ? 'Dailymotion 官方认证' : 'Dailymotion',
          sourceUrl: item.url || `https://www.dailymotion.com/video/${item.id}`,
          playableType: allowEmbed ? 'embed' : 'external_only',
          playableUrl: allowEmbed
            ? `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(
                item.id
              )}&mute=true&controls=false`
            : undefined,
          embedProvider: allowEmbed ? 'dailymotion' : undefined,
          supportsWebPlayback: allowEmbed,
          supportsPreciseSync: false,
          isOfficial: Boolean(item['owner.verified']),
          isPreviewClip: false,
          notice: allowEmbed
            ? '允许嵌入完整 MV（受跨源嵌入式播放器限制，支持联动启停与跳转）'
            : '该视频发布者禁用了网页嵌入播放，请前往原平台观看',
        });
      }
    }
  } catch {
    // ignore fallback error
  }

  return results;
}

export async function searchOnlineMvs(
  title: string,
  artist: string,
  opts?: {
    album?: string;
    duration?: number;
    customQuery?: string;
    signal?: AbortSignal;
  }
): Promise<OnlineMvResult[]> {
  const cleanT = (title || '').trim();
  const cleanA = (artist || '').trim();
  const customQ = (opts?.customQuery || '').trim();
  const cacheKey = `${cleanT.toLowerCase()}|${cleanA.toLowerCase()}|${customQ.toLowerCase()}|${
    opts?.album || ''
  }`;

  const cached = clientMvSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.results;
  }

  const params = new URLSearchParams();
  if (cleanT) params.set('title', cleanT);
  if (cleanA) params.set('artist', cleanA);
  if (opts?.album) params.set('album', opts.album);
  if (opts?.duration && opts.duration > 0) {
    params.set('duration', String(Math.round(opts.duration)));
  }
  if (customQ) params.set('q', customQ);

  let results: OnlineMvResult[] = [];
  try {
    const res = await fetch(`/api/mv/search?${params.toString()}`, {
      signal: opts?.signal,
    });
    if (res.ok) {
      const json = (await res.json()) as {
        candidates?: OnlineMvResult[];
        results?: OnlineMvResult[];
      };
      results = json.candidates || json.results || [];
    } else {
      results = await fallbackBrowserMvSearch(cleanT, cleanA, customQ, opts?.signal);
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    results = await fallbackBrowserMvSearch(cleanT, cleanA, customQ, opts?.signal);
  }

  if (results.length > 0) {
    clientMvSearchCache.set(cacheKey, {
      results,
      expiresAt: Date.now() + MV_CLIENT_CACHE_TTL_MS,
    });
  }
  return results;
}

export async function resolveOnlineMvUrl(
  rawUrl: string
): Promise<OnlineMvResult> {
  const trimmed = (rawUrl || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('请输入有效的 http(s) 视频或 MV 链接');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('仅支持 http 或 https 协议的视频链接');
  }
  const h = parsed.hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local')
  ) {
    throw new Error('生产环境禁止使用 localhost 或内网地址作为在线 MV 来源');
  }

  const res = await fetch('/api/mv/resolve-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: trimmed }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    candidate?: OnlineMvResult;
    result?: OnlineMvResult;
    error?: string;
  };
  const resolved = json.candidate || json.result;
  if (!res.ok || !resolved) {
    throw new Error(json.error || '解析 MV 链接失败');
  }
  return resolved;
}

export function buildOnlineMvConfig(
  songId: string,
  item: OnlineMvResult,
  prev?: TrackMvConfig | null
): TrackMvConfig {
  const baseVisual = prev
    ? {
        displayMode: prev.displayMode,
        scale: prev.scale,
        cropX: prev.cropX,
        cropY: prev.cropY,
        brightness: prev.brightness,
        blurPx: prev.blurPx,
        overlayOpacity: prev.overlayOpacity,
        endBehavior: prev.endBehavior,
      }
    : DEFAULT_MV_VISUAL_SETTINGS;

  return {
    songId,
    enabled: item.playableType !== 'external_only',
    sourceType: 'online',
    title: item.title,
    artist: item.artist,
    thumbnailUrl: item.thumbnailUrl,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    playableType: item.playableType,
    playableUrl: item.playableUrl,
    embedProvider: item.embedProvider,
    isPreviewClip: item.isPreviewClip,
    syncOffsetSec: prev ? prev.syncOffsetSec : 0,
    ...baseVisual,
    linkBroken: false,
    updatedAt: Date.now(),
  };
}
