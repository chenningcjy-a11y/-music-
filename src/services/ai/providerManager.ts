import {
  AiProviderConfig,
  AiProviderKind,
  AiVaultSnapshot,
  DetailedTestConnectionResult,
  DiscoveredModel,
  ModelCapabilities,
  StemServiceConfig,
  StemServiceKind,
} from '../../types/ai';
import { loadAiVaultSnapshot, saveAiVaultSnapshot } from '../storage';

let memorySnapshot: AiVaultSnapshot | null = null;

function encodeSnapshotHeader(snapshot: AiVaultSnapshot | null): string | null {
  if (!snapshot || (!snapshot.providers?.length && !snapshot.stemServices?.length)) {
    return null;
  }
  try {
    const compact = {
      defaultProviderId: snapshot.defaultProviderId,
      providers: snapshot.providers.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseUrl: p.baseUrl,
        model: p.model,
        availableModels: p.availableModels,
        maskedKey: p.maskedKey,
        hasKey: p.hasKey,
        keySource: p.keySource,
        sealedKey: p.sealedKey,
        enabled: p.enabled,
        timeoutMs: p.timeoutMs,
        maxRequestsPerDay: p.maxRequestsPerDay,
        customHeadersJson: p.customHeadersJson,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      activeStemServiceId: snapshot.activeStemServiceId,
      stemServices: snapshot.stemServices?.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        baseUrl: s.baseUrl,
        endpointPath: s.endpointPath,
        maskedKey: s.maskedKey,
        hasKey: s.hasKey,
        sealedKey: s.sealedKey,
        enabled: s.enabled,
        timeoutMs: s.timeoutMs,
      })),
    };
    const json = JSON.stringify(compact);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    // Keep safe HTTP header budget (< 16KB)
    return b64.length <= 15000 ? b64 : null;
  } catch {
    return null;
  }
}

export async function getVaultSnapshotForRequest(): Promise<AiVaultSnapshot | null> {
  if (!memorySnapshot) {
    memorySnapshot = await loadAiVaultSnapshot<AiVaultSnapshot>();
  }
  return memorySnapshot;
}

export async function getVaultHeaders(): Promise<Record<string, string>> {
  const snap = await getVaultSnapshotForRequest();
  const encoded = encodeSnapshotHeader(snap);
  return encoded ? { 'X-Lumina-Provider-Snapshot': encoded } : {};
}

async function persistProviderSnapshotPatch(patch: {
  defaultProviderId?: string | null;
  providers?: AiProviderConfig[];
  activeStemServiceId?: string | null;
  stemServices?: StemServiceConfig[];
}): Promise<void> {
  const prev = (await getVaultSnapshotForRequest()) || {
    defaultProviderId: null,
    providers: [],
    updatedAt: Date.now(),
  };
  const next: AiVaultSnapshot = {
    defaultProviderId:
      patch.defaultProviderId !== undefined
        ? patch.defaultProviderId
        : prev.defaultProviderId,
    providers: patch.providers ?? prev.providers,
    activeStemServiceId:
      patch.activeStemServiceId !== undefined
        ? patch.activeStemServiceId
        : prev.activeStemServiceId,
    stemServices: patch.stemServices ?? prev.stemServices,
    updatedAt: Date.now(),
  };
  memorySnapshot = next;
  await saveAiVaultSnapshot(next);
}

export function inferClientModelCapabilities(
  kind: AiProviderKind,
  modelId: string
): ModelCapabilities {
  const m = (modelId || '').toLowerCase();
  if (kind === 'gemini') {
    const isTextOrMultimodal =
      !m.includes('embedding') && !m.includes('tts') && !m.includes('image');
    return {
      textReasoning: isTextOrMultimodal,
      lyricsProcessing: isTextOrMultimodal,
      dspPlanning: isTextOrMultimodal,
      audioInputAnalysis:
        m.includes('gemini-4') ||
        m.includes('gemini-3') ||
        m.includes('gemini-2.5') ||
        m.includes('transcribe'),
      stemSeparation: false,
      note: '支持文本推理与音频理解，音轨分离需使用独立音源分离服务',
    };
  }
  if (kind === 'deepseek') {
    return {
      textReasoning: true,
      lyricsProcessing: true,
      dspPlanning: true,
      audioInputAnalysis: false,
      stemSeparation: false,
      note: '纯文本模型（支持歌词、调音建议与任务规划；不支持音频信号识别与音轨分离）',
    };
  }
  if (kind === 'openai' || kind === 'openai-compatible') {
    const supportsAudio = m.includes('audio-preview') || m.includes('gpt-4o-audio');
    return {
      textReasoning: true,
      lyricsProcessing: true,
      dspPlanning: true,
      audioInputAnalysis: supportsAudio,
      stemSeparation: false,
      note: supportsAudio
        ? '支持文本与音频输入分析；不支持音轨分离'
        : '纯文本模型（不支持原始音频信号听辨与音轨分离）',
    };
  }
  return {
    textReasoning: true,
    lyricsProcessing: true,
    dspPlanning: true,
    audioInputAnalysis: false,
    stemSeparation: false,
    note: '自定义接口（默认文本推理；音轨分离请配置独立分离服务）',
  };
}

export interface RuntimeCapabilities {
  ok: boolean;
  runtime: 'netlify-serverless' | 'node-express';
  stemServerAvailable: boolean;
  browserWorkerStemAvailable: boolean;
  securityMode: string;
}

