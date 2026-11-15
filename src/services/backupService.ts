import {
  fetchProviders,
  fetchStemServices,
  getVaultHeaders,
  getVaultSnapshotForRequest,
} from './ai/providerManager';
import {
  clearAiTasks,
  clearAllMusicData,
  getAllAiTasks,
  getAllMvConfigs,
  getAllPlaylists,
  getAllStemRecords,
  getAllTracks,
  getAudioBlob,
  getMvBlob,
  loadAudioSettings,
  loadPersonalization,
  loadPlaybackPrefs,
  saveAiTasksBatch,
  saveAudioSettings,
  saveMvConfig,
  saveMvVideoWithConfig,
  savePersonalization,
  savePlaybackPrefs,
  savePlaylist,
  saveTrackStems,
  saveTrackWithBlob,
} from './storage';
import {
  AiProviderConfig,
  AiTaskRecord,
  AiTaskStatus,
  StemServiceConfig,
} from '../types/ai';
import {
  AudioDspSettings,
  PersonalizationSettings,
  PlaybackPrefs,
  Playlist,
  TrackMetadata,
  TrackMvConfig,
  TrackStemsRecord,
} from '../types/music';

interface SerializedTrackEntry {
  track: TrackMetadata;
  audioBase64?: string;
  audioMimeType?: string;
}

interface SerializedStemEntry {
  trackId: string;
  modelId: string;
  modelName: string;
  engineUsed: TrackStemsRecord['engineUsed'];
  duration: number;
  createdAt: number;
  vocalBase64: string;
  instrumentalBase64: string;
}

interface SerializedMvVideoEntry {
  localVideoId: string;
  mimeType: string;
  videoBase64: string;
}

export interface EncryptedBackupSecretsEnvelope {
  algorithm: 'PBKDF2-SHA256-AES-256-GCM';
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  keyCount: number;
}

export interface LuminaBackupBundle {
  format: 'lumina-music-backup';
  version: 1 | 2 | 3 | 4;
  exportedAt: number;
  manifest?: {
    trackCount: number;
    playlistCount: number;
    stemCount: number;
    taskCount: number;
    mvCount?: number;
    mvVideosCount?: number;
    includesEncryptedSecrets: boolean;
  };
  tracks: SerializedTrackEntry[];
  playlists: Playlist[];
  stems: SerializedStemEntry[];
  aiTasks: AiTaskRecord[];
  mvConfigs?: TrackMvConfig[];
  mvVideos?: SerializedMvVideoEntry[];
  settings: {
    audioSettings: AudioDspSettings;
    personalization: PersonalizationSettings;
    playbackPrefs: PlaybackPrefs;
  };
  // Non-secret metadata ONLY; plaintext API keys & vault tokens are NEVER written here
  aiConfigMetadata: {
    defaultProviderId: string | null;
    providers: Array<Omit<AiProviderConfig, 'hasKey' | 'sealedKey'>>;
    activeStemServiceId: string | null;
    stemServices: Array<Omit<StemServiceConfig, 'hasKey' | 'sealedKey'>>;
  };
  // Optional PBKDF2 + AES-256-GCM passphrase-encrypted API key bundle (only when user supplies passphrase)
  encryptedSecrets?: EncryptedBackupSecretsEnvelope;
}

export interface BackupImportSummary {
  tracksRestored: number;
  playlistsRestored: number;
  stemsRestored: number;
  tasksRestored: number;
  tasksNormalizedToResubmit: number;
  providersRestored: number;
  keysRestored: number;
  includesEncryptedSecrets: boolean;
  mvConfigsRestored: number;
  mvVideosRestored: number;
  mvBrokenLinks: number;
  mvMissingLocalVideos: number;
}

export interface ExportBackupOptions {
  passphrase?: string;
  includeMvVideos?: boolean;
}

async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = typeof reader.result === 'string' ? reader.result : '';
        const commaIdx = res.indexOf(',');
        resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
      };
      reader.onerror = () => reject(reader.error || new Error('读取二进制数据失败'));
      reader.readAsDataURL(blob);
    });
  }
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function shouldNormalizeImportedTask(status: AiTaskStatus): boolean {
  return (
    status === 'running' ||
    status === 'queued' ||
    status === 'paused' ||
    status === 'awaiting_confirmation'
  );
}

