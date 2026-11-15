import { AiTaskRecord } from '../types/ai';
import {
  AudioDspSettings,
  PersonalizationSettings,
  PlaybackPrefs,
  Playlist,
  TrackMetadata,
  TrackStemsMeta,
  TrackStemsRecord,
} from '../types/music';
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_PERSONALIZATION,
  DEFAULT_PLAYBACK_PREFS,
} from '../utils/constants';

const DB_NAME = 'lumina-music-db';
const DB_VERSION = 3;

const STORE_TRACKS = 'tracks';
const STORE_BLOBS = 'audioBlobs';
const STORE_PLAYLISTS = 'playlists';
const STORE_SETTINGS = 'settings';
const STORE_STEMS = 'stems';
const STORE_MODELS = 'models';
const STORE_AI_TASKS = 'ai_tasks';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_TRACKS)) {
        db.createObjectStore(STORE_TRACKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
      if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
        db.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS);
      }
      if (!db.objectStoreNames.contains(STORE_STEMS)) {
        db.createObjectStore(STORE_STEMS, { keyPath: 'trackId' });
      }
      if (!db.objectStoreNames.contains(STORE_MODELS)) {
        db.createObjectStore(STORE_MODELS);
      }
      if (!db.objectStoreNames.contains(STORE_AI_TASKS)) {
        db.createObjectStore(STORE_AI_TASKS, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开 IndexedDB 数据库'));
  });

  return dbPromise;
}

function wrapRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllTracks(): Promise<TrackMetadata[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_TRACKS, 'readonly');
  const items = await wrapRequest(tx.objectStore(STORE_TRACKS).getAll());
  return (items as TrackMetadata[]).sort((a, b) => a.addedAt - b.addedAt);
}

export async function saveTrackWithBlob(
  track: TrackMetadata,
  blob: Blob
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TRACKS, STORE_BLOBS], 'readwrite');
    tx.objectStore(STORE_TRACKS).put(track);
    tx.objectStore(STORE_BLOBS).put(blob, track.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      const err = tx.error;
      if (err && err.name === 'QuotaExceededError') {
        reject(new Error('浏览器本地存储空间已满，请清理部分曲目后重试。'));
      } else {
        reject(err || new Error('保存音频到本地数据库失败'));
      }
    };
  });
}

export async function updateTrackMetadata(track: TrackMetadata): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_TRACKS, 'readwrite');
  await wrapRequest(tx.objectStore(STORE_TRACKS).put(track));
}

export async function getAudioBlob(trackId: string): Promise<Blob | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_BLOBS, 'readonly');
  return wrapRequest(tx.objectStore(STORE_BLOBS).get(trackId)) as Promise<
    Blob | undefined
  >;
}

export async function deleteTrackById(trackId: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TRACKS, STORE_BLOBS, STORE_STEMS], 'readwrite');
    tx.objectStore(STORE_TRACKS).delete(trackId);
    tx.objectStore(STORE_BLOBS).delete(trackId);
    tx.objectStore(STORE_STEMS).delete(trackId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveTrackStems(record: TrackStemsRecord): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STEMS, 'readwrite');
    tx.objectStore(STORE_STEMS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      const err = tx.error;
      if (err && err.name === 'QuotaExceededError') {
        reject(new Error('浏览器存储空间不足，无法缓存分离音轨，请清理部分缓存后重试。'));
      } else {
        reject(err || new Error('保存分离音轨失败'));
      }
    };
  });
}

export async function getTrackStems(
  trackId: string
): Promise<TrackStemsRecord | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_STEMS, 'readonly');
  return wrapRequest(tx.objectStore(STORE_STEMS).get(trackId)) as Promise<
    TrackStemsRecord | undefined
  >;
}

export async function getAllStemMetas(): Promise<TrackStemsMeta[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_STEMS, 'readonly');
  const records = (await wrapRequest(tx.objectStore(STORE_STEMS).getAll())) as TrackStemsRecord[];
  return records.map((r) => ({
    trackId: r.trackId,
    modelId: r.modelId,
    modelName: r.modelName,
    engineUsed: r.engineUsed,
    duration: r.duration,
    createdAt: r.createdAt,
    vocalSizeBytes: r.vocalBlob?.size || 0,
    instrumentalSizeBytes: r.instrumentalBlob?.size || 0,
  }));
}

export async function deleteTrackStems(trackId: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_STEMS, 'readwrite');
  await wrapRequest(tx.objectStore(STORE_STEMS).delete(trackId));
}

export async function getCachedModelBytes(modelId: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_MODELS, 'readonly');
    return (await wrapRequest(tx.objectStore(STORE_MODELS).get(modelId))) as
      | ArrayBuffer
      | undefined;
  } catch {
    return undefined;
  }
}

