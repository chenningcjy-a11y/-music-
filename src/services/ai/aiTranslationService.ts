import { LyricPairRecord, LyricTranslationStyle } from '../../types/music';
import { getVaultHeaders, getVaultSnapshotForRequest } from './providerManager';

export type { LyricTranslationStyle };

export const LYRIC_TRANSLATION_STYLES: {
  id: LyricTranslationStyle;
  label: string;
  description: string;
}[] = [
  {
    id: 'poetic',
    label: '诗意翻译',
    description: '默认推荐：富含文学感、画面感与情绪张力，忠实原意不臆造',
  },
  {
    id: 'natural',
    label: '自然翻译',
    description: '符合现代中文表达习惯，通顺自然、亲切流畅',
  },
  {
    id: 'literal',
    label: '忠实直译',
    description: '尽可能保留原文逐句含义与结构对应，不做多余发挥',
  },
  {
    id: 'literary',
    label: '文学润色',
    description: '在忠实原意基础上锤炼文字修辞与韵致表现力',
  },
  {
    id: 'custom',
    label: '自定义风格',
    description: '自定义你的翻译风格要求（如古风、民谣口吻、散文诗等）',
  },
];

export interface TranslateOptions {
  rawLyrics: string;
  trackTitle?: string;
  artistName?: string;
  targetLanguage?: string;
  style?: LyricTranslationStyle;
  customStylePrompt?: string;
  providerId?: string;
  modelName?: string;
  force?: boolean;
}

export interface TranslateResult {
  bilingualLyrics: string;
  originalLyricsRaw: string;
  translatedLyricsRaw: string;
  lyricPairs: LyricPairRecord[];
  translatedCount: number;
  providerId?: string;
  providerName?: string;
  modelUsed?: string;
  style: LyricTranslationStyle;
  skippedReason?: string;
}

export async function translateLyricsWithAiEngine(
  opts: TranslateOptions
): Promise<TranslateResult> {
  const [snap, headers] = await Promise.all([
    getVaultSnapshotForRequest(),
    getVaultHeaders(),
  ]);

  const res = await fetch('/api/lyrics/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      rawLyrics: opts.rawLyrics,
      trackTitle: opts.trackTitle,
      artistName: opts.artistName,
      targetLanguage: opts.targetLanguage || 'zh-CN',
      style: opts.style || 'poetic',
      customStylePrompt: opts.customStylePrompt || '',
      providerId: opts.providerId,
      modelName: opts.modelName,
      force: Boolean(opts.force),
      providerSnapshot: snap,
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `AI 歌词翻译失败 (${res.status})`);
  }

  return payload as TranslateResult;
}
