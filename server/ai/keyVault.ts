import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  getCacheDir,
  isServerlessRuntime,
  maskSecretKey,
  sealSecret,
  unsealSecret,
} from './cryptoSeal.ts';

export type AiProviderKind =
  | 'deepseek'
  | 'openai'
  | 'gemini'
  | 'openai-compatible'
  | 'custom';

export type ProviderConnectionStatus = 'untested' | 'connected' | 'error';

export interface StoredAiProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  availableModels: string[];
  encryptedApiKey?: string; // AES-256-GCM sealed token; never plaintext to client
  maskedKey: string;
  hasKey: boolean;
  keySource?: 'user' | 'env';
  enabled: boolean;
  timeoutMs: number;
  maxRequestsPerDay: number; // 0 = unlimited
  requestsToday: number;
  requestsDate: string; // YYYY-MM-DD
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
  lastLatencyMs?: number;
  customHeadersJson?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicAiProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  availableModels: string[];
  maskedKey: string;
  hasKey: boolean;
  keySource?: 'user' | 'env';
  sealedKey?: string; // Opaque AES-256-GCM ciphertext used ONLY to re-hydrate stateless serverless requests
  enabled: boolean;
  isDefault: boolean;
  timeoutMs: number;
  maxRequestsPerDay: number;
  requestsToday: number;
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
  lastLatencyMs?: number;
  customHeadersJson?: string;
  createdAt: number;
  updatedAt: number;
}

export type StemServiceKind = 'builtin-mdx' | 'remote-demucs-http' | 'none';

export interface StoredStemService {
  id: string;
  name: string;
  kind: StemServiceKind;
  baseUrl: string;
  endpointPath: string;
  encryptedApiKey?: string;
  maskedKey: string;
  hasKey: boolean;
  enabled: boolean;
  timeoutMs: number;
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
}

export interface PublicStemService {
  id: string;
  name: string;
  kind: StemServiceKind;
  baseUrl: string;
  endpointPath: string;
  maskedKey: string;
  hasKey: boolean;
  sealedKey?: string;
  enabled: boolean;
  isActive: boolean;
  timeoutMs: number;
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
}

export interface VaultState {
  version: 1;
  defaultProviderId: string | null;
  providers: StoredAiProvider[];
  activeStemServiceId: string | null;
  stemServices: StoredStemService[];
}

