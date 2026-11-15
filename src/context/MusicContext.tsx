import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { audioEngine } from '../audio/AudioEngine';
import { isSupportedAudioFile, parseAudioFileToTrack } from '../services/audioMetadata';
import { getProxiedCoverUrl } from '../services/coverSearchService';
import {
  clearAllMusicData,
  deleteMvConfigAndBlob,
  deletePlaylistById,
  deleteTrackById,
  deleteTrackStems,
  getAllMvConfigs,
  getAllPlaylists,
  getAllStemMetas,
  getAllTracks,
  getAudioBlob,
  getTrackStems,
  hasInitializedDemo,
  loadAudioSettings,
  loadPersonalization,
  loadPlaybackPrefs,
  markDemoInitialized,
  saveAudioSettings,
  saveMvConfig,
  saveMvVideoWithConfig,
  savePersonalization,
  savePlaybackPrefs,
  savePlaylist,
  saveTrackWithBlob,
  updateTrackMetadata,
} from '../services/storage';
import {
  DEFAULT_MV_VISUAL_SETTINGS,
  probeLocalVideoFile,
} from '../services/mvService';
import {
  AudioDspSettings,
  LyricPairRecord,
  LyricTranslationStyle,
  MvRuntimeStatus,
  NavPage,
  PersonalizationSettings,
  Playlist,
  RepeatMode,
  SeparationEngineMode,
  TrackColorPalette,
  TrackMetadata,
  TrackMvConfig,
  TrackStemsMeta,
  TrackTranslationMeta,
} from '../types/music';
import {
  extractPaletteFromImage,
  resizeCoverToDataUrl,
} from '../utils/colorExtractor';
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_PALETTE,
  DEFAULT_PERSONALIZATION,
} from '../utils/constants';
import { generateDemoTracks } from '../utils/demoAudioGenerator';
import {
  buildLyricPairsFromRaw,
  buildSeparatedLyricsFromPairs,
  extractOriginalLyricsOnly,
  extractTranslationLyricsOnly,
  LyricTargetLanguage,
  translateLyricsToBilingual,
} from '../utils/lrcParser';

const THEME_PALETTES: Record<string, TrackColorPalette> = {
  burgundy: {
    primary: '#e8437f',
    secondary: '#9d2c6b',
    deep: '#1a050d',
    rgbPrimary: [232, 67, 127],
    rgbSecondary: [157, 44, 107],
  },
  violet: {
    primary: '#a855f7',
    secondary: '#ec4899',
    deep: '#150723',
    rgbPrimary: [168, 85, 247],
    rgbSecondary: [236, 72, 153],
  },
  emerald: {
    primary: '#10b981',
    secondary: '#06b6d4',
    deep: '#051916',
    rgbPrimary: [16, 185, 129],
    rgbSecondary: [6, 182, 212],
  },
};

interface MusicContextValue {
  activePage: NavPage;
  setActivePage: (p: NavPage) => void;
  tracks: TrackMetadata[];
  playlists: Playlist[];
  queueIds: string[];
  currentTrack: TrackMetadata | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  isQueueOpen: boolean;
  setIsQueueOpen: (open: boolean) => void;
  showLyricsInPlayer: boolean;
  setShowLyricsInPlayer: (show: boolean) => void;
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
  audioSettings: AudioDspSettings;
  personalization: PersonalizationSettings;
  activePalette: TrackColorPalette;
  isImporting: boolean;
  importProgress: string | null;
  toastMessage: string | null;
  showToast: (msg: string) => void;

