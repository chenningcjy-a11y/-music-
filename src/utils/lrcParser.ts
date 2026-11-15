import { LyricLine, LyricPairRecord, LyricWord, TrackMetadata } from '../types/music';

const LINE_TIME_REGEX = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TIME_REGEX = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

function parseTimestamp(minStr: string, secStr: string, msStr?: string): number {
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

export function formatLrcTimestamp(timeSec: number): string {
  if (!Number.isFinite(timeSec) || timeSec < 0) return '';
  const mins = Math.floor(timeSec / 60);
  const secs = Math.floor(timeSec % 60);
  const cs = Math.round((timeSec - Math.floor(timeSec)) * 100);
  const adjSecs = cs >= 100 ? secs + 1 : secs;
  const adjCs = cs >= 100 ? 0 : cs;
  return `[${String(mins).padStart(2, '0')}:${String(adjSecs).padStart(
    2,
    '0'
  )}.${String(adjCs).padStart(2, '0')}]`;
}

/**
 * Splits a single lyric line into primary text & secondary translation if formatted
 * with explicit bilingual delimiters (`//`, `|`, `／`, or trailing `【译文】`).
 */
export function splitInlineBilingual(rawText: string): {
  primary: string;
  translation?: string;
} {
  const trimmed = rawText.trim();

  const sepMatch = trimmed.split(/\s+\/\/\s+|\s+\|\s+|\s+／\s+/);
  if (sepMatch.length === 2 && sepMatch[0].trim() && sepMatch[1].trim()) {
    return {
      primary: sepMatch[0].trim(),
      translation: sepMatch[1].trim(),
    };
  }

  const bracketMatch = trimmed.match(/^(.+?)\s*【([^】]+)】$/);
  if (bracketMatch && bracketMatch[1].trim() && bracketMatch[2].trim()) {
    return {
      primary: bracketMatch[1].trim(),
      translation: bracketMatch[2].trim(),
    };
  }

  return { primary: trimmed };
}

/**
 * Parses standard LRC, multi-source bilingual LRC (dual-line matching timestamps,
 * slight offset alignment <= 0.12s, or inline separators), and enhanced word-level LRC (`<mm:ss.xx>word`).
 * Strictly NEVER fabricates word-level timestamps when none exist.
 */
export function parseLrc(raw?: string): {
  lines: LyricLine[];
  hasSyncedTimestamps: boolean;
  hasWordTimestamps: boolean;
  hasTranslations: boolean;
} {
  if (!raw || !raw.trim()) {
    return {
      lines: [],
      hasSyncedTimestamps: false,
      hasWordTimestamps: false,
      hasTranslations: false,
    };
  }

  const rawLines = raw.split(/\r?\n/);
  const parsedEntries: {
    time: number;
    text: string;
    words?: LyricWord[];
  }[] = [];

  let anyWordTimestamps = false;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (/^\[(ti|ar|al|by|offset|re|ve):/i.test(trimmed)) continue;

    const times: number[] = [];
    let match: RegExpExecArray | null;
    LINE_TIME_REGEX.lastIndex = 0;
    while ((match = LINE_TIME_REGEX.exec(trimmed)) !== null) {
      times.push(parseTimestamp(match[1], match[2], match[3]));
    }

    if (times.length === 0) continue;

    const content = trimmed.replace(LINE_TIME_REGEX, '').trim();
    if (!content) continue;

    let words: LyricWord[] | undefined;
    WORD_TIME_REGEX.lastIndex = 0;
    const wordMatches = [...content.matchAll(WORD_TIME_REGEX)];
    if (wordMatches.length > 0) {
      anyWordTimestamps = true;
      words = [];
      for (let i = 0; i < wordMatches.length; i++) {
        const wm = wordMatches[i];
        const wTime = parseTimestamp(wm[1], wm[2], wm[3]);
        const startIdx = (wm.index ?? 0) + wm[0].length;
        const endIdx =
          i + 1 < wordMatches.length
            ? (wordMatches[i + 1].index ?? content.length)
            : content.length;
        const wText = content.slice(startIdx, endIdx);
        if (wText.length > 0) {
          words.push({ time: wTime, text: wText });
        }
      }
    }

    const cleanText = content.replace(WORD_TIME_REGEX, '').trim();
    for (const t of times) {
      parsedEntries.push({
        time: t,
        text: cleanText,
        words: words && words.length > 0 ? words : undefined,
      });
    }
  }

  if (parsedEntries.length === 0) {
    const plainLines = rawLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^\[.*\]$/.test(l));
    let anyPlainTrans = false;
    const mapped = plainLines.map((line, idx) => {
      const { primary, translation } = splitInlineBilingual(line);
      if (translation) anyPlainTrans = true;
      return {
        id: `plain-${idx}`,
        time: -1,
        text: primary,
        translation,
      };
    });
    return {
      lines: mapped,
      hasSyncedTimestamps: false,
      hasWordTimestamps: false,
      hasTranslations: anyPlainTrans,
    };
  }

  parsedEntries.sort((a, b) => a.time - b.time);

  const merged: LyricLine[] = [];
  let anyTranslations = false;

  for (const entry of parsedEntries) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      Math.abs(prev.time - entry.time) <= 0.12 &&
      !prev.translation &&
      entry.text !== prev.text
    ) {
      prev.translation = entry.text;
      anyTranslations = true;
      continue;
    }

    if (!entry.words) {
      const { primary, translation } = splitInlineBilingual(entry.text);
      if (translation) anyTranslations = true;
      merged.push({
        id: `lrc-${merged.length}-${entry.time.toFixed(3)}`,
        time: entry.time,
        text: primary,
        translation,
      });
    } else {
      const splitIdx = entry.text.indexOf(' // ');
      if (splitIdx !== -1) {
        anyTranslations = true;
        merged.push({
          id: `lrc-${merged.length}-${entry.time.toFixed(3)}`,
          time: entry.time,
          text: entry.text.slice(0, splitIdx).trim(),
          translation: entry.text.slice(splitIdx + 4).trim(),
          words: entry.words,
        });
      } else {
        merged.push({
          id: `lrc-${merged.length}-${entry.time.toFixed(3)}`,
          time: entry.time,
          text: entry.text,
          words: entry.words,
        });
      }
    }
  }

  return {
    lines: merged,
    hasSyncedTimestamps: true,
    hasWordTimestamps: anyWordTimestamps,
    hasTranslations: anyTranslations,
  };
}