function isProductionSafeOnlineUrl(raw?: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h === '0.0.0.0' ||
      h.endsWith('.local')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function exportFullLuminaBackup(
  passphraseOrOptions?: string | ExportBackupOptions
): Promise<{
  bundle: LuminaBackupBundle;
  filename: string;
}> {
  const opts: ExportBackupOptions =
    typeof passphraseOrOptions === 'string'
      ? { passphrase: passphraseOrOptions, includeMvVideos: false }
      : passphraseOrOptions || {};

  const cleanPass = (opts.passphrase || '').trim();
  if (cleanPass && cleanPass.length < 4) {
    throw new Error('备份加密口令至少需要 4 个字符');
  }

  const [
    tracks,
    playlists,
    stemRecords,
    aiTasks,
    mvConfigs,
    audioSettings,
    personalization,
    playbackPrefs,
    providerResp,
    stemServiceResp,
  ] = await Promise.all([
    getAllTracks(),
    getAllPlaylists(),
    getAllStemRecords(),
    getAllAiTasks(),
    getAllMvConfigs(),
    loadAudioSettings(),
    loadPersonalization(),
    loadPlaybackPrefs(),
    fetchProviders().catch(() => ({
      defaultProviderId: null,
      providers: [] as AiProviderConfig[],
      securityMode: 'server',
    })),
    fetchStemServices().catch(() => ({
      activeStemServiceId: null,
      services: [] as StemServiceConfig[],
    })),
  ]);

  let encryptedSecrets: EncryptedBackupSecretsEnvelope | undefined;
  if (cleanPass) {
    const [headers, snapshot] = await Promise.all([
      getVaultHeaders(),
      getVaultSnapshotForRequest(),
    ]);
    const res = await fetch('/api/ai/backup/export-sealed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        passphrase: cleanPass,
        providerSnapshot: snapshot,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      encryptedSecrets?: EncryptedBackupSecretsEnvelope;
      error?: string;
    };
    if (!res.ok || !json.encryptedSecrets) {
      throw new Error(json.error || '导出加密 API 密钥失败');
    }
    encryptedSecrets = json.encryptedSecrets;
  }

  const serializedTracks: SerializedTrackEntry[] = [];
  for (const track of tracks) {
    const blob = await getAudioBlob(track.id);
    if (blob) {
      serializedTracks.push({
        track,
        audioBase64: await blobToBase64(blob),
        audioMimeType: blob.type || 'audio/wav',
      });
    } else {
      serializedTracks.push({ track });
    }
  }

  const serializedStems: SerializedStemEntry[] = [];
  for (const stem of stemRecords) {
    serializedStems.push({
      trackId: stem.trackId,
      modelId: stem.modelId,
      modelName: stem.modelName,
      engineUsed: stem.engineUsed,
      duration: stem.duration,
      createdAt: stem.createdAt,
      vocalBase64: await blobToBase64(stem.vocalBlob),
      instrumentalBase64: await blobToBase64(stem.instrumentalBlob),
    });
  }

  const serializedMvVideos: SerializedMvVideoEntry[] = [];
  if (opts.includeMvVideos) {
    const seenVideoIds = new Set<string>();
    for (const cfg of mvConfigs) {
      if (cfg.sourceType === 'local' && cfg.localVideoId && !seenVideoIds.has(cfg.localVideoId)) {
        seenVideoIds.add(cfg.localVideoId);
        const vBlob = await getMvBlob(cfg.localVideoId);
        if (vBlob && vBlob.size > 0) {
          serializedMvVideos.push({
            localVideoId: cfg.localVideoId,
            mimeType: vBlob.type || cfg.localMimeType || 'video/mp4',
            videoBase64: await blobToBase64(vBlob),
          });
        }
      }
    }
  }

  // Explicitly strip any secret indicator or sealed vault token from unencrypted metadata
  const safeProviders = (providerResp.providers || []).map(
    ({ hasKey: _ignoredKey, sealedKey: _ignoredSealed, ...rest }) => rest
  );
  const safeStemServices = (stemServiceResp.services || []).map(
    ({ hasKey: _ignoredKey, sealedKey: _ignoredSealed, ...rest }) => rest
  );

  const bundle: LuminaBackupBundle = {
    format: 'lumina-music-backup',
    version: 4,
    exportedAt: Date.now(),
    manifest: {
      trackCount: serializedTracks.length,
      playlistCount: playlists.length,
      stemCount: serializedStems.length,
      taskCount: aiTasks.length,
      mvCount: mvConfigs.length,
      mvVideosCount: serializedMvVideos.length,
      includesEncryptedSecrets: Boolean(encryptedSecrets && encryptedSecrets.keyCount > 0),
    },
    tracks: serializedTracks,
    playlists,
    stems: serializedStems,
    aiTasks,
    mvConfigs,
    ...(serializedMvVideos.length > 0 ? { mvVideos: serializedMvVideos } : {}),
    settings: {
      audioSettings,
      personalization,
      playbackPrefs,
    },
    aiConfigMetadata: {
      defaultProviderId: providerResp.defaultProviderId,
      providers: safeProviders,
      activeStemServiceId: stemServiceResp.activeStemServiceId,
      stemServices: safeStemServices,
    },
    ...(encryptedSecrets ? { encryptedSecrets } : {}),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    bundle,
    filename: `lumina-music-backup-${stamp}.json`,
  };
}

export async function importFullLuminaBackup(
  rawJson: string,
  passphrase?: string
): Promise<BackupImportSummary> {
  const parsed = JSON.parse(rawJson) as Partial<LuminaBackupBundle>;
  if (!parsed || parsed.format !== 'lumina-music-backup') {
    throw new Error('无效的备份文件格式，请选择由 LUMINA MUSIC 导出的 JSON 备份文件');
  }

  const cleanPass = (passphrase || '').trim();
  const hasEncryptedSecrets = Boolean(parsed.encryptedSecrets);
  if (hasEncryptedSecrets && !cleanPass) {
    throw new Error('该备份包含加密的 API 密钥，请先输入备份加密口令后再导入恢复');
  }

  // Restore AI provider metadata & decrypt secrets BEFORE wiping local library so a wrong passphrase fails cleanly
  let providersRestored = 0;
  let keysRestored = 0;
  if (parsed.aiConfigMetadata || parsed.encryptedSecrets) {
    const headers = await getVaultHeaders();
    const res = await fetch('/api/ai/backup/import-sealed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        aiConfigMetadata: parsed.aiConfigMetadata,
        encryptedSecrets: parsed.encryptedSecrets,
        passphrase: cleanPass,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      providersRestored?: number;
      keysRestored?: number;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(json.error || '解密并恢复 AI 服务配置失败');
    }
    providersRestored = json.providersRestored || 0;
    keysRestored = json.keysRestored || 0;

    // Sync restored providers & freshly sealed keys back into local IndexedDB snapshot
    await Promise.all([
      fetchProviders({ skipHydrate: true }).catch(() => null),
      fetchStemServices().catch(() => null),
    ]);
  }

  await clearAllMusicData();
  await clearAiTasks();

  let tracksRestored = 0;
  for (const entry of parsed.tracks || []) {
    if (!entry?.track?.id) continue;
    const blob = entry.audioBase64
      ? base64ToBlob(entry.audioBase64, entry.audioMimeType || 'audio/wav')
      : new Blob([], { type: 'audio/wav' });
    await saveTrackWithBlob(entry.track, blob);
    tracksRestored++;
  }

  let playlistsRestored = 0;
  for (const pl of parsed.playlists || []) {
    if (!pl?.id) continue;
    await savePlaylist(pl);
    playlistsRestored++;
  }

  let stemsRestored = 0;
  for (const st of parsed.stems || []) {
    if (!st?.trackId || !st.vocalBase64 || !st.instrumentalBase64) continue;
    await saveTrackStems({
      trackId: st.trackId,
      modelId: st.modelId,
      modelName: st.modelName,
      engineUsed: st.engineUsed,
      duration: st.duration,
      createdAt: st.createdAt,
      vocalBlob: base64ToBlob(st.vocalBase64, 'audio/wav'),
      instrumentalBlob: base64ToBlob(st.instrumentalBase64, 'audio/wav'),
    });
    stemsRestored++;
  }

  // Restore MV configs & optional local video blobs
  const mvVideoMap = new Map<string, Blob>();
  for (const mvItem of parsed.mvVideos || []) {
    if (mvItem?.localVideoId && mvItem.videoBase64) {
      mvVideoMap.set(
        mvItem.localVideoId,
        base64ToBlob(mvItem.videoBase64, mvItem.mimeType || 'video/mp4')
      );
    }
  }

  let mvConfigsRestored = 0;
  let mvVideosRestored = 0;
  let mvBrokenLinks = 0;
  let mvMissingLocalVideos = 0;

  for (const cfg of parsed.mvConfigs || []) {
    if (!cfg?.songId) continue;
    if (cfg.sourceType === 'local') {
      const restoredBlob = cfg.localVideoId ? mvVideoMap.get(cfg.localVideoId) : undefined;
      if (restoredBlob && restoredBlob.size > 0) {
        await saveMvVideoWithConfig(
          { ...cfg, linkBroken: false },
          restoredBlob
        );
        mvVideosRestored++;
      } else {
        await saveMvConfig({
          ...cfg,
          enabled: false,
          linkBroken: true,
        });
        mvMissingLocalVideos++;
      }
      mvConfigsRestored++;
      continue;
    }

    // Online MV config validation (flags invalid/localhost/expired or missing playableUrl cleanly)
    let isBroken =
      cfg.playableType === 'external_only' ||
      !isProductionSafeOnlineUrl(cfg.playableUrl);

    if (!isBroken && cfg.playableType === 'video' && cfg.playableUrl) {
      try {
        const ctrl = new AbortController();
        const t = window.setTimeout(() => ctrl.abort(), 2200);
        const headRes = await fetch(cfg.playableUrl, {
          method: 'HEAD',
          signal: ctrl.signal,
        });
        window.clearTimeout(t);
        if (headRes.status === 404 || headRes.status === 410 || headRes.status === 403) {
          isBroken = true;
        }
      } catch {
        // Ignore CORS/timeout here; actual <video> decoder checks playability during playback
      }
    }

    if (isBroken) {
      mvBrokenLinks++;
    }

    await saveMvConfig({
      ...cfg,
      enabled: isBroken ? false : cfg.enabled,
      linkBroken: isBroken,
    });
    mvConfigsRestored++;
  }

  if (parsed.settings?.audioSettings) {
    await saveAudioSettings(parsed.settings.audioSettings);
  }
  if (parsed.settings?.personalization) {
    await savePersonalization(parsed.settings.personalization);
  }
  if (parsed.settings?.playbackPrefs) {
    await savePlaybackPrefs(parsed.settings.playbackPrefs);
  }

  let tasksNormalizedToResubmit = 0;
  const now = Date.now();
  const normalizedTasks: AiTaskRecord[] = (parsed.aiTasks || [])
    .filter((t): t is AiTaskRecord => Boolean(t && t.id))
    .map((task) => {
      if (shouldNormalizeImportedTask(task.status)) {
        tasksNormalizedToResubmit++;
        const prevLogs = task.stageLogs ? [...task.stageLogs] : [];
        prevLogs.push({
          timestamp: now,
          stage: '从备份恢复 · 需要重新提交执行',
          detail: `原状态为「${task.status}」，跨环境导入不伪造后台运行状态`,
        });
        return {
          ...task,
          status: 'needs_resubmit',
          stageLabel: '从备份恢复 · 需要重新提交执行',
          estimatedRemainingSec: null,
          backendJobId: undefined,
          finishedAt: task.finishedAt ?? now,
          stageLogs: prevLogs.slice(-40),
        };
      }
      return task;
    });

  if (normalizedTasks.length > 0) {
    await saveAiTasksBatch(normalizedTasks);
  }

  return {
    tracksRestored,
    playlistsRestored,
    stemsRestored,
    tasksRestored: normalizedTasks.length,
    tasksNormalizedToResubmit,
    providersRestored,
    keysRestored,
    includesEncryptedSecrets: hasEncryptedSecrets,
    mvConfigsRestored,
    mvVideosRestored,
    mvBrokenLinks,
    mvMissingLocalVideos,
  };
}

