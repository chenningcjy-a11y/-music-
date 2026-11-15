import { AdapterCallError, extractJsonFromLlmText } from './adapters.ts';
import { ClientVaultSnapshot, getStoredProviderWithKey } from './keyVault.ts';
import { callProviderTextCompletion } from './providerClient.ts';

export interface ParsedSourceLine {
  raw: string;
  timestamps: string[];
  cleanText: string;
  isMeta: boolean;
}

export interface TimedLyricEntry {
  timeSec: number;
  tag: string;
  text: string;
}

export interface UnifiedLyricResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  hasNativeTranslation?: boolean;
  source?: string;
  matchScore?: number;
  lineCount?: number;
  durationDiffSec?: number;
}

export interface LyricSearchQueryInput {
  q?: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
}

export interface LyricSearchDetailedResult {
  results: UnifiedLyricResult[];
  cacheHit: boolean;
  elapsedMs: number;
  sourcesUsed: string[];
}

export interface LyricPairOutput {
  idx: number;
  timestamp: string;
  originalText: string;
  translatedText: string;
}

const LINE_TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TIME_TAG_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function toSeconds(minStr: string, secStr: string, msStr?: string): number {
  const min = parseInt(minStr, 10) || 0;
  const sec = parseInt(secStr, 10) || 0;
  let ms = 0;
  if (msStr) {
    if (msStr.length === 1) ms = parseInt(msStr, 10) * 100;
    else if (msStr.length === 2) ms = parseInt(msStr, 10) * 10;
    else ms = parseInt(msStr.slice(0, 3), 10);
  }
  return min * 60 + sec + ms / 1000;
}

export function parseTimedEntries(lrc: string): TimedLyricEntry[] {
  const entries: TimedLyricEntry[] = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^\[(ti|ar|al|by|offset|re|ve):/i.test(trimmed)) continue;

    const tags: { tag: string; sec: number }[] = [];
    let m: RegExpExecArray | null;
    LINE_TIME_TAG_RE.lastIndex = 0;
    while ((m = LINE_TIME_TAG_RE.exec(trimmed)) !== null) {
      tags.push({ tag: m[0], sec: toSeconds(m[1], m[2], m[3]) });
    }
    if (tags.length === 0) continue;
    const text = trimmed.replace(LINE_TIME_TAG_RE, '').trim();
    if (!text) continue;

    for (const t of tags) {
      entries.push({ timeSec: t.sec, tag: t.tag, text });
    }
  }
  return entries.sort((a, b) => a.timeSec - b.timeSec);
}

export function mergeOriginalAndTranslatedLrc(
  origLrc: string,
  transLrc: string
): string {
  const origEntries = parseTimedEntries(origLrc);
  const transEntries = parseTimedEntries(transLrc);
  if (origEntries.length === 0 || transEntries.length === 0) return origLrc;

  const lines: string[] = [];
  let transCursor = 0;

  for (const orig of origEntries) {
    lines.push(`${orig.tag}${orig.text}`);

    while (
      transCursor < transEntries.length &&
      transEntries[transCursor].timeSec < orig.timeSec - 0.35
    ) {
      transCursor++;
    }

    let bestMatch: TimedLyricEntry | null = null;
    let bestDiff = 0.35;
    for (let k = transCursor; k < transEntries.length; k++) {
      const cand = transEntries[k];
      const diff = Math.abs(cand.timeSec - orig.timeSec);
      if (diff <= bestDiff) {
        bestDiff = diff;
        bestMatch = cand;
      }
      if (cand.timeSec > orig.timeSec + 0.35) break;
    }

    if (bestMatch && bestMatch.text && bestMatch.text !== orig.text) {
      lines.push(`${orig.tag}${bestMatch.text}`);
    }
  }

  return lines.join('\n');
}

export function parseSourceLines(rawLyrics: string): ParsedSourceLine[] {
  return rawLyrics.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return { raw: '', timestamps: [], cleanText: '', isMeta: true };
    }
    if (/^\[(ti|ar|al|by|offset|re|ve):/i.test(trimmed)) {
      return { raw: trimmed, timestamps: [], cleanText: '', isMeta: true };
    }
    const timestamps: string[] = [];
    let m: RegExpExecArray | null;
    LINE_TIME_TAG_RE.lastIndex = 0;
    while ((m = LINE_TIME_TAG_RE.exec(trimmed)) !== null) {
      timestamps.push(m[0]);
    }
    const withoutLineTime = trimmed.replace(LINE_TIME_TAG_RE, '').trim();
    const cleanText = withoutLineTime.replace(WORD_TIME_TAG_RE, '').trim();
    return {
      raw: trimmed,
      timestamps,
      cleanText,
      isMeta: cleanText.length === 0,
    };
  });
}

/**
 * Strips any paired/inline translations from a bilingual LRC or plain lyric string
 * so re-translation with a different model or style operates cleanly on the original lyrics.
 */
export function stripExistingTranslationsToOriginal(rawLyrics: string): string {
  const parsed = parseSourceLines(rawLyrics);
  const out: string[] = [];
  let prevTimestamp = '';

  for (let i = 0; i < parsed.length; i++) {
    const line = parsed[i];
    if (!line.raw) continue;
    if (line.isMeta) {
      out.push(line.raw);
      continue;
    }

    // Inline separator: keep only original part before ` // ` or ` | `
    const inlineParts = line.cleanText.split(/\s+(?:\/\/|\|)\s+/);
    if (inlineParts.length >= 2) {
      const origClean = inlineParts[0].trim();
      const prefix = line.timestamps.join('');
      out.push(`${prefix}${origClean}`);
      prevTimestamp = line.timestamps[0] || '';
      continue;
    }

    // Duplicate timestamp stacked translation line: skip secondary line
    const currentTs = line.timestamps[0] || '';
    if (currentTs && currentTs === prevTimestamp) {
      continue;
    }

    out.push(line.raw);
    prevTimestamp = currentTs;
  }

  return out.join('\n');
}

