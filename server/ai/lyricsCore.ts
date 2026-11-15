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

export async function fetchLrclibResults(query: string): Promise<UnifiedLyricResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);
  try {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LUMINA-MUSIC/1.0',
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as UnifiedLyricResult[];
    return data.map((item) => ({
      ...item,
      hasNativeTranslation: false,
      source: 'LRCLIB',
    }));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNeteaseResults(query: string): Promise<UnifiedLyricResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const searchUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(
      query
    )}&type=1&limit=4`;
    const searchRes = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!searchRes.ok) return [];
    const searchJson = (await searchRes.json()) as {
      result?: {
        songs?: {
          id: number;
          name: string;
          duration: number;
          artists?: { name: string }[];
          album?: { name: string };
        }[];
      };
    };
    const songs = searchJson.result?.songs?.slice(0, 3) || [];
    if (songs.length === 0) return [];

    const lyricPromises = songs.map(async (song): Promise<UnifiedLyricResult | null> => {
      try {
        const lrcUrl = `https://music.163.com/api/song/lyric?id=${song.id}&lv=1&tv=1`;
        const lrcRes = await fetch(lrcUrl, {
          signal: controller.signal,
          headers: {
            Referer: 'https://music.163.com/',
            'User-Agent': 'Mozilla/5.0',
          },
        });
        if (!lrcRes.ok) return null;
        const lrcJson = (await lrcRes.json()) as {
          lrc?: { lyric?: string };
          tlyric?: { lyric?: string };
        };
        const orig = lrcJson.lrc?.lyric?.trim();
        if (!orig) return null;
        const trans = lrcJson.tlyric?.lyric?.trim();
        const hasTrans = Boolean(trans && parseTimedEntries(trans).length > 0);
        const merged =
          hasTrans && trans ? mergeOriginalAndTranslatedLrc(orig, trans) : orig;
        const isTimed = /\[\d{1,3}:\d{1,2}/.test(merged);

        return {
          id: 900000000 + song.id,
          trackName: song.name,
          artistName: song.artists?.map((a) => a.name).join(' / ') || '',
          albumName: song.album?.name || '',
          duration: Math.round((song.duration || 0) / 1000),
          syncedLyrics: isTimed ? merged : null,
          plainLyrics: isTimed ? null : merged,
          hasNativeTranslation: hasTrans,
          source: hasTrans ? '网易云双语' : '网易云',
        };
      } catch {
        return null;
      }
    });

    const resolved = await Promise.all(lyricPromises);
    return resolved.filter((x): x is UnifiedLyricResult => x !== null);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchOnlineLyricsCombined(
  query: string
): Promise<UnifiedLyricResult[]> {
  const [neteaseSettled, lrclibSettled] = await Promise.allSettled([
    fetchNeteaseResults(query),
    fetchLrclibResults(query),
  ]);

  const neteaseList =
    neteaseSettled.status === 'fulfilled' ? neteaseSettled.value : [];
  const lrclibList =
    lrclibSettled.status === 'fulfilled' ? lrclibSettled.value : [];

  return [...neteaseList, ...lrclibList].sort((a, b) => {
    if (a.hasNativeTranslation && !b.hasNativeTranslation) return -1;
    if (!a.hasNativeTranslation && b.hasNativeTranslation) return 1;
    if (a.syncedLyrics && !b.syncedLyrics) return -1;
    if (!a.syncedLyrics && b.syncedLyrics) return 1;
    return 0;
  });
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
