import { LyricPairRecord, LyricTranslationStyle } from '../../types/music';
import { getVaultHeaders, getVaultSnapshotForRequest } from './providerManager';

export type LyricsAiAction =
  | 'translate'
  | 'detect-language'
  | 'proofread'
  | 'explain'
  | 'timeline-align';

export interface LyricsAiResponse {
  action: LyricsAiAction;
  providerId?: string;
  providerName: string;
  modelUsed: string;
  style?: LyricTranslationStyle;
  isTimedLrc: boolean;
  hasWordTags?: boolean;
  bilingualLyrics?: string;
  originalLyricsRaw?: string;
  translatedLyricsRaw?: string;
  lyricPairs?: LyricPairRecord[];
  translatedCount?: number;
  correctedLyrics?: string;
  changes?: string[];
  summary?: string;
  result?: Record<string, unknown>;
}

export async function runLyricsAiTask(params: {
  providerId?: string;
  model?: string;
  action: LyricsAiAction;
  rawLyrics: string;
  trackTitle: string;
  artistName: string;
  targetLanguage?: 'zh-CN' | 'zh-TW' | 'en' | 'ja';
  style?: LyricTranslationStyle;
  customStylePrompt?: string;
  force?: boolean;
  durationSec?: number;
  signal?: AbortSignal;
}): Promise<LyricsAiResponse> {
  const [snap, headers] = await Promise.all([
    getVaultSnapshotForRequest(),
    getVaultHeaders(),
  ]);

  const res = await fetch('/api/ai/tasks/lyrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      providerId: params.providerId,
      model: params.model,
      action: params.action,
      rawLyrics: params.rawLyrics,
      trackTitle: params.trackTitle,
      artistName: params.artistName,
      targetLanguage: params.targetLanguage || 'zh-CN',
      style: params.style || 'poetic',
      customStylePrompt: params.customStylePrompt || '',
      force: Boolean(params.force),
      durationSec: params.durationSec,
      providerSnapshot: snap,
    }),
    signal: params.signal,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || `AI 歌词任务失败 (${res.status})`);
  }
  return json as LyricsAiResponse;
}