function isPrimarilyChinese(text: string): boolean {
  const stripped = text.replace(/[\s\p{P}\d]/gu, '');
  if (!stripped) return true;
  const hanMatches = stripped.match(/[\u4e00-\u9fff]/g) || [];
  const kanaMatches = stripped.match(/[\u3040-\u30ff]/g) || [];
  if (kanaMatches.length > 0) return false;
  return hanMatches.length / stripped.length > 0.55;
}

// ---------------------------------------------------------------------------
// High-Speed Multi-Source Lyrics Search Engine (LRCLIB + 网易云 + 酷狗)
// ---------------------------------------------------------------------------

interface NormalizedSearchContext {
  rawQuery: string;
  title: string;
  coreTitle: string;
  artist: string;
  album: string;
  durationSec?: number;
  combinedQuery: string;
}

interface CacheEntry {
  results: UnifiedLyricResult[];
  sourcesUsed: string[];
  expiresAt: number;
}

const LYRIC_CACHE_TTL_MS = 5 * 60 * 1000;
const LYRIC_EMPTY_CACHE_TTL_MS = 30 * 1000;
const LYRIC_CACHE_MAX_ENTRIES = 250;

const lyricSearchCache = new Map<string, CacheEntry>();
const inflightLyricSearches = new Map<
  string,
  Promise<{ results: UnifiedLyricResult[]; sourcesUsed: string[] }>
>();

const NOISE_PARENS_RE =
  /\s*[\(\[【（](?:explicit|clean|remaster(?:ed)?(?:\s*\d{4})?|deluxe(?:\s*edition)?|mono|stereo|single\s*version|album\s*version|radio\s*edit|official\s*(?:audio|video|lyric\s*video|mv)|lyric\s*video|audio|flac|hi-?res|lossless|\d{4}\s*(?:remaster|mix|ver\.?))[\)\]】）]/gi;

const FEAT_PARENS_RE =
  /\s*[\(\[【（](?:feat\.?|ft\.?|featuring|with)\s+[^\)\]】）]+[\)\]】）]/gi;

const FEAT_TAIL_RE = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i;

const VARIANT_KEYWORDS: { pattern: RegExp; key: string }[] = [
  { pattern: /\b(instrumental|inst\.?|off\s*vocal|karaoke|minus\s*one)\b/i, key: 'instrumental' },
  { pattern: /(纯音乐|伴奏|消音|无人生|无人声|卡拉OK)/i, key: 'instrumental' },
  { pattern: /\b(remix|dj|club\s*mix|extended\s*mix|pop\s*mix|radio\s*mix|bootleg|mashup)\b/i, key: 'remix' },
  { pattern: /(混音|dj版|串烧|电音版)/i, key: 'remix' },
  { pattern: /\b(nightcore|sped\s*up|speed\s*up|slowed(?:\s*\+\s*reverb)?|8d\s*audio)\b/i, key: 'speedmod' },
  { pattern: /(变速|加速版|降速|立体环绕)/i, key: 'speedmod' },
  { pattern: /\b(cover|tribute)\b/i, key: 'cover' },
  { pattern: /(翻唱)/i, key: 'cover' },
  { pattern: /\b(live(?:\s+at|\s+from|\s+in)?|concert|unplugged|tour)\b/i, key: 'live' },
  { pattern: /(现场版?|演唱会)/i, key: 'live' },
  { pattern: /\b(piano\s*ver(?:sion)?|acoustic|orchestral|lullaby)\b/i, key: 'arrangement' },
  { pattern: /(钢琴版|吉他版|八音盒|纯享版)/i, key: 'arrangement' },
];

export function cleanSearchTitleText(rawTitle: string): string {
  return (rawTitle || '')
    .replace(/\.(mp3|flac|wav|aac|m4a|ogg|opus|wma|alac|aiff)$/i, '')
    .replace(NOISE_PARENS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCoreTitleText(rawTitle: string): string {
  return cleanSearchTitleText(rawTitle)
    .replace(FEAT_PARENS_RE, '')
    .replace(FEAT_TAIL_RE, '')
    .replace(/\s*[\(\[【（][^()\[\]【】（）]*[\)\]】）]\s*$/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTokenText(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitArtistVariants(rawArtist: string): string[] {
  const cleaned = (rawArtist || '')
    .normalize('NFKC')
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b/gi, '/');
  const parts = new Set<string>();
  const full = normalizeTokenText(cleaned);
  if (full) parts.add(full);

  // Extract parenthetical aliases like "NewJeans (뉴진스)" -> "NewJeans", "뉴진스"
  const aliasMatches = cleaned.match(/[\(\[【（]([^\)\]】）]+)[\)\]】）]/g) || [];
  for (const m of aliasMatches) {
    const inner = normalizeTokenText(m.slice(1, -1));
    if (inner.length >= 2) parts.add(inner);
  }

  const strippedParens = cleaned.replace(/[\(\[【（][^\)\]】）]+[\)\]】）]/g, '/');
  for (const seg of strippedParens.split(/[\/,&×·;、]+/)) {
    const norm = normalizeTokenText(seg);
    if (norm.length >= 1) parts.add(norm);
  }
  return Array.from(parts);
}

function diceBigramSimilarity(a: string, b: string): number {
  const s1 = a.replace(/\s+/g, '');
  const s2 = b.replace(/\s+/g, '');
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length === 1 || s2.length === 1) {
    return s2.includes(s1) || s1.includes(s2) ? 0.6 : 0;
  }
  const bigrams = new Map<string, number>();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      hits++;
    }
  }
  return (2 * hits) / (s1.length - 1 + (s2.length - 1));
}