export interface ClientVaultSnapshot {
  defaultProviderId?: string | null;
  providers?: Array<Partial<PublicAiProvider>>;
  activeStemServiceId?: string | null;
  stemServices?: Array<Partial<PublicStemService>>;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

let cachedVault: VaultState | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function getVaultFilePath(): string {
  return path.join(getCacheDir(), 'ai-providers-vault.enc');
}

function getEnvApiKeyForDefault(id: string): string {
  if (id === 'provider-gemini-default') {
    return (process.env.GEMINI_API_KEY || '').trim();
  }
  if (id === 'provider-deepseek-default') {
    return (process.env.DEEPSEEK_API_KEY || '').trim();
  }
  if (id === 'provider-openai-default') {
    return (process.env.OPENAI_API_KEY || '').trim();
  }
  return '';
}

function createInitialVaultState(): VaultState {
  const now = Date.now();
  const deepseekEnv = getEnvApiKeyForDefault('provider-deepseek-default');
  const openaiEnv = getEnvApiKeyForDefault('provider-openai-default');
  const geminiEnv = getEnvApiKeyForDefault('provider-gemini-default');

  const defaultId = deepseekEnv
    ? 'provider-deepseek-default'
    : geminiEnv
    ? 'provider-gemini-default'
    : openaiEnv
    ? 'provider-openai-default'
    : 'provider-deepseek-default';

  return {
    version: 1,
    defaultProviderId: defaultId,
    providers: [
      {
        id: 'provider-deepseek-default',
        name: 'DeepSeek',
        kind: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        availableModels: ['deepseek-chat', 'deepseek-reasoner'],
        maskedKey: deepseekEnv ? maskSecretKey(deepseekEnv) : '',
        hasKey: Boolean(deepseekEnv),
        keySource: deepseekEnv ? 'env' : undefined,
        enabled: true,
        timeoutMs: 30000,
        maxRequestsPerDay: 0,
        requestsToday: 0,
        requestsDate: todayIso(),
        connectionStatus: 'untested',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'provider-openai-default',
        name: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        availableModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
        maskedKey: openaiEnv ? maskSecretKey(openaiEnv) : '',
        hasKey: Boolean(openaiEnv),
        keySource: openaiEnv ? 'env' : undefined,
        enabled: true,
        timeoutMs: 30000,
        maxRequestsPerDay: 0,
        requestsToday: 0,
        requestsDate: todayIso(),
        connectionStatus: 'untested',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'provider-gemini-default',
        name: 'Google Gemini',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-4-hydrogen',
        availableModels: [
          'gemini-4-hydrogen',
          'gemini-3.1-flash-lite',
          'gemini-4-argon',
        ],
        maskedKey: geminiEnv ? maskSecretKey(geminiEnv) : '',
        hasKey: Boolean(geminiEnv),
        keySource: geminiEnv ? 'env' : undefined,
        enabled: true,
        timeoutMs: 45000,
        maxRequestsPerDay: 0,
        requestsToday: 0,
        requestsDate: todayIso(),
        connectionStatus: 'untested',
        createdAt: now,
        updatedAt: now,
      },
    ],
    activeStemServiceId: 'stem-builtin-mdx',
    stemServices: [
      {
        id: 'stem-builtin-mdx',
        name: '内置 UVR MDX-Net (Kim_Vocal_2)',
        kind: 'builtin-mdx',
        baseUrl: '/api/stems',
        endpointPath: '/separate',
        maskedKey: '',
        hasKey: true,
        enabled: true,
        timeoutMs: 300000,
        connectionStatus: 'connected',
        lastCheckedAt: now,
      },
      {
        id: 'stem-remote-demucs',
        name: '外部 Demucs / Spleeter 分离服务',
        kind: 'remote-demucs-http',
        baseUrl: '',
        endpointPath: '/separate',
        maskedKey: '',
        hasKey: false,
        enabled: false,
        timeoutMs: 180000,
        connectionStatus: 'untested',
      },
    ],
  };
}

function hydrateEnvFallbackOnVault(vault: VaultState): void {
  for (const p of vault.providers) {
    if (!p.encryptedApiKey) {
      const envKey = getEnvApiKeyForDefault(p.id);
      if (envKey) {
        p.hasKey = true;
        p.maskedKey = maskSecretKey(envKey);
        p.keySource = 'env';
      } else if (p.keySource === 'env') {
        p.hasKey = false;
        p.maskedKey = '';
        p.keySource = undefined;
      }
    } else {
      p.keySource = 'user';
    }
  }
}

async function loadVault(): Promise<VaultState> {
  if (cachedVault) {
    hydrateEnvFallbackOnVault(cachedVault);
    return cachedVault;
  }

  const cacheDir = getCacheDir();
  const vaultFile = getVaultFilePath();
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    if (fs.existsSync(vaultFile)) {
      const payload = await fsp.readFile(vaultFile, 'utf8');
      const plain = await unsealSecret(payload.trim());
      if (plain) {
        const parsed = JSON.parse(plain) as VaultState;
        if (parsed && Array.isArray(parsed.providers) && Array.isArray(parsed.stemServices)) {
          hydrateEnvFallbackOnVault(parsed);
          cachedVault = parsed;
          return cachedVault;
        }
      }
    }
  } catch {
    // Fall through to initial vault if unreadable or ephemeral
  }

  cachedVault = createInitialVaultState();
  await persistVault(cachedVault).catch(() => {});
  return cachedVault;
}

async function persistVault(state: VaultState): Promise<void> {
  cachedVault = state;
  writeQueue = writeQueue.then(async () => {
    try {
      const cacheDir = getCacheDir();
      const vaultFile = getVaultFilePath();
      const serialized = await sealSecret(JSON.stringify(state));
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(vaultFile, serialized, { mode: 0o600 });
    } catch {
      // Serverless read-only filesystems fall back to /tmp or snapshot re-hydration
    }
  });
  await writeQueue;
}

