import React, { useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from '../../audio/AudioEngine';
import { useMusic } from '../../context/MusicContext';
import { computeMvTargetState } from '../../services/mvService';
import { getMvBlob } from '../../services/storage';
import { MvRuntimeStatus } from '../../types/music';

function normalizeLoopDrift(
  targetTime: number,
  currentVideoTime: number,
  durationSec: number,
  loop: boolean
): number {
  let diff = targetTime - currentVideoTime;
  if (loop && durationSec > 2) {
    if (diff > durationSec / 2) diff -= durationSec;
    else if (diff < -durationSec / 2) diff += durationSec;
  }
  return diff;
}

export const MvBackgroundStage: React.FC = () => {
  const {
    activePage,
    currentTrack,
    currentTrackMv,
    setMvRuntimeStatus,
    mvRetrySignal,
    markTrackMvLinkBroken,
    personalization,
  } = useMusic();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastSeekAtRef = useRef<number>(0);
  const lastStatusReportAtRef = useRef<number>(0);
  const lastReportedStateRef = useRef<string>('');
  const autoplayBlockedRef = useRef<boolean>(false);

  const [resolvedVideoSrc, setResolvedVideoSrc] = useState<string | null>(null);
  const [videoDecodeFailed, setVideoDecodeFailed] = useState(false);

  const mvConfig = currentTrackMv;
  const shouldRenderMv = Boolean(
    activePage === 'player' &&
      currentTrack &&
      mvConfig &&
      mvConfig.enabled &&
      !mvConfig.linkBroken &&
      mvConfig.playableType !== 'external_only'
  );

  // Report explicit non-playable states cleanly when disabled or external-only
  useEffect(() => {
    if (!currentTrack || !mvConfig || !mvConfig.enabled) {
      setMvRuntimeStatus({
        state: 'inactive',
        mvCurrentTime: 0,
        mvDuration: 0,
        driftSec: 0,
      });
      return;
    }
    if (mvConfig.linkBroken) {
      setMvRuntimeStatus({
        state: 'link_broken',
        mvCurrentTime: 0,
        mvDuration: mvConfig.localDuration || 0,
        driftSec: 0,
        message: 'MV 资源失效或已丢失，请更换在线 MV 或重新上传本地视频',
      });
      return;
    }
    if (mvConfig.playableType === 'external_only') {
      setMvRuntimeStatus({
        state: 'external_only',
        mvCurrentTime: 0,
        mvDuration: 0,
        driftSec: 0,
        message: '该来源仅支持跳转原页面观看，不支持站内背景播放',
      });
    }
  }, [currentTrack, mvConfig, setMvRuntimeStatus]);

  // Resolve video src (Disk-backed Blob ObjectURL for local, HTTPS URL for online stream)
  useEffect(() => {
    setVideoDecodeFailed(false);
    autoplayBlockedRef.current = false;

    if (!shouldRenderMv || !mvConfig || mvConfig.playableType !== 'video') {
      setResolvedVideoSrc(null);
      return;
    }

    if (mvConfig.sourceType === 'online') {
      setResolvedVideoSrc(mvConfig.playableUrl || null);
      return;
    }

    // Local video: stream via URL.createObjectURL from IndexedDB Blob (zero heap copy)
    const videoId = mvConfig.localVideoId;
    if (!videoId) {
      setResolvedVideoSrc(null);
      void markTrackMvLinkBroken(mvConfig.songId, true);
      return;
    }

    let cancelled = false;
    let createdBlobUrl: string | null = null;

    setMvRuntimeStatus({
      state: 'loading',
      mvCurrentTime: 0,
      mvDuration: mvConfig.localDuration || 0,
      driftSec: 0,
      message: '正在加载本地 MV 视频...',
    });

    getMvBlob(videoId)
      .then((blob) => {
        if (cancelled) return;
        if (!blob || blob.size === 0) {
          setResolvedVideoSrc(null);
          setMvRuntimeStatus({
            state: 'link_broken',
            mvCurrentTime: 0,
            mvDuration: 0,
            driftSec: 0,
            message: '未找到本地 MV 视频数据，请重新上传',
          });
          void markTrackMvLinkBroken(mvConfig.songId, true);
          return;
        }
        createdBlobUrl = URL.createObjectURL(blob);
        setResolvedVideoSrc(createdBlobUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setResolvedVideoSrc(null);
        setMvRuntimeStatus({
          state: 'error',
          mvCurrentTime: 0,
          mvDuration: 0,
          driftSec: 0,
          message: '读取本地 MV 视频失败',
        });
      });

    return () => {
      cancelled = true;
      if (createdBlobUrl) {
        URL.revokeObjectURL(createdBlobUrl);
      }
    };
  }, [
    shouldRenderMv,
    mvConfig?.songId,
    mvConfig?.sourceType,
    mvConfig?.localVideoId,
    mvConfig?.playableType,
    mvConfig?.playableUrl,
    mvConfig?.localDuration,
    markTrackMvLinkBroken,
    setMvRuntimeStatus,
  ]);

  // Release HTMLVideoElement buffer explicitly whenever hidden/closed
  useEffect(() => {
    if (shouldRenderMv && mvConfig?.playableType === 'video' && resolvedVideoSrc) {
      return;
    }
    const vid = videoRef.current;
    if (vid) {
      vid.pause();
      vid.removeAttribute('src');
      vid.load();
    }
  }, [shouldRenderMv, mvConfig?.playableType, resolvedVideoSrc]);

  // Native <video> master-clock synchronization engine anchored to audioEngine.element
  useEffect(() => {
    if (
      !shouldRenderMv ||
      !mvConfig ||
      mvConfig.playableType !== 'video' ||
      !resolvedVideoSrc ||
      videoDecodeFailed
    ) {
      return;
    }

    const video = videoRef.current;
    const audioEl = audioEngine.element;
    if (!video) return;

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;

    let rafId = 0;

    const pushStatus = (status: MvRuntimeStatus, force = false) => {
      const now = performance.now();
      if (
        !force &&
        status.state === lastReportedStateRef.current &&
        now - lastStatusReportAtRef.current < 160
      ) {
        return;
      }
      lastStatusReportAtRef.current = now;
      lastReportedStateRef.current = status.state;
      setMvRuntimeStatus(status);
    };

    const syncVideo = (forceSeek: boolean) => {
      const musicTime = audioEl.currentTime || 0;
      const musicPlaying = !audioEl.paused && !audioEl.ended;
      const mvDur =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : mvConfig.localDuration || 0;

      if (video.readyState < 1) {
        pushStatus(
          {
            state: 'loading',
            mvCurrentTime: 0,
            mvDuration: mvDur,
            driftSec: 0,
            message: '正在缓冲 MV 视频画面...',
          },
          forceSeek
        );
        return;
      }

      const target = computeMvTargetState(
        musicTime,
        mvConfig.syncOffsetSec || 0,
        mvDur,
        mvConfig.endBehavior || 'stop'
      );

      if (target.ended) {
        if (!video.paused) video.pause();
        video.playbackRate = 1;
        if (
          mvDur > 0 &&
          Math.abs((video.currentTime || 0) - mvDur) > 0.25 &&
          video.readyState >= 2
        ) {
          try {
            video.currentTime = Math.max(0, mvDur - 0.05);
          } catch {
            // ignore seek error near end
          }
        }
        pushStatus(
          {
            state: 'ended',
            mvCurrentTime: mvDur,
            mvDuration: mvDur,
            driftSec: 0,
            message: 'MV 已播完（可开启循环播放或调整偏移）',
          },
          forceSeek
        );
        return;
      }

      if (target.waitingOffset) {
        if (!video.paused) video.pause();
        video.playbackRate = 1;
        if (Math.abs(video.currentTime || 0) > 0.08 && video.readyState >= 2) {
          try {
            video.currentTime = 0;
          } catch {
            // ignore
          }
        }
        const remainWait = Math.max(0, -(musicTime + (mvConfig.syncOffsetSec || 0)));
        pushStatus(
          {
            state: 'waiting_offset',
            mvCurrentTime: 0,
            mvDuration: mvDur,
            driftSec: 0,
            message: `等待同步点进入（还剩 ${remainWait.toFixed(1)}s）`,
          },
          forceSeek
        );
        return;
      }

      const diff = normalizeLoopDrift(
        target.targetTime,
        video.currentTime || 0,
        mvDur,
        mvConfig.endBehavior === 'loop'
      );
      const absDiff = Math.abs(diff);

      if (!musicPlaying) {
        if (!video.paused) video.pause();
        video.playbackRate = 1;
        if ((forceSeek || absDiff > 0.16) && video.readyState >= 1) {
          try {
            video.currentTime = target.targetTime;
          } catch {
            // ignore
          }
        }
        pushStatus(
          {
            state: 'synced',
            mvCurrentTime: video.currentTime || target.targetTime,
            mvDuration: mvDur,
            driftSec: diff,
          },
          forceSeek
        );
        return;
      }

      // Music IS playing
      if (autoplayBlockedRef.current) {
        pushStatus(
          {
            state: 'autoplay_blocked',
            mvCurrentTime: video.currentTime || 0,
            mvDuration: mvDur,
            driftSec: diff,
            message: '浏览器限制自动播放视频，点击「启动 MV 画面」即可同步播放',
          },
          forceSeek
        );
        return;
      }

      if (video.paused && video.readyState >= 2) {
        video.muted = true;
        const p = video.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err: unknown) => {
            const name = err instanceof Error ? err.name : '';
            if (name === 'NotAllowedError') {
              autoplayBlockedRef.current = true;
              pushStatus(
                {
                  state: 'autoplay_blocked',
                  mvCurrentTime: video.currentTime || 0,
                  mvDuration: mvDur,
                  driftSec: diff,
                  message: '浏览器限制自动播放视频，点击「启动 MV 画面」即可同步播放',
                },
                true
              );
            }
          });
        }
      }

      const now = performance.now();
      let syncState: MvRuntimeStatus['state'] = 'synced';
      let msg: string | undefined;

      if (forceSeek || absDiff > 0.45) {
        if (forceSeek || now - lastSeekAtRef.current > 240) {
          lastSeekAtRef.current = now;
          try {
            video.currentTime = target.targetTime;
          } catch {
            // ignore seek on unready stream
          }
        }
        video.playbackRate = 1;
        syncState = 'correcting';
        msg = '正在对齐音画进度...';
      } else if (absDiff > 0.12) {
        video.playbackRate = diff > 0 ? 1.06 : 0.94;
        syncState = 'correcting';
        msg = '微调速率对齐中';
      } else {
        if (video.playbackRate !== 1) {
          video.playbackRate = 1;
        }
        syncState = 'synced';
      }

      pushStatus(
        {
          state: syncState,
          mvCurrentTime: video.currentTime || target.targetTime,
          mvDuration: mvDur,
          driftSec: diff,
          message: msg,
        },
        forceSeek
      );
    };

    const tick = () => {
      if (document.visibilityState === 'visible') {
        syncVideo(false);
      }
      if (!audioEl.paused && !audioEl.ended) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const startLoopIfPlaying = () => {
      cancelAnimationFrame(rafId);
      if (!audioEl.paused && !audioEl.ended) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onAudioPlay = () => {
      autoplayBlockedRef.current = false;
      syncVideo(true);
      startLoopIfPlaying();
    };
    const onAudioPause = () => {
      cancelAnimationFrame(rafId);
      syncVideo(true);
    };
    const onAudioSeek = () => {
      syncVideo(true);
    };
    const onAudioEnded = () => {
      cancelAnimationFrame(rafId);
      if (!video.paused) video.pause();
    };
    const onVideoLoadedMetadata = () => {
      syncVideo(true);
      startLoopIfPlaying();
    };
    const onVideoCanPlay = () => {
      syncVideo(true);
      startLoopIfPlaying();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncVideo(true);
        startLoopIfPlaying();
      } else {
        cancelAnimationFrame(rafId);
      }
    };

    audioEl.addEventListener('play', onAudioPlay);
    audioEl.addEventListener('pause', onAudioPause);
    audioEl.addEventListener('seeking', onAudioSeek);
    audioEl.addEventListener('seeked', onAudioSeek);
    audioEl.addEventListener('ended', onAudioEnded);
    video.addEventListener('loadedmetadata', onVideoLoadedMetadata);
    video.addEventListener('canplay', onVideoCanPlay);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Initial immediate sync
    syncVideo(true);
    startLoopIfPlaying();

    return () => {
      cancelAnimationFrame(rafId);
      audioEl.removeEventListener('play', onAudioPlay);
      audioEl.removeEventListener('pause', onAudioPause);
      audioEl.removeEventListener('seeking', onAudioSeek);
      audioEl.removeEventListener('seeked', onAudioSeek);
      audioEl.removeEventListener('ended', onAudioEnded);
      video.removeEventListener('loadedmetadata', onVideoLoadedMetadata);
      video.removeEventListener('canplay', onVideoCanPlay);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (!video.paused) video.pause();
      video.playbackRate = 1;
    };
  }, [
    shouldRenderMv,
    mvConfig?.songId,
    mvConfig?.playableType,
    mvConfig?.syncOffsetSec,
    mvConfig?.endBehavior,
    mvConfig?.localDuration,
    resolvedVideoSrc,
    videoDecodeFailed,
    setMvRuntimeStatus,
  ]);

  // Explicit user-gesture recovery when autoplay was blocked
  useEffect(() => {
    if (mvRetrySignal === 0) return;
    const vid = videoRef.current;
    const audioEl = audioEngine.element;
    if (!vid || !shouldRenderMv || !mvConfig || mvConfig.playableType !== 'video') {
      return;
    }
    autoplayBlockedRef.current = false;
    setVideoDecodeFailed(false);
    vid.muted = true;
    const dur =
      Number.isFinite(vid.duration) && vid.duration > 0
        ? vid.duration
        : mvConfig.localDuration || 0;
    const target = computeMvTargetState(
      audioEl.currentTime || 0,
      mvConfig.syncOffsetSec || 0,
      dur,
      mvConfig.endBehavior || 'stop'
    );
    try {
      vid.currentTime = target.targetTime;
    } catch {
      // ignore
    }
    if (!audioEl.paused && !target.ended && !target.waitingOffset) {
      vid.play().catch(() => {
        autoplayBlockedRef.current = true;
      });
    }
  }, [mvRetrySignal, shouldRenderMv, mvConfig]);

  // Embedded iframe postMessage controller (YouTube / Vimeo / Dailymotion)
  useEffect(() => {
    if (!shouldRenderMv || !mvConfig || mvConfig.playableType !== 'embed') return;
    const audioEl = audioEngine.element;

    const sendEmbedCommand = (playCmd: boolean, seekSec?: number) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      const provider = mvConfig.embedProvider;
      try {
        if (provider === 'youtube') {
          win.postMessage(JSON.stringify({ event: 'command', func: 'mute', args: [] }), '*');
          if (typeof seekSec === 'number') {
            win.postMessage(
              JSON.stringify({ event: 'command', func: 'seekTo', args: [Math.max(0, seekSec), true] }),
              '*'
            );
          }
          win.postMessage(
            JSON.stringify({
              event: 'command',
              func: playCmd ? 'playVideo' : 'pauseVideo',
              args: [],
            }),
            '*'
          );
        } else if (provider === 'vimeo') {
          win.postMessage(JSON.stringify({ method: 'setVolume', value: 0 }), '*');
          if (typeof seekSec === 'number') {
            win.postMessage(
              JSON.stringify({ method: 'setCurrentTime', value: Math.max(0, seekSec) }),
              '*'
            );
          }
          win.postMessage(JSON.stringify({ method: playCmd ? 'play' : 'pause' }), '*');
        }
      } catch {
        // Ignore cross-origin postMessage restrictions
      }
    };

    const syncEmbed = (withSeek: boolean) => {
      const targetSec = Math.max(0, (audioEl.currentTime || 0) + (mvConfig.syncOffsetSec || 0));
      const playing = !audioEl.paused && !audioEl.ended;
      sendEmbedCommand(playing, withSeek ? targetSec : undefined);
      setMvRuntimeStatus({
        state: mvConfig.embedProvider === 'dailymotion' ? 'embed_limited' : 'embed_synced',
        mvCurrentTime: targetSec,
        mvDuration: 0,
        driftSec: 0,
        message:
          mvConfig.embedProvider === 'dailymotion'
            ? '嵌入播放器模式（跨源限制不支持实时时间轴控制）'
            : '官方嵌入播放器已与歌曲启停/跳转联动',
      });
    };

    const onPlay = () => syncEmbed(true);
    const onPause = () => syncEmbed(false);
    const onSeeked = () => syncEmbed(true);
    const onTimeUpdate = () => {
      const targetSec = Math.max(0, (audioEl.currentTime || 0) + (mvConfig.syncOffsetSec || 0));
      setMvRuntimeStatus({
        state: mvConfig.embedProvider === 'dailymotion' ? 'embed_limited' : 'embed_synced',
        mvCurrentTime: targetSec,
        mvDuration: 0,
        driftSec: 0,
      });
    };

    audioEl.addEventListener('play', onPlay);
    audioEl.addEventListener('pause', onPause);
    audioEl.addEventListener('seeked', onSeeked);
    audioEl.addEventListener('timeupdate', onTimeUpdate);

    syncEmbed(true);

    return () => {
      audioEl.removeEventListener('play', onPlay);
      audioEl.removeEventListener('pause', onPause);
      audioEl.removeEventListener('seeked', onSeeked);
      audioEl.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [
    shouldRenderMv,
    mvConfig?.songId,
    mvConfig?.playableType,
    mvConfig?.embedProvider,
    mvConfig?.syncOffsetSec,
    setMvRuntimeStatus,
  ]);

  const videoTransformStyle = useMemo<React.CSSProperties>(() => {
    if (!mvConfig) return {};
    const brightness = Math.max(0.2, Math.min(1, mvConfig.brightness ?? 0.62));
    const blur = personalization.reducedMotion
      ? 0
      : Math.max(0, Math.min(24, mvConfig.blurPx ?? 0));
    const scale =
      mvConfig.displayMode === 'custom'
        ? Math.max(1, Math.min(2.5, mvConfig.scale || 1))
        : 1;
    const tx =
      mvConfig.displayMode === 'custom'
        ? Math.max(-50, Math.min(50, mvConfig.cropX || 0))
        : 0;
    const ty =
      mvConfig.displayMode === 'custom'
        ? Math.max(-50, Math.min(50, mvConfig.cropY || 0))
        : 0;

    return {
      filter: `brightness(${brightness})${blur > 0 ? ` blur(${blur}px)` : ''}`,
      transform: `translate3d(${tx}%, ${ty}%, 0) scale(${scale})`,
      transformOrigin: 'center center',
    };
  }, [mvConfig, personalization.reducedMotion]);

  if (!shouldRenderMv || !mvConfig) {
    return null;
  }

  const overlayOpacity = Math.max(0.1, Math.min(0.85, mvConfig.overlayOpacity ?? 0.45));

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 -z-[5] pointer-events-none overflow-hidden bg-black"
    >
      {mvConfig.playableType === 'video' && resolvedVideoSrc && !videoDecodeFailed && (
        <video
          ref={videoRef}
          key={`${mvConfig.songId}-${resolvedVideoSrc}`}
          src={resolvedVideoSrc}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          style={videoTransformStyle}
          onError={() => {
            setVideoDecodeFailed(true);
            setMvRuntimeStatus({
              state: 'error',
              mvCurrentTime: 0,
              mvDuration: mvConfig.localDuration || 0,
              driftSec: 0,
              message:
                mvConfig.sourceType === 'online'
                  ? '在线 MV 视频流无法加载或已失效（音乐播放未受影响）'
                  : '该本地视频当前编码解码异常（音乐播放未受影响）',
            });
          }}
          className={`w-full h-full transition-[filter,transform] duration-300 ${
            mvConfig.displayMode === 'contain' ? 'object-contain' : 'object-cover'
          }`}
        />
      )}

      {mvConfig.playableType === 'embed' && mvConfig.playableUrl && (
        <iframe
          ref={iframeRef}
          key={`${mvConfig.songId}-${mvConfig.playableUrl}`}
          src={mvConfig.playableUrl}
          title={mvConfig.title || 'MV 背景播放器'}
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          style={videoTransformStyle}
          onLoad={() => {
            const audioEl = audioEngine.element;
            if (!audioEl.paused && mvConfig.embedProvider === 'youtube') {
              const targetSec = Math.max(
                0,
                (audioEl.currentTime || 0) + (mvConfig.syncOffsetSec || 0)
              );
              try {
                iframeRef.current?.contentWindow?.postMessage(
                  JSON.stringify({ event: 'command', func: 'mute', args: [] }),
                  '*'
                );
                iframeRef.current?.contentWindow?.postMessage(
                  JSON.stringify({
                    event: 'command',
                    func: 'seekTo',
                    args: [targetSec, true],
                  }),
                  '*'
                );
                iframeRef.current?.contentWindow?.postMessage(
                  JSON.stringify({ event: 'command', func: 'playVideo', args: [] }),
                  '*'
                );
              } catch {
                // ignore
              }
            }
          }}
          className="w-full h-full border-0 scale-105"
        />
      )}

      {/* Adaptive Readability Scrim so Lyrics, Cover & Transport Controls stay crisp */}
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-300"
        style={{
          background: `radial-gradient(circle at 50% 45%, rgba(10, 4, 8, ${
            overlayOpacity * 0.68
          }) 0%, rgba(8, 3, 6, ${Math.min(0.92, overlayOpacity + 0.16)}) 100%)`,
        }}
      />
    </div>
  );
};