function computeTitleSimilarity(queryTitle: string, candTitle: string): number {
  const qFull = normalizeTokenText(cleanSearchTitleText(queryTitle));
  const cFull = normalizeTokenText(cleanSearchTitleText(candTitle));
  if (!qFull || !cFull) return 0;
  if (qFull === cFull) return 1.0;

  const qCore = normalizeTokenText(extractCoreTitleText(queryTitle));
  const cCore = normalizeTokenText(extractCoreTitleText(candTitle));
  if (qCore && cCore && qCore === cCore) return 0.94;

  if (cFull.includes(qFull) || qFull.includes(cFull)) {
    const ratio = Math.min(qFull.length, cFull.length) / Math.max(qFull.length, cFull.length);
    return 0.72 + ratio * 0.2;
  }
  if (qCore && cCore && (cCore.includes(qCore) || qCore.includes(cCore))) {
    const ratio = Math.min(qCore.length, cCore.length) / Math.max(qCore.length, cCore.length);
    return 0.68 + ratio * 0.2;
  }

  return Math.max(
    diceBigramSimilarity(qFull, cFull),
    qCore && cCore ? diceBigramSimilarity(qCore, cCore) * 0.95 : 0
  );
}

function computeArtistScore(queryArtist: string, candArtist: string): number {
  if (!queryArtist.trim()) return 0;
  const qVariants = splitArtistVariants(queryArtist);
  const cVariants = splitArtistVariants(candArtist);
  if (qVariants.length === 0 || cVariants.length === 0) return -8;

  let bestSim = 0;
  for (const qv of qVariants) {
    for (const cv of cVariants) {
      if (qv === cv) return 28;
      if (
        (qv.length >= 2 && cv.includes(qv)) ||
        (cv.length >= 2 && qv.includes(cv))
      ) {
        bestSim = Math.max(bestSim, 0.85);
      } else {
        bestSim = Math.max(bestSim, diceBigramSimilarity(qv, cv));
      }
    }
  }

  if (bestSim >= 0.8) return 24;
  if (bestSim >= 0.55) return 14;
  if (bestSim >= 0.35) return 4;
  return -18;
}

function countMeaningfulLyricLines(rawLyrics: string | null | undefined): {
  lineCount: number;
  isInstrumentalStub: boolean;
} {
  if (!rawLyrics || !rawLyrics.trim()) {
    return { lineCount: 0, isInstrumentalStub: false };
  }
  const lower = rawLyrics.toLowerCase();
  const isStubText =
    /纯音乐[，,\s]*请欣赏|没有填词的纯音乐|this\s+song\s+is\s+an\s+instrumental/i.test(
      lower
    );

  let count = 0;
  for (const rawLine of rawLyrics.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^\[(ti|ar|al|by|offset|re|ve|id|hash|sign|total):/i.test(trimmed)) {
      continue;
    }
    const text = trimmed
      .replace(LINE_TIME_TAG_RE, '')
      .replace(WORD_TIME_TAG_RE, '')
      .trim();
    if (text.length > 0) count++;
  }

  return {
    lineCount: count,
    isInstrumentalStub: isStubText && count <= 5,
  };
}

function detectUnwantedVariantPenalty(
  queryText: string,
  candTitle: string,
  candAlbum: string
): number {
  const queryCombined = `${queryText}`;
  const candCombined = `${candTitle} ${candAlbum}`;
  for (const v of VARIANT_KEYWORDS) {
    if (v.pattern.test(candCombined) && !v.pattern.test(queryCombined)) {
      return -28;
    }
  }
  return 0;
}

function buildSearchContext(input: string | LyricSearchQueryInput): NormalizedSearchContext {
  if (typeof input === 'string') {
    const rawQuery = input.trim();
    const cleaned = cleanSearchTitleText(rawQuery);
    return {
      rawQuery,
      title: cleaned,
      coreTitle: extractCoreTitleText(cleaned),
      artist: '',
      album: '',
      durationSec: undefined,
      combinedQuery: rawQuery,
    };
  }

  const rawTitle = (input.title || '').trim();
  const rawArtist = (input.artist || '').trim();
  const rawAlbum = (input.album || '').trim();
  const rawQ = (input.q || '').trim();

  const cleanArtist =
    rawArtist && rawArtist !== '未知艺术家' && rawArtist !== 'Unknown Artist'
      ? rawArtist
      : '';
  const cleanTitle = cleanSearchTitleText(rawTitle || rawQ);
  const coreTitle = extractCoreTitleText(cleanTitle);
  const durationSec =
    typeof input.duration === 'number' &&
    Number.isFinite(input.duration) &&
    input.duration > 0
      ? Math.round(input.duration)
      : undefined;

  const combinedQuery =
    rawQ || [cleanTitle, cleanArtist].filter(Boolean).join(' ').trim();

  return {
    rawQuery: rawQ || combinedQuery,
    title: cleanTitle,
    coreTitle,
    artist: cleanArtist,
    album: rawAlbum,
    durationSec,
    combinedQuery,
  };
}

function buildCacheKey(ctx: NormalizedSearchContext): string {
  const durBucket = ctx.durationSec ? Math.round(ctx.durationSec / 2) * 2 : 0;
  return [
    normalizeTokenText(ctx.title),
    normalizeTokenText(ctx.artist),
    normalizeTokenText(ctx.album),
    String(durBucket),
    normalizeTokenText(ctx.combinedQuery),
  ].join('|');
}