function toPublicProvider(
  p: StoredAiProvider,
  defaultId: string | null
): PublicAiProvider {
  const today = todayIso();
  const requestsToday = p.requestsDate === today ? p.requestsToday : 0;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    availableModels: p.availableModels,
    maskedKey: p.maskedKey,
    hasKey: p.hasKey,
    keySource: p.keySource,
    sealedKey: p.encryptedApiKey,
    enabled: p.enabled,
    isDefault: p.id === defaultId,
    timeoutMs: p.timeoutMs,
    maxRequestsPerDay: p.maxRequestsPerDay,
    requestsToday,
    connectionStatus: p.connectionStatus,
    lastError: p.lastError,
    lastCheckedAt: p.lastCheckedAt,
    lastLatencyMs: p.lastLatencyMs,
    customHeadersJson: p.customHeadersJson,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toPublicStemService(
  s: StoredStemService,
  activeId: string | null
): PublicStemService {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    baseUrl: s.baseUrl,
    endpointPath: s.endpointPath,
    maskedKey: s.maskedKey,
    hasKey: s.hasKey,
    sealedKey: s.encryptedApiKey,
    enabled: s.enabled,
    isActive: s.id === activeId,
    timeoutMs: s.timeoutMs,
    connectionStatus: s.connectionStatus,
    lastError: s.lastError,
    lastCheckedAt: s.lastCheckedAt,
  };
}

/**
 * Re-hydrates an ephemeral serverless vault instance from a client-cached non-secret + sealedKey snapshot.
 */
export async function hydrateVaultFromClientSnapshot(
  snapshot?: ClientVaultSnapshot | null
): Promise<void> {
  if (!snapshot || (!Array.isArray(snapshot.providers) && !Array.isArray(snapshot.stemServices))) {
    return;
  }
  const vault = await loadVault();
  const now = Date.now();
  let changed = false;

  if (Array.isArray(snapshot.providers)) {
    for (const incoming of snapshot.providers) {
      if (!incoming || !incoming.id || !incoming.kind) continue;
      const existing = vault.providers.find((p) => p.id === incoming.id);
      if (existing) {
        // Only fill/upgrade if incoming is newer or existing has no user key while incoming has valid sealedKey
        const incomingIsNewer =
          typeof incoming.updatedAt === 'number' &&
          incoming.updatedAt > (existing.updatedAt || 0);
        if (!existing.encryptedApiKey && incoming.sealedKey) {
          const checkPlain = await unsealSecret(incoming.sealedKey);
          if (checkPlain) {
            existing.encryptedApiKey = incoming.sealedKey;
            existing.hasKey = true;
            existing.maskedKey = incoming.maskedKey || maskSecretKey(checkPlain);
            existing.keySource = 'user';
            changed = true;
          }
        }
        if (incomingIsNewer) {
          existing.name = incoming.name || existing.name;
          existing.kind = incoming.kind;
          existing.baseUrl = incoming.baseUrl || existing.baseUrl;
          existing.model = incoming.model ?? existing.model;
          if (Array.isArray(incoming.availableModels) && incoming.availableModels.length > 0) {
            existing.availableModels = incoming.availableModels;
          }
          existing.enabled = incoming.enabled ?? existing.enabled;
          existing.timeoutMs = incoming.timeoutMs ?? existing.timeoutMs;
          existing.maxRequestsPerDay =
            incoming.maxRequestsPerDay ?? existing.maxRequestsPerDay;
          existing.customHeadersJson =
            incoming.customHeadersJson ?? existing.customHeadersJson;
          existing.updatedAt = incoming.updatedAt || now;
          changed = true;
        }
      } else {
        let validSealed: string | undefined;
        let masked = incoming.maskedKey || '';
        let hasKey = false;
        if (incoming.sealedKey) {
          const checkPlain = await unsealSecret(incoming.sealedKey);
          if (checkPlain) {
            validSealed = incoming.sealedKey;
            masked = masked || maskSecretKey(checkPlain);
            hasKey = true;
          }
        }
        vault.providers.push({
          id: incoming.id,
          name: incoming.name || 'AI 服务',
          kind: incoming.kind,
          baseUrl: incoming.baseUrl || '',
          model: incoming.model || '',
          availableModels: Array.isArray(incoming.availableModels)
            ? incoming.availableModels
            : incoming.model
            ? [incoming.model]
            : [],
          encryptedApiKey: validSealed,
          maskedKey: masked,
          hasKey,
          keySource: hasKey ? 'user' : undefined,
          enabled: incoming.enabled ?? true,
          timeoutMs: incoming.timeoutMs || 30000,
          maxRequestsPerDay: incoming.maxRequestsPerDay || 0,
          requestsToday: 0,
          requestsDate: todayIso(),
          connectionStatus: incoming.connectionStatus || 'untested',
          lastError: incoming.lastError,
          lastCheckedAt: incoming.lastCheckedAt,
          lastLatencyMs: incoming.lastLatencyMs,
          customHeadersJson: incoming.customHeadersJson,
          createdAt: incoming.createdAt || now,
          updatedAt: incoming.updatedAt || now,
        });
        changed = true;
      }
    }

    if (
      snapshot.defaultProviderId &&
      vault.providers.some((p) => p.id === snapshot.defaultProviderId) &&
      snapshot.defaultProviderId !== vault.defaultProviderId
    ) {
      vault.defaultProviderId = snapshot.defaultProviderId;
      changed = true;
    }
  }

  if (Array.isArray(snapshot.stemServices)) {
    for (const incoming of snapshot.stemServices) {
      if (!incoming || !incoming.id || !incoming.kind) continue;
      const existing = vault.stemServices.find((s) => s.id === incoming.id);
      if (existing) {
        if (!existing.encryptedApiKey && incoming.sealedKey) {
          const plain = await unsealSecret(incoming.sealedKey);
          if (plain) {
            existing.encryptedApiKey = incoming.sealedKey;
            existing.hasKey = true;
            existing.maskedKey = incoming.maskedKey || maskSecretKey(plain);
            changed = true;
          }
        }
      } else {
        let validSealed: string | undefined;
        let hasKey = incoming.kind === 'builtin-mdx';
        let masked = incoming.maskedKey || '';
        if (incoming.sealedKey) {
          const plain = await unsealSecret(incoming.sealedKey);
          if (plain) {
            validSealed = incoming.sealedKey;
            hasKey = true;
            masked = masked || maskSecretKey(plain);
          }
        }
        vault.stemServices.push({
          id: incoming.id,
          name: incoming.name || '自定义分离服务',
          kind: incoming.kind,
          baseUrl: incoming.baseUrl || '',
          endpointPath: incoming.endpointPath || '/separate',
          encryptedApiKey: validSealed,
          maskedKey: masked,
          hasKey,
          enabled: incoming.enabled ?? true,
          timeoutMs: incoming.timeoutMs || 180000,
          connectionStatus: incoming.connectionStatus || 'untested',
        });
        changed = true;
      }
    }
    if (snapshot.activeStemServiceId !== undefined) {
      vault.activeStemServiceId = snapshot.activeStemServiceId;
      changed = true;
    }
  }

  if (changed) {
    await persistVault(vault);
  }
}