export async function saveCachedModelBytes(
  modelId: string,
  bytes: ArrayBuffer
): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_MODELS, 'readwrite');
    await wrapRequest(tx.objectStore(STORE_MODELS).put(bytes, modelId));
  } catch {
    // Non-fatal if browser quota skips persisting 66MB ONNX weights
  }
}

export async function getAllPlaylists(): Promise<Playlist[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_PLAYLISTS, 'readonly');
  const items = await wrapRequest(tx.objectStore(STORE_PLAYLISTS).getAll());
  return (items as Playlist[]).sort((a, b) => a.createdAt - b.createdAt);
}

export async function savePlaylist(playlist: Playlist): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
  await wrapRequest(tx.objectStore(STORE_PLAYLISTS).put(playlist));
}

export async function deletePlaylistById(id: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
  await wrapRequest(tx.objectStore(STORE_PLAYLISTS).delete(id));
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const val = await wrapRequest(tx.objectStore(STORE_SETTINGS).get(key));
    return val !== undefined ? { ...fallback, ...val } : fallback;
  } catch {
    return fallback;
  }
}

async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_SETTINGS, 'readwrite');
  await wrapRequest(tx.objectStore(STORE_SETTINGS).put(value, key));
}

export const loadAudioSettings = () =>
  getSetting<AudioDspSettings>('audioSettings', DEFAULT_AUDIO_SETTINGS);

export const saveAudioSettings = (s: AudioDspSettings) =>
  setSetting('audioSettings', s);

export const loadPersonalization = () =>
  getSetting<PersonalizationSettings>('personalization', DEFAULT_PERSONALIZATION);

export const savePersonalization = (s: PersonalizationSettings) =>
  setSetting('personalization', s);

export const loadPlaybackPrefs = () =>
  getSetting<PlaybackPrefs>('playbackPrefs', DEFAULT_PLAYBACK_PREFS);

export const savePlaybackPrefs = (p: PlaybackPrefs) =>
  setSetting('playbackPrefs', p);

export async function hasInitializedDemo(): Promise<boolean> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const val = await wrapRequest(tx.objectStore(STORE_SETTINGS).get('demoSeeded'));
    return Boolean(val);
  } catch {
    return false;
  }
}

export async function markDemoInitialized(): Promise<void> {
  await setSetting('demoSeeded', true);
}

export async function getStorageEstimate(): Promise<{
  usageBytes: number;
  quotaBytes: number;
}> {
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    return {
      usageBytes: est.usage || 0,
      quotaBytes: est.quota || 0,
    };
  }
  return { usageBytes: 0, quotaBytes: 0 };
}

export async function clearAllMusicData(): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [STORE_TRACKS, STORE_BLOBS, STORE_PLAYLISTS, STORE_STEMS],
      'readwrite'
    );
    tx.objectStore(STORE_TRACKS).clear();
    tx.objectStore(STORE_BLOBS).clear();
    tx.objectStore(STORE_PLAYLISTS).clear();
    tx.objectStore(STORE_STEMS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllAiTasks(): Promise<AiTaskRecord[]> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_AI_TASKS, 'readonly');
    const list = (await wrapRequest(
      tx.objectStore(STORE_AI_TASKS).getAll()
    )) as AiTaskRecord[];
    return list
      .sort((a, b) => (b.createdAt || b.startedAt) - (a.createdAt || a.startedAt))
      .slice(0, 200);
  } catch {
    return [];
  }
}

export async function saveAiTask(task: AiTaskRecord): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_AI_TASKS, 'readwrite');
    await wrapRequest(tx.objectStore(STORE_AI_TASKS).put(task));
  } catch {
    // Non-fatal
  }
}

export async function deleteAiTaskById(taskId: string): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_AI_TASKS, 'readwrite');
    await wrapRequest(tx.objectStore(STORE_AI_TASKS).delete(taskId));
  } catch {
    // Non-fatal
  }
}

export async function clearAiTasks(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_AI_TASKS, 'readwrite');
  await wrapRequest(tx.objectStore(STORE_AI_TASKS).clear());
}

export async function getAllStemRecords(): Promise<TrackStemsRecord[]> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_STEMS, 'readonly');
    return (await wrapRequest(tx.objectStore(STORE_STEMS).getAll())) as TrackStemsRecord[];
  } catch {
    return [];
  }
}

export async function saveAiTasksBatch(tasks: AiTaskRecord[]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AI_TASKS, 'readwrite');
    const store = tx.objectStore(STORE_AI_TASKS);
    for (const t of tasks) {
      store.put(t);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAiVaultSnapshot<T>(): Promise<T | null> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const val = await wrapRequest(tx.objectStore(STORE_SETTINGS).get('aiVaultSnapshot'));
    return (val as T | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveAiVaultSnapshot<T>(snapshot: T): Promise<void> {
  try {
    await setSetting('aiVaultSnapshot', snapshot);
  } catch {
    // Non-fatal
  }
}