function scoreLyricCandidate(
  item: UnifiedLyricResult,
  ctx: NormalizedSearchContext
): UnifiedLyricResult {
  const effectiveTitleQuery = ctx.title || ctx.combinedQuery;
  const titleSim = computeTitleSimilarity(effectiveTitleQuery, item.trackName || '');
  const titlePts = Math.round(titleSim * 44);

  const artistPts = computeArtistScore(ctx.artist, item.artistName || '');

  // If no explicit artist field was passed, check if combined query mentions candidate artist
  let implicitArtistBonus = 0;
  if (!ctx.artist && ctx.combinedQuery && item.artistName) {
    const normQ = normalizeTokenText(ctx.combinedQuery);
    const variants = splitArtistVariants(item.artistName);
    if (variants.some((v) => v.length >= 2 && normQ.includes(v))) {
      implicitArtistBonus = 12;
    }
  }

  let durationPts = 0;
  let durationDiffSec: number | undefined;
  if (ctx.durationSec && ctx.durationSec > 0 && item.duration > 0) {
    durationDiffSec = Math.abs(ctx.durationSec - item.duration);
    if (durationDiffSec <= 1.5) durationPts = 24;
    else if (durationDiffSec <= 3.5) durationPts = 18;
    else if (durationDiffSec <= 7) durationPts = 10;
    else if (durationDiffSec <= 15) durationPts = 0;
    else if (durationDiffSec <= 30) durationPts = -14;
    else durationPts = -24;
  }

  let albumPts = 0;
  if (ctx.album && item.albumName) {
    const albumSim = diceBigramSimilarity(
      normalizeTokenText(ctx.album),
      normalizeTokenText(item.albumName)
    );
    if (albumSim >= 0.85) albumPts = 7;
    else if (albumSim >= 0.55) albumPts = 3;
  }

  const variantPenalty = detectUnwantedVariantPenalty(
    `${ctx.title} ${ctx.combinedQuery}`,
    item.trackName || '',
    item.albumName || ''
  );

  const rawBody = item.syncedLyrics || item.plainLyrics || '';
  const { lineCount, isInstrumentalStub } = countMeaningfulLyricLines(rawBody);

  let lyricQualityPts = 0;
  if (isInstrumentalStub) {
    lyricQualityPts = -38;
  } else if (item.syncedLyrics) {
    lyricQualityPts = lineCount >= 10 ? 15 : lineCount >= 5 ? 9 : -12;
  } else if (item.plainLyrics) {
    lyricQualityPts = lineCount >= 8 ? 3 : -10;
  } else {
    lyricQualityPts = -50;
  }

  // Reward native bilingual ONLY when track identity actually matches
  const isTrackIdentityValid =
    titlePts >= 20 &&
    artistPts >= 0 &&
    variantPenalty === 0 &&
    (durationDiffSec === undefined || durationDiffSec <= 15);
  const nativeBilingualPts =
    item.hasNativeTranslation && isTrackIdentityValid ? 10 : 0;

  const rawScore =
    titlePts +
    artistPts +
    implicitArtistBonus +
    durationPts +
    albumPts +
    variantPenalty +
    lyricQualityPts +
    nativeBilingualPts;

  return {
    ...item,
    matchScore: rawScore,
    lineCount,
    durationDiffSec:
      durationDiffSec !== undefined ? Math.round(durationDiffSec) : undefined,
  };
}

function preScoreMetadata(
  trackName: string,
  artistName: string,
  albumName: string,
  durationSec: number,
  ctx: NormalizedSearchContext
): number {
  const titleSim = computeTitleSimilarity(ctx.title || ctx.combinedQuery, trackName);
  const artistPts = computeArtistScore(ctx.artist, artistName);
  const variantPenalty = detectUnwantedVariantPenalty(
    `${ctx.title} ${ctx.combinedQuery}`,
    trackName,
    albumName
  );
  let durationPts = 0;
  if (ctx.durationSec && ctx.durationSec > 0 && durationSec > 0) {
    const diff = Math.abs(ctx.durationSec - durationSec);
    if (diff <= 2) durationPts = 22;
    else if (diff <= 5) durationPts = 14;
    else if (diff <= 12) durationPts = 4;
    else if (diff > 20) durationPts = -16;
  }
  return titleSim * 45 + artistPts + durationPts + variantPenalty;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
  parentSignal?: AbortSignal
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

function mapLrclibItem(item: UnifiedLyricResult): UnifiedLyricResult {
  return {
    id: item.id,
    trackName: item.trackName,
    artistName: item.artistName,
    albumName: item.albumName || '',
    duration: Math.round(item.duration || 0),
    syncedLyrics: item.syncedLyrics || null,
    plainLyrics: item.plainLyrics || null,
    hasNativeTranslation: false,
    source: 'LRCLIB',
  };
}

export async function fetchLrclibResults(
  ctxOrQuery: string | NormalizedSearchContext
): Promise<UnifiedLyricResult[]> {
  const ctx =
    typeof ctxOrQuery === 'string' ? buildSearchContext(ctxOrQuery) : ctxOrQuery;
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'LUMINA-MUSIC/1.0',
  };

  const requests: Promise<UnifiedLyricResult[]>[] = [];

  // 1. Ultra-fast exact lookup via /api/get (~250-350ms) when structured metadata exists
  if (ctx.title && ctx.artist) {
    const getParams = new URLSearchParams({
      track_name: ctx.title,
      artist_name: ctx.artist,
    });
    if (ctx.album) getParams.set('album_name', ctx.album);
    if (ctx.durationSec) getParams.set('duration', String(ctx.durationSec));

    requests.push(
      fetchJsonWithTimeout<UnifiedLyricResult>(
        `https://lrclib.net/api/get?${getParams.toString()}`,
        2600,
        headers
      ).then((item) => (item && (item.syncedLyrics || item.plainLyrics) ? [mapLrclibItem(item)] : []))
    );

    const structSearchParams = new URLSearchParams({
      track_name: ctx.title,
      artist_name: ctx.artist,
    });
    requests.push(
      fetchJsonWithTimeout<UnifiedLyricResult[]>(
        `https://lrclib.net/api/search?${structSearchParams.toString()}`,
        3000,
        headers
      ).then((list) => (Array.isArray(list) ? list.map(mapLrclibItem) : []))
    );
  }

  // 2. General keyword search (also handles queries without split artist)
  if (ctx.combinedQuery) {
    requests.push(
      fetchJsonWithTimeout<UnifiedLyricResult[]>(
        `https://lrclib.net/api/search?q=${encodeURIComponent(ctx.combinedQuery)}`,
        3000,
        headers
      ).then((list) => (Array.isArray(list) ? list.map(mapLrclibItem) : []))
    );
  }

  const batches = await Promise.all(requests);
  const collected = batches.flat().filter((x) => x.syncedLyrics || x.plainLyrics);

  // Relaxed core-title fallback ONLY if primary queries returned zero synced candidates
  const hasGoodSynced = collected.some((x) => {
    if (!x.syncedLyrics) return false;
    const sim = computeTitleSimilarity(ctx.title || ctx.combinedQuery, x.trackName || '');
    return sim >= 0.7;
  });

  if (!hasGoodSynced && ctx.coreTitle && ctx.coreTitle !== ctx.title) {
    const fallbackQuery = [ctx.coreTitle, ctx.artist].filter(Boolean).join(' ');
    const fallbackList = await fetchJsonWithTimeout<UnifiedLyricResult[]>(
      `https://lrclib.net/api/search?q=${encodeURIComponent(fallbackQuery)}`,
      2200,
      headers
    );
    if (Array.isArray(fallbackList)) {
      collected.push(
        ...fallbackList.map(mapLrclibItem).filter((x) => x.syncedLyrics || x.plainLyrics)
      );
    }
  }

  return collected;
}