export async function listPublicProviders(): Promise<{
  defaultProviderId: string | null;
  providers: PublicAiProvider[];
  runtime: 'netlify-serverless' | 'node-express';
  securityMode: string;
}> {
  const vault = await loadVault();
  const serverless = isServerlessRuntime();
  return {
    defaultProviderId: vault.defaultProviderId,
    providers: vault.providers.map((p) => toPublicProvider(p, vault.defaultProviderId)),
    runtime: serverless ? 'netlify-serverless' : 'node-express',
    securityMode: serverless ? 'serverless-sealed-proxy' : 'backend-encrypted-proxy',
  };
}

export async function getStoredProviderWithKey(
  providerId?: string,
  options?: { strict?: boolean; snapshot?: ClientVaultSnapshot | null }
): Promise<{
  provider: StoredAiProvider;
  apiKey: string;
} | null> {
  if (options?.snapshot) {
    await hydrateVaultFromClientSnapshot(options.snapshot);
  }
  const vault = await loadVault();
  const explicitId = (providerId || '').trim();
  const targetId = explicitId || vault.defaultProviderId;

  let found: StoredAiProvider | null = null;
  if (explicitId && options?.strict) {
    found = vault.providers.find((p) => p.id === explicitId) || null;
  } else {
    found =
      vault.providers.find((p) => p.id === targetId) ||
      (explicitId ? null : vault.providers.find((p) => p.enabled && p.hasKey)) ||
      null;
  }

  if (!found) return null;

  let apiKey = await unsealSecret(found.encryptedApiKey);
  if (!apiKey) {
    apiKey = getEnvApiKeyForDefault(found.id);
  }
  return { provider: found, apiKey };
}