  // Playback controls
  playTrackById: (id: string, customQueue?: string[]) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  playNext: (manual?: boolean) => Promise<void>;
  playPrev: () => Promise<void>;
  seekTo: (timeSec: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;

  // Queue operations
  enqueueTrack: (id: string) => void;
  removeFromQueue: (id: string) => void;
  clearQueue: () => void;

  // Library & Metadata
  importLocalFiles: (files: FileList | File[]) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  deleteTrack: (id: string) => Promise<void>;
  updateTrackCover: (id: string, imageFile: File) => Promise<void>;
  updateTrackCoverFromUrl: (id: string, remoteUrl: string) => Promise<void>;
  updateTrackLyrics: (id: string, lyricsRaw: string) => Promise<void>;
  saveSeparatedTrackLyrics: (
    id: string,
    params: {
      pairs: LyricPairRecord[];
      metaPatch?: Partial<TrackTranslationMeta>;
    }
  ) => Promise<void>;
  applyTranslationResultToTrack: (
    trackId: string,
    result: {
      bilingualLyrics: string;
      originalLyricsRaw: string;
      translatedLyricsRaw: string;
      lyricPairs: LyricPairRecord[];
      providerId?: string;
      providerName?: string;
      modelUsed?: string;
      style?: LyricTranslationStyle;
      customStylePrompt?: string;
      targetLanguage?: string;
    }
  ) => Promise<void>;
  restoreOriginalLyrics: (id: string) => Promise<void>;
  restoreOriginalAiTranslation: (id: string) => Promise<void>;
  translateTrackLyrics: (
    id: string,
    targetLanguage?: LyricTargetLanguage,
    style?: string,
    providerId?: string,
    modelName?: string,
    options?: { customStylePrompt?: string; force?: boolean }
  ) => Promise<void>;
  isTranslatingLyrics: boolean;
  updateLyricsOffset: (id: string, offsetMs: number) => Promise<void>;
  loadDemoLibrary: () => Promise<void>;
  resetLibrary: () => Promise<void>;

  // Playlists
  createPlaylist: (name: string, description?: string) => Promise<Playlist>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
  addTrackToPlaylist: (playlistId: string, trackId: string) => Promise<void>;
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => Promise<void>;
  playPlaylist: (playlistId: string, startTrackId?: string) => Promise<void>;

  // Settings
  updateAudioSettings: (patch: Partial<AudioDspSettings>) => void;
  resetAudioSettings: () => void;
  updatePersonalization: (patch: Partial<PersonalizationSettings>) => void;

  // Stem Cache & Decoupled Playback Sync (task execution lives in TaskCenterContext)
  stemMetas: Record<string, TrackStemsMeta>;
  currentTrackStemMeta: TrackStemsMeta | null;
  separationEngineMode: SeparationEngineMode;
  setSeparationEngineMode: (mode: SeparationEngineMode) => void;
  refreshStemMetas: (
    updatedTrackId?: string,
    autoEnableIfLoaded?: boolean
  ) => Promise<void>;
  importTrackAndStemsToPlayer: (trackId: string) => Promise<void>;
  pauseMainPlayer: () => void;
  removeTrackStems: (trackId: string) => Promise<void>;
  reloadAllLibraryData: () => Promise<void>;

  // Per-song MV background & audio-video sync
  mvConfigs: Record<string, TrackMvConfig>;
  currentTrackMv: TrackMvConfig | null;
  mvRuntimeStatus: MvRuntimeStatus;
  setMvRuntimeStatus: (status: MvRuntimeStatus) => void;
  mvRetrySignal: number;
  triggerMvRetry: () => void;
  saveTrackMvConfig: (config: TrackMvConfig) => Promise<void>;
  uploadLocalMvForTrack: (trackId: string, file: File) => Promise<TrackMvConfig>;
  removeTrackMv: (trackId: string) => Promise<void>;
  toggleTrackMvEnabled: (trackId: string, enabled?: boolean) => Promise<void>;
  markTrackMvLinkBroken: (trackId: string, broken: boolean) => Promise<void>;
}

const MusicContext = createContext<MusicContextValue | null>(null);

export const MusicProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [activePage, setActivePage] = useState<NavPage>('player');
  const [tracks, setTracks] = useState<TrackMetadata[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('all');

  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [showLyricsInPlayer, setShowLyricsInPlayer] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [audioSettings, setAudioSettings] = useState<AudioDspSettings>(
    DEFAULT_AUDIO_SETTINGS
  );
  const [personalization, setPersonalization] = useState<PersonalizationSettings>(
    DEFAULT_PERSONALIZATION
  );

  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [isTranslatingLyrics, setIsTranslatingLyrics] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [stemMetas, setStemMetas] = useState<Record<string, TrackStemsMeta>>({});
  const [separationEngineMode, setSeparationEngineMode] =
    useState<SeparationEngineMode>('auto');

  const [mvConfigs, setMvConfigs] = useState<Record<string, TrackMvConfig>>({});
  const [mvRuntimeStatus, setMvRuntimeStatus] = useState<MvRuntimeStatus>({
    state: 'inactive',
    mvCurrentTime: 0,
    mvDuration: 0,
    driftSec: 0,
  });
  const [mvRetrySignal, setMvRetrySignal] = useState(0);

  const toastTimerRef = useRef<number | null>(null);
  const loadedTrackIdRef = useRef<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
    }, 3400);
  }, []);

  const currentTrack = useMemo(
    () => tracks.find((t) => t.id === currentTrackId) || null,
    [tracks, currentTrackId]
  );

  const currentTrackStemMeta = useMemo(
    () => (currentTrackId ? stemMetas[currentTrackId] || null : null),
    [currentTrackId, stemMetas]
  );

  const currentTrackMv = useMemo(
    () => (currentTrackId ? mvConfigs[currentTrackId] || null : null),
    [currentTrackId, mvConfigs]
  );

  const activePalette = useMemo<TrackColorPalette>(() => {
    if (personalization.themePreset !== 'adaptive') {
      return THEME_PALETTES[personalization.themePreset] || DEFAULT_PALETTE;
    }
    if (personalization.followCoverColor && currentTrack?.palette) {
      return currentTrack.palette;
    }
    return DEFAULT_PALETTE;
  }, [personalization, currentTrack]);

  // Keep CSS variables updated with active palette
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--lumina-accent', activePalette.primary);
    root.style.setProperty('--lumina-secondary', activePalette.secondary);
    root.style.setProperty('--lumina-bg-deep', activePalette.deep);
  }, [activePalette]);

  // Refs for latest state inside audio event listeners
  const stateRef = useRef({
    tracks,
    queueIds,
    currentTrackId,
    shuffle,
    repeat,
  });
  stateRef.current = { tracks, queueIds, currentTrackId, shuffle, repeat };

  const loadBlobIntoEngine = useCallback(
    async (track: TrackMetadata, autoplay: boolean) => {
      const blob = await getAudioBlob(track.id);
      if (!blob) {
        showToast('未找到音频文件数据，请重新导入该歌曲');
        return;
      }
      audioEngine.loadBlob(blob);
      loadedTrackIdRef.current = track.id;
      setCurrentTrackId(track.id);
      setCurrentTime(0);
      setDuration(track.duration || 0);

      // Hydrate cached AI-separated stems if available for this track
      getTrackStems(track.id)
        .then((stems) => {
          if (stems && loadedTrackIdRef.current === track.id) {
            return audioEngine.loadStems(
              track.id,
              stems.vocalBlob,
              stems.instrumentalBlob
            );
          }
        })
        .catch((err) => {
          console.warn('Failed to hydrate cached stems:', err);
        });

      if (autoplay) {
        try {
          await audioEngine.play();
        } catch (err) {
          console.warn('Autoplay blocked until gesture:', err);
          setIsPlaying(false);
        }
      }
    },
    [showToast]
  );

  const playTrackById = useCallback(
    async (id: string, customQueue?: string[]) => {
      const target = stateRef.current.tracks.find((t) => t.id === id);
      if (!target) return;

      if (customQueue) {
        setQueueIds(customQueue);
      } else if (!stateRef.current.queueIds.includes(id)) {
        setQueueIds((prev) => (prev.length > 0 ? [...prev, id] : [id]));
      }

      savePlaybackPrefs({
        volume,
        muted,
        shuffle: stateRef.current.shuffle,
        repeat: stateRef.current.repeat,
        lastTrackId: id,
      }).catch(() => {});

      if (loadedTrackIdRef.current === id && audioEngine.element.src) {
        await audioEngine.play();
      } else {
        await loadBlobIntoEngine(target, true);
      }
    },
    [loadBlobIntoEngine, muted, volume]
  );

  const playNext = useCallback(
    async (manual = true) => {
      const { queueIds: q, tracks: all, currentTrackId: curId, shuffle: shuf, repeat: rep } =
        stateRef.current;
      const list = q.length > 0 ? q : all.map((t) => t.id);
      if (list.length === 0) return;

      if (!manual && rep === 'one') {
        audioEngine.seek(0);
        await audioEngine.play();
        return;
      }

      const curIdx = curId ? list.indexOf(curId) : -1;
      let nextIdx = 0;

      if (shuf && list.length > 1) {
        const candidates = list.filter((id) => id !== curId);
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        await playTrackById(pick);
        return;
      } else {
        nextIdx = curIdx + 1;
        if (nextIdx >= list.length) {
          if (!manual && rep === 'off') {
            audioEngine.pause();
            audioEngine.seek(0);
            setIsPlaying(false);
            return;
          }
          nextIdx = 0;
        }
      }

      await playTrackById(list[nextIdx]);
    },
    [playTrackById]
  );

  const playPrev = useCallback(async () => {
    if (audioEngine.element.currentTime > 3) {
      audioEngine.seek(0);
      return;
    }
    const { queueIds: q, tracks: all, currentTrackId: curId } = stateRef.current;
    const list = q.length > 0 ? q : all.map((t) => t.id);
    if (list.length === 0) return;
    const curIdx = curId ? list.indexOf(curId) : 0;
    const prevIdx = (curIdx - 1 + list.length) % list.length;
    await playTrackById(list[prevIdx]);
  }, [playTrackById]);

  const togglePlayPause = useCallback(async () => {
    const el = audioEngine.element;
    if (!currentTrack && tracks.length > 0) {
      await playTrackById(tracks[0].id, tracks.map((t) => t.id));
      return;
    }
    if (!currentTrack) {
      showToast('请先在「我的音乐」中导入本地歌曲');
      return;
    }

    if (el.paused) {
      if (loadedTrackIdRef.current !== currentTrack.id || !el.src) {
        await loadBlobIntoEngine(currentTrack, true);
      } else {
        await audioEngine.play();
      }
    } else {
      audioEngine.pause();
    }
  }, [currentTrack, tracks, playTrackById, loadBlobIntoEngine, showToast]);

  // Initial hydrate from IndexedDB
  useEffect(() => {
    let cancelled = false;
    async function init() {
      const [loadedAudio, loadedPers, loadedPrefs] = await Promise.all([
        loadAudioSettings(),
        loadPersonalization(),
        loadPlaybackPrefs(),
      ]);
      if (cancelled) return;

      setAudioSettings(loadedAudio);
      audioEngine.applySettings(loadedAudio);
      setPersonalization(loadedPers);
      setVolumeState(loadedPrefs.volume);
      setMuted(loadedPrefs.muted);
      setShuffle(loadedPrefs.shuffle);
      setRepeat(loadedPrefs.repeat);
      audioEngine.setVolume(loadedPrefs.volume, loadedPrefs.muted);

      let existingTracks = await getAllTracks();
      const seeded = await hasInitializedDemo();

      if (existingTracks.length === 0 && !seeded) {
        try {
          const demos = await generateDemoTracks();
          for (const d of demos) {
            await saveTrackWithBlob(d.track, d.blob);
          }
          await markDemoInitialized();
          existingTracks = await getAllTracks();
        } catch (err) {
          console.warn('Demo seed skipped:', err);
        }
      }

      if (cancelled) return;
      const [existingPlaylists, existingStemMetas, existingMvConfigs] = await Promise.all([
        getAllPlaylists(),
        getAllStemMetas(),
        getAllMvConfigs(),
      ]);
      if (cancelled) return;

      const metaMap: Record<string, TrackStemsMeta> = {};
      for (const m of existingStemMetas) {
        metaMap[m.trackId] = m;
      }

      const mvMap: Record<string, TrackMvConfig> = {};
      for (const mv of existingMvConfigs) {
        mvMap[mv.songId] = mv;
      }

      setTracks(existingTracks);
      setPlaylists(existingPlaylists);
      setStemMetas(metaMap);
      setMvConfigs(mvMap);
      setQueueIds(existingTracks.map((t) => t.id));

      const preferred =
        existingTracks.find((t) => t.id === loadedPrefs.lastTrackId) ||
        existingTracks[0];

      if (preferred) {
        await loadBlobIntoEngine(preferred, false);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [loadBlobIntoEngine]);

  // Bind HTMLAudioElement listeners
  useEffect(() => {
    const el = audioEngine.element;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(el.currentTime || 0);
    const onLoadedMeta = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration);
      }
    };
    const onEnded = () => {
      playNext(false);
    };
    const onError = () => {
      setIsPlaying(false);
      showToast('当前音频解码失败，可能不受此浏览器支持');
    };

    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('loadedmetadata', onLoadedMeta);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);

    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('loadedmetadata', onLoadedMeta);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
    };
  }, [playNext, showToast]);

  // Media Session API for Android Chrome hardware/lockscreen controls
  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album,
      artwork: currentTrack.coverDataUrl
        ? [{ src: currentTrack.coverDataUrl, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    });
    navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext(true));
  }, [currentTrack, togglePlayPause, playPrev, playNext]);

  const seekTo = useCallback((timeSec: number) => {
    audioEngine.seek(timeSec);
    setCurrentTime(timeSec);
  }, []);

  const setVolume = useCallback(
    (vol: number) => {
      const clamped = Math.max(0, Math.min(1, vol));
      setVolumeState(clamped);
      const nextMuted = clamped === 0;
      setMuted(nextMuted);
      audioEngine.setVolume(clamped, nextMuted);
      savePlaybackPrefs({
        volume: clamped,
        muted: nextMuted,
        shuffle,
        repeat,
        lastTrackId: currentTrackId || undefined,
      }).catch(() => {});
    },
    [shuffle, repeat, currentTrackId]
  );

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    audioEngine.setVolume(volume, next);
  }, [muted, volume]);

  const toggleShuffle = useCallback(() => {
    setShuffle((prev) => {
      const next = !prev;
      savePlaybackPrefs({
        volume,
        muted,
        shuffle: next,
        repeat,
        lastTrackId: currentTrackId || undefined,
      }).catch(() => {});
      return next;
    });
  }, [volume, muted, repeat, currentTrackId]);

  const cycleRepeat = useCallback(() => {
    setRepeat((prev) => {
      const next: RepeatMode = prev === 'all' ? 'one' : prev === 'one' ? 'off' : 'all';
      savePlaybackPrefs({
        volume,
        muted,
        shuffle,
        repeat: next,
        lastTrackId: currentTrackId || undefined,
      }).catch(() => {});
      return next;
    });
  }, [volume, muted, shuffle, currentTrackId]);

  const enqueueTrack = useCallback(
    (id: string) => {
      setQueueIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      showToast('已添加到播放队列');
    },
    [showToast]
  );

  const removeFromQueue = useCallback((id: string) => {
    setQueueIds((prev) => prev.filter((item) => item !== id));
  }, []);

  const clearQueue = useCallback(() => {
    setQueueIds(currentTrackId ? [currentTrackId] : []);
  }, [currentTrackId]);

  const importLocalFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const importMode: 'lean' | 'full' = personalization.importMode || 'lean';
      const allSelected = Array.from(fileList);
      const files = allSelected.filter((f) => isSupportedAudioFile(f));

      if (files.length === 0) {
        showToast('未检测到支持的音频文件 (MP3 / FLAC / WAV / AAC / M4A / OGG / OPUS)');
        return;
      }

      // In full mode only, collect companion .lrc files dropped in the same batch matched by filename stem
      const companionLrcMap = new Map<string, string>();
      if (importMode === 'full') {
        for (const f of allSelected) {
          if (f.name.toLowerCase().endsWith('.lrc')) {
            const stem = f.name.replace(/\.[^.]+$/, '').toLowerCase();
            try {
              const txt = await f.text();
              if (txt.trim()) companionLrcMap.set(stem, txt);
            } catch {
              // ignore unreadable lrc
            }
          }
        }
      }

      setIsImporting(true);
      let importedCount = 0;
      const newlyAdded: TrackMetadata[] = [];

      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          setImportProgress(`正在解析 ${i + 1}/${files.length}: ${file.name}`);
          const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
          const companionLrc =
            importMode === 'full' ? companionLrcMap.get(stem) : undefined;
          const track = await parseAudioFileToTrack(file, importMode, companionLrc);
          await saveTrackWithBlob(track, file);
          newlyAdded.push(track);
          importedCount++;
        }

        const refreshed = await getAllTracks();
        setTracks(refreshed);
        setQueueIds((prev) => {
          const addedIds = newlyAdded.map((t) => t.id);
          return Array.from(new Set([...prev, ...addedIds]));
        });

        if (!currentTrackId && newlyAdded.length > 0) {
          await loadBlobIntoEngine(newlyAdded[0], false);
        }

        showToast(
          importMode === 'lean'
            ? `已精简导入 ${importedCount} 首本地歌曲（仅音频与封面）`
            : `成功完整导入 ${importedCount} 首本地歌曲`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : '导入歌曲时发生错误';
        showToast(msg);
      } finally {
        setIsImporting(false);
        setImportProgress(null);
      }
    },
    [currentTrackId, loadBlobIntoEngine, personalization.importMode, showToast]
  );

  const toggleFavorite = useCallback(async (id: string) => {
    setTracks((prev) => {
      const target = prev.find((t) => t.id === id);
      if (!target) return prev;
      const updated = { ...target, favorite: !target.favorite };
      updateTrackMetadata(updated).catch(() => {});
      return prev.map((t) => (t.id === id ? updated : t));
    });
  }, []);

  const deleteTrack = useCallback(
    async (id: string) => {
      await deleteTrackById(id);
      setTracks((prev) => prev.filter((t) => t.id !== id));
      setStemMetas((prev) => {
        if (!prev[id]) return prev;
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      setMvConfigs((prev) => {
        if (!prev[id]) return prev;
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      setQueueIds((prev) => prev.filter((qId) => qId !== id));
      setPlaylists((prev) =>
        prev.map((pl) => {
          if (!pl.trackIds.includes(id)) return pl;
          const updatedPl = {
            ...pl,
            trackIds: pl.trackIds.filter((tid) => tid !== id),
            updatedAt: Date.now(),
          };
          savePlaylist(updatedPl).catch(() => {});
          return updatedPl;
        })
      );

      if (currentTrackId === id) {
        audioEngine.pause();
        audioEngine.clearStems();
        setIsPlaying(false);
        setCurrentTrackId(null);
        loadedTrackIdRef.current = null;
      }
      showToast('已从曲库删除歌曲');
    },
    [currentTrackId, showToast]
  );

  const updateTrackCover = useCallback(
    async (id: string, imageFile: File) => {
      const target = stateRef.current.tracks.find((t) => t.id === id);
      if (!target) return;
      const coverDataUrl = await resizeCoverToDataUrl(imageFile);
      const palette = await extractPaletteFromImage(coverDataUrl);
      const updated = { ...target, coverDataUrl, palette };
      await updateTrackMetadata(updated);
      setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      showToast('专辑封面已更新并同步配色');
    },
    [showToast]
  );

  const updateTrackCoverFromUrl = useCallback(
    async (id: string, remoteUrl: string) => {
      const target = stateRef.current.tracks.find((t) => t.id === id);
      if (!target) return;
      const proxiedUrl = getProxiedCoverUrl(remoteUrl);
      const res = await fetch(proxiedUrl);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `下载封面失败 (${res.status})`);
      }
      const blob = await res.blob();
      const coverDataUrl = await resizeCoverToDataUrl(blob);
      const palette = await extractPaletteFromImage(coverDataUrl);
      const updated = { ...target, coverDataUrl, palette };
      await updateTrackMetadata(updated);
      setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      showToast('在线专辑封面已应用并同步配色');
    },
    [showToast]
  );

  const updateTrackLyrics = useCallback(
    async (id: string, lyricsRaw: string) => {
      const target = stateRef.current.tracks.find((t) => t.id === id);
      if (!target) return;
      const origClean = extractOriginalLyricsOnly(lyricsRaw);
      const transClean = extractTranslationLyricsOnly(lyricsRaw);
      const pairs = buildLyricPairsFromRaw(lyricsRaw);
      const updated: TrackMetadata = {
        ...target,
        lyricsRaw,
        originalLyricsRaw: origClean || lyricsRaw,
        translatedLyricsRaw: transClean || undefined,
        lyricPairs: pairs,
      };
      await updateTrackMetadata(updated);
      setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      showToast('歌词已保存（原文与译文已分别归档）');
    },
    [showToast]
  );

  const saveSeparatedTrackLyrics = useCallback(
    async (
      id: string,
      params: { pairs: LyricPairRecord[]; metaPatch?: Partial<TrackTranslationMeta> }
    ) => {
      const target = stateRef.current.tracks.find((t) => t.id === id);
      if (!target) return;
      const rebuilt = buildSeparatedLyricsFromPairs(params.pairs);
      const updated: TrackMetadata = {
        ...target,
        lyricsRaw: rebuilt.bilingualLyrics,
        originalLyricsRaw: rebuilt.originalLyricsRaw,
        translatedLyricsRaw: rebuilt.translatedLyricsRaw || undefined,
        lyricPairs: params.pairs,
        translationMeta: params.metaPatch
          ? { ...(target.translationMeta || {}), ...params.metaPatch }
          : target.translationMeta,
      };
      await updateTrackMetadata(updated);
      setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      showToast('原文与译文歌词已分别保存');
    },
    [showToast]
  );

  const applyTranslationResultToTrack = useCallback(
    async (
      trackId: string,
      result: {
        bilingualLyrics: string;
        originalLyricsRaw: string;
        translatedLyricsRaw: string;
        lyricPairs: LyricPairRecord[];
        providerId?: string;
        providerName?: string;
        modelUsed?: string;
        style?: LyricTranslationStyle;
        customStylePrompt?: string;
        targetLanguage?: string;
      }
    ) => {
      const target = stateRef.current.tracks.find((t) => t.id === trackId);
      if (!target) return;
      const updated: TrackMetadata = {
        ...target,
        lyricsRaw: result.bilingualLyrics,
        originalLyricsRaw: result.originalLyricsRaw || target.originalLyricsRaw,
        translatedLyricsRaw: result.translatedLyricsRaw,
        lyricPairs: result.lyricPairs,
        translationMeta: {
          providerId: result.providerId,
          providerName: result.providerName,
          modelName: result.modelUsed,
          style: result.style || 'poetic',
          customStylePrompt: result.customStylePrompt,
          targetLanguage: result.targetLanguage || 'zh-CN',
          translatedAt: Date.now(),
          initialAiTranslatedRaw: result.translatedLyricsRaw,
          initialAiBilingualRaw: result.bilingualLyrics,
        },
      };
      await updateTrackMetadata(updated);
      setTracks((prev) => prev.map((t) => (t.id === trackId ? updated : t)));
      setPersonalization((prev) => {
        if (prev.showBilingualLyrics) return prev;
        const next = { ...prev, showBilingualLyrics: true };
        savePersonalization(next).catch(() => {});
        return next;
      });
    },
    []
  );

  const restoreOriginalLyrics = useCallback(
    async (id: string) => {
      const target = stateRef.current.tracks.find((t) => t.id === id);
      if (!target) return;
      const cleanOrig =
        target.originalLyricsRaw?.trim() ||
        extractOriginalLyricsOnly(target.lyricsRaw);
      if (!cleanOrig) {
        showToast('当前歌曲没有可恢复的原始歌词');
        return;
      }
      const pairs = buildLyricPairsFromRaw(cleanOrig).map((p) => ({
        ...p,
        translatedText: '',
      }));
      const updated: TrackMetadata = {
        ...target,
        lyricsRaw: cleanOrig,
        originalLyricsRaw: cleanOrig,
        translatedLyricsRaw: undefined,
        lyricPairs: pairs,
      };
      await updateTrackMetadata(updated);
      setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      showToast('已恢复纯粹原始歌词（保留完整时间轴）');
    },
    [showToast]
  );

  const restoreOriginalAiTranslation = useCallback(
    async (id: string) => {
      const target = stateRef.current.tracks.find((t) => t.id === id);
      if (!target) return;
      const initialTrans = target.translationMeta?.initialAiTranslatedRaw;
      const initialBilingual = target.translationMeta?.initialAiBilingualRaw;
      if (!initialTrans && !initialBilingual) {
        showToast('暂无可恢复的初始 AI 翻译记录');
        return;
      }
      const restoredBilingual =
        initialBilingual || target.lyricsRaw || '';
      const pairs = buildLyricPairsFromRaw(restoredBilingual);
      const updated: TrackMetadata = {
        ...target,
        lyricsRaw: restoredBilingual,
        translatedLyricsRaw: initialTrans || extractTranslationLyricsOnly(restoredBilingual),
        lyricPairs: pairs,
      };
      await updateTrackMetadata(updated);
      setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      showToast('已恢复最初保存的 AI 翻译结果');
    },
    [showToast]
  );

  const translateTrackLyrics = useCallback(
    async (
      id: string,
      targetLanguage: LyricTargetLanguage = 'zh-CN',
      style: string = 'poetic',
      providerId?: string,
      modelName?: string,
      options?: { customStylePrompt?: string; force?: boolean }
    ) => {
      const target = stateRef.current.tracks.find((t) => t.id === id);
      const sourceLyrics = target?.originalLyricsRaw || target?.lyricsRaw;
      if (!target || !sourceLyrics) return;
      setIsTranslatingLyrics(true);
      try {
        const res = await translateLyricsToBilingual(
          sourceLyrics,
          target.title,
          target.artist,
          targetLanguage,
          style,
          providerId,
          modelName,
          options?.customStylePrompt,
          options?.force ?? true
        );
        if (res.translatedCount > 0) {
          await applyTranslationResultToTrack(id, {
            bilingualLyrics: res.bilingualLyrics,
            originalLyricsRaw: res.originalLyricsRaw || sourceLyrics,
            translatedLyricsRaw: res.translatedLyricsRaw,
            lyricPairs: res.lyricPairs,
            providerId: res.providerId || providerId,
            providerName: res.providerName,
            modelUsed: res.modelUsed || modelName,
            style: (res.style as LyricTranslationStyle) || (style as LyricTranslationStyle),
            customStylePrompt: options?.customStylePrompt,
            targetLanguage,
          });
          showToast(
            `已完成 ${res.translatedCount} 句歌词翻译 (${res.modelUsed || res.providerName || 'AI'})`
          );
        } else if (res.skippedReason === 'already_bilingual') {
          showToast('当前歌词已包含双语译文');
        } else {
          showToast('当前歌词无需翻译或已为目标语言');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : '歌词翻译失败，请稍后重试');
      } finally {
        setIsTranslatingLyrics(false);
      }
    },
    [applyTranslationResultToTrack, showToast]
  );

  const updateLyricsOffset = useCallback(
    async (id: string, offsetMs: number) => {
      const target = tracks.find((t) => t.id === id);
      if (!target) return;
      const updated = { ...target, lyricsOffsetMs: offsetMs };
      await updateTrackMetadata(updated);
      setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    },
    [tracks]
  );

  const loadDemoLibrary = useCallback(async () => {
    const demos = await generateDemoTracks();
    for (const d of demos) {
      await saveTrackWithBlob(d.track, d.blob);
    }
    const refreshed = await getAllTracks();
    setTracks(refreshed);
    setQueueIds(refreshed.map((t) => t.id));
    if (refreshed.length > 0 && !currentTrackId) {
      await loadBlobIntoEngine(refreshed[0], false);
    }
    showToast('已重新加载内置无损 WAV 示例曲目');
  }, [currentTrackId, loadBlobIntoEngine, showToast]);

  const resetLibrary = useCallback(async () => {
    audioEngine.pause();
    audioEngine.clearStems();
    setIsPlaying(false);
    setCurrentTrackId(null);
    loadedTrackIdRef.current = null;
    await clearAllMusicData();
    setTracks([]);
    setPlaylists([]);
    setStemMetas({});
    setMvConfigs({});
    setQueueIds([]);
    showToast('本地曲库与播放列表已清空');
  }, [showToast]);

  // Playlist operations
  const createPlaylist = useCallback(
    async (name: string, description?: string) => {
      const pl: Playlist = {
        id: crypto.randomUUID ? crypto.randomUUID() : `pl-${Date.now()}`,
        name: name.trim() || '新建播放列表',
        description: description?.trim(),
        trackIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await savePlaylist(pl);
      setPlaylists((prev) => [...prev, pl]);
      showToast(`已创建播放列表「${pl.name}」`);
      return pl;
    },
    [showToast]
  );

  const renamePlaylist = useCallback(async (id: string, name: string) => {
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id !== id) return pl;
        const updated = { ...pl, name: name.trim() || pl.name, updatedAt: Date.now() };
        savePlaylist(updated).catch(() => {});
        return updated;
      })
    );
  }, []);

  const deletePlaylist = useCallback(
    async (id: string) => {
      await deletePlaylistById(id);
      setPlaylists((prev) => prev.filter((p) => p.id !== id));
      showToast('已删除播放列表');
    },
    [showToast]
  );

  const addTrackToPlaylist = useCallback(
    async (playlistId: string, trackId: string) => {
      const target = playlists.find((p) => p.id === playlistId);
      if (!target) return;
      if (target.trackIds.includes(trackId)) {
        showToast('歌曲已在该播放列表中');
        return;
      }
      const updated: Playlist = {
        ...target,
        trackIds: [...target.trackIds, trackId],
        updatedAt: Date.now(),
      };
      await savePlaylist(updated);
      setPlaylists((prev) => prev.map((p) => (p.id === playlistId ? updated : p)));
      showToast(`已添加到「${target.name}」`);
    },
    [playlists, showToast]
  );

  const removeTrackFromPlaylist = useCallback(
    async (playlistId: string, trackId: string) => {
      const target = playlists.find((p) => p.id === playlistId);
      if (!target) return;
      const updated: Playlist = {
        ...target,
        trackIds: target.trackIds.filter((id) => id !== trackId),
        updatedAt: Date.now(),
      };
      await savePlaylist(updated);
      setPlaylists((prev) => prev.map((p) => (p.id === playlistId ? updated : p)));
    },
    [playlists]
  );

  const playPlaylist = useCallback(
    async (playlistId: string, startTrackId?: string) => {
      const pl = playlists.find((p) => p.id === playlistId);
      if (!pl || pl.trackIds.length === 0) {
        showToast('该播放列表暂无歌曲');
        return;
      }
      const validIds = pl.trackIds.filter((id) => tracks.some((t) => t.id === id));
      if (validIds.length === 0) return;
      const targetId = startTrackId && validIds.includes(startTrackId) ? startTrackId : validIds[0];
      await playTrackById(targetId, validIds);
      setActivePage('player');
    },
    [playlists, tracks, playTrackById, showToast]
  );

  // Settings updates
  const updateAudioSettings = useCallback((patch: Partial<AudioDspSettings>) => {
    setAudioSettings((prev) => {
      const next = { ...prev, ...patch };
      audioEngine.applySettings(next);
      saveAudioSettings(next).catch(() => {});
      return next;
    });
  }, []);

  const resetAudioSettings = useCallback(() => {
    setAudioSettings(DEFAULT_AUDIO_SETTINGS);
    audioEngine.applySettings(DEFAULT_AUDIO_SETTINGS);
    saveAudioSettings(DEFAULT_AUDIO_SETTINGS).catch(() => {});
    showToast('音效与均衡器已恢复默认设置');
  }, [showToast]);

  const updatePersonalization = useCallback(
    (patch: Partial<PersonalizationSettings>) => {
      setPersonalization((prev) => {
        const next = { ...prev, ...patch };
        savePersonalization(next).catch(() => {});
        return next;
      });
    },
    []
  );

  const refreshStemMetas = useCallback(
    async (updatedTrackId?: string, autoEnableIfLoaded = false) => {
      const metas = await getAllStemMetas();
      const metaMap: Record<string, TrackStemsMeta> = {};
      for (const m of metas) {
        metaMap[m.trackId] = m;
      }
      setStemMetas(metaMap);

      if (updatedTrackId && loadedTrackIdRef.current === updatedTrackId) {
        const record = await getTrackStems(updatedTrackId);
        if (record && loadedTrackIdRef.current === updatedTrackId) {
          await audioEngine.loadStems(
            updatedTrackId,
            record.vocalBlob,
            record.instrumentalBlob
          );
          if (autoEnableIfLoaded) {
            setAudioSettings((prev) => {
              const next = { ...prev, stemModeActive: true };
              audioEngine.applySettings(next);
              saveAudioSettings(next).catch(() => {});
              return next;
            });
          }
        }
      }
    },
    []
  );

  const importTrackAndStemsToPlayer = useCallback(
    async (trackId: string) => {
      const target = stateRef.current.tracks.find((t) => t.id === trackId);
      if (!target) {
        showToast('未在曲库中找到该任务对应的歌曲');
        return;
      }
      await playTrackById(trackId);
      const stems = await getTrackStems(trackId);
      if (stems && loadedTrackIdRef.current === trackId) {
        await audioEngine.loadStems(trackId, stems.vocalBlob, stems.instrumentalBlob);
        setAudioSettings((prev) => {
          const next = { ...prev, stemModeActive: true };
          audioEngine.applySettings(next);
          saveAudioSettings(next).catch(() => {});
          return next;
        });
      }
      setActivePage('player');
      showToast(`已将「${target.title}」及分离音轨导入播放器`);
    },
    [playTrackById, showToast]
  );

  const pauseMainPlayer = useCallback(() => {
    if (!audioEngine.element.paused) {
      audioEngine.pause();
    }
  }, []);

  const reloadAllLibraryData = useCallback(async () => {
    const [
      loadedAudio,
      loadedPers,
      loadedPrefs,
      allTracks,
      allPlaylists,
      allMetas,
      allMvConfigs,
    ] = await Promise.all([
      loadAudioSettings(),
      loadPersonalization(),
      loadPlaybackPrefs(),
      getAllTracks(),
      getAllPlaylists(),
      getAllStemMetas(),
      getAllMvConfigs(),
    ]);

    setAudioSettings(loadedAudio);
    audioEngine.applySettings(loadedAudio);
    setPersonalization(loadedPers);
    setVolumeState(loadedPrefs.volume);
    setMuted(loadedPrefs.muted);
    setShuffle(loadedPrefs.shuffle);
    setRepeat(loadedPrefs.repeat);
    audioEngine.setVolume(loadedPrefs.volume, loadedPrefs.muted);

    const metaMap: Record<string, TrackStemsMeta> = {};
    for (const m of allMetas) {
      metaMap[m.trackId] = m;
    }

    const mvMap: Record<string, TrackMvConfig> = {};
    for (const mv of allMvConfigs) {
      mvMap[mv.songId] = mv;
    }

    setTracks(allTracks);
    setPlaylists(allPlaylists);
    setStemMetas(metaMap);
    setMvConfigs(mvMap);
    setQueueIds(allTracks.map((t) => t.id));

    const preferred =
      allTracks.find((t) => t.id === loadedPrefs.lastTrackId) || allTracks[0];
    if (preferred) {
      await loadBlobIntoEngine(preferred, false);
    }
  }, [loadBlobIntoEngine]);

  const removeTrackStems = useCallback(
    async (trackId: string) => {
      await deleteTrackStems(trackId);
      setStemMetas((prev) => {
        const copy = { ...prev };
        delete copy[trackId];
        return copy;
      });
      if (loadedTrackIdRef.current === trackId) {
        audioEngine.clearStems();
        updateAudioSettings({ stemModeActive: false });
      }
      showToast('已清除该曲目的分离音轨缓存');
    },
    [showToast, updateAudioSettings]
  );

  const mvConfigsRef = useRef(mvConfigs);
  mvConfigsRef.current = mvConfigs;

  const triggerMvRetry = useCallback(() => {
    setMvRetrySignal((n) => n + 1);
  }, []);

  const saveTrackMvConfig = useCallback(async (config: TrackMvConfig) => {
    const cleanConfig: TrackMvConfig = {
      ...config,
      updatedAt: Date.now(),
    };
    await saveMvConfig(cleanConfig);
    setMvConfigs((prev) => ({ ...prev, [cleanConfig.songId]: cleanConfig }));
  }, []);

  const uploadLocalMvForTrack = useCallback(
    async (trackId: string, file: File): Promise<TrackMvConfig> => {
      const probed = await probeLocalVideoFile(file);
      const prev = mvConfigsRef.current[trackId];
      const localVideoId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? `mv-${trackId}-${crypto.randomUUID()}`
          : `mv-${trackId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      const nextConfig: TrackMvConfig = {
        songId: trackId,
        enabled: true,
        sourceType: 'local',
        title: probed.fileName.replace(/\.[^.]+$/, '') || probed.fileName,
        playableType: 'video',
        localVideoId,
        localFileName: probed.fileName,
        localMimeType: probed.mimeType,
        localFileSize: probed.fileSize,
        localDuration: probed.duration,
        localWidth: probed.width,
        localHeight: probed.height,
        syncOffsetSec: prev ? prev.syncOffsetSec : 0,
        displayMode: prev?.displayMode || DEFAULT_MV_VISUAL_SETTINGS.displayMode,
        scale: prev?.scale ?? DEFAULT_MV_VISUAL_SETTINGS.scale,
        cropX: prev?.cropX ?? DEFAULT_MV_VISUAL_SETTINGS.cropX,
        cropY: prev?.cropY ?? DEFAULT_MV_VISUAL_SETTINGS.cropY,
        brightness: prev?.brightness ?? DEFAULT_MV_VISUAL_SETTINGS.brightness,
        blurPx: prev?.blurPx ?? DEFAULT_MV_VISUAL_SETTINGS.blurPx,
        overlayOpacity: prev?.overlayOpacity ?? DEFAULT_MV_VISUAL_SETTINGS.overlayOpacity,
        endBehavior: prev?.endBehavior || DEFAULT_MV_VISUAL_SETTINGS.endBehavior,
        linkBroken: false,
        updatedAt: Date.now(),
      };

      await saveMvVideoWithConfig(nextConfig, file, prev?.localVideoId);
      setMvConfigs((old) => ({ ...old, [trackId]: nextConfig }));
      showToast(`已保存本地 MV「${probed.fileName}」并开启音画同步`);
      return nextConfig;
    },
    [showToast]
  );

  const removeTrackMv = useCallback(
    async (trackId: string) => {
      await deleteMvConfigAndBlob(trackId);
      setMvConfigs((prev) => {
        if (!prev[trackId]) return prev;
        const copy = { ...prev };
        delete copy[trackId];
        return copy;
      });
      if (loadedTrackIdRef.current === trackId) {
        setMvRuntimeStatus({
          state: 'inactive',
          mvCurrentTime: 0,
          mvDuration: 0,
          driftSec: 0,
        });
      }
      showToast('已清除当前歌曲的 MV 背景设置');
    },
    [showToast]
  );

  const toggleTrackMvEnabled = useCallback(
    async (trackId: string, enabled?: boolean) => {
      const existing = mvConfigsRef.current[trackId];
      if (!existing) return;
      const nextEnabled = enabled !== undefined ? enabled : !existing.enabled;
      const updated: TrackMvConfig = {
        ...existing,
        enabled: nextEnabled,
        linkBroken: nextEnabled ? false : existing.linkBroken,
        updatedAt: Date.now(),
      };
      await saveMvConfig(updated);
      setMvConfigs((prev) => ({ ...prev, [trackId]: updated }));
      if (!nextEnabled && loadedTrackIdRef.current === trackId) {
        setMvRuntimeStatus({
          state: 'inactive',
          mvCurrentTime: 0,
          mvDuration: 0,
          driftSec: 0,
        });
      }
      showToast(nextEnabled ? '已开启 MV 背景模式' : '已关闭 MV 背景，恢复动态背景');
    },
    [showToast]
  );

  const markTrackMvLinkBroken = useCallback(
    async (trackId: string, broken: boolean) => {
      const existing = mvConfigsRef.current[trackId];
      if (!existing || existing.linkBroken === broken) return;
      const updated: TrackMvConfig = {
        ...existing,
        linkBroken: broken,
        enabled: broken ? false : existing.enabled,
        updatedAt: Date.now(),
      };
      await saveMvConfig(updated);
      setMvConfigs((prev) => ({ ...prev, [trackId]: updated }));
    },
    []
  );

  // Sync native Fullscreen API & Escape key with immersive fullscreen mode
  useEffect(() => {
    const onFullscreenChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const nativeActive = Boolean(
        document.fullscreenElement || doc.webkitFullscreenElement
      );
      if (!nativeActive) {
        setIsFullscreen(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen]);

  const exitFullscreen = useCallback(async () => {
    setIsFullscreen(false);
    try {
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null;
        webkitExitFullscreen?: () => Promise<void> | void;
      };
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) {
        await doc.webkitExitFullscreen();
      }
    } catch {
      // Ignore native exit errors if iframe or browser restricted it
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await exitFullscreen();
      return;
    }
    setIsFullscreen(true);
    try {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        await el.webkitRequestFullscreen();
      }
    } catch {
      // If browser/iframe blocks native requestFullscreen, immersive full-viewport mode still activates cleanly
      showToast('已进入沉浸式全屏展示（按 ESC 或点击右上角退出）');
    }
  }, [isFullscreen, exitFullscreen, showToast]);

  const value: MusicContextValue = {
    activePage,
    setActivePage,
    tracks,
    playlists,
    queueIds,
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    volume,
    muted,
    shuffle,
    repeat,
    isQueueOpen,
    setIsQueueOpen,
    showLyricsInPlayer,
    setShowLyricsInPlayer,
    isFullscreen,
    toggleFullscreen,
    exitFullscreen,
    audioSettings,
    personalization,
    activePalette,
    isImporting,
    importProgress,
    toastMessage,
    showToast,
    playTrackById,
    togglePlayPause,
    playNext,
    playPrev,
    seekTo,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    enqueueTrack,
    removeFromQueue,
    clearQueue,
    importLocalFiles,
    toggleFavorite,
    deleteTrack,
    updateTrackCover,
    updateTrackCoverFromUrl,
    updateTrackLyrics,
    saveSeparatedTrackLyrics,
    applyTranslationResultToTrack,
    restoreOriginalLyrics,
    restoreOriginalAiTranslation,
    translateTrackLyrics,
    isTranslatingLyrics,
    updateLyricsOffset,
    loadDemoLibrary,
    resetLibrary,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    playPlaylist,
    updateAudioSettings,
    resetAudioSettings,
    updatePersonalization,
    stemMetas,
    currentTrackStemMeta,
    separationEngineMode,
    setSeparationEngineMode,
    refreshStemMetas,
    importTrackAndStemsToPlayer,
    pauseMainPlayer,
    removeTrackStems,
    reloadAllLibraryData,
    mvConfigs,
    currentTrackMv,
    mvRuntimeStatus,
    setMvRuntimeStatus,
    mvRetrySignal,
    triggerMvRetry,
    saveTrackMvConfig,
    uploadLocalMvForTrack,
    removeTrackMv,
    toggleTrackMvEnabled,
    markTrackMvLinkBroken,
  };

  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
};

export function useMusic(): MusicContextValue {
  const ctx = useContext(MusicContext);
  if (!ctx) throw new Error('useMusic must be used within MusicProvider');
  return ctx;
}
