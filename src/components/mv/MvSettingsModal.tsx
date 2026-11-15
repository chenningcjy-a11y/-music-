import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Film,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { audioEngine } from '../../audio/AudioEngine';
import { useMusic } from '../../context/MusicContext';
import {
  buildOnlineMvConfig,
  computeMvTargetState,
  resolveOnlineMvUrl,
  searchOnlineMvs,
} from '../../services/mvService';
import { getMvBlob } from '../../services/storage';
import {
  MvDisplayMode,
  OnlineMvResult,
  TrackColorPalette,
  TrackMvConfig,
} from '../../types/music';
import { formatFileSize, formatTime } from '../../utils/constants';

type MvModalTab = 'online' | 'local' | 'sync' | 'display';

interface MvSettingsModalProps {
  open: boolean;
  onClose: () => void;
  palette: TrackColorPalette;
}

function formatOffsetLabel(offset: number): string {
  const rounded = Math.round(offset * 100) / 100;
  if (Math.abs(rounded) < 0.005) return '0.00 秒（默认音画一致）';
  return rounded > 0
    ? `+${rounded.toFixed(2)} 秒（MV 画面提前）`
    : `${rounded.toFixed(2)} 秒（MV 画面延迟）`;
}

export const MvSettingsModal: React.FC<MvSettingsModalProps> = ({
  open,
  onClose,
  palette,
}) => {
  const {
    currentTrack,
    currentTime,
    duration,
    isPlaying,
    togglePlayPause,
    currentTrackMv,
    mvRuntimeStatus,
    triggerMvRetry,
    saveTrackMvConfig,
    uploadLocalMvForTrack,
    removeTrackMv,
    toggleTrackMvEnabled,
    showToast,
  } = useMusic();

  const [activeTab, setActiveTab] = useState<MvModalTab>('online');

  // Online MV Search & URL Resolve State
  const [searchKeyword, setSearchKeyword] = useState('');
  const [searchResults, setSearchResults] = useState<OnlineMvResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [resolvingUrl, setResolvingUrl] = useState(false);
  const [previewCandidate, setPreviewCandidate] = useState<OnlineMvResult | null>(null);

  // Local Video Upload State
  const [uploadingLocal, setUploadingLocal] = useState(false);
  const [localUploadError, setLocalUploadError] = useState<string | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const localInputRef = useRef<HTMLInputElement | null>(null);

  // Sync Studio State
  const [draftOffsetSec, setDraftOffsetSec] = useState<number>(0);
  const [offsetInputText, setOffsetInputText] = useState<string>('0');
  const [syncPreviewUrl, setSyncPreviewUrl] = useState<string | null>(null);
  const [syncPreviewTime, setSyncPreviewTime] = useState<number>(0);
  const [syncPreviewDuration, setSyncPreviewDuration] = useState<number>(0);
  const [isScrubbingMv, setIsScrubbingMv] = useState(false);
  const syncVideoRef = useRef<HTMLVideoElement | null>(null);

  const autoSearchedTrackIdRef = useRef<string | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  // Reset per-track defaults when modal opens or track switches
  useEffect(() => {
    if (!open || !currentTrack) return;
    const defaultKw = [currentTrack.artist, currentTrack.title]
      .filter((s) => s && s !== '未知艺术家' && s !== 'Unknown Artist')
      .join(' ');
    setSearchKeyword(defaultKw || currentTrack.title);
    setPreviewCandidate(null);
    setSearchError(null);
    setLocalUploadError(null);

    const savedOffset = currentTrackMv?.syncOffsetSec ?? 0;
    setDraftOffsetSec(savedOffset);
    setOffsetInputText(String(Math.round(savedOffset * 100) / 100));

    if (currentTrackMv?.sourceType === 'local' && activeTab === 'online') {
      // Keep user's current context if already configured locally
    }
  }, [open, currentTrack?.id]);

  // Sync draft offset when stored MV changes externally
  useEffect(() => {
    if (!open) return;
    const saved = currentTrackMv?.syncOffsetSec ?? 0;
    setDraftOffsetSec(saved);
    setOffsetInputText(String(Math.round(saved * 100) / 100));
  }, [open, currentTrackMv?.songId, currentTrackMv?.syncOffsetSec]);

  // Auto-search current track online when opening Online tab without results yet
  const runOnlineSearch = async (overrideQuery?: string) => {
    if (!currentTrack) return;
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;

    setSearching(true);
    setSearchError(null);
    try {
      const list = await searchOnlineMvs(currentTrack.title, currentTrack.artist, {
        album: currentTrack.album,
        duration: currentTrack.duration,
        customQuery: overrideQuery,
        signal: ctrl.signal,
      });
      setSearchResults(list);
      if (list.length === 0) {
        setSearchError('暂未检索到匹配的公开 MV，可尝试简化关键词、粘贴视频链接或上传本地视频');
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setSearchError(err instanceof Error ? err.message : '搜索 MV 失败，请检查网络连接');
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    if (!open || !currentTrack || activeTab !== 'online') return;
    if (autoSearchedTrackIdRef.current === currentTrack.id && searchResults.length > 0) {
      return;
    }
    autoSearchedTrackIdRef.current = currentTrack.id;
    void runOnlineSearch();
  }, [open, currentTrack?.id, activeTab]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
    };
  }, []);

  // Resolve Blob URL for Local tab & Sync Studio video preview (with full revocation)
  useEffect(() => {
    if (!open || !currentTrackMv) {
      setLocalPreviewUrl(null);
      setSyncPreviewUrl(null);
      return;
    }
    if (activeTab !== 'local' && activeTab !== 'sync') {
      setLocalPreviewUrl(null);
      setSyncPreviewUrl(null);
      return;
    }

    if (currentTrackMv.sourceType === 'online') {
      const streamUrl =
        currentTrackMv.playableType === 'video' ? currentTrackMv.playableUrl || null : null;
      setLocalPreviewUrl(null);
      setSyncPreviewUrl(streamUrl);
      return;
    }

    const vidId = currentTrackMv.localVideoId;
    if (!vidId) {
      setLocalPreviewUrl(null);
      setSyncPreviewUrl(null);
      return;
    }

    let cancelled = false;
    let blobUrl: string | null = null;
    getMvBlob(vidId).then((blob) => {
      if (cancelled || !blob) return;
      blobUrl = URL.createObjectURL(blob);
      setLocalPreviewUrl(blobUrl);
      setSyncPreviewUrl(blobUrl);
    });

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [
    open,
    activeTab,
    currentTrackMv?.songId,
    currentTrackMv?.sourceType,
    currentTrackMv?.localVideoId,
    currentTrackMv?.playableType,
    currentTrackMv?.playableUrl,
  ]);

  // Keep Sync Studio mini video preview aligned to music + draftOffsetSec when not scrubbing
  useEffect(() => {
    if (!open || activeTab !== 'sync' || isScrubbingMv) return;
    const vid = syncVideoRef.current;
    if (!vid || !currentTrackMv || !syncPreviewUrl) return;

    const mvDur =
      Number.isFinite(vid.duration) && vid.duration > 0
        ? vid.duration
        : currentTrackMv.localDuration || 0;
    const state = computeMvTargetState(
      currentTime,
      draftOffsetSec,
      mvDur,
      currentTrackMv.endBehavior
    );
    setSyncPreviewDuration(mvDur);

    if (state.ended || state.waitingOffset) {
      if (!vid.paused) vid.pause();
      if (Math.abs((vid.currentTime || 0) - state.targetTime) > 0.12 && vid.readyState >= 1) {
        try {
          vid.currentTime = state.targetTime;
        } catch {
          // ignore
        }
      }
      setSyncPreviewTime(state.targetTime);
      return;
    }

    if (isPlaying && vid.paused && vid.readyState >= 2) {
      vid.muted = true;
      vid.play().catch(() => {});
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }

    const diff = Math.abs((vid.currentTime || 0) - state.targetTime);
    if (diff > 0.35 && vid.readyState >= 1) {
      try {
        vid.currentTime = state.targetTime;
      } catch {
        // ignore
      }
    }
    setSyncPreviewTime(vid.currentTime || state.targetTime);
  }, [
    open,
    activeTab,
    isScrubbingMv,
    currentTime,
    draftOffsetSec,
    isPlaying,
    currentTrackMv,
    syncPreviewUrl,
  ]);

  const effectiveMusicDuration =
    duration > 0 ? duration : currentTrack?.duration || 0;

  const targetMvPreviewState = useMemo(() => {
    const dur =
      syncPreviewDuration > 0
        ? syncPreviewDuration
        : currentTrackMv?.localDuration || mvRuntimeStatus.mvDuration || 0;
    return computeMvTargetState(
      currentTime,
      draftOffsetSec,
      dur,
      currentTrackMv?.endBehavior || 'stop'
    );
  }, [
    currentTime,
    draftOffsetSec,
    syncPreviewDuration,
    currentTrackMv?.localDuration,
    currentTrackMv?.endBehavior,
    mvRuntimeStatus.mvDuration,
  ]);

  if (!open) return null;

  const handleResolveCustomUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customUrlInput.trim()) return;
    setResolvingUrl(true);
    setSearchError(null);
    try {
      const candidate = await resolveOnlineMvUrl(customUrlInput.trim());
      setSearchResults((prev) => [
        candidate,
        ...prev.filter((item) => item.id !== candidate.id),
      ]);
      setPreviewCandidate(candidate);
      if (!candidate.supportsWebPlayback) {
        showToast('该链接不支持站内播放，仅可打开原页面观看');
      } else {
        showToast('链接检测完成，可预览或直接设为背景 MV');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '链接解析失败';
      setSearchError(msg);
      showToast(msg);
    } finally {
      setResolvingUrl(false);
    }
  };

  const handleApplyOnlineCandidate = async (item: OnlineMvResult) => {
    if (!currentTrack) return;
    if (item.playableType === 'external_only' || !item.supportsWebPlayback) {
      showToast('该平台禁止站内嵌入播放，请点击来源链接前往原网页观看');
      return;
    }
    const nextConfig = buildOnlineMvConfig(currentTrack.id, item, currentTrackMv);
    await saveTrackMvConfig(nextConfig);
    showToast(`已为「${currentTrack.title}」设置 MV 背景并自动同步`);
    setActiveTab('sync');
  };

  const handleLocalFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !currentTrack) return;
    setUploadingLocal(true);
    setLocalUploadError(null);
    try {
      await uploadLocalMvForTrack(currentTrack.id, file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '导入本地视频失败';
      setLocalUploadError(msg);
      showToast(msg);
    } finally {
      setUploadingLocal(false);
    }
  };

  const setDraftOffsetClean = (val: number) => {
    const clamped = Math.max(-600, Math.min(600, Math.round(val * 100) / 100));
    setDraftOffsetSec(clamped);
    setOffsetInputText(String(clamped));
  };

  const handleAlignToCurrentFrame = () => {
    const liveMusic = audioEngine.element.currentTime || currentTime;
    const vid = syncVideoRef.current;
    const mvPos = vid ? vid.currentTime : syncPreviewTime;
    const alignedOffset = mvPos - liveMusic;
    setDraftOffsetClean(alignedOffset);
    setIsScrubbingMv(false);
    showToast(`已按当前画面对齐：偏移设为 ${formatOffsetLabel(alignedOffset)}`);
  };

  const handlePreviewSync = async () => {
    if (!currentTrackMv) return;
    await saveTrackMvConfig({
      ...currentTrackMv,
      enabled: true,
      syncOffsetSec: draftOffsetSec,
      linkBroken: false,
    });
    setIsScrubbingMv(false);
    if (!isPlaying) {
      await togglePlayPause();
    }
    triggerMvRetry();
    showToast('正在以新同步参数预览 MV 背景');
  };

  const handleSaveSync = async () => {
    if (!currentTrackMv) return;
    await saveTrackMvConfig({
      ...currentTrackMv,
      syncOffsetSec: draftOffsetSec,
      linkBroken: false,
    });
    setIsScrubbingMv(false);
    showToast(`已保存同步偏移（${formatOffsetLabel(draftOffsetSec)}）`);
  };

  const updateVisualConfig = async (patch: Partial<TrackMvConfig>) => {
    if (!currentTrackMv) return;
    await saveTrackMvConfig({
      ...currentTrackMv,
      ...patch,
    });
  };

  const syncStatusBadge = (() => {
    switch (mvRuntimeStatus.state) {
      case 'synced':
        return { text: '实时音画已同步', cls: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/30' };
      case 'correcting':
        return { text: mvRuntimeStatus.message || '微调对齐中', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/30' };
      case 'waiting_offset':
        return { text: mvRuntimeStatus.message || '等待同步点进入', cls: 'bg-sky-500/20 text-sky-200 border-sky-400/30' };
      case 'ended':
        return { text: 'MV 已播完', cls: 'bg-white/10 text-white/75 border-white/15' };
      case 'embed_synced':
        return { text: '嵌入播放器联动同步', cls: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/30' };
      case 'embed_limited':
        return { text: '嵌入播放器（跨源受限）', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/30' };
      case 'autoplay_blocked':
        return { text: '等待手势触发视频播放', cls: 'bg-rose-500/20 text-rose-200 border-rose-400/35' };
      case 'link_broken':
      case 'error':
        return { text: mvRuntimeStatus.message || '视频加载异常', cls: 'bg-rose-500/20 text-rose-200 border-rose-400/35' };
      default:
        return { text: 'MV 背景未开启', cls: 'bg-white/10 text-white/60 border-white/15' };
    }
  })();

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-2 sm:p-5">
      <div className="w-full max-w-4xl max-h-[92dvh] rounded-3xl bg-[#16070f]/95 border border-white/15 shadow-2xl flex flex-col overflow-hidden">
        {/* Top Modal Header */}
        <div className="px-4 sm:px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="min-w-0 flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 border border-white/15"
              style={{
                background: `linear-gradient(135deg, ${palette.primary}55, ${palette.secondary}55)`,
              }}
            >
              <Film className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold text-white truncate">
                MV 背景播放与音画同步系统
              </h2>
              <p className="text-xs text-white/60 truncate">
                {currentTrack
                  ? `${currentTrack.title} · ${currentTrack.artist}（每首歌曲独立记忆 MV 设置）`
                  : '请先选择或导入一首歌曲'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {currentTrack && currentTrackMv && (
              <>
                <button
                  type="button"
                  onClick={() => void toggleTrackMvEnabled(currentTrack.id)}
                  className={`min-h-[38px] px-3.5 py-1.5 rounded-xl text-xs font-semibold border transition-colors cursor-pointer ${
                    currentTrackMv.enabled
                      ? 'bg-emerald-500/25 border-emerald-400/45 text-emerald-100'
                      : 'bg-white/8 border-white/15 text-white/75 hover:text-white'
                  }`}
                >
                  {currentTrackMv.enabled ? 'MV 背景：已开启' : 'MV 背景：已关闭'}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('online')}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-white/8 hover:bg-white/15 border border-white/12 text-xs text-white/85 cursor-pointer"
                >
                  更换 MV
                </button>
                <button
                  type="button"
                  onClick={() => void removeTrackMv(currentTrack.id)}
                  title="清除当前歌曲 MV 设置"
                  className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-xs text-rose-200 flex items-center gap-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">清除 MV</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭 MV 设置"
              className="min-w-[38px] min-h-[38px] flex items-center justify-center rounded-xl text-white/70 hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="px-4 sm:px-6 pt-3 pb-2 border-b border-white/10 grid grid-cols-4 gap-2 shrink-0">
          {(
            [
              { id: 'online', label: '网页找 MV', icon: Search },
              { id: 'local', label: '上传本地 MV', icon: Upload },
              { id: 'sync', label: '音画同步调整', icon: Clock },
              { id: 'display', label: '画面与背景', icon: Sliders },
            ] as { id: MvModalTab; label: string; icon: React.FC<{ className?: string }> }[]
          ).map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`min-h-[42px] px-2 sm:px-3 py-2 rounded-2xl text-xs font-medium flex items-center justify-center gap-1.5 border transition-all cursor-pointer ${
                  active
                    ? 'bg-white/14 text-white border-white/25 shadow-sm'
                    : 'bg-white/[0.03] text-white/60 border-white/8 hover:text-white hover:bg-white/[0.07]'
                }`}
                style={
                  active
                    ? { borderColor: `${palette.primary}80` }
                    : undefined
                }
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 min-h-0 overflow-y-auto lumina-scroll p-4 sm:p-6 space-y-5">
          {!currentTrack ? (
            <div className="py-12 text-center text-sm text-white/60">
              当前没有正在播放的歌曲，请先在「我的音乐」中选择或导入歌曲。
            </div>
          ) : (
            <>
              {/* Current Song Active MV Summary Strip */}
              {currentTrackMv && (
                <div className="p-3.5 rounded-2xl bg-white/[0.05] border border-white/12 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-3">
                    <div className="w-12 h-9 rounded-lg overflow-hidden bg-black/40 shrink-0 flex items-center justify-center border border-white/10">
                      {currentTrackMv.thumbnailUrl ? (
                        <img
                          src={currentTrackMv.thumbnailUrl}
                          alt={currentTrackMv.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Video className="w-4 h-4 text-white/60" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white truncate">
                        当前绑定：{currentTrackMv.title}
                      </p>
                      <p className="text-[11px] text-white/60 truncate">
                        {currentTrackMv.sourceType === 'local'
                          ? `本地视频 (${currentTrackMv.localWidth || '?'}×${currentTrackMv.localHeight || '?'})`
                          : currentTrackMv.sourceName || '在线 MV'}
                        {' · '}同步偏移：{formatOffsetLabel(currentTrackMv.syncOffsetSec)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[11px] px-2.5 py-1 rounded-xl border font-medium ${syncStatusBadge.cls}`}
                    >
                      {syncStatusBadge.text}
                    </span>
                    {mvRuntimeStatus.state === 'autoplay_blocked' && (
                      <button
                        type="button"
                        onClick={triggerMvRetry}
                        className="px-3 py-1.5 rounded-xl bg-rose-500 text-white text-xs font-semibold cursor-pointer"
                      >
                        启动 MV 画面
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 1: ONLINE MV SEARCH & URL RESOLUTION */}
              {activeTab === 'online' && (
                <div className="space-y-4">
                  {/* Keyword Search Bar */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void runOnlineSearch(searchKeyword.trim());
                    }}
                    className="flex flex-col sm:flex-row gap-2"
                  >
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 text-white/45 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={searchKeyword}
                        onChange={(e) => setSearchKeyword(e.target.value)}
                        placeholder="输入歌曲名 / 歌手 / 专辑 / MV 关键词..."
                        className="w-full pl-10 pr-3 py-2.5 rounded-2xl bg-white/8 border border-white/12 text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-white/30"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={searching}
                      className="min-h-[42px] px-4 py-2 rounded-2xl text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60 shrink-0"
                      style={{
                        background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                      }}
                    >
                      {searching ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Search className="w-4 h-4" />
                      )}
                      <span>搜索官方/可嵌入 MV</span>
                    </button>
                  </form>

                  {/* Custom MV URL Resolver */}
                  <form
                    onSubmit={handleResolveCustomUrl}
                    className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/10 space-y-2"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-medium text-white/85">
                      <Link2 className="w-3.5 h-3.5" style={{ color: palette.primary }} />
                      <span>粘贴 MV 视频直链或公开播放器链接（YouTube / Vimeo / Dailymotion / HTTPS MP4/WebM）</span>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="url"
                        value={customUrlInput}
                        onChange={(e) => setCustomUrlInput(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=... 或 https://.../mv.mp4"
                        className="flex-1 px-3.5 py-2 rounded-xl bg-white/8 border border-white/12 text-xs text-white placeholder:text-white/35 focus:outline-none focus:border-white/30"
                      />
                      <button
                        type="submit"
                        disabled={resolvingUrl || !customUrlInput.trim()}
                        className="min-h-[38px] px-4 py-2 rounded-xl bg-white/12 hover:bg-white/18 border border-white/15 text-xs font-medium text-white flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        {resolvingUrl && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <span>检测并解析链接</span>
                      </button>
                    </div>
                  </form>

                  {/* Inline Candidate Preview Stage */}
                  {previewCandidate && (
                    <div className="p-4 rounded-2xl bg-black/45 border border-white/15 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">
                            MV 预览：{previewCandidate.title}
                          </p>
                          <p className="text-[11px] text-white/60 truncate">
                            {previewCandidate.sourceName} · {previewCandidate.notice}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {previewCandidate.supportsWebPlayback && (
                            <button
                              type="button"
                              onClick={() => void handleApplyOnlineCandidate(previewCandidate)}
                              className="px-3.5 py-1.5 rounded-xl text-xs font-semibold text-white cursor-pointer"
                              style={{ backgroundColor: palette.primary }}
                            >
                              设为背景 MV
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setPreviewCandidate(null)}
                            className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 cursor-pointer"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {previewCandidate.playableType === 'video' &&
                      previewCandidate.playableUrl ? (
                        <video
                          key={previewCandidate.playableUrl}
                          src={previewCandidate.playableUrl}
                          controls
                          muted
                          playsInline
                          className="w-full max-h-60 rounded-xl bg-black object-contain"
                        />
                      ) : previewCandidate.playableType === 'embed' &&
                        previewCandidate.playableUrl ? (
                        <iframe
                          key={previewCandidate.playableUrl}
                          src={previewCandidate.playableUrl}
                          title={previewCandidate.title}
                          allow="autoplay; encrypted-media; picture-in-picture"
                          className="w-full h-56 rounded-xl border-0 bg-black"
                        />
                      ) : (
                        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-400/25 text-xs text-amber-100 flex flex-wrap items-center justify-between gap-3">
                          <span>
                            该视频平台限制外部网页内嵌播放（版权或防盗链策略），不会伪造播放结果。请点击右侧链接前往原页面观看。
                          </span>
                          <a
                            href={previewCandidate.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 rounded-xl bg-amber-500/25 hover:bg-amber-500/35 text-white font-medium inline-flex items-center gap-1"
                          >
                            <span>跳转来源页</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {searchError && (
                    <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-400/25 text-xs text-amber-100 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-300" />
                      <span>{searchError}</span>
                    </div>
                  )}

                  {/* Search Results List */}
                  <div className="space-y-2.5">
                    {searchResults.map((item) => {
                      const isCurrentSelected =
                        currentTrackMv?.sourceType === 'online' &&
                        (currentTrackMv.playableUrl === item.playableUrl ||
                          currentTrackMv.sourceUrl === item.sourceUrl);
                      return (
                        <div
                          key={item.id}
                          className={`p-3.5 rounded-2xl border transition-colors flex flex-col sm:flex-row gap-3.5 ${
                            isCurrentSelected
                              ? 'bg-white/12 border-white/30'
                              : 'bg-white/[0.035] border-white/10 hover:bg-white/[0.06]'
                          }`}
                        >
                          <div className="w-full sm:w-36 h-24 rounded-xl overflow-hidden bg-black/50 shrink-0 relative border border-white/10">
                            {item.thumbnailUrl ? (
                              <img
                                src={item.thumbnailUrl}
                                alt={item.title}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-white/40">
                                <Film className="w-6 h-6" />
                              </div>
                            )}
                            {item.duration > 0 && (
                              <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/75 text-[10px] font-mono-tabular text-white">
                                {formatTime(item.duration)}
                              </span>
                            )}
                          </div>

                          <div className="flex-1 min-w-0 flex flex-col justify-between gap-2">
                            <div className="space-y-1">
                              <div className="flex items-start justify-between gap-2">
                                <h3 className="text-sm font-semibold text-white line-clamp-1">
                                  {item.title}
                                </h3>
                                {typeof item.matchScore === 'number' && (
                                  <span className="text-[11px] font-mono-tabular text-white/55 shrink-0">
                                    匹配 {item.matchScore}%
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-white/65 truncate">
                                {item.artist} · {item.sourceName}
                                {item.isOfficial ? ' · 官方来源' : ''}
                                {item.isPreviewClip ? ' · 预览视频流' : ''}
                              </p>
                              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                                {item.playableType === 'video' ? (
                                  <span className="text-[11px] px-2 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-200 border border-emerald-400/25">
                                    支持网页原生播放 · 毫秒级同步
                                  </span>
                                ) : item.playableType === 'embed' ? (
                                  <span className="text-[11px] px-2 py-0.5 rounded-lg bg-sky-500/20 text-sky-200 border border-sky-400/25">
                                    支持网页嵌入播放
                                  </span>
                                ) : (
                                  <span className="text-[11px] px-2 py-0.5 rounded-lg bg-amber-500/18 text-amber-200 border border-amber-400/25">
                                    不支持站内播放（仅跳转原站）
                                  </span>
                                )}
                              </div>
                              {item.notice && (
                                <p className="text-[11px] text-white/50 leading-relaxed">
                                  {item.notice}
                                </p>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setPreviewCandidate(item)}
                                className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/16 border border-white/12 text-xs text-white flex items-center gap-1 cursor-pointer"
                              >
                                <Play className="w-3.5 h-3.5" />
                                <span>预览</span>
                              </button>

                              {item.supportsWebPlayback ? (
                                <button
                                  type="button"
                                  onClick={() => void handleApplyOnlineCandidate(item)}
                                  className="px-3.5 py-1.5 rounded-xl text-xs font-semibold text-white flex items-center gap-1 cursor-pointer"
                                  style={{
                                    background: isCurrentSelected
                                      ? '#10b981'
                                      : `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                                  }}
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  <span>{isCurrentSelected ? '已应用为背景' : '设为背景 MV'}</span>
                                </button>
                              ) : null}

                              <a
                                href={item.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-auto px-2.5 py-1.5 rounded-xl text-xs text-white/70 hover:text-white hover:bg-white/8 inline-flex items-center gap-1"
                              >
                                <span>来源链接</span>
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* TAB 2: LOCAL VIDEO UPLOAD */}
              {activeTab === 'local' && (
                <div className="space-y-4">
                  <input
                    ref={localInputRef}
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime,video/x-m4v,video/*"
                    className="hidden"
                    onChange={handleLocalFilePicked}
                  />

                  <div className="p-6 rounded-3xl border border-dashed border-white/20 bg-white/[0.03] text-center space-y-3">
                    <div
                      className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center border border-white/15"
                      style={{ backgroundColor: `${palette.primary}30` }}
                    >
                      {uploadingLocal ? (
                        <Loader2 className="w-6 h-6 text-white animate-spin" />
                      ) : (
                        <Upload className="w-6 h-6 text-white" />
                      )}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white">
                        从本地设备选择 MV 视频（适配平板 / 手机 / 桌面端）
                      </h3>
                      <p className="text-xs text-white/60 mt-1 max-w-lg mx-auto leading-relaxed">
                        优先推荐浏览器原生兼容度最高的 <strong>MP4 (H.264)</strong> 与{' '}
                        <strong>WebM (VP8/VP9)</strong>。视频将通过浏览器原生解码与本地 IndexedDB 分块存储，不会占用额外云端流量，也不影响歌曲原声播放。
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={uploadingLocal}
                      onClick={() => localInputRef.current?.click()}
                      className="min-h-[44px] px-5 py-2.5 rounded-2xl text-xs font-semibold text-white inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
                      style={{
                        background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                      }}
                    >
                      <Upload className="w-4 h-4" />
                      <span>
                        {currentTrackMv?.sourceType === 'local'
                          ? '更换本地 MV 视频'
                          : '选择本地视频文件'}
                      </span>
                    </button>
                  </div>

                  {localUploadError && (
                    <div className="p-3.5 rounded-2xl bg-rose-500/15 border border-rose-400/30 text-xs text-rose-100 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-300" />
                      <span>{localUploadError}</span>
                    </div>
                  )}

                  {currentTrackMv?.sourceType === 'local' && (
                    <div className="p-4 rounded-2xl bg-white/[0.045] border border-white/12 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-semibold text-white">
                            {currentTrackMv.localFileName || currentTrackMv.title}
                          </h4>
                          <p className="text-xs text-white/65 mt-1 font-mono-tabular">
                            时长 {formatTime(currentTrackMv.localDuration || 0)} · 分辨率{' '}
                            {currentTrackMv.localWidth || '?'} × {currentTrackMv.localHeight || '?'} ·{' '}
                            大小 {formatFileSize(currentTrackMv.localFileSize || 0)}
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setActiveTab('sync')}
                            className="px-3.5 py-2 rounded-xl bg-white/12 hover:bg-white/18 text-xs font-medium text-white cursor-pointer"
                          >
                            调整音画同步 →
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeTrackMv(currentTrack.id)}
                            className="px-3 py-2 rounded-xl bg-rose-500/18 hover:bg-rose-500/28 border border-rose-500/30 text-xs text-rose-200 cursor-pointer"
                          >
                            删除视频
                          </button>
                        </div>
                      </div>

                      {localPreviewUrl ? (
                        <video
                          key={localPreviewUrl}
                          src={localPreviewUrl}
                          controls
                          muted
                          playsInline
                          className="w-full max-h-64 rounded-2xl bg-black object-contain"
                        />
                      ) : (
                        <div className="py-8 text-center text-xs text-white/55">
                          正在加载本地视频预览...
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: AUDIO-VIDEO SYNC STUDIO */}
              {activeTab === 'sync' && (
                <div className="space-y-4">
                  {!currentTrackMv ? (
                    <div className="p-8 rounded-2xl bg-white/[0.03] border border-white/10 text-center space-y-3">
                      <p className="text-sm text-white/75">
                        当前歌曲尚未绑定在线或本地 MV
                      </p>
                      <div className="flex justify-center gap-2.5">
                        <button
                          type="button"
                          onClick={() => setActiveTab('online')}
                          className="px-4 py-2 rounded-xl bg-white/12 text-xs text-white cursor-pointer"
                        >
                          网页寻找 MV
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab('local')}
                          className="px-4 py-2 rounded-xl bg-white/12 text-xs text-white cursor-pointer"
                        >
                          上传本地视频
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Live Video Preview + Visual Frame Alignment */}
                      {syncPreviewUrl ? (
                        <div className="p-3.5 rounded-2xl bg-black/50 border border-white/12 space-y-3">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-white/80 font-medium">
                              MV 同步定位预览（拖动下方 MV 进度条可定位对应画面）
                            </span>
                            <span className={`px-2 py-0.5 rounded-lg border text-[11px] ${syncStatusBadge.cls}`}>
                              {syncStatusBadge.text}
                            </span>
                          </div>

                          <video
                            ref={syncVideoRef}
                            key={`sync-${syncPreviewUrl}`}
                            src={syncPreviewUrl}
                            muted
                            playsInline
                            preload="auto"
                            onLoadedMetadata={(e) => {
                              const d = e.currentTarget.duration;
                              if (Number.isFinite(d) && d > 0) setSyncPreviewDuration(d);
                            }}
                            onTimeUpdate={(e) => {
                              if (isScrubbingMv) {
                                setSyncPreviewTime(e.currentTarget.currentTime);
                              }
                            }}
                            className="w-full max-h-52 rounded-xl bg-black object-contain"
                          />

                          {/* MV Manual Scrub Bar & One-Tap Align */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-[11px] font-mono-tabular text-white/70">
                              <span>MV 画面位置：{formatTime(isScrubbingMv ? syncPreviewTime : targetMvPreviewState.targetTime)}</span>
                              <span>MV 总长：{formatTime(syncPreviewDuration || currentTrackMv.localDuration || 0)}</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={Math.max(1, syncPreviewDuration || currentTrackMv.localDuration || 60)}
                              step={0.05}
                              value={Math.min(
                                isScrubbingMv ? syncPreviewTime : targetMvPreviewState.targetTime,
                                Math.max(1, syncPreviewDuration || currentTrackMv.localDuration || 60)
                              )}
                              onPointerDown={() => setIsScrubbingMv(true)}
                              onChange={(e) => {
                                setIsScrubbingMv(true);
                                const nextSec = parseFloat(e.target.value);
                                setSyncPreviewTime(nextSec);
                                if (syncVideoRef.current) {
                                  syncVideoRef.current.pause();
                                  syncVideoRef.current.currentTime = nextSec;
                                }
                              }}
                              aria-label="MV 画面时间定位"
                              className="lumina-range w-full"
                            />
                            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                              <span className="text-[11px] text-white/55">
                                示例：歌曲到 30 秒，MV 对应画面在 32 秒 → 滑到 32 秒后点击右方按钮即可自动设为 +2.00s
                              </span>
                              <button
                                type="button"
                                onClick={handleAlignToCurrentFrame}
                                className="px-3.5 py-1.5 rounded-xl bg-white/14 hover:bg-white/22 border border-white/20 text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer"
                              >
                                <Sparkles className="w-3.5 h-3.5" style={{ color: palette.primary }} />
                                <span>以当前画面对齐音乐时间</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="p-4 rounded-2xl bg-white/[0.04] border border-white/10 text-xs text-white/70 leading-relaxed">
                          当前 MV 为跨源嵌入式播放器（{currentTrackMv.sourceName}），仍可使用下方偏移数值与音乐启停/跳转进行同步调整。
                        </div>
                      )}

                      {/* Dual-Timeline Readout */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10">
                          <span className="text-[11px] text-white/55 block">音乐时间轴</span>
                          <span className="text-base font-semibold font-mono-tabular text-white mt-1 block">
                            {formatTime(currentTime)} / {formatTime(effectiveMusicDuration)}
                          </span>
                        </div>
                        <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10">
                          <span className="text-[11px] text-white/55 block">MV 目标位置 / 总长</span>
                          <span className="text-base font-semibold font-mono-tabular text-white mt-1 block">
                            {formatTime(targetMvPreviewState.targetTime)} /{' '}
                            {formatTime(
                              syncPreviewDuration ||
                                currentTrackMv.localDuration ||
                                mvRuntimeStatus.mvDuration ||
                                0
                            )}
                          </span>
                        </div>
                        <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10">
                          <span className="text-[11px] text-white/55 block">当前偏移设置</span>
                          <span
                            className="text-sm font-semibold font-mono-tabular mt-1 block truncate"
                            style={{ color: palette.primary }}
                          >
                            {formatOffsetLabel(draftOffsetSec)}
                          </span>
                        </div>
                      </div>

                      {/* Precision +/- Controls */}
                      <div className="p-4 rounded-2xl bg-white/[0.045] border border-white/12 space-y-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-white">
                            精细偏移微调（正数 = MV 提前，负数 = MV 延迟）
                          </span>
                          <button
                            type="button"
                            onClick={() => setDraftOffsetClean(0)}
                            className="px-3 py-1.5 rounded-xl bg-white/8 hover:bg-white/15 border border-white/12 text-xs text-white/80 flex items-center gap-1 cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>恢复默认 0 秒</span>
                          </button>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-center">
                          <button
                            type="button"
                            onClick={() => setDraftOffsetClean(draftOffsetSec - 0.1)}
                            className="min-h-[42px] px-3 py-2 rounded-xl bg-white/10 hover:bg-white/18 text-xs font-mono-tabular text-white cursor-pointer"
                          >
                            -0.10s (延迟)
                          </button>
                          <button
                            type="button"
                            onClick={() => setDraftOffsetClean(draftOffsetSec - 0.05)}
                            className="min-h-[42px] px-3 py-2 rounded-xl bg-white/10 hover:bg-white/18 text-xs font-mono-tabular text-white cursor-pointer"
                          >
                            -0.05s (微延)
                          </button>
                          <input
                            type="number"
                            step={0.05}
                            min={-600}
                            max={600}
                            value={offsetInputText}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setOffsetInputText(raw);
                              const num = parseFloat(raw);
                              if (Number.isFinite(num)) {
                                setDraftOffsetSec(
                                  Math.max(-600, Math.min(600, Math.round(num * 100) / 100))
                                );
                              }
                            }}
                            aria-label="偏移秒数输入"
                            className="col-span-2 sm:col-span-1 min-h-[42px] px-3 py-2 rounded-xl bg-black/40 border border-white/20 text-center text-sm font-mono-tabular text-white focus:outline-none focus:border-white/40"
                          />
                          <button
                            type="button"
                            onClick={() => setDraftOffsetClean(draftOffsetSec + 0.05)}
                            className="min-h-[42px] px-3 py-2 rounded-xl bg-white/10 hover:bg-white/18 text-xs font-mono-tabular text-white cursor-pointer"
                          >
                            +0.05s (微前)
                          </button>
                          <button
                            type="button"
                            onClick={() => setDraftOffsetClean(draftOffsetSec + 0.1)}
                            className="min-h-[42px] px-3 py-2 rounded-xl bg-white/10 hover:bg-white/18 text-xs font-mono-tabular text-white cursor-pointer"
                          >
                            +0.10s (提前)
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
                          <button
                            type="button"
                            onClick={() => void handlePreviewSync()}
                            className="min-h-[42px] px-4 py-2 rounded-xl bg-white/12 hover:bg-white/18 border border-white/15 text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>预览同步</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSaveSync()}
                            className="min-h-[42px] px-5 py-2 rounded-xl text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                            style={{
                              background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                            }}
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            <span>保存同步设置</span>
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* TAB 4: DISPLAY, SCALING, READABILITY & END BEHAVIOR */}
              {activeTab === 'display' && (
                <div className="space-y-4">
                  {!currentTrackMv ? (
                    <div className="p-8 rounded-2xl bg-white/[0.03] border border-white/10 text-center text-sm text-white/65">
                      请先在「网页找 MV」或「上传本地 MV」中为当前歌曲设置一个 MV。
                    </div>
                  ) : (
                    <>
                      <div className="p-4 rounded-2xl bg-white/[0.045] border border-white/12 space-y-3">
                        <span className="text-xs font-semibold text-white block">
                          画面适配模式
                        </span>
                        <div className="grid grid-cols-3 gap-2.5">
                          {(
                            [
                              { id: 'cover', label: '填满屏幕 (Cover)', desc: '无黑边沉浸铺满' },
                              { id: 'contain', label: '完整显示 (Contain)', desc: '完整保留画幅比例' },
                              { id: 'custom', label: '自定义缩放/位置', desc: '自由裁剪偏移焦点' },
                            ] as { id: MvDisplayMode; label: string; desc: string }[]
                          ).map((mode) => {
                            const active = currentTrackMv.displayMode === mode.id;
                            return (
                              <button
                                key={mode.id}
                                type="button"
                                onClick={() => void updateVisualConfig({ displayMode: mode.id })}
                                className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                                  active
                                    ? 'bg-white/14 border-white/35 text-white'
                                    : 'bg-white/[0.03] border-white/10 text-white/70 hover:text-white'
                                }`}
                              >
                                <p className="text-xs font-semibold">{mode.label}</p>
                                <p className="text-[11px] text-white/55 mt-0.5">{mode.desc}</p>
                              </button>
                            );
                          })}
                        </div>

                        {currentTrackMv.displayMode === 'custom' && (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                            <div>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="text-white/75">画面缩放</span>
                                <span className="font-mono-tabular text-white">
                                  {(currentTrackMv.scale || 1).toFixed(2)}x
                                </span>
                              </div>
                              <input
                                type="range"
                                min={1}
                                max={2.5}
                                step={0.05}
                                value={currentTrackMv.scale || 1}
                                onChange={(e) =>
                                  void updateVisualConfig({ scale: parseFloat(e.target.value) })
                                }
                                className="lumina-range w-full"
                              />
                            </div>
                            <div>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="text-white/75">水平位置</span>
                                <span className="font-mono-tabular text-white">
                                  {currentTrackMv.cropX || 0}%
                                </span>
                              </div>
                              <input
                                type="range"
                                min={-35}
                                max={35}
                                step={1}
                                value={currentTrackMv.cropX || 0}
                                onChange={(e) =>
                                  void updateVisualConfig({ cropX: parseFloat(e.target.value) })
                                }
                                className="lumina-range w-full"
                              />
                            </div>
                            <div>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="text-white/75">垂直位置</span>
                                <span className="font-mono-tabular text-white">
                                  {currentTrackMv.cropY || 0}%
                                </span>
                              </div>
                              <input
                                type="range"
                                min={-35}
                                max={35}
                                step={1}
                                value={currentTrackMv.cropY || 0}
                                onChange={(e) =>
                                  void updateVisualConfig({ cropY: parseFloat(e.target.value) })
                                }
                                className="lumina-range w-full"
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Readability & Atmosphere Sliders */}
                      <div className="p-4 rounded-2xl bg-white/[0.045] border border-white/12 grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                          <div className="flex justify-between text-xs mb-1.5">
                            <span className="text-white/80">视频背景亮度</span>
                            <span className="font-mono-tabular text-white">
                              {Math.round((currentTrackMv.brightness ?? 0.62) * 100)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0.2}
                            max={1}
                            step={0.02}
                            value={currentTrackMv.brightness ?? 0.62}
                            onChange={(e) =>
                              void updateVisualConfig({ brightness: parseFloat(e.target.value) })
                            }
                            className="lumina-range w-full"
                          />
                        </div>

                        <div>
                          <div className="flex justify-between text-xs mb-1.5">
                            <span className="text-white/80">暗角文字护眼遮罩</span>
                            <span className="font-mono-tabular text-white">
                              {Math.round((currentTrackMv.overlayOpacity ?? 0.45) * 100)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0.1}
                            max={0.85}
                            step={0.05}
                            value={currentTrackMv.overlayOpacity ?? 0.45}
                            onChange={(e) =>
                              void updateVisualConfig({
                                overlayOpacity: parseFloat(e.target.value),
                              })
                            }
                            className="lumina-range w-full"
                          />
                        </div>

                        <div>
                          <div className="flex justify-between text-xs mb-1.5">
                            <span className="text-white/80">背景柔化模糊</span>
                            <span className="font-mono-tabular text-white">
                              {Math.round(currentTrackMv.blurPx ?? 0)} px
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={20}
                            step={1}
                            value={currentTrackMv.blurPx ?? 0}
                            onChange={(e) =>
                              void updateVisualConfig({ blurPx: parseFloat(e.target.value) })
                            }
                            className="lumina-range w-full"
                          />
                        </div>
                      </div>

                      {/* MV End Behavior */}
                      <div className="p-4 rounded-2xl bg-white/[0.045] border border-white/12 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <span className="text-xs font-semibold text-white block">
                            当 MV 时长短于歌曲时的播完处理
                          </span>
                          <span className="text-[11px] text-white/55 block mt-0.5">
                            仅影响背景视频，绝不会中断或重放歌曲音频
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => void updateVisualConfig({ endBehavior: 'stop' })}
                            className={`px-3.5 py-2 rounded-xl text-xs font-medium border cursor-pointer ${
                              currentTrackMv.endBehavior === 'stop'
                                ? 'bg-white/16 border-white/30 text-white'
                                : 'bg-white/[0.03] border-white/10 text-white/65 hover:text-white'
                            }`}
                          >
                            停留在尾帧
                          </button>
                          <button
                            type="button"
                            onClick={() => void updateVisualConfig({ endBehavior: 'loop' })}
                            className={`px-3.5 py-2 rounded-xl text-xs font-medium border cursor-pointer ${
                              currentTrackMv.endBehavior === 'loop'
                                ? 'bg-white/16 border-white/30 text-white'
                                : 'bg-white/[0.03] border-white/10 text-white/65 hover:text-white'
                            }`}
                          >
                            平滑循环播放
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