export async function upsertProvider(input: {
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
}): Promise<{ defaultProviderId: string | null; provider: PublicAiProvider }> {
  const vault = await loadVault();
  const now = Date.now();
  const existingIdx = input.id
    ? vault.providers.findIndex((p) => p.id === input.id)
    : -1;

  const trimmedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const hasNewKey = trimmedKey.length > 0;

  if (existingIdx >= 0) {
    const prev = vault.providers[existingIdx];
    const nextEncrypted = hasNewKey
      ? await sealSecret(trimmedKey)
      : prev.encryptedApiKey;
    const nextMasked = hasNewKey ? maskSecretKey(trimmedKey) : prev.maskedKey;
    const envFallback = !nextEncrypted ? getEnvApiKeyForDefault(prev.id) : '';
    const nextHasKey = hasNewKey ? true : Boolean(nextEncrypted || envFallback);

    const updated: StoredAiProvider = {
      ...prev,
      name: input.name.trim() || prev.name,
      kind: input.kind,
      baseUrl: input.baseUrl.trim(),
      model: input.model.trim() || prev.model,
      availableModels: Array.isArray(input.availableModels)
        ? input.availableModels
        : prev.availableModels,
      encryptedApiKey: nextEncrypted,
      maskedKey: nextMasked || (envFallback ? maskSecretKey(envFallback) : ''),
      hasKey: nextHasKey,
      keySource: nextEncrypted ? 'user' : envFallback ? 'env' : undefined,
      enabled: input.enabled ?? prev.enabled,
      timeoutMs: Math.max(3000, Math.min(180000, Number(input.timeoutMs) || prev.timeoutMs)),
      maxRequestsPerDay: Math.max(0, Number(input.maxRequestsPerDay ?? prev.maxRequestsPerDay)),
      customHeadersJson: input.customHeadersJson ?? prev.customHeadersJson,
      connectionStatus: hasNewKey ? 'untested' : prev.connectionStatus,
      lastError: hasNewKey ? undefined : prev.lastError,
      updatedAt: now,
    };
    vault.providers[existingIdx] = updated;
    if (input.setAsDefault) {
      vault.defaultProviderId = updated.id;
    }
    await persistVault(vault);
    return {
      defaultProviderId: vault.defaultProviderId,
      provider: toPublicProvider(updated, vault.defaultProviderId),
    };
  }

  const newId = input.id || `provider-${crypto.randomUUID().slice(0, 8)}`;
  const created: StoredAiProvider = {
    id: newId,
    name: input.name.trim() || '自定义 AI 服务',
    kind: input.kind,
    baseUrl: input.baseUrl.trim(),
    model: input.model.trim(),
    availableModels: Array.isArray(input.availableModels)
      ? input.availableModels
      : input.model.trim()
      ? [input.model.trim()]
      : [],
    encryptedApiKey: hasNewKey ? await sealSecret(trimmedKey) : undefined,
    maskedKey: hasNewKey ? maskSecretKey(trimmedKey) : '',
    hasKey: hasNewKey,
    keySource: hasNewKey ? 'user' : undefined,
    enabled: input.enabled ?? true,
    timeoutMs: Math.max(3000, Math.min(180000, Number(input.timeoutMs) || 30000)),
    maxRequestsPerDay: Math.max(0, Number(input.maxRequestsPerDay) || 0),
    requestsToday: 0,
    requestsDate: todayIso(),
    connectionStatus: 'untested',
    customHeadersJson: input.customHeadersJson,
    createdAt: now,
    updatedAt: now,
  };

  vault.providers.push(created);
  if (input.setAsDefault || !vault.defaultProviderId) {
    vault.defaultProviderId = created.id;
  }
  await persistVault(vault);
  return {
    defaultProviderId: vault.defaultProviderId,
    provider: toPublicProvider(created, vault.defaultProviderId),
  };
}

export async function clearProviderKey(providerId: string): Promise<PublicAiProvider | null> {
  const vault = await loadVault();
  const target = vault.providers.find((p) => p.id === providerId);
  if (!target) return null;
  target.encryptedApiKey = undefined;
  const envFallback = getEnvApiKeyForDefault(target.id);
  target.maskedKey = envFallback ? maskSecretKey(envFallback) : '';
  target.hasKey = Boolean(envFallback);
  target.keySource = envFallback ? 'env' : undefined;
  target.connectionStatus = 'untested';
  target.lastError = undefined;
  target.updatedAt = Date.now();
  await persistVault(vault);
  return toPublicProvider(target, vault.defaultProviderId);
}