export async function fetchNeteaseResults(
  ctxOrQuery: string | NormalizedSearchContext
): Promise<UnifiedLyricResult[]> {
  const ctx =
    typeof ctxOrQuery === 'string' ? buildSearchContext(ctxOrQuery) : ctxOrQuery;
  const query = ctx.combinedQuery;
  if (!query) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3400);
  const neHeaders = {
    Referer: 'https://music.163.com/',
    'User-Agent': 'Mozilla/5.0',
  };

  try {
    const searchUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(
      query
    )}&type=1&limit=6`;
    const searchJson = await fetchJsonWithTimeout<{
      nolyric?: boolean;
      result?: {
        songs?: {
          id: number;
          name: string;
          duration: number;
          artists?: { name: string }[];
          album?: { name: string };
        }[];
      };
    }>(searchUrl, 2100, neHeaders, controller.signal);

    const rawSongs = searchJson?.result?.songs || [];
    if (rawSongs.length === 0) return [];

    // Pre-rank candidates by title, artist, album, and duration BEFORE fetching lyrics
    const rankedSongs = rawSongs
      .map((song) => {
        const artistName = song.artists?.map((a) => a.name).join(' / ') || '';
        const albumName = song.album?.name || '';
        const durationSec = Math.round((song.duration || 0) / 1000);
        return {
          song,
          artistName,
          albumName,
          durationSec,
          preScore: preScoreMetadata(
            song.name,
            artistName,
            albumName,
            durationSec,
            ctx
          ),
        };
      })
      .sort((a, b) => b.preScore - a.preScore)
      .slice(0, 4);

    const lyricPromises = rankedSongs.map(
      async ({ song, artistName, albumName, durationSec }): Promise<UnifiedLyricResult | null> => {
        const lrcUrl = `https://music.163.com/api/song/lyric?id=${song.id}&lv=1&tv=1`;
        const lrcJson = await fetchJsonWithTimeout<{
          nolyric?: boolean;
          uncollected?: boolean;
          lrc?: { lyric?: string };
          tlyric?: { lyric?: string };
        }>(lrcUrl, 1600, neHeaders, controller.signal);

        if (!lrcJson || lrcJson.nolyric || lrcJson.uncollected) return null;
        const orig = lrcJson.lrc?.lyric?.trim();
        if (!orig) return null;

        const trans = lrcJson.tlyric?.lyric?.trim();
        const transEntriesCount = trans ? parseTimedEntries(trans).length : 0;
        const hasTrans = Boolean(trans && transEntriesCount >= 3);
        const merged =
          hasTrans && trans ? mergeOriginalAndTranslatedLrc(orig, trans) : orig;
        const isTimed = /\[\d{1,3}:\d{1,2}/.test(merged);

        return {
          id: 900000000 + song.id,
          trackName: song.name,
          artistName,
          albumName,
          duration: durationSec,
          syncedLyrics: isTimed ? merged : null,
          plainLyrics: isTimed ? null : merged,
          hasNativeTranslation: hasTrans,
          source: hasTrans ? '网易云双语' : '网易云',
        };
      }
    );

    const resolved = await Promise.all(lyricPromises);
    return resolved.filter((x): x is UnifiedLyricResult => x !== null);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function cleanKugouLrc(rawLrc: string): string {
  return rawLrc
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\[(id|hash|sign|total|kana):/i.test(line.trim()))
    .join('\n')
    .trim();
}