/**
 * Extracts pure original lyrics (timestamps + original line text) stripping stacked or inline translations.
 */
export function extractOriginalLyricsOnly(raw?: string): string {
  if (!raw || !raw.trim()) return '';
  const { lines, hasSyncedTimestamps } = parseLrc(raw);
  if (lines.length === 0) return raw;
  return lines
    .map((line) => {
      const ts = hasSyncedTimestamps && line.time >= 0 ? formatLrcTimestamp(line.time) : '';
      return `${ts}${line.text}`;
    })
    .join('\n');
}

/**
 * Extracts pure translated lyrics (timestamps + translated text only).
 */
export function extractTranslationLyricsOnly(raw?: string): string {
  if (!raw || !raw.trim()) return '';
  const { lines, hasSyncedTimestamps } = parseLrc(raw);
  if (lines.length === 0) return '';
  return lines
    .map((line) => {
      const ts = hasSyncedTimestamps && line.time >= 0 ? formatLrcTimestamp(line.time) : '';
      const trans = (line.translation || '').trim();
      return ts ? `${ts}${trans}` : trans;
    })
    .filter((l) => l.length > 0)
    .join('\n');
}

/**
 * Converts any LRC / bilingual text into explicit line-by-line pairs.
 */
export function buildLyricPairsFromRaw(raw?: string): LyricPairRecord[] {
  if (!raw || !raw.trim()) return [];
  const { lines, hasSyncedTimestamps } = parseLrc(raw);
  return lines.map((line, idx) => ({
    idx,
    timestamp:
      hasSyncedTimestamps && line.time >= 0 ? formatLrcTimestamp(line.time) : '',
    originalText: line.text,
    translatedText: line.translation || '',
  }));
}

/**
 * Reconstructs separated originalLyricsRaw, translatedLyricsRaw, and combined bilingualLyrics
 * cleanly from an array of per-line LyricPairRecord items.
 */
export function buildSeparatedLyricsFromPairs(pairs: LyricPairRecord[]): {
  originalLyricsRaw: string;
  translatedLyricsRaw: string;
  bilingualLyrics: string;
} {
  const origLines: string[] = [];
  const transLines: string[] = [];
  const bilingualLines: string[] = [];

  for (const pair of pairs) {
    const ts = pair.timestamp || '';
    const orig = (pair.originalText || '').trim();
    const trans = (pair.translatedText || '').trim();
    if (!orig && !trans) continue;

    origLines.push(`${ts}${orig}`);
    if (trans) {
      transLines.push(`${ts}${trans}`);
      if (ts) {
        bilingualLines.push(`${ts}${orig}`);
        bilingualLines.push(`${ts}${trans}`);
      } else {
        bilingualLines.push(`${orig} // ${trans}`);
      }
    } else {
      if (ts) transLines.push('');
      bilingualLines.push(`${ts}${orig}`);
    }
  }

  return {
    originalLyricsRaw: origLines.join('\n'),
    translatedLyricsRaw: transLines.filter((l) => l.trim().length > 0).join('\n'),
    bilingualLyrics: bilingualLines.join('\n'),
  };
}