export async function deleteProvider(providerId: string): Promise<boolean> {
  const vault = await loadVault();
  const before = vault.providers.length;
  vault.providers = vault.providers.filter((p) => p.id !== providerId);
  if (vault.providers.length === before) return false;
  if (vault.defaultProviderId === providerId) {
    vault.defaultProviderId = vault.providers[0]?.id ?? null;
  }
  await persistVault(vault);
  return true;
}

export async function setDefaultProvider(providerId: string): Promise<boolean> {
  const vault = await loadVault();
  if (!vault.providers.some((p) => p.id === providerId)) return false;
  vault.defaultProviderId = providerId;
  await persistVault(vault);
  return true;
}

export async function recordProviderProbeResult(
  providerId: string,
  result: {
    status: ProviderConnectionStatus;
    error?: string;
    latencyMs?: number;
    availableModels?: string[];
  }
): Promise<PublicAiProvider | null> {
  const vault = await loadVault();
  const target = vault.providers.find((p) => p.id === providerId);
  if (!target) return null;
  target.connectionStatus = result.status;
  target.lastError = result.error;
  target.lastCheckedAt = Date.now();
  if (typeof result.latencyMs === 'number') {
    target.lastLatencyMs = result.latencyMs;
  }
  if (result.availableModels && result.availableModels.length > 0) {
    target.availableModels = result.availableModels;
  }
  target.updatedAt = Date.now();
  await persistVault(vault);
  return toPublicProvider(target, vault.defaultProviderId);
}

export async function checkAndIncrementProviderQuota(
  providerId: string
): Promise<{ allowed: boolean; error?: string }> {
  const vault = await loadVault();
  const target = vault.providers.find((p) => p.id === providerId);
  if (!target) return { allowed: false, error: '未找到指定 AI 服务商' };
  const today = todayIso();
  if (target.requestsDate !== today) {
    target.requestsDate = today;
    target.requestsToday = 0;
  }
  if (
    target.maxRequestsPerDay > 0 &&
    target.requestsToday >= target.maxRequestsPerDay
  ) {
    return {
      allowed: false,
      error: `已达到「${target.name}」设定的每日最大请求限制 (${target.maxRequestsPerDay} 次/日)`,
    };
  }
  target.requestsToday += 1;
  await persistVault(vault);
  return { allowed: true };
}

/**
 * Passphrase-protected encrypted backup export of user API keys (PBKDF2 + AES-256-GCM).
 * Plaintext keys NEVER leave the vault unencrypted.
 */
export interface EncryptedBackupSecretsEnvelope {
  algorithm: 'PBKDF2-SHA256-AES-256-GCM';
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  keyCount: number;
}

export async function exportEncryptedBackupSecrets(
  passphrase: string,
  snapshot?: ClientVaultSnapshot | null
): Promise<EncryptedBackupSecretsEnvelope> {
  const cleanPass = (passphrase || '').trim();
  if (cleanPass.length < 4) {
    throw new Error('备份加密口令至少需要 4 个字符');
  }
  if (snapshot) {
    await hydrateVaultFromClientSnapshot(snapshot);
  }
  const vault = await loadVault();
  const secretMap: Record<string, string> = {};
  for (const p of vault.providers) {
    if (p.encryptedApiKey) {
      const plain = await unsealSecret(p.encryptedApiKey);
      if (plain) secretMap[`provider:${p.id}`] = plain;
    }
  }
  for (const s of vault.stemServices) {
    if (s.encryptedApiKey) {
      const plain = await unsealSecret(s.encryptedApiKey);
      if (plain) secretMap[`stem:${s.id}`] = plain;
    }
  }

  const iterations = 150000;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(cleanPass, salt, iterations, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secretMap), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    algorithm: 'PBKDF2-SHA256-AES-256-GCM',
    iterations,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    keyCount: Object.keys(secretMap).length,
  };
}

