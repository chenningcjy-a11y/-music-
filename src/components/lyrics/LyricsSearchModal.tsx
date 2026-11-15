import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Cpu,
  KeyRound,
  Languages,
  Loader2,
  Search,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { useAi } from '../../context/AiContext';
import { useMusic } from '../../context/MusicContext';
import { useTaskCenter } from '../../context/TaskCenterContext';
import {
  LYRIC_TRANSLATION_STYLES,
  LyricTranslationStyle,
} from '../../services/ai/aiTranslationService';
import { testProviderApi } from '../../services/ai/providerManager';
import { TrackColorPalette, TrackMetadata } from '../../types/music';
import { formatTime } from '../../utils/constants';
import {
  extractOriginalLyricsOnly,
  LyricTargetLanguage,
  OnlineLyricResult,
  parseLrc,
  searchOnlineLyrics,
} from '../../utils/lrcParser';

interface LyricsSearchModalProps {
  open: boolean;
  track: TrackMetadata | null;
  palette: TrackColorPalette;
  onClose: () => void;
  onApplyLyrics: (rawLrc: string) => void | Promise<void>;
}

export const LyricsSearchModal: React.FC<LyricsSearchModalProps> = ({
  open,
  track,
  palette,
  onClose,
  onApplyLyrics,
}) => {
  const { personalization, updatePersonalization, showToast } = useMusic();
  const {
    providers,
    selectedProviderId,
    setSelectedProviderId,
    selectedModel,
    setSelectedModel,
    activeProvider,
    hasConfiguredProvider,
    defaultTranslationProviderId,
    defaultTranslationModel,
    defaultTranslationStyle,
    setDefaultTranslationConfig,
    openAiCenter,
    refreshProviders,
  } = useAi();
  const { enqueueLyricsTranslationTask } = useTaskCenter();

  const [titleQuery, setTitleQuery] = useState('');
  const [artistQuery, setArtistQuery] = useState('');
  const [includeTranslation, setIncludeTranslation] = useState(true);
  const [targetLanguage, setTargetLanguage] = useState<LyricTargetLanguage>('zh-CN');

  const [enableModelTranslation, setEnableModelTranslation] = useState(true);
  const [translationStyle, setTranslationStyle] = useState<LyricTranslationStyle>(
    defaultTranslationStyle || 'poetic'
  );
  const [customStylePrompt, setCustomStylePrompt] = useState(
    personalization.customTranslationStylePrompt || ''
  );

  const [loading, setLoading] = useState(false);
  const [translatingId, setTranslatingId] = useState<number | null>(null);
  const [failedTranslationId, setFailedTranslationId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<OnlineLyricResult[]>([]);

  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (open && track) {
      setTitleQuery(track.title.replace(/\(.*\)|\[.*\]/g, '').trim());
      setArtistQuery(
        track.artist === '未知艺术家' || track.artist === 'Lumina Acoustic Ensemble'
          ? ''
          : track.artist
      );
      setResults([]);
      setError(null);
      setTranslatingId(null);
      setFailedTranslationId(null);
      setTestResult(null);
      setTranslationStyle(defaultTranslationStyle || 'poetic');
      setCustomStylePrompt(personalization.customTranslationStylePrompt || '');
      if (defaultTranslationProviderId && !selectedProviderId) {
        setSelectedProviderId(defaultTranslationProviderId);
      }
      if (defaultTranslationModel && !selectedModel) {
        setSelectedModel(defaultTranslationModel);
      }
    }
  }, [
    open,
    track,
    defaultTranslationStyle,
    defaultTranslationProviderId,
    defaultTranslationModel,
    personalization.customTranslationStylePrompt,
    selectedProviderId,
    selectedModel,
    setSelectedProviderId,
    setSelectedModel,
  ]);

  const availableModels = useMemo(() => {
    if (!activeProvider) return [];
    const list = [activeProvider.model, ...(activeProvider.availableModels || [])];
    return Array.from(new Set(list.filter(Boolean)));
  }, [activeProvider]);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!titleQuery.trim() && !artistQuery.trim()) return;
    setLoading(true);
    setError(null);
    setFailedTranslationId(null);
    try {
      const list = await searchOnlineLyrics(titleQuery, artistQuery);
      setResults(list);
      if (list.length === 0) {
        setError('未检索到匹配的在线歌词，请尝试简化歌名或手动导入 .lrc 文件。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '在线检索失败，请检查网络连接');
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async () => {
    if (!selectedProviderId) return;
    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await testProviderApi(selectedProviderId);
      await refreshProviders();
      if (res.ok) {
        setTestResult({ ok: true, msg: `连接正常 (${res.latencyMs}ms)` });
        showToast(`AI 服务「${activeProvider?.name || '当前服务'}」连接正常 (${res.latencyMs}ms)`);
      } else {
        setTestResult({ ok: false, msg: res.error || '连接失败' });
        showToast(`连接失败: ${res.error || '请检查密钥或网络'}`);
      }
    } catch (err) {
      setTestResult({
        ok: false,
        msg: err instanceof Error ? err.message : '连接测试异常',
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleApplyResult = async (
    item: OnlineLyricResult,
    raw: string,
    action: 'auto' | 'force_original' | 'force_model' = 'auto'
  ) => {
    const parsedCheck = parseLrc(raw);
    const hasNative = Boolean(item.hasNativeTranslation || parsedCheck.hasTranslations);
    const cleanOriginal = hasNative ? extractOriginalLyricsOnly(raw) || raw : raw;

    // 1. Force pure original lyrics
    if (action === 'force_original') {
      await onApplyLyrics(cleanOriginal);
      showToast('已保存纯粹原始歌词');
      onClose();
      return;
    }

    // 2. Native bilingual lyrics when not requesting AI re-translation
    if (hasNative && action !== 'force_model') {
      updatePersonalization({ showBilingualLyrics: true });
      await onApplyLyrics(raw);
      showToast('已匹配并应用自带双语同步歌词');
      onClose();
      return;
    }

    // 3. Model translation disabled -> apply original lyrics
    if (!enableModelTranslation && action !== 'force_model') {
      await onApplyLyrics(cleanOriginal);
      showToast('已保存原始歌词（未开启模型翻译）');
      onClose();
      return;
    }

    // 4. Validate real configured AI provider strictly (never fake translations)
    if (!activeProvider) {
      setError('尚未选择 AI 服务商，请先在「API 服务管理」中添加并启用 AI 服务。');
      setFailedTranslationId(item.id);
      return;
    }
    if (!activeProvider.enabled) {
      setError(`AI 服务商「${activeProvider.name}」当前已停用，请先启用或切换其他服务商。`);
      setFailedTranslationId(item.id);
      return;
    }
    if (!activeProvider.hasKey) {
      setError(`AI 服务商「${activeProvider.name}」尚未填写 API Key，请先配置密钥。`);
      setFailedTranslationId(item.id);
      return;
    }
    const modelToUse = selectedModel || activeProvider.model;
    if (!modelToUse) {
      setError(`AI 服务商「${activeProvider.name}」未指定模型名称。`);
      setFailedTranslationId(item.id);
      return;
    }

    const styleLabel =
      LYRIC_TRANSLATION_STYLES.find((s) => s.id === translationStyle)?.label ||
      '诗意翻译';

    setTranslatingId(item.id);
    setError(null);
    setFailedTranslationId(null);

    try {
      // First persist pure original lyrics separately so original lyrics are never lost
      await onApplyLyrics(cleanOriginal);
      updatePersonalization({ showBilingualLyrics: true });

      if (track) {
        await enqueueLyricsTranslationTask({
          track: { ...track, lyricsRaw: cleanOriginal, originalLyricsRaw: cleanOriginal },
          rawLyricsOverride: cleanOriginal,
          targetLanguage,
          style: translationStyle,
          customStylePrompt:
            translationStyle === 'custom' ? customStylePrompt.trim() : undefined,
          providerId: activeProvider.id,
          providerName: activeProvider.name,
          modelName: modelToUse,
          force: true,
        });
        showToast(
          `已保存原歌词，正使用 ${activeProvider.name} (${styleLabel}) 在独立任务后台翻译`
        );
      }
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '启动 AI 翻译任务失败';
      setError(`${msg}（可点击“仅应用原版”先使用原版歌词）`);
      setFailedTranslationId(item.id);
    } finally {
      setTranslatingId(null);
    }
  };

  if (!open || !track) return null;

  const isDefaultSelected = Boolean(
    activeProvider &&
      defaultTranslationProviderId === activeProvider.id &&
      (selectedModel || activeProvider.model) === defaultTranslationModel &&
      translationStyle === defaultTranslationStyle
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
      />
      <div className="relative z-10 w-full max-w-2xl max-h-[90vh] bg-[#1b0711]/95 backdrop-blur-2xl border border-white/14 rounded-3xl flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <h3 className="text-base font-semibold text-white truncate">
              智能在线歌词匹配与 AI 翻译
            </h3>
            <span className="hidden sm:inline-block px-2 py-0.5 rounded-full text-[10px] bg-rose-500/15 border border-rose-400/25 text-rose-200">
              原文与译文独立保存
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-white/65 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search & AI Controls Form */}
        <form onSubmit={handleSearch} className="p-4 sm:p-5 border-b border-white/10 space-y-3.5 shrink-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-white/60 mb-1">歌曲名称</label>
              <input
                type="text"
                value={titleQuery}
                onChange={(e) => setTitleQuery(e.target.value)}
                placeholder="输入歌名..."
                className="w-full px-3.5 py-2 rounded-xl bg-white/8 border border-white/12 text-sm text-white placeholder-white/35 focus:outline-none focus:border-white/35"
              />
            </div>
            <div>
              <label className="block text-xs text-white/60 mb-1">艺术家 (可选)</label>
              <input
                type="text"
                value={artistQuery}
                onChange={(e) => setArtistQuery(e.target.value)}
                placeholder="输入歌手..."
                className="w-full px-3.5 py-2 rounded-xl bg-white/8 border border-white/12 text-sm text-white placeholder-white/35 focus:outline-none focus:border-white/35"
              />
            </div>
          </div>

          {/* Translation Options Toolbar */}
          <div className="pt-1.5 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-white/85 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeTranslation}
                  onChange={(e) => {
                    setIncludeTranslation(e.target.checked);
                    if (!e.target.checked) setEnableModelTranslation(false);
                  }}
                  className="accent-rose-500 w-4 h-4 rounded"
                />
                <Sparkles className="w-3.5 h-3.5 text-rose-300 shrink-0" />
                <span className="font-medium">附带翻译</span>
              </label>

              {includeTranslation && (
                <select
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value as LyricTargetLanguage)}
                  aria-label="翻译目标语言"
                  className="px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs text-white/90 focus:outline-none cursor-pointer"
                >
                  <option value="zh-CN" className="bg-[#1b0711]">简体中文</option>
                  <option value="zh-TW" className="bg-[#1b0711]">繁體中文</option>
                  <option value="en" className="bg-[#1b0711]">English</option>
                  <option value="ja" className="bg-[#1b0711]">日本語</option>
                </select>
              )}

              <div className="h-4 w-px bg-white/20 hidden sm:block" />

              <label
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs cursor-pointer select-none transition-all ${
                  enableModelTranslation
                    ? 'bg-rose-500/20 border-rose-400/40 text-rose-100 shadow-sm'
                    : 'bg-white/6 border-white/12 text-white/55 hover:text-white/80'
                }`}
                title="使用已配置的 AI 模型逐句翻译没有双语的歌词"
              >
                <input
                  type="checkbox"
                  checked={enableModelTranslation}
                  onChange={(e) => {
                    setEnableModelTranslation(e.target.checked);
                    if (e.target.checked) setIncludeTranslation(true);
                  }}
                  className="accent-rose-500 w-3.5 h-3.5 rounded"
                />
                <Cpu className="w-3.5 h-3.5 text-rose-300 shrink-0" />
                <span className="font-medium whitespace-nowrap">模型翻译</span>
              </label>

              {enableModelTranslation && (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={selectedProviderId}
                    onChange={(e) => setSelectedProviderId(e.target.value)}
                    aria-label="选择 AI 翻译服务商"
                    className="px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs text-white/90 focus:outline-none max-w-[140px] truncate cursor-pointer"
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id} className="bg-[#1b0711]">
                        {p.name}
                        {!p.hasKey ? ' (未配密钥)' : ''}
                      </option>
                    ))}
                  </select>

                  {availableModels.length > 0 && (
                    <select
                      value={selectedModel || availableModels[0]}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      aria-label="选择具体模型"
                      className="px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs text-white/90 focus:outline-none max-w-[150px] truncate font-mono-tabular cursor-pointer"
                    >
                      {availableModels.map((m) => (
                        <option key={m} value={m} className="bg-[#1b0711]">
                          {m}
                        </option>
                      ))}
                    </select>
                  )}

                  <select
                    value={translationStyle}
                    onChange={(e) =>
                      setTranslationStyle(e.target.value as LyricTranslationStyle)
                    }
                    aria-label="翻译风格"
                    className="px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs text-white/90 focus:outline-none cursor-pointer"
                  >
                    {LYRIC_TRANSLATION_STYLES.map((style) => (
                      <option
                        key={style.id}
                        value={style.id}
                        className="bg-[#1b0711]"
                      >
                        {style.label}
                        {style.id === 'poetic' ? ' (推荐)' : ''}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testingConnection || !selectedProviderId}
                    className="px-2 py-1.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/12 text-[11px] text-white/80 flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
                    title="测试与当前所选 AI 服务的连通性"
                  >
                    {testingConnection ? (
                      <Loader2 className="w-3 h-3 animate-spin text-rose-300" />
                    ) : (
                      <Zap className="w-3 h-3 text-rose-300" />
                    )}
                    <span>测试</span>
                  </button>

                  {activeProvider && (
                    <button
                      type="button"
                      disabled={isDefaultSelected}
                      onClick={() =>
                        setDefaultTranslationConfig({
                          providerId: activeProvider.id,
                          model: selectedModel || activeProvider.model,
                          style: translationStyle,
                          customStylePrompt,
                        })
                      }
                      className="px-2 py-1.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/12 text-[11px] text-white/80 cursor-pointer disabled:opacity-45"
                    >
                      {isDefaultSelected ? '默认模型' : '设为默认'}
                    </button>
                  )}
                </div>
              )}
            </div>

            {enableModelTranslation && translationStyle === 'custom' && (
              <input
                type="text"
                value={customStylePrompt}
                onChange={(e) => setCustomStylePrompt(e.target.value)}
                placeholder="输入自定义翻译风格要求（例如：简洁现代诗意、保留第二人称呼语）"
                className="w-full px-3 py-2 rounded-xl bg-black/35 border border-white/15 text-xs text-white placeholder-white/35 focus:outline-none focus:border-white/35"
              />
            )}

            {/* API Status & Guidance Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/55 border-t border-white/6 pt-2">
              <div className="flex items-center gap-2 min-w-0">
                {!hasConfiguredProvider || !activeProvider?.hasKey ? (
                  <span className="text-amber-300 flex items-center gap-1">
                    <KeyRound className="w-3 h-3 shrink-0" />
                    <span>
                      {activeProvider
                        ? `「${activeProvider.name}」尚未配置 API Key`
                        : '尚未配置可用 AI API Key'}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        openAiCenter('providers');
                      }}
                      className="underline text-amber-200 hover:text-white ml-1 cursor-pointer"
                    >
                      去配置 →
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    {activeProvider.connectionStatus === 'connected' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
                    ) : activeProvider.connectionStatus === 'error' ? (
                      <AlertCircle className="w-3.5 h-3.5 text-rose-300 shrink-0" />
                    ) : (
                      <span className="text-rose-300/80">✦</span>
                    )}
                    <span>
                      当前：{activeProvider.name} · {selectedModel || activeProvider.model}（
                      {LYRIC_TRANSLATION_STYLES.find((s) => s.id === translationStyle)?.label}
                      ）
                    </span>
                  </span>
                )}
              </div>

              {testResult && (
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-lg border ${
                    testResult.ok
                      ? 'bg-emerald-500/15 border-emerald-400/25 text-emerald-300'
                      : 'bg-rose-500/15 border-rose-400/25 text-rose-300'
                  }`}
                >
                  {testResult.msg}
                </span>
              )}
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={loading || translatingId !== null}
              className="px-5 py-2 rounded-xl text-xs font-medium text-white flex items-center justify-center gap-2 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer shrink-0 shadow-lg"
              style={{
                background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
              }}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              搜索 LRC 歌词
            </button>
          </div>
        </form>

        {/* Search Results List */}
        <div className="flex-1 overflow-y-auto lumina-scroll p-4 space-y-2.5 min-h-[180px]">
          {error && (
            <div className="text-xs text-rose-300/90 text-center py-3 px-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex flex-col items-center gap-2">
              <p>{error}</p>
              {(!hasConfiguredProvider || !activeProvider?.hasKey) && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    openAiCenter('providers');
                  }}
                  className="px-3 py-1 rounded-lg bg-rose-500/25 hover:bg-rose-500/35 text-white cursor-pointer"
                >
                  前往「API 服务管理」配置密钥 →
                </button>
              )}
            </div>
          )}

          {results.length === 0 && !loading && !error && (
            <div className="py-12 text-center text-xs text-white/45 space-y-1">
              <p>输入歌名或歌手并点击“搜索 LRC 歌词”</p>
              <p className="text-[11px] text-white/35">
                支持聚合网易云原生双语歌词与 LRCLIB 纯净歌词，原文与译文独立归档
              </p>
            </div>
          )}

          {results.map((item) => {
            const raw = item.syncedLyrics || item.plainLyrics;
            if (!raw) return null;
            const isSynced = Boolean(item.syncedLyrics);
            const isTranslating = translatingId === item.id;
            const showOriginalFallback = failedTranslationId === item.id;
            const hasNativeTrans = Boolean(item.hasNativeTranslation);
            const providerLabel = activeProvider?.name || 'AI 模型';

            return (
              <div
                key={item.id}
                className="p-3.5 rounded-2xl bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-white truncate">
                      {item.trackName}
                    </p>
                    {hasNativeTrans ? (
                      <span className="px-2 py-0.5 rounded-md text-[10px] bg-rose-500/20 text-rose-300 border border-rose-400/30 font-medium shrink-0">
                        自带双语
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-white/10 text-white/60 border border-white/10 shrink-0">
                        无双语
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-white/60 truncate mt-1">
                    {item.artistName}
                    {item.albumName ? ` · ${item.albumName}` : ''}
                    {item.duration ? ` · ${formatTime(item.duration)}` : ''}
                    {item.source ? ` · ${item.source}` : ''}
                    {' · '}
                    <span className={isSynced ? 'text-emerald-300 font-mono-tabular' : 'text-white/50'}>
                      {isSynced ? '带时间戳 LRC' : '纯文本'}
                    </span>
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {showOriginalFallback && (
                    <button
                      type="button"
                      onClick={() => void handleApplyResult(item, raw, 'force_original')}
                      className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/18 text-xs font-medium text-white/85 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      仅应用原版
                    </button>
                  )}

                  {hasNativeTrans ? (
                    <>
                      <button
                        type="button"
                        disabled={translatingId !== null}
                        onClick={() => void handleApplyResult(item, raw, 'auto')}
                        className="px-3.5 py-2 rounded-xl text-xs font-medium text-white flex items-center gap-1.5 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap shadow-sm"
                        style={{
                          background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                        }}
                      >
                        <Languages className="w-3.5 h-3.5 text-white" />
                        <span>应用自带双语</span>
                      </button>

                      {enableModelTranslation && (
                        <button
                          type="button"
                          disabled={translatingId !== null}
                          onClick={() => void handleApplyResult(item, raw, 'force_model')}
                          className="px-2.5 py-2 rounded-xl bg-white/8 hover:bg-white/14 border border-white/10 text-xs text-rose-200/90 flex items-center gap-1 transition-colors cursor-pointer whitespace-nowrap"
                          title="保留原词，使用当前 AI 模型重新翻译"
                        >
                          <Sparkles className="w-3 h-3 text-rose-300" />
                          <span>重译</span>
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {enableModelTranslation ? (
                        <>
                          <button
                            type="button"
                            disabled={translatingId !== null}
                            onClick={() => void handleApplyResult(item, raw, 'force_model')}
                            className="px-3.5 py-2 rounded-xl text-xs font-medium text-white flex items-center gap-1.5 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap shadow-md"
                            style={{
                              background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                            }}
                          >
                            {isTranslating ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>提交中...</span>
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                                <span>模型翻译 ({providerLabel})</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            disabled={translatingId !== null}
                            onClick={() => void handleApplyResult(item, raw, 'force_original')}
                            className="px-3 py-2 rounded-xl bg-white/8 hover:bg-white/14 border border-white/10 text-xs text-white/75 transition-colors cursor-pointer whitespace-nowrap"
                            title="跳过 AI 翻译，直接应用原始单语歌词"
                          >
                            仅原版
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={translatingId !== null}
                            onClick={() => void handleApplyResult(item, raw, 'force_original')}
                            className="px-3.5 py-2 rounded-xl bg-white/12 hover:bg-white/20 text-xs font-medium text-white flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>应用原版</span>
                          </button>

                          <button
                            type="button"
                            disabled={translatingId !== null}
                            onClick={() => void handleApplyResult(item, raw, 'force_model')}
                            className="px-3 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/30 text-xs font-medium text-rose-200 flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
                            title="使用当前 AI 模型翻译为双语歌词"
                          >
                            <Sparkles className="w-3.5 h-3.5 text-rose-300" />
                            <span>模型翻译</span>
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