/**
 * Returns the saved lyrics string suitable for playback rendering directly from IndexedDB track fields
 * without ever calling any AI API during playback.
 */
export function getSavedTrackLyricsForPlayback(
  track: TrackMetadata | null,
  displayMode: 'bilingual' | 'original' | 'translation' = 'bilingual'
): string {
  if (!track) return '';
  if (displayMode === 'original') {
    if (track.originalLyricsRaw?.trim()) return track.originalLyricsRaw;
    if (track.lyricPairs?.length) {
      return buildSeparatedLyricsFromPairs(track.lyricPairs).originalLyricsRaw;
    }
    return extractOriginalLyricsOnly(track.lyricsRaw);
  }
  if (displayMode === 'translation') {
    if (track.translatedLyricsRaw?.trim()) return track.translatedLyricsRaw;
    if (track.lyricPairs?.length) {
      return buildSeparatedLyricsFromPairs(track.lyricPairs).translatedLyricsRaw;
    }
    return extractTranslationLyricsOnly(track.lyricsRaw) || track.lyricsRaw || '';
  }
  if (track.lyricPairs && track.lyricPairs.length > 0) {
    return buildSeparatedLyricsFromPairs(track.lyricPairs).bilingualLyrics;
  }
  return track.lyricsRaw || track.originalLyricsRaw || '';
}

export function findActiveLyricIndex(
  lines: LyricLine[],
  currentTimeSec: number,
  offsetMs: number
): number {
  if (lines.length === 0 || lines[0].time < 0) return -1;
  const effectiveTime = currentTimeSec + offsetMs / 1000;
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= effectiveTime + 0.02) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

export interface OnlineLyricResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  hasNativeTranslation?: boolean;
  source?: string;
}

export type LyricTargetLanguage = 'zh-CN' | 'zh-TW' | 'en' | 'ja';

export async function searchOnlineLyrics(
  title: string,
  artist: string
): Promise<OnlineLyricResult[]> {
  const cleanTitle = title.replace(/\.[^.]+$/, '').trim();
  const cleanArtist =
    artist && artist !== '未知艺术家' && artist !== 'Unknown Artist' ? artist.trim() : '';

  const query = [cleanTitle, cleanArtist].filter(Boolean).join(' ');
  if (!query) return [];

  let data: OnlineLyricResult[];
  const apiRes = await fetch(`/api/lyrics/search?q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json' },
  });

  if (apiRes.ok) {
    data = (await apiRes.json()) as OnlineLyricResult[];
  } else {
    const directRes = await fetch(
      `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!directRes.ok) {
      throw new Error(`歌词检索请求失败 (${directRes.status})`);
    }
    data = (await directRes.json()) as OnlineLyricResult[];
  }

  return data.sort((a, b) => {
    if (a.hasNativeTranslation && !b.hasNativeTranslation) return -1;
    if (!a.hasNativeTranslation && b.hasNativeTranslation) return 1;
    if (a.syncedLyrics && !b.syncedLyrics) return -1;
    if (!a.syncedLyrics && b.syncedLyrics) return 1;
    return 0;
  });
}

export async function translateLyricsToBilingual(
  rawLyrics: string,
  trackTitle?: string,
  artistName?: string,
  targetLanguage: LyricTargetLanguage = 'zh-CN',
  style: string = 'poetic',
  providerId?: string,
  modelName?: string,
  customStylePrompt?: string,
  force = false
): Promise<{
  bilingualLyrics: string;
  originalLyricsRaw: string;
  translatedLyricsRaw: string;
  lyricPairs: LyricPairRecord[];
  translatedCount: number;
  providerId?: string;
  providerName?: string;
  modelUsed?: string;
  style?: string;
  skippedReason?: string;
}> {
  const { getVaultHeaders, getVaultSnapshotForRequest } = await import(
    '../services/ai/providerManager'
  );
  const [snap, headers] = await Promise.all([
    getVaultSnapshotForRequest(),
    getVaultHeaders(),
  ]);

  const res = await fetch('/api/lyrics/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      rawLyrics,
      trackTitle,
      artistName,
      targetLanguage,
      style,
      customStylePrompt,
      providerId,
      modelName,
      force,
      providerSnapshot: snap,
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `歌词翻译失败 (${res.status})`);
  }

  return payload;
}