export async function importEncryptedBackupSecrets(params: {
  aiConfigMetadata?: ClientVaultSnapshot;
  encryptedSecrets?: EncryptedBackupSecretsEnvelope;
  passphrase?: string;
}): Promise<{
  providersRestored: number;
  keysRestored: number;
  defaultProviderId: string | null;
  providers: PublicAiProvider[];
}> {
  const vault = await loadVault();
  let decryptedMap: Record<string, string> = {};

  if (params.encryptedSecrets) {
    const cleanPass = (params.passphrase || '').trim();
    if (!cleanPass) {
      throw new Error('该备份包含加密的 API 密钥，请输入备份加密口令后再恢复密钥');
    }
    try {
      const env = params.encryptedSecrets;
      const key = crypto.pbkdf2Sync(
        cleanPass,
        Buffer.from(env.salt, 'hex'),
        Math.max(10000, env.iterations || 150000),
        32,
        'sha256'
      );
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(env.iv, 'hex')
      );
      decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(env.ciphertext, 'hex')),
        decipher.final(),
      ]).toString('utf8');
      decryptedMap = JSON.parse(plain) as Record<string, string>;
    } catch {
      throw new Error('备份口令错误或加密密钥数据已损坏，无法解密 API 密钥');
    }
  }

  let providersRestored = 0;
  let keysRestored = 0;
  const now = Date.now();

  if (params.aiConfigMetadata?.providers) {
    for (const meta of params.aiConfigMetadata.providers) {
      if (!meta?.id || !meta?.kind) continue;
      const restoredPlainKey = decryptedMap[`provider:${meta.id}`] || '';
      const existing = vault.providers.find((p) => p.id === meta.id);
      const sealed = restoredPlainKey ? await sealSecret(restoredPlainKey) : undefined;
      if (sealed) keysRestored++;

      if (existing) {
        existing.name = meta.name || existing.name;
        existing.kind = meta.kind;
        existing.baseUrl = meta.baseUrl || existing.baseUrl;
        existing.model = meta.model ?? existing.model;
        if (Array.isArray(meta.availableModels) && meta.availableModels.length > 0) {
          existing.availableModels = meta.availableModels;
        }
        existing.enabled = meta.enabled ?? existing.enabled;
        existing.timeoutMs = meta.timeoutMs ?? existing.timeoutMs;
        existing.maxRequestsPerDay = meta.maxRequestsPerDay ?? existing.maxRequestsPerDay;
        existing.customHeadersJson = meta.customHeadersJson ?? existing.customHeadersJson;
        if (sealed) {
          existing.encryptedApiKey = sealed;
          existing.maskedKey = maskSecretKey(restoredPlainKey);
          existing.hasKey = true;
          existing.keySource = 'user';
        }
        existing.updatedAt = now;
      } else {
        vault.providers.push({
          id: meta.id,
          name: meta.name || 'AI 服务',
          kind: meta.kind,
          baseUrl: meta.baseUrl || '',
          model: meta.model || '',
          availableModels: Array.isArray(meta.availableModels) ? meta.availableModels : [],
          encryptedApiKey: sealed,
          maskedKey: sealed ? maskSecretKey(restoredPlainKey) : '',
          hasKey: Boolean(sealed),
          keySource: sealed ? 'user' : undefined,
          enabled: meta.enabled ?? true,
          timeoutMs: meta.timeoutMs || 30000,
          maxRequestsPerDay: meta.maxRequestsPerDay || 0,
          requestsToday: 0,
          requestsDate: todayIso(),
          connectionStatus: 'untested',
          customHeadersJson: meta.customHeadersJson,
          createdAt: meta.createdAt || now,
          updatedAt: now,
        });
      }
      providersRestored++;
    }
    if (
      params.aiConfigMetadata.defaultProviderId &&
      vault.providers.some((p) => p.id === params.aiConfigMetadata?.defaultProviderId)
    ) {
      vault.defaultProviderId = params.aiConfigMetadata.defaultProviderId;
    }
  }

  hydrateEnvFallbackOnVault(vault);
  await persistVault(vault);

  return {
    providersRestored,
    keysRestored,
    defaultProviderId: vault.defaultProviderId,
    providers: vault.providers.map((p) => toPublicProvider(p, vault.defaultProviderId)),
  };
}

export async function listPublicStemServices(): Promise<{
  activeStemServiceId: string | null;
  services: PublicStemService[];
}> {
  const vault = await loadVault();
  return {
    activeStemServiceId: vault.activeStemServiceId,
    services: vault.stemServices.map((s) =>
      toPublicStemService(s, vault.activeStemServiceId)
    ),
  };
}

export async function getActiveStemServiceWithKey(): Promise<{
  service: StoredStemService;
  apiKey: string;
} | null> {
  const vault = await loadVault();
  const target = vault.stemServices.find(
    (s) => s.id === vault.activeStemServiceId
  );
  if (!target) return null;
  const apiKey = await unsealSecret(target.encryptedApiKey);
  return { service: target, apiKey };
}