export async function fetchKugouResults(
  ctx: NormalizedSearchContext
): Promise<UnifiedLyricResult[]> {
  // KuGou search API requires duration (ms) for reliable hits
  if (!ctx.durationSec || ctx.durationSec <= 0) return [];
  const keyword = [ctx.title || ctx.combinedQuery, ctx.artist].filter(Boolean).join(' - ');
  if (!keyword) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2400);
  const kgHeaders = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  };

  try {
    const searchUrl = `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(
      keyword
    )}&duration=${ctx.durationSec * 1000}`;

    const searchJson = await fetchJsonWithTimeout<{
      candidates?: Array<{
        id: string;
        accesskey: string;
        song: string;
        singer: string;
        duration: number;
        score?: number;
      }>;
    }>(searchUrl, 1400, kgHeaders, controller.signal);

    const candidates = searchJson?.candidates || [];
    if (candidates.length === 0) return [];

    const topCandidates = candidates
      .map((c) => {
        const durationSec = Math.round((c.duration || 0) / 1000);
        return {
          c,
          durationSec,
          preScore:
            preScoreMetadata(c.song || '', c.singer || '', '', durationSec, ctx) +
            (c.score || 0) * 0.1,
        };
      })
      .sort((a, b) => b.preScore - a.preScore)
      .slice(0, 2);

    const downloads = topCandidates.map(
      async ({ c, durationSec }): Promise<UnifiedLyricResult | null> => {
        const dlUrl = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(
          c.id
        )}&accesskey=${encodeURIComponent(c.accesskey)}&fmt=lrc&charset=utf8`;
        const dlJson = await fetchJsonWithTimeout<{ content?: string }>(
          dlUrl,
          1200,
          kgHeaders,
          controller.signal
        );
        if (!dlJson?.content) return null;
        const decoded = Buffer.from(dlJson.content, 'base64').toString('utf8');
        const cleaned = cleanKugouLrc(decoded);
        if (!cleaned) return null;

        const isTimed = /\[\d{1,3}:\d{1,2}/.test(cleaned);
        const numericId = Number(c.id) || Math.floor(Math.random() * 1_000_000);

        return {
          id: 800000000 + (numericId % 99_999_999),
          trackName: c.song || ctx.title || ctx.combinedQuery,
          artistName: c.singer || ctx.artist,
          albumName: '',
          duration: durationSec,
          syncedLyrics: isTimed ? cleaned : null,
          plainLyrics: isTimed ? null : cleaned,
          hasNativeTranslation: false,
          source: '酷狗',
        };
      }
    );

    const resolved = await Promise.all(downloads);
    return resolved.filter((x): x is UnifiedLyricResult => x !== null);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function buildLyricFingerprint(item: UnifiedLyricResult): string {
  const raw = item.syncedLyrics || item.plainLyrics || '';
  const sampleLines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(LINE_TIME_TAG_RE, '').replace(WORD_TIME_TAG_RE, '').trim())
    .filter((l) => l.length > 0 && !/^\[/.test(l))
    .slice(0, 4)
    .join('|');
  const normSample = normalizeTokenText(sampleLines).slice(0, 80);
  const normSource = (item.source || '').startsWith('网易云') ? '网易云' : item.source || '';
  return [
    normSource,
    normalizeTokenText(item.trackName),
    Boolean(item.hasNativeTranslation) ? 'bi' : 'mono',
    Boolean(item.syncedLyrics) ? 'sync' : 'plain',
    normSample,
  ].join('::');
}

function deduplicateAndRank(
  rawResults: UnifiedLyricResult[],
  ctx: NormalizedSearchContext
): UnifiedLyricResult[] {
  const scored = rawResults.map((item) => scoreLyricCandidate(item, ctx));

  scored.sort((a, b) => {
    const scoreDiff = (b.matchScore || 0) - (a.matchScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    if (a.hasNativeTranslation && !b.hasNativeTranslation) return -1;
    if (!a.hasNativeTranslation && b.hasNativeTranslation) return 1;
    if (a.syncedLyrics && !b.syncedLyrics) return -1;
    if (!a.syncedLyrics && b.syncedLyrics) return 1;
    return (b.lineCount || 0) - (a.lineCount || 0);
  });

  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const deduped: UnifiedLyricResult[] = [];

  for (const item of scored) {
    // Filter out empty or completely junk instrumental stubs if we already have real hits
    if ((item.lineCount || 0) === 0) continue;

    const idKey = `${item.source || ''}:${item.id}`;
    if (seenIds.has(idKey)) continue;

    const fp = buildLyricFingerprint(item);
    if (seenFingerprints.has(fp)) continue;

    seenIds.add(idKey);
    seenFingerprints.add(fp);
    deduped.push({
      ...item,
      matchScore: Math.max(0, Math.min(100, Math.round(item.matchScore || 0))),
    });
    if (deduped.length >= 15) break;
  }

  return deduped;
}

export async function searchOnlineLyricsDetailed(
  input: string | LyricSearchQueryInput
): Promise<LyricSearchDetailedResult> {
  const startedAt = Date.now();
  const ctx = buildSearchContext(input);
  if (!ctx.combinedQuery) {
    return { results: [], cacheHit: false, elapsedMs: 0, sourcesUsed: [] };
  }

  const cacheKey = buildCacheKey(ctx);
  const now = Date.now();
  const cached = lyricSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    // Refresh LRU order
    lyricSearchCache.delete(cacheKey);
    lyricSearchCache.set(cacheKey, cached);
    return {
      results: cached.results,
      cacheHit: true,
      elapsedMs: Date.now() - startedAt,
      sourcesUsed: cached.sourcesUsed,
    };
  }

  let pending = inflightLyricSearches.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const [lrclibSettled, neteaseSettled, kugouSettled] = await Promise.allSettled([
        fetchLrclibResults(ctx),
        fetchNeteaseResults(ctx),
        fetchKugouResults(ctx),
      ]);

      const sourcesUsed: string[] = [];
      const combinedRaw: UnifiedLyricResult[] = [];

      if (lrclibSettled.status === 'fulfilled' && lrclibSettled.value.length > 0) {
        sourcesUsed.push('LRCLIB');
        combinedRaw.push(...lrclibSettled.value);
      }
      if (neteaseSettled.status === 'fulfilled' && neteaseSettled.value.length > 0) {
        sourcesUsed.push('网易云');
        combinedRaw.push(...neteaseSettled.value);
      }
      if (kugouSettled.status === 'fulfilled' && kugouSettled.value.length > 0) {
        sourcesUsed.push('酷狗');
        combinedRaw.push(...kugouSettled.value);
      }

      const ranked = deduplicateAndRank(combinedRaw, ctx);
      const ttl =
        ranked.length > 0 ? LYRIC_CACHE_TTL_MS : LYRIC_EMPTY_CACHE_TTL_MS;

      if (lyricSearchCache.size >= LYRIC_CACHE_MAX_ENTRIES) {
        const oldestKey = lyricSearchCache.keys().next().value;
        if (oldestKey !== undefined) lyricSearchCache.delete(oldestKey);
      }
      lyricSearchCache.set(cacheKey, {
        results: ranked,
        sourcesUsed,
        expiresAt: Date.now() + ttl,
      });

      return { results: ranked, sourcesUsed };
    })().finally(() => {
      inflightLyricSearches.delete(cacheKey);
    });

    inflightLyricSearches.set(cacheKey, pending);
  }

  const resolved = await pending;
  return {
    results: resolved.results,
    cacheHit: false,
    elapsedMs: Date.now() - startedAt,
    sourcesUsed: resolved.sourcesUsed,
  };
}

export async function searchOnlineLyricsCombined(
  input: string | LyricSearchQueryInput
): Promise<UnifiedLyricResult[]> {
  const detailed = await searchOnlineLyricsDetailed(input);
  return detailed.results;
}

export function clearLyricSearchCache(): void {
  lyricSearchCache.clear();
}

export const TARGET_LANGUAGE_PROMPTS: Record<string, string> = {
  'zh-CN':
    'Simplified Chinese (简体中文). Ensure natural, expressive Chinese that preserves the emotional nuance and lyrical cadence.',
  'zh-TW':
    'Traditional Chinese (繁體中文). Ensure natural, expressive Traditional Chinese that preserves emotional nuance and lyrical cadence.',
  en: 'English. Write lyrical, natural-sounding English lines that preserve the imagery, rhythm, and emotional resonance of the song.',
  ja: 'Japanese (日本語). Write poetic, natural Japanese lyrics preserving emotional subtlety and lyrical imagery.',
};

export const STYLE_INSTRUCTIONS: Record<string, string> = {
  poetic:
    '诗意翻译（默认推荐）：兼具文学美感、画面感与情绪感染力；语言自然优美，绝不生硬直译；可适当运用文学修辞与意象，但必须严格忠实原意，不得臆造原歌词未表达的情节，不得为强求押韵而扭曲原意。',
  literal:
    '忠实直译：尽可能精准保留原文逐词与句法含义，清晰传达原词表达，不做额外发挥或大幅改写。',
  natural:
    '自然翻译：完全贴合现代中文自然表达习惯，通顺流畅、亲切直观、朗朗上口，不带机翻腔。',
  literary:
    '文学润色：在严格忠实原文核心意义的基础上，进一步锤炼辞藻与韵致，呈现高级散文诗般的文字表现力。',
  bilingual:
    '双语精炼对照：凝练准确，节奏干脆，适合同屏双语对照阅读。',
  custom: '自定义风格：严格遵循用户指定的翻译风格与要求。',
};

export interface ExecuteTranslationInput {
  rawLyrics: string;
  trackTitle?: string;
  artistName?: string;
  targetLanguage?: string;
  style?: string;
  customStylePrompt?: string;
  providerId?: string;
  modelName?: string;
  force?: boolean;
  snapshot?: ClientVaultSnapshot | null;
}

export interface ExecuteTranslationResult {
  bilingualLyrics: string;
  originalLyricsRaw: string;
  translatedLyricsRaw: string;
  lyricPairs: LyricPairOutput[];
  translatedCount: number;
  providerId?: string;
  providerName?: string;
  modelUsed?: string;
  style: string;
  skippedReason?: string;
}

export class LyricsTranslationHttpError extends Error {
  readonly status: number;
  readonly errorCategory?: string;

  constructor(message: string, status = 400, errorCategory?: string) {
    super(message);
    this.status = status;
    this.errorCategory = errorCategory;
  }
}

export function normalizeTranslationItems(
  parsedJson: unknown
): { idx: number; translation: string }[] {
  if (Array.isArray(parsedJson)) {
    return parsedJson as { idx: number; translation: string }[];
  }
  if (parsedJson && typeof parsedJson === 'object') {
    const obj = parsedJson as Record<string, unknown>;
    const candidate = obj.translations || obj.lines || obj.items || obj.data;
    if (Array.isArray(candidate)) {
      return candidate as { idx: number; translation: string }[];
    }
  }
  return [];
}

export async function executeLyricsTranslation(
  input: ExecuteTranslationInput
): Promise<ExecuteTranslationResult> {
  const rawInput = typeof input.rawLyrics === 'string' ? input.rawLyrics : '';
  if (!rawInput.trim()) {
    throw new LyricsTranslationHttpError('歌词内容为空，无法翻译', 400);
  }

  const targetLanguage =
    typeof input.targetLanguage === 'string' &&
    TARGET_LANGUAGE_PROMPTS[input.targetLanguage]
      ? input.targetLanguage
      : 'zh-CN';

  const style =
    typeof input.style === 'string' && STYLE_INSTRUCTIONS[input.style]
      ? input.style
      : 'poetic';

  const force = Boolean(input.force);

  // When re-translating (force=true) or cleaning mixed lines, work cleanly on stripped original lyrics
  const workingSource = force
    ? stripExistingTranslationsToOriginal(rawInput)
    : rawInput;

  const parsed = parseSourceLines(workingSource);
  const translatable: { idx: number; text: string }[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item.isMeta && item.cleanText) {
      translatable.push({ idx: i, text: item.cleanText });
    }
  }

  if (translatable.length === 0) {
    return {
      bilingualLyrics: workingSource,
      originalLyricsRaw: workingSource,
      translatedLyricsRaw: '',
      lyricPairs: [],
      translatedCount: 0,
      style,
      skippedReason: 'no_lines',
    };
  }

  if (!force) {
    let bilingualPairs = 0;
    for (let i = 0; i < parsed.length; i++) {
      if (/\s+(?:\/\/|\|)\s+/.test(parsed[i].cleanText)) bilingualPairs++;
      if (
        i > 0 &&
        parsed[i].timestamps.length > 0 &&
        parsed[i - 1].timestamps.length > 0 &&
        parsed[i].timestamps[0] === parsed[i - 1].timestamps[0]
      ) {
        bilingualPairs++;
      }
    }
    if (bilingualPairs >= 3) {
      return {
        bilingualLyrics: rawInput,
        originalLyricsRaw: stripExistingTranslationsToOriginal(rawInput),
        translatedLyricsRaw: '',
        lyricPairs: [],
        translatedCount: 0,
        style,
        skippedReason: 'already_bilingual',
      };
    }

    const combinedSample = translatable.map((t) => t.text).join(' ');
    if (
      (targetLanguage === 'zh-CN' || targetLanguage === 'zh-TW') &&
      isPrimarilyChinese(combinedSample)
    ) {
      return {
        bilingualLyrics: workingSource,
        originalLyricsRaw: workingSource,
        translatedLyricsRaw: '',
        lyricPairs: [],
        translatedCount: 0,
        style,
        skippedReason: 'already_target_language',
      };
    }
  }

  const requestedProviderId = (input.providerId || '').trim();
  const resolved = await getStoredProviderWithKey(
    requestedProviderId || undefined,
    {
      strict: Boolean(requestedProviderId),
      snapshot: input.snapshot,
    }
  );

  if (!resolved) {
    throw new LyricsTranslationHttpError(
      requestedProviderId
        ? '未找到选定的 AI 服务商配置，请重新选择或前往「设置 → AI 智能中心 → API 服务管理」检查。'
        : '尚未配置可用 AI 服务商，请先前往「设置 → AI 智能中心 → API 服务管理」填写 API Key。',
      400,
      'unknown_error'
    );
  }

  const { provider, apiKey } = resolved;
  if (!provider.enabled) {
    throw new LyricsTranslationHttpError(
      `选定的 AI 服务商「${provider.name}」当前处于禁用状态，请先启用后再翻译。`,
      400,
      'unknown_error'
    );
  }
  if (!apiKey) {
    throw new LyricsTranslationHttpError(
      `AI 服务商「${provider.name}」尚未配置 API Key，请先前往「API 服务管理」填写 API Key 并测试连接。`,
      400,
      'auth_error'
    );
  }

  const effectiveModel = (input.modelName || provider.model || '').trim();
  if (!effectiveModel) {
    throw new LyricsTranslationHttpError(
      `AI 服务商「${provider.name}」尚未选择或填写模型名称。`,
      400,
      'model_not_found'
    );
  }

  const langInstruction = TARGET_LANGUAGE_PROMPTS[targetLanguage];
  const baseStyleInstruction = STYLE_INSTRUCTIONS[style];
  const customDirective = (input.customStylePrompt || '').trim();
  const styleInstruction =
    style === 'custom' && customDirective
      ? `${baseStyleInstruction}\n用户自定义要求：${customDirective}`
      : style === 'poetic' && customDirective
      ? `${baseStyleInstruction}\n附加要求：${customDirective}`
      : baseStyleInstruction;

  const systemInstruction = `You are an acclaimed literary song lyricist and poetic translator.
Translate the given song lyrics line by line into ${langInstruction}.
Translation style requirement: ${styleInstruction}

NON-NEGOTIABLE FIDELITY & STRUCTURE RULES:
1. Preserve the core meaning, emotional tone, atmosphere, and imagery of the original lyrics.
2. Express naturally and gracefully in the target language—avoid stiff word-for-word machine translation.
3. For poetic/literary styles, you may use appropriate literary imagery and rhetoric, BUT NEVER add plot events or details not present in the original lyrics, and NEVER severely distort original meaning merely to force rhyme.
4. NEVER summarize the whole song into a paragraph. You MUST translate line-by-line, keeping exact one-to-one structural correspondence with every input item.
5. Keep recurring chorus lines consistent in phrasing and tone across the whole song.
6. If a line is already purely in the target language, purely non-lexical vocalizations ("Ooh", "Ah", "La la la", "Yeah"), or structural/credit markers ("Instrumental", "作曲", "作词", "[Verse]", "[Chorus]"), return an empty string "" for translation.
7. Preserve the exact "idx" for every item in the input array; never merge or skip indices.
8. Return strictly valid JSON array (no extra prose): [{"idx": 0, "translation": "..."}]`;

  const userPrompt = JSON.stringify({
    song: input.trackTitle || '',
    artist: input.artistName || '',
    targetLanguage,
    style,
    lines: translatable,
  });

  let responseText: string;
  try {
    responseText = await callProviderTextCompletion({
      provider,
      apiKey,
      modelOverride: effectiveModel,
      systemInstruction,
      userPrompt,
      expectJson: true,
    });
  } catch (err) {
    if (err instanceof AdapterCallError) {
      throw new LyricsTranslationHttpError(
        err.message,
        err.httpStatus && err.httpStatus >= 400 ? err.httpStatus : 502,
        err.category
      );
    }
    throw new LyricsTranslationHttpError(
      err instanceof Error ? err.message : '调用 AI 模型翻译失败',
      502
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = extractJsonFromLlmText<unknown>(responseText);
  } catch {
    throw new LyricsTranslationHttpError(
      `模型「${effectiveModel}」返回格式无法解析为逐句 JSON 译文，请重试或切换模型。`,
      502,
      'unknown_error'
    );
  }

  const translations = normalizeTranslationItems(parsedJson);
  if (translations.length === 0) {
    throw new LyricsTranslationHttpError(
      `模型「${effectiveModel}」未返回有效逐句译文内容。`,
      502,
      'empty_response'
    );
  }

  const transMap = new Map<number, string>();
  for (const item of translations) {
    if (typeof item.idx === 'number' && typeof item.translation === 'string') {
      transMap.set(item.idx, item.translation.trim());
    }
  }

  const bilingualLines: string[] = [];
  const originalLines: string[] = [];
  const translatedOnlyLines: string[] = [];
  const lyricPairs: LyricPairOutput[] = [];
  let translatedCount = 0;

  for (let i = 0; i < parsed.length; i++) {
    const line = parsed[i];
    if (!line.raw) continue;
    if (line.isMeta) {
      bilingualLines.push(line.raw);
      originalLines.push(line.raw);
      translatedOnlyLines.push(line.raw);
      continue;
    }

    const prefix = line.timestamps.join('');
    originalLines.push(line.raw);

    const translated = (transMap.get(i) || '').trim();
    const validTranslation =
      translated.length > 0 && translated !== line.cleanText ? translated : '';

    if (validTranslation) {
      translatedCount++;
      if (prefix) {
        bilingualLines.push(line.raw);
        bilingualLines.push(`${prefix}${validTranslation}`);
        translatedOnlyLines.push(`${prefix}${validTranslation}`);
      } else {
        bilingualLines.push(`${line.raw} // ${validTranslation}`);
        translatedOnlyLines.push(validTranslation);
      }
    } else {
      bilingualLines.push(line.raw);
      if (prefix) {
        translatedOnlyLines.push(line.raw);
      } else {
        translatedOnlyLines.push('');
      }
    }

    lyricPairs.push({
      idx: lyricPairs.length,
      timestamp: prefix,
      originalText: line.cleanText,
      translatedText: validTranslation,
    });
  }

  return {
    bilingualLyrics: bilingualLines.join('\n'),
    originalLyricsRaw: originalLines.join('\n'),
    translatedLyricsRaw: translatedOnlyLines.join('\n'),
    lyricPairs,
    translatedCount,
    providerId: provider.id,
    providerName: provider.name,
    modelUsed: effectiveModel,
    style,
  };
}