export async function fetchRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      return (await res.json()) as RuntimeCapabilities;
    }
  } catch {
    // Fallback
  }
  return {
    ok: true,
    runtime: 'netlify-serverless',
    stemServerAvailable: false,
    browserWorkerStemAvailable: true,
    securityMode: 'serverless-sealed-proxy',
  };
}

export async function fetchProviders(options?: {
  skipHydrate?: boolean;
}): Promise<{
  defaultProviderId: string | null;
  providers: AiProviderConfig[];
  runtime?: string;
  securityMode: string;
}> {
  if (options?.skipHydrate) {
    memorySnapshot = null;
  }
  const savedSnap = options?.skipHydrate ? null : await getVaultSnapshotForRequest();
  const headers = options?.skipHydrate ? {} : await getVaultHeaders();

  // If saved snapshot has sealed user keys and backend might be cold (serverless), hydrate proactively
  const hasSavedSealed = Boolean(savedSnap?.providers?.some((p) => p.sealedKey));
  const res = hasSavedSealed
    ? await fetch('/api/ai/providers/hydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ providerSnapshot: savedSnap }),
      })
    : await fetch('/api/ai/providers', { headers });

  if (!res.ok) {
    throw new Error(`加载 AI 服务配置失败 (${res.status})`);
  }
  const data = (await res.json()) as {
    defaultProviderId: string | null;
    providers: AiProviderConfig[];
    runtime?: string;
    securityMode: string;
  };
  await persistProviderSnapshotPatch({
    defaultProviderId: data.defaultProviderId,
    providers: data.providers,
  });
  return data;
}

export async function saveProvider(payload: {
  id?: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  availableModels?: string[];
  apiKey?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxRequestsPerDay?: number;
  customHeadersJson?: string;
  setAsDefault?: boolean;
}): Promise<{ defaultProviderId: string | null; provider: AiProviderConfig }> {
  const snap = await getVaultSnapshotForRequest();
  const headers = await getVaultHeaders();
  const res = await fetch('/api/ai/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ...payload, providerSnapshot: snap }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error || '保存服务商失败');
  }
  await fetchProviders().catch(() => {});
  return json;
}

export async function deleteProviderById(id: string): Promise<void> {
  const headers = await getVaultHeaders();
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || '删除服务商失败');
  }
  const prev = await getVaultSnapshotForRequest();
  if (prev) {
    await persistProviderSnapshotPatch({
      providers: prev.providers.filter((p) => p.id !== id),
    });
  }
}

export async function deleteProviderKey(id: string): Promise<AiProviderConfig> {
  const headers = await getVaultHeaders();
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}/key`, {
    method: 'DELETE',
    headers,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error || '删除 API Key 失败');
  }
  await fetchProviders().catch(() => {});
  return json.provider;
}

export async function setDefaultProviderById(id: string): Promise<void> {
  const headers = await getVaultHeaders();
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}/default`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || '切换默认服务商失败');
  }
  await persistProviderSnapshotPatch({ defaultProviderId: id });
}

export async function testProviderApi(
  id: string
): Promise<DetailedTestConnectionResult & { provider?: AiProviderConfig }> {
  const snap = await getVaultSnapshotForRequest();
  const headers = await getVaultHeaders();
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ providerSnapshot: snap }),
  });
  const json = await res.json();
  await fetchProviders().catch(() => {});
  return json;
}

export async function fetchProviderModels(id: string): Promise<{
  models: DiscoveredModel[];
  supportsModelListing: boolean;
  message?: string;
}> {
  const snap = await getVaultSnapshotForRequest();
  const headers = await getVaultHeaders();
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ providerSnapshot: snap }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error || '获取模型列表失败');
  }
  await fetchProviders().catch(() => {});
  return json;
}

export async function fetchStemServices(): Promise<{
  activeStemServiceId: string | null;
  services: StemServiceConfig[];
}> {
  const headers = await getVaultHeaders();
  const res = await fetch('/api/ai/stem-services', { headers });
  if (!res.ok) {
    throw new Error('加载音源分离服务配置失败');
  }
  const data = (await res.json()) as {
    activeStemServiceId: string | null;
    services: StemServiceConfig[];
  };
  await persistProviderSnapshotPatch({
    activeStemServiceId: data.activeStemServiceId,
    stemServices: data.services,
  });
  return data;
}

export async function saveStemService(payload: {
  id?: string;
  name: string;
  kind: StemServiceKind;
  baseUrl: string;
  endpointPath: string;
  apiKey?: string;
  clearKey?: boolean;
  enabled?: boolean;
  timeoutMs?: number;
  setActive?: boolean;
}): Promise<{ activeStemServiceId: string | null; service: StemServiceConfig }> {
  const headers = await getVaultHeaders();
  const res = await fetch('/api/ai/stem-services', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error || '保存音源分离服务失败');
  }
  await fetchStemServices().catch(() => {});
  return json;
}

export async function setActiveStemServiceId(serviceId: string | null): Promise<void> {
  const headers = await getVaultHeaders();
  const res = await fetch('/api/ai/stem-services/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ serviceId }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || '切换音源分离服务失败');
  }
  await persistProviderSnapshotPatch({ activeStemServiceId: serviceId });
}

export async function deleteStemServiceById(id: string): Promise<void> {
  const headers = await getVaultHeaders();
  const res = await fetch(`/api/ai/stem-services/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || '删除分离服务失败');
  }
}

export async function testStemServiceById(id: string): Promise<{
  ok: boolean;
  message?: string;
  error?: string;
  service?: StemServiceConfig;
}> {
  const headers = await getVaultHeaders();
  const res = await fetch(`/api/ai/stem-services/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers,
  });
  return res.json();
}