export async function upsertStemService(input: {
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
}): Promise<{ activeStemServiceId: string | null; service: PublicStemService }> {
  const vault = await loadVault();
  const idx = input.id
    ? vault.stemServices.findIndex((s) => s.id === input.id)
    : -1;
  const trimmedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const hasNewKey = trimmedKey.length > 0;

  if (idx >= 0) {
    const prev = vault.stemServices[idx];
    const nextEncrypted = input.clearKey
      ? undefined
      : hasNewKey
      ? await sealSecret(trimmedKey)
      : prev.encryptedApiKey;
    const nextMasked = input.clearKey
      ? ''
      : hasNewKey
      ? maskSecretKey(trimmedKey)
      : prev.maskedKey;
    const nextHasKey =
      prev.kind === 'builtin-mdx'
        ? true
        : input.clearKey
        ? false
        : hasNewKey
        ? true
        : prev.hasKey;

    const updated: StoredStemService = {
      ...prev,
      name: input.name.trim() || prev.name,
      kind: input.kind,
      baseUrl: input.baseUrl.trim(),
      endpointPath: input.endpointPath.trim() || '/separate',
      encryptedApiKey: nextEncrypted,
      maskedKey: nextMasked,
      hasKey: nextHasKey,
      enabled: input.enabled ?? prev.enabled,
      timeoutMs: Math.max(10000, Math.min(600000, Number(input.timeoutMs) || prev.timeoutMs)),
      connectionStatus:
        prev.kind === 'builtin-mdx' ? 'connected' : hasNewKey ? 'untested' : prev.connectionStatus,
    };
    vault.stemServices[idx] = updated;
    if (input.setActive) {
      vault.activeStemServiceId = updated.id;
    }
    await persistVault(vault);
    return {
      activeStemServiceId: vault.activeStemServiceId,
      service: toPublicStemService(updated, vault.activeStemServiceId),
    };
  }

  const newId = input.id || `stem-${crypto.randomUUID().slice(0, 8)}`;
  const created: StoredStemService = {
    id: newId,
    name: input.name.trim() || '自定义音源分离服务',
    kind: input.kind,
    baseUrl: input.baseUrl.trim(),
    endpointPath: input.endpointPath.trim() || '/separate',
    encryptedApiKey: hasNewKey ? await sealSecret(trimmedKey) : undefined,
    maskedKey: hasNewKey ? maskSecretKey(trimmedKey) : '',
    hasKey: input.kind === 'builtin-mdx' ? true : hasNewKey,
    enabled: input.enabled ?? true,
    timeoutMs: Math.max(10000, Math.min(600000, Number(input.timeoutMs) || 180000)),
    connectionStatus: 'untested',
  };
  vault.stemServices.push(created);
  if (input.setActive) {
    vault.activeStemServiceId = created.id;
  }
  await persistVault(vault);
  return {
    activeStemServiceId: vault.activeStemServiceId,
    service: toPublicStemService(created, vault.activeStemServiceId),
  };
}

export async function setActiveStemService(serviceId: string | null): Promise<boolean> {
  const vault = await loadVault();
  if (serviceId !== null && !vault.stemServices.some((s) => s.id === serviceId)) {
    return false;
  }
  vault.activeStemServiceId = serviceId;
  await persistVault(vault);
  return true;
}

export async function deleteStemService(serviceId: string): Promise<boolean> {
  if (serviceId === 'stem-builtin-mdx') return false;
  const vault = await loadVault();
  const before = vault.stemServices.length;
  vault.stemServices = vault.stemServices.filter((s) => s.id !== serviceId);
  if (vault.stemServices.length === before) return false;
  if (vault.activeStemServiceId === serviceId) {
    vault.activeStemServiceId = vault.stemServices[0]?.id ?? null;
  }
  await persistVault(vault);
  return true;
}

export async function recordStemServiceProbeResult(
  serviceId: string,
  result: { status: ProviderConnectionStatus; error?: string }
): Promise<PublicStemService | null> {
  const vault = await loadVault();
  const target = vault.stemServices.find((s) => s.id === serviceId);
  if (!target) return null;
  target.connectionStatus = result.status;
  target.lastError = result.error;
  target.lastCheckedAt = Date.now();
  await persistVault(vault);
  return toPublicStemService(target, vault.activeStemServiceId);
}
