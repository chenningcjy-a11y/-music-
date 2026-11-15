import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  FileUp,
  KeyRound,
  Languages,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  PencilLine,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { LyricsEditorModal } from '../components/lyrics/LyricsEditorModal';
import { LyricsSearchModal } from '../components/lyrics/LyricsSearchModal';
import { LyricsView } from '../components/lyrics/LyricsView';
import { useAi } from '../context/AiContext';
import { useMusic } from '../context/MusicContext';
import { useTaskCenter } from '../context/TaskCenterContext';
import { LYRIC_TRANSLATION_STYLES } from '../services/ai/aiTranslationService';
import { LyricTranslationStyle } from '../types/music';
import { formatTime } from '../utils/constants';
import {
  getSavedTrackLyricsForPlayback,
  LyricTargetLanguage,
} from '../utils/lrcParser';

export const LyricsPage: React.FC = () => {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    activePalette,
    personalization,
    isFullscreen,
    toggleFullscreen,
    togglePlayPause,
    seekTo,
    updateTrackLyrics,
    saveSeparatedTrackLyrics,
    restoreOriginalLyrics,
    restoreOriginalAiTranslation,
    isTranslatingLyrics,
    updateLyricsOffset,
    updatePersonalization,
    showToast,
  } = useMusic();

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
  } = useAi();

  const { tasks, enqueueLyricsTranslationTask } = useTaskCenter();

  const [searchOpen, setSearchOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'bilingual' | 'original' | 'translation'>(
    'bilingual'
  );
  const [translationStyle, setTranslationStyle] = useState<LyricTranslationStyle>(
    defaultTranslationStyle || 'poetic'
  );
  const [customStylePrompt, setCustomStylePrompt] = useState<string>(
    personalization.customTranslationStylePrompt || ''
  );
  const [targetLanguage, setTargetLanguage] = useState<LyricTargetLanguage>('zh-CN');
  const [translationError, setTranslationError] = useState<string | null>(null);
  const lrcInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (personalization.defaultTranslationStyle) {
      setTranslationStyle(personalization.defaultTranslationStyle);
    }
  }, [personalization.defaultTranslationStyle]);

  useEffect(() => {
    if (personalization.customTranslationStylePrompt !== undefined) {
      setCustomStylePrompt(personalization.customTranslationStylePrompt);
    }
  }, [personalization.customTranslationStylePrompt]);

  const availableModels = useMemo(() => {
    if (!activeProvider) return [];
    return Array.from(
      new Set([activeProvider.model, ...(activeProvider.availableModels || [])].filter(Boolean))
    );
  }, [activeProvider]);

  const activeTranslationTask = useMemo(() => {
    if (!currentTrack) return undefined;
    return tasks.find(
      (t) =>
        t.category === 'lyrics_assistant' &&
        t.sourceTrackId === currentTrack.id &&
        (t.status === 'running' || t.status === 'queued')
    );
  }, [currentTrack, tasks]);

  const displayedLyricsRaw = useMemo(
    () => getSavedTrackLyricsForPlayback(currentTrack, viewMode),
    [currentTrack, viewMode]
  );

  const handleImportLrc = async (file: File) => {
    if (!currentTrack) return;
    try {
      const text = await file.text();
      await updateTrackLyrics(currentTrack.id, text);
    } catch {
      showToast('读取 .lrc 歌词文件失败');
    }
  };

  const handleStartAiTranslation = async () => {
    if (!currentTrack) return;
    setTranslationError(null);

    const sourceLyrics = (
      currentTrack.originalLyricsRaw ||
      currentTrack.lyricsRaw ||
      ''
    ).trim();
    if (!sourceLyrics) {
      const msg = '当前曲目暂无原始歌词，请先点击「在线搜索匹配」或导入 .lrc 文件';
      setTranslationError(msg);
      showToast(msg);
      return;
    }

    if (!activeProvider) {
      const msg = '尚未选择任何 AI 服务商，请先前往「AI 服务管理」配置 API';
      setTranslationError(msg);
      showToast(msg);
      return;
    }

    if (!activeProvider.enabled) {
      const msg = `AI 服务「${activeProvider.name}」已停用，请先启用或切换其他服务商`;
      setTranslationError(msg);
      showToast(msg);
      return;
    }

    if (!activeProvider.hasKey) {
      const msg = `AI 服务「${activeProvider.name}」尚未配置 API Key，请先配置密钥后再翻译`;
      setTranslationError(msg);
      showToast(msg);
      return;
    }

    const modelToUse = selectedModel || activeProvider.model;
    if (!modelToUse) {
      const msg = `AI 服务「${activeProvider.name}」尚未指定模型名称`;
      setTranslationError(msg);
      showToast(msg);
      return;
    }

    try {
      await enqueueLyricsTranslationTask({
        track: currentTrack,
        targetLanguage,
        style: translationStyle,
        customStylePrompt:
          translationStyle === 'custom' ? customStylePrompt.trim() : undefined,
        providerId: activeProvider.id,
        providerName: activeProvider.name,
        modelName: modelToUse,
        force: true,
      });
    } catch (err) {
      setTranslationError(err instanceof Error ? err.message : '启动歌词翻译任务失败');
    }
  };

  const offsetMs = currentTrack?.lyricsOffsetMs || 0;
  const effectiveDuration = duration > 0 ? duration : currentTrack?.duration || 0;
  const hasTranslationSaved = Boolean(
    currentTrack?.translatedLyricsRaw?.trim() ||
      currentTrack?.lyricPairs?.some((p) => p.translatedText.trim())
  );
  const hasInitialAiBackup = Boolean(
    currentTrack?.translationMeta?.initialAiTranslatedRaw ||
      currentTrack?.translationMeta?.initialAiBilingualRaw
  );
  const isDefaultModelSelected = Boolean(
    activeProvider &&
      defaultTranslationProviderId === activeProvider.id &&
      (selectedModel || activeProvider.model) === defaultTranslationModel &&
      translationStyle === defaultTranslationStyle
  );

  return (
    <div className="h-full flex flex-col px-4 sm:px-6 lg:px-10 pt-5 pb-20 lg:pb-5 gap-5 overflow-y-auto lg:overflow-hidden lumina-scroll">
      <input
        ref={lrcInputRef}
        type="file"
        accept=".lrc,.txt"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImportLrc(f);
          e.target.value = '';
        }}
      />

      {/* Top Track Context + Lyrics Studio Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 shrink-0 rounded-3xl bg-white/[0.045] backdrop-blur-xl border border-white/10 p-4 sm:p-5">
        <div className="flex items-center gap-4 min-w-0">
          <div className="relative w-14 h-14 rounded-2xl overflow-hidden bg-white/10 shrink-0">
            {currentTrack?.coverDataUrl && (
              <img
                src={currentTrack.coverDataUrl}
                alt={currentTrack.title}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            )}
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-lg sm:text-xl font-semibold text-white truncate">
              {currentTrack ? currentTrack.title : '歌词中心'}
            </h1>
            <p className="text-xs sm:text-sm text-white/60 truncate mt-0.5">
              {currentTrack
                ? `${currentTrack.artist} · ${formatTime(currentTime)} / ${formatTime(
                    effectiveDuration
                  )}`
                : '请先选择并播放一首歌曲'}
            </p>
          </div>
        </div>

        {currentTrack && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={togglePlayPause}
              className="px-4 py-2 rounded-xl text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer"
              style={{
                background: `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.secondary})`,
              }}
            >
              {isPlaying ? (
                <Pause className="w-3.5 h-3.5" fill="currentColor" />
              ) : (
                <Play className="w-3.5 h-3.5" fill="currentColor" />
              )}
              {isPlaying ? '暂停' : '播放'}
            </button>

            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/12 text-xs text-white flex items-center gap-1.5 cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              在线搜索匹配
            </button>

            <button
              type="button"
              onClick={() => lrcInputRef.current?.click()}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/12 text-xs text-white flex items-center gap-1.5 cursor-pointer"
            >
              <FileUp className="w-3.5 h-3.5" />
              导入 .lrc
            </button>

            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/12 text-xs text-white flex items-center gap-1.5 cursor-pointer"
            >
              <PencilLine className="w-3.5 h-3.5" />
              编辑原文/译文
            </button>

            <button
              type="button"
              onClick={toggleFullscreen}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/12 text-xs text-white flex items-center gap-1.5 cursor-pointer"
            >
              {isFullscreen ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
              {isFullscreen ? '退出全屏' : '全屏展示'}
            </button>
          </div>
        )}
      </div>

      {/* Main Lyrics Canvas + Sync Calibration & AI Translation Controls */}
      <div className="lg:flex-1 lg:min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-8 min-h-[340px] lg:min-h-0 rounded-3xl bg-white/[0.04] backdrop-blur-2xl border border-white/10 p-5 sm:p-7 flex flex-col gap-3">
          {/* View Mode & Translation Metadata Strip */}
          {currentTrack && (
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-white/8 shrink-0">
              <div className="flex items-center gap-1 bg-white/[0.06] border border-white/10 p-0.5 rounded-xl">
                {(
                  [
                    { id: 'bilingual', label: '双语对照' },
                    { id: 'original', label: '仅看原文' },
                    { id: 'translation', label: '仅看译文' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setViewMode(tab.id)}
                    className={`px-3 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      viewMode === tab.id
                        ? 'bg-white/16 text-white'
                        : 'text-white/60 hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/60">
                {currentTrack.translationMeta?.modelName ? (
                  <span>
                    已保存译文：{currentTrack.translationMeta.providerName || 'AI'} ·{' '}
                    <span className="font-mono-tabular text-white/80">
                      {currentTrack.translationMeta.modelName}
                    </span>
                    {currentTrack.translationMeta.style && (
                      <span>
                        {' '}
                        (
                        {LYRIC_TRANSLATION_STYLES.find(
                          (s) => s.id === currentTrack.translationMeta?.style
                        )?.label || currentTrack.translationMeta.style}
                        )
                      </span>
                    )}
                  </span>
                ) : (
                  <span>播放时直接读取本地保存的原文与译文，不重复消耗 API</span>
                )}
              </div>
            </div>
          )}

          {/* Active Independent Translation Task Banner */}
          {activeTranslationTask && (
            <div className="rounded-2xl bg-rose-500/12 border border-rose-400/25 px-4 py-2.5 flex items-center justify-between gap-3 text-xs shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Loader2 className="w-4 h-4 animate-spin text-rose-300 shrink-0" />
                <span className="text-white truncate">
                  {activeTranslationTask.stageLabel || '正在执行 AI 歌词翻译任务…'}
                </span>
              </div>
              <span className="font-mono-tabular text-rose-200 shrink-0">
                {activeTranslationTask.progress}%
              </span>
            </div>
          )}

          <div className="flex-1 min-h-0">
            <LyricsView
              lyricsRaw={displayedLyricsRaw}
              currentTime={currentTime}
              offsetMs={offsetMs}
              palette={activePalette}
              showBilingual={
                viewMode === 'bilingual' ? personalization.showBilingualLyrics : false
              }
              showWordSync={personalization.showWordSync}
              displayMode={viewMode}
              onSeek={seekTo}
              onAdjustOffset={
                currentTrack
                  ? (ms) => updateLyricsOffset(currentTrack.id, ms)
                  : undefined
              }
              onImportLrcFile={currentTrack ? handleImportLrc : undefined}
              onOpenSearchOnline={currentTrack ? () => setSearchOpen(true) : undefined}
              onOpenEditor={currentTrack ? () => setEditorOpen(true) : undefined}
              onTranslateLyrics={
                currentTrack ? () => void handleStartAiTranslation() : undefined
              }
              isTranslating={Boolean(activeTranslationTask) || isTranslatingLyrics}
            />
          </div>
        </div>

        {/* Right AI Translation + Calibration & Display Controls */}
        <aside className="lg:col-span-4 rounded-3xl bg-white/[0.045] backdrop-blur-xl border border-white/10 p-5 space-y-5 lg:min-h-0 lg:overflow-y-auto lumina-scroll">
          {/* AI Lyrics Translation Workbench */}
          <div className="space-y-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-rose-300" />
                <h2 className="text-sm font-semibold text-white">AI 歌词翻译模型与风格</h2>
              </div>
              <button
                type="button"
                onClick={() => openAiCenter('providers')}
                className="text-[11px] text-rose-300 hover:text-rose-200 underline cursor-pointer"
              >
                API 管理
              </button>
            </div>

            {!hasConfiguredProvider && (
              <div className="rounded-2xl bg-amber-500/12 border border-amber-400/30 p-3 text-xs text-amber-100 space-y-2">
                <div className="flex items-start gap-2">
                  <KeyRound className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    尚未配置可用 AI API Key。请先配置 DeepSeek、Gemini、OpenAI 或自定义兼容接口后使用 AI 歌词翻译。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openAiCenter('providers')}
                  className="px-3 py-1.5 rounded-xl bg-amber-500/25 hover:bg-amber-500/35 text-white font-medium cursor-pointer"
                >
                  前往「API 服务管理」配置 →
                </button>
              </div>
            )}

            {/* Provider Selector */}
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-white/65">AI 服务商</span>
                {activeProvider && (
                  <span
                    className={`flex items-center gap-1 text-[11px] ${
                      !activeProvider.hasKey
                        ? 'text-amber-300'
                        : activeProvider.connectionStatus === 'connected'
                        ? 'text-emerald-300'
                        : activeProvider.connectionStatus === 'error'
                        ? 'text-rose-300'
                        : 'text-white/55'
                    }`}
                  >
                    {!activeProvider.hasKey ? (
                      '未配密钥'
                    ) : activeProvider.connectionStatus === 'connected' ? (
                      <>
                        <CheckCircle2 className="w-3 h-3" />
                        已连接
                      </>
                    ) : activeProvider.connectionStatus === 'error' ? (
                      <>
                        <AlertCircle className="w-3 h-3" />
                        连接异常
                      </>
                    ) : (
                      '密钥已配置'
                    )}
                  </span>
                )}
              </div>
              <select
                value={selectedProviderId}
                onChange={(e) => {
                  setSelectedProviderId(e.target.value);
                  setTranslationError(null);
                }}
                aria-label="选择歌词翻译服务商"
                className="w-full px-3 py-2 rounded-xl bg-black/35 border border-white/15 text-xs text-white outline-none cursor-pointer"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id} className="bg-[#180713]">
                    {p.name}
                    {!p.enabled ? ' (已停用)' : !p.hasKey ? ' (未配密钥)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Model Selector */}
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-white/65">翻译模型</span>
                <button
                  type="button"
                  disabled={!activeProvider || isDefaultModelSelected}
                  onClick={() =>
                    activeProvider &&
                    setDefaultTranslationConfig({
                      providerId: activeProvider.id,
                      model: selectedModel || activeProvider.model,
                      style: translationStyle,
                      customStylePrompt,
                    })
                  }
                  className="text-[11px] text-white/75 hover:text-white underline cursor-pointer disabled:opacity-45 disabled:no-underline"
                >
                  {isDefaultModelSelected ? '已为默认翻译模型' : '设为默认翻译模型'}
                </button>
              </div>
              {availableModels.length > 0 ? (
                <select
                  value={selectedModel || availableModels[0]}
                  onChange={(e) => {
                    setSelectedModel(e.target.value);
                    setTranslationError(null);
                  }}
                  aria-label="选择具体翻译模型"
                  className="w-full px-3 py-2 rounded-xl bg-black/35 border border-white/15 text-xs text-white font-mono-tabular outline-none cursor-pointer"
                >
                  {availableModels.map((m) => (
                    <option key={m} value={m} className="bg-[#180713]">
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  placeholder="输入模型名称"
                  className="w-full px-3 py-2 rounded-xl bg-black/35 border border-white/15 text-xs text-white font-mono-tabular outline-none"
                />
              )}
            </div>

            {/* Style + Target Language */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="space-y-1">
                <span className="text-white/65 block">翻译风格</span>
                <select
                  value={translationStyle}
                  onChange={(e) => {
                    const nextStyle = e.target.value as LyricTranslationStyle;
                    setTranslationStyle(nextStyle);
                    updatePersonalization({ defaultTranslationStyle: nextStyle });
                  }}
                  aria-label="选择歌词翻译风格"
                  className="w-full px-2.5 py-2 rounded-xl bg-black/35 border border-white/15 text-xs text-white outline-none cursor-pointer"
                >
                  {LYRIC_TRANSLATION_STYLES.map((st) => (
                    <option key={st.id} value={st.id} className="bg-[#180713]">
                      {st.label}
                      {st.id === 'poetic' ? ' (推荐)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-white/65 block">目标语言</span>
                <select
                  value={targetLanguage}
                  onChange={(e) =>
                    setTargetLanguage(e.target.value as LyricTargetLanguage)
                  }
                  aria-label="选择目标语言"
                  className="w-full px-2.5 py-2 rounded-xl bg-black/35 border border-white/15 text-xs text-white outline-none cursor-pointer"
                >
                  <option value="zh-CN" className="bg-[#180713]">简体中文</option>
                  <option value="zh-TW" className="bg-[#180713]">繁體中文</option>
                  <option value="en" className="bg-[#180713]">English</option>
                  <option value="ja" className="bg-[#180713]">日本語</option>
                </select>
              </label>
            </div>

            {translationStyle === 'custom' && (
              <div className="space-y-1 text-xs">
                <span className="text-white/65 block">自定义翻译风格要求</span>
                <textarea
                  rows={2}
                  value={customStylePrompt}
                  onChange={(e) => {
                    setCustomStylePrompt(e.target.value);
                    updatePersonalization({
                      customTranslationStylePrompt: e.target.value,
                    });
                  }}
                  placeholder="例如：用婉约古典诗词意境逐句译写，保留第一人称口吻..."
                  className="w-full px-3 py-2 rounded-xl bg-black/35 border border-white/15 text-xs text-white placeholder-white/35 outline-none focus:border-white/35 resize-none"
                />
              </div>
            )}

            <p className="text-[11px] text-white/50 leading-relaxed">
              {LYRIC_TRANSLATION_STYLES.find((s) => s.id === translationStyle)?.description}
            </p>

            {translationError && (
              <div className="rounded-xl bg-rose-500/12 border border-rose-400/25 px-3 py-2 text-[11px] text-rose-200 leading-relaxed">
                {translationError}
              </div>
            )}

            <div className="space-y-2 pt-1">
              <button
                type="button"
                disabled={!currentTrack || Boolean(activeTranslationTask)}
                onClick={() => void handleStartAiTranslation()}
                className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 shadow-lg"
                style={{
                  background: `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.secondary})`,
                }}
              >
                {activeTranslationTask ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>翻译任务进行中 ({activeTranslationTask.progress}%)</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{hasTranslationSaved ? '使用所选模型重新翻译' : '使用所选模型 AI 翻译'}</span>
                  </>
                )}
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={!currentTrack || !hasTranslationSaved}
                  onClick={() => currentTrack && void restoreOriginalLyrics(currentTrack.id)}
                  className="py-2 px-2.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/10 text-[11px] text-white/80 flex items-center justify-center gap-1 cursor-pointer disabled:opacity-35"
                  title="清除当前译文，仅保留纯正原始歌词"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>仅保留原歌词</span>
                </button>

                <button
                  type="button"
                  disabled={!currentTrack || !hasInitialAiBackup}
                  onClick={() =>
                    currentTrack && void restoreOriginalAiTranslation(currentTrack.id)
                  }
                  className="py-2 px-2.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/10 text-[11px] text-white/80 flex items-center justify-center gap-1 cursor-pointer disabled:opacity-35"
                  title="撤销手动修改，恢复最初保存的 AI 翻译"
                >
                  <Undo2 className="w-3 h-3" />
                  <span>恢复原始翻译</span>
                </button>
              </div>
            </div>
          </div>

          {/* Timeline Offset Calibration */}
          <div className="pt-4 border-t border-white/10">
            <h2 className="text-sm font-semibold text-white">时间轴微调</h2>
            <p className="text-xs text-white/55 mt-1 leading-relaxed">
              手动校准歌词同步偏移（正值提前显示，负值延后显示）。
            </p>

            <div className="mt-3 p-3 rounded-2xl bg-black/30 border border-white/10 text-center">
              <span className="text-xs text-white/50">当前偏移</span>
              <p className="font-mono-tabular text-lg font-semibold text-white mt-0.5">
                {offsetMs > 0
                  ? `+${(offsetMs / 1000).toFixed(1)}s`
                  : `${(offsetMs / 1000).toFixed(1)}s`}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 mt-2.5">
              <button
                type="button"
                disabled={!currentTrack}
                onClick={() =>
                  currentTrack && updateLyricsOffset(currentTrack.id, offsetMs - 500)
                }
                className="py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-mono-tabular text-white cursor-pointer disabled:opacity-40"
              >
                延后 0.5s
              </button>
              <button
                type="button"
                disabled={!currentTrack}
                onClick={() =>
                  currentTrack && updateLyricsOffset(currentTrack.id, offsetMs + 500)
                }
                className="py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-mono-tabular text-white cursor-pointer disabled:opacity-40"
              >
                提前 0.5s
              </button>
              <button
                type="button"
                disabled={!currentTrack}
                onClick={() =>
                  currentTrack && updateLyricsOffset(currentTrack.id, offsetMs - 100)
                }
                className="py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-mono-tabular text-white cursor-pointer disabled:opacity-40"
              >
                延后 0.1s
              </button>
              <button
                type="button"
                disabled={!currentTrack}
                onClick={() =>
                  currentTrack && updateLyricsOffset(currentTrack.id, offsetMs + 100)
                }
                className="py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-mono-tabular text-white cursor-pointer disabled:opacity-40"
              >
                提前 0.1s
              </button>
            </div>

            <button
              type="button"
              disabled={!currentTrack || offsetMs === 0}
              onClick={() => currentTrack && updateLyricsOffset(currentTrack.id, 0)}
              className="w-full mt-2 py-2 rounded-xl bg-white/6 hover:bg-white/12 text-xs text-white/75 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              重置偏移归零
            </button>
          </div>

          <div className="pt-4 border-t border-white/10 space-y-3">
            <h2 className="text-sm font-semibold text-white">显示选项</h2>

            <label className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-white/[0.04] border border-white/8 cursor-pointer">
              <div className="flex items-center gap-2.5">
                <Languages className="w-4 h-4 text-white/70" />
                <span className="text-xs text-white/90">双语歌词显示</span>
              </div>
              <input
                type="checkbox"
                checked={personalization.showBilingualLyrics}
                onChange={(e) =>
                  updatePersonalization({ showBilingualLyrics: e.target.checked })
                }
                className="accent-rose-500 w-4 h-4"
              />
            </label>

            <label className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-white/[0.04] border border-white/8 cursor-pointer">
              <div className="flex items-center gap-2.5">
                <Sparkles className="w-4 h-4 text-white/70" />
                <div>
                  <span className="text-xs text-white/90 block">逐字同步高亮</span>
                  <span className="text-[10px] text-white/50 block">
                    仅在存在真实逐字时间戳时启用
                  </span>
                </div>
              </div>
              <input
                type="checkbox"
                checked={personalization.showWordSync}
                onChange={(e) =>
                  updatePersonalization({ showWordSync: e.target.checked })
                }
                className="accent-rose-500 w-4 h-4"
              />
            </label>
          </div>
        </aside>
      </div>

      <LyricsSearchModal
        open={searchOpen}
        track={currentTrack}
        palette={activePalette}
        onClose={() => setSearchOpen(false)}
        onApplyLyrics={async (raw) => {
          if (currentTrack) await updateTrackLyrics(currentTrack.id, raw);
        }}
      />

      <LyricsEditorModal
        open={editorOpen}
        track={currentTrack}
        currentTime={currentTime}
        palette={activePalette}
        onClose={() => setEditorOpen(false)}
        onSave={async (raw) => {
          if (currentTrack) await updateTrackLyrics(currentTrack.id, raw);
        }}
        onSavePairs={async (pairs) => {
          if (currentTrack) await saveSeparatedTrackLyrics(currentTrack.id, { pairs });
        }}
        onRestoreOriginal={async () => {
          if (currentTrack) await restoreOriginalLyrics(currentTrack.id);
        }}
        onRestoreInitialTranslation={async () => {
          if (currentTrack) await restoreOriginalAiTranslation(currentTrack.id);
        }}
      />
    </div>
  );
};
