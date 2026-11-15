import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { sanitizeSecretError } from './cryptoSeal.ts';
import {
  AiProviderKind,
  checkAndIncrementProviderQuota,
  ClientVaultSnapshot,
  getStoredProviderWithKey,
  recordProviderProbeResult,
  StoredAiProvider,
} from './keyVault.ts';

export type ErrorCategory =
  | 'auth_error'
  | 'model_not_found'
  | 'base_url_error'
  | 'timeout_error'
  | 'network_error'
  | 'quota_error'
  | 'empty_response'
  | 'unknown_error';

export interface ModelCapabilities {
  textReasoning: boolean;
  lyricsProcessing: boolean;
  dspPlanning: boolean;
  audioInputAnalysis: boolean;
  stemSeparation: boolean; // Always false for LLM text/multimodal APIs; requires dedicated separation service
  note?: string;
}

export interface DiscoveredModel {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
}

export interface DetailedTestConnectionResult {
  ok: boolean;
  providerId: string;
  providerName: string;
  modelUsed: string;
  latencyMs: number;
  httpStatus?: number;
  errorCategory?: ErrorCategory;
  error?: string;
  modelsFound?: number;
}

export interface AdapterCompletionParams {
  provider: StoredAiProvider;
  apiKey: string;
  modelOverride?: string;
  systemInstruction: string;
  userPrompt: string;
  expectJson?: boolean;
  audioInline?: { mimeType: string; base64Data: string };
  signal?: AbortSignal;
}

export interface AiProviderAdapter {
  readonly kind: AiProviderKind;
  readonly requestFormat: 'google-genai' | 'openai-chat-completions';
  readonly responseFormat: 'google-genai-response' | 'openai-choices-json';
  fetchModels(
    provider: StoredAiProvider,
    apiKey: string
  ): Promise<{
    models: DiscoveredModel[];
    supportsModelListing: boolean;
    message?: string;
  }>;
  complete(params: AdapterCompletionParams): Promise<string>;
}

export class AdapterCallError extends Error {
  readonly category: ErrorCategory;
  readonly httpStatus?: number;

  constructor(
    message: string,
    category: ErrorCategory = 'unknown_error',
    httpStatus?: number
  ) {
    super(sanitizeSecretError(message));
    this.name = 'AdapterCallError';
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

const DEPRECATED_GEMINI_IDS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.0-flash-thinking',
]);

export function inferModelCapabilities(
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
      note: 'Gemini 支持文本规划与音频输入理解，但不能直接输出分离后的人声/伴奏音轨',
    };
  }

  if (kind === 'deepseek') {
    return {
      textReasoning: true,
      lyricsProcessing: true,
      dspPlanning: true,
      audioInputAnalysis: false,
      stemSeparation: false,
      note: 'DeepSeek 为纯文本推理模型：擅长任务调度、歌词处理与调音方案规划，不支持直接听辨音频流或分离音轨',
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
        ? '支持文本与音频输入分析，但不能直接执行音轨分离'
        : '文本对话模型：支持歌词与调音规划，不支持直接解析原始音频频谱与分离音轨',
    };
  }

  return {
    textReasoning: true,
    lyricsProcessing: true,
    dspPlanning: true,
    audioInputAnalysis: false,
    stemSeparation: false,
    note: '自定义接口默认按文本模型处理；音轨分离请使用独立分离服务',
  };
}

export function normalizeOpenAiBaseUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.openai.com/v1';
  if (/\/v\d+(?:alpha|beta)?$/i.test(trimmed)) return trimmed;
  if (trimmed.includes('api.deepseek.com')) return trimmed;
  return `${trimmed}/v1`;
}

function parseCustomHeaders(rawJson?: string): Record<string, string> {
  if (!rawJson || !rawJson.trim()) return {};
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (
        typeof v === 'string' &&
        k.toLowerCase() !== 'authorization' &&
        k.toLowerCase() !== 'x-goog-api-key'
      ) {
        clean[k] = v;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function buildTimeoutSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new AdapterCallError(
          `请求超时 (${Math.round(timeoutMs / 1000)}s)，请检查网络连通性或调大超时时间`,
          'timeout_error'
        )
      ),
    Math.max(3000, timeoutMs)
  );
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

export function classifyHttpError(
  status: number | undefined,
  rawMessage: string,
  context: 'models' | 'completion' = 'completion'
): { category: ErrorCategory; message: string } {
  const cleanMsg = sanitizeSecretError(rawMessage || '');
  const lower = cleanMsg.toLowerCase();

  if (status === 401 || status === 403 || lower.includes('api key') || lower.includes('invalid_api_key') || lower.includes('unauthorized')) {
    return {
      category: 'auth_error',
      message: `API Key 无效、已过期或权限不足${status ? ` (HTTP ${status})` : ''}: ${cleanMsg}`,
    };
  }
  if (status === 429 || lower.includes('rate limit') || lower.includes('quota') || lower.includes('insufficient_quota')) {
    return {
      category: 'quota_error',
      message: `API 配额耗尽或触发速率限制${status ? ` (HTTP ${status})` : ''}: ${cleanMsg}`,
    };
  }
  if (
    status === 404 ||
    lower.includes('model_not_found') ||
    lower.includes('does not exist') ||
    lower.includes('unknown model') ||
    lower.includes('model not found')
  ) {
    if (context === 'models' && status === 404) {
      return {
        category: 'base_url_error',
        message: `接口地址或路径可能不正确 (HTTP 404): ${cleanMsg}`,
      };
    }
    return {
      category: 'model_not_found',
      message: `指定的模型名称无效或当前账号无权访问该模型${status ? ` (HTTP ${status})` : ''}: ${cleanMsg}`,
    };
  }
  if (status === 400 && (lower.includes('model') || lower.includes('invalid argument'))) {
    return {
      category: 'model_not_found',
      message: `请求参数或模型名称不被服务商支持 (HTTP 400): ${cleanMsg}`,
    };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('超时') || lower.includes('abort')) {
    return {
      category: 'timeout_error',
      message: cleanMsg || '请求超时，请检查网络连接或服务端响应速度',
    };
  }
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('fetch failed') ||
    lower.includes('invalid url') ||
    lower.includes('failed to parse url')
  ) {
    return {
      category: 'base_url_error',
      message: `无法连接 Base URL，请检查接口地址格式与网络可达性: ${cleanMsg}`,
    };
  }
  return {
    category: status && status >= 500 ? 'network_error' : 'unknown_error',
    message: cleanMsg || `第三方 AI 接口调用失败${status ? ` (HTTP ${status})` : ''}`,
  };
}

function normalizeThrownAdapterError(
  err: unknown,
  context: 'models' | 'completion' = 'completion'
): AdapterCallError {
  if (err instanceof AdapterCallError) return err;
  const rawMsg = err instanceof Error ? err.message : String(err || '调用失败');
  const httpStatusMatch = rawMsg.match(/\b(400|401|403|404|405|429|500|502|503|504)\b/);
  const status = httpStatusMatch ? Number(httpStatusMatch[1]) : undefined;
  const classified = classifyHttpError(status, rawMsg, context);
  return new AdapterCallError(classified.message, classified.category, status);
}

class GeminiAdapter implements AiProviderAdapter {
  readonly kind: AiProviderKind = 'gemini';
  readonly requestFormat = 'google-genai' as const;
  readonly responseFormat = 'google-genai-response' as const;

  async fetchModels(provider: StoredAiProvider, apiKey: string) {
    const { signal, cleanup } = buildTimeoutSignal(Math.min(15000, provider.timeoutMs));
    try {
      const base = (
        provider.baseUrl || 'https://generativelanguage.googleapis.com'
      ).replace(/\/+$/, '');
      const res = await fetch(`${base}/v1beta/models`, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
        },
        signal,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const rawMsg =
          (errJson as { error?: { message?: string } })?.error?.message ||
          `HTTP ${res.status}`;
        const classified = classifyHttpError(res.status, rawMsg, 'models');
        throw new AdapterCallError(classified.message, classified.category, res.status);
      }

      const data = (await res.json()) as {
        models?: {
          name?: string;
          displayName?: string;
          supportedGenerationMethods?: string[];
        }[];
      };

      const rawIds = (data.models || [])
        .filter((m) =>
          (m.supportedGenerationMethods || []).includes('generateContent')
        )
        .map((m) => (m.name || '').replace(/^models\//, ''))
        .filter((id) => id && !DEPRECATED_GEMINI_IDS.has(id));

      const mergedIds = Array.from(
        new Set([
          'gemini-4-hydrogen',
          'gemini-3.1-flash-lite',
          'gemini-4-argon',
          ...rawIds,
        ])
      );

      const models: DiscoveredModel[] = mergedIds.map((id) => ({
        id,
        label: id,
        capabilities: inferModelCapabilities('gemini', id),
      }));

      await recordProviderProbeResult(provider.id, {
        status: 'connected',
        availableModels: mergedIds,
      });

      return { models, supportsModelListing: true };
    } catch (err) {
      throw normalizeThrownAdapterError(err, 'models');
    } finally {
      cleanup();
    }
  }

  async complete(params: AdapterCompletionParams): Promise<string> {
    const {
      provider,
      apiKey,
      modelOverride,
      systemInstruction,
      userPrompt,
      expectJson,
      audioInline,
      signal: externalSignal,
    } = params;
    const model = (modelOverride || provider.model || '').trim();
    const { signal, cleanup } = buildTimeoutSignal(provider.timeoutMs, externalSignal);

    try {
      const customBase = (provider.baseUrl || '').trim().replace(/\/+$/, '');
      const isDefaultGeminiUrl =
        !customBase || customBase === 'https://generativelanguage.googleapis.com';
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          ...(isDefaultGeminiUrl ? {} : { baseUrl: customBase }),
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const parts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [];
      if (audioInline) {
        parts.push({
          inlineData: {
            mimeType: audioInline.mimeType,
            data: audioInline.base64Data,
          },
        });
      }
      parts.push({ text: userPrompt });

      const useThinking =
        model.startsWith('gemini-4') || model.startsWith('gemini-3');

      const response = await ai.models.generateContent({
        model,
        contents: { parts },
        config: {
          systemInstruction,
          abortSignal: signal,
          ...(expectJson ? { responseMimeType: 'application/json' } : {}),
          ...(useThinking
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
        },
      });

      const out = (response.text ?? '').trim();
      if (!out) {
        throw new AdapterCallError('Gemini 返回内容为空', 'empty_response');
      }
      return out;
    } catch (err) {
      throw normalizeThrownAdapterError(err, 'completion');
    } finally {
      cleanup();
    }
  }
}

class OpenAiCompatibleAdapter implements AiProviderAdapter {
  readonly kind: AiProviderKind;
  readonly requestFormat = 'openai-chat-completions' as const;
  readonly responseFormat = 'openai-choices-json' as const;

  constructor(kind: AiProviderKind) {
    this.kind = kind;
  }

  async fetchModels(provider: StoredAiProvider, apiKey: string) {
    const { signal, cleanup } = buildTimeoutSignal(Math.min(15000, provider.timeoutMs));
    try {
      const base = normalizeOpenAiBaseUrl(provider.baseUrl);
      const customHeaders = parseCustomHeaders(provider.customHeadersJson);
      const res = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...customHeaders,
        },
        signal,
      });

      if (!res.ok) {
        if (provider.kind === 'custom' && (res.status === 404 || res.status === 405)) {
          return {
            models: provider.availableModels.map((id) => ({
              id,
              label: id,
              capabilities: inferModelCapabilities(provider.kind, id),
            })),
            supportsModelListing: false,
            message: '该自定义服务未提供 /models 列表接口，请手动输入模型名称',
          };
        }
        const errBody = await res.json().catch(() => ({}));
        const msg =
          (errBody as { error?: { message?: string }; message?: string })?.error
            ?.message ||
          (errBody as { message?: string })?.message ||
          `HTTP ${res.status}`;
        const classified = classifyHttpError(res.status, msg, 'models');
        throw new AdapterCallError(classified.message, classified.category, res.status);
      }

      const json = (await res.json()) as {
        data?: { id?: string }[];
        models?: { id?: string }[];
      };
      const list = (json.data || json.models || [])
        .map((item) => item?.id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

      const uniqueIds = Array.from(new Set(list));
      if (uniqueIds.length > 0) {
        await recordProviderProbeResult(provider.id, {
          status: 'connected',
          availableModels: uniqueIds,
        });
      }

      return {
        models: uniqueIds.map((id) => ({
          id,
          label: id,
          capabilities: inferModelCapabilities(provider.kind, id),
        })),
        supportsModelListing: uniqueIds.length > 0,
        message:
          uniqueIds.length === 0
            ? '接口未返回模型列表，请手动填写模型名称'
            : undefined,
      };
    } catch (err) {
      throw normalizeThrownAdapterError(err, 'models');
    } finally {
      cleanup();
    }
  }

  async complete(params: AdapterCompletionParams): Promise<string> {
    const {
      provider,
      apiKey,
      modelOverride,
      systemInstruction,
      userPrompt,
      expectJson,
      audioInline,
      signal: externalSignal,
    } = params;
    const model = (modelOverride || provider.model || '').trim();

    if (audioInline) {
      throw new AdapterCallError(
        `当前模型「${model}」(${provider.name}) 不支持直接接收原始音频流输入，请切换至支持音频的多模态模型（如 Google Gemini）。`,
        'unknown_error',
        400
      );
    }

    const { signal, cleanup } = buildTimeoutSignal(provider.timeoutMs, externalSignal);

    try {
      const base = normalizeOpenAiBaseUrl(provider.baseUrl);
      const customHeaders = parseCustomHeaders(provider.customHeadersJson);
      const endpoint = `${base}/chat/completions`;

      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
      };

      if (expectJson && !model.includes('reasoner')) {
        body.response_format = { type: 'json_object' };
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...customHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });

      const rawText = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        // keep rawText fallback
      }

      if (!res.ok) {
        const errMsg =
          (parsed?.error as { message?: string })?.message ||
          (parsed?.message as string) ||
          rawText.slice(0, 180) ||
          `HTTP ${res.status}`;
        const classified = classifyHttpError(res.status, errMsg, 'completion');
        throw new AdapterCallError(classified.message, classified.category, res.status);
      }

      const choices = parsed?.choices as
        | Array<{ message?: { content?: string } }>
        | undefined;
      const content = choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new AdapterCallError(
          `${provider.name} 返回了空响应`,
          'empty_response'
        );
      }
      return content;
    } catch (err) {
      throw normalizeThrownAdapterError(err, 'completion');
    } finally {
      cleanup();
    }
  }
}

export function getAiProviderAdapter(kind: AiProviderKind): AiProviderAdapter {
  switch (kind) {
    case 'gemini':
      return new GeminiAdapter();
    case 'deepseek':
    case 'openai':
    case 'openai-compatible':
    case 'custom':
    default:
      return new OpenAiCompatibleAdapter(kind);
  }
}

export async function fetchModelsWithAdapter(
  providerId: string,
  snapshot?: ClientVaultSnapshot | null
): Promise<{
  models: DiscoveredModel[];
  supportsModelListing: boolean;
  message?: string;
}> {
  const resolved = await getStoredProviderWithKey(providerId, {
    strict: true,
    snapshot,
  });
  if (!resolved) {
    throw new AdapterCallError('未找到对应的 AI 服务商配置', 'unknown_error', 404);
  }
  const { provider, apiKey } = resolved;
  if (!apiKey) {
    throw new AdapterCallError(
      `「${provider.name}」尚未填写 API Key`,
      'auth_error',
      400
    );
  }
  const adapter = getAiProviderAdapter(provider.kind);
  return adapter.fetchModels(provider, apiKey);
}

export async function callProviderWithAdapter(
  params: AdapterCompletionParams
): Promise<string> {
  const { provider, apiKey, modelOverride } = params;
  const model = (modelOverride || provider.model || '').trim();
  if (!model) {
    throw new AdapterCallError(
      `服务商「${provider.name}」未指定模型名称`,
      'model_not_found',
      400
    );
  }
  if (!provider.enabled) {
    throw new AdapterCallError(
      `服务商「${provider.name}」当前处于禁用状态`,
      'unknown_error',
      400
    );
  }
  if (!apiKey) {
    throw new AdapterCallError(
      `服务商「${provider.name}」尚未配置 API Key`,
      'auth_error',
      400
    );
  }

  const quota = await checkAndIncrementProviderQuota(provider.id);
  if (!quota.allowed) {
    throw new AdapterCallError(quota.error || '超出每日请求限制', 'quota_error', 429);
  }

  const adapter = getAiProviderAdapter(provider.kind);
  return adapter.complete({ ...params, modelOverride: model });
}

export async function testProviderConnectionWithAdapter(
  providerId: string,
  snapshot?: ClientVaultSnapshot | null
): Promise<DetailedTestConnectionResult> {
  const resolved = await getStoredProviderWithKey(providerId, {
    strict: true,
    snapshot,
  });
  if (!resolved) {
    return {
      ok: false,
      providerId,
      providerName: '未知服务商',
      modelUsed: '',
      latencyMs: 0,
      errorCategory: 'unknown_error',
      error: '未找到服务商配置',
    };
  }
  const { provider, apiKey } = resolved;
  const modelUsed = provider.model || '';
  if (!apiKey) {
    const errText = '尚未配置 API Key，请先填写并保存';
    await recordProviderProbeResult(provider.id, {
      status: 'error',
      error: errText,
    });
    return {
      ok: false,
      providerId: provider.id,
      providerName: provider.name,
      modelUsed,
      latencyMs: 0,
      errorCategory: 'auth_error',
      error: errText,
    };
  }

  const adapter = getAiProviderAdapter(provider.kind);
  const startedAt = Date.now();
  let modelsFound: number | undefined;

  try {
    // 1. Validate connectivity & auth via model listing when supported
    try {
      const listRes = await adapter.fetchModels(provider, apiKey);
      if (listRes.supportsModelListing) {
        modelsFound = listRes.models.length;
      }
    } catch (listErr) {
      if (provider.kind !== 'custom') {
        throw listErr;
      }
    }

    // 2. If user specified a model, also perform a minimal real ping completion to verify model validity
    if (modelUsed) {
      const pingText = await adapter.complete({
        provider: { ...provider, enabled: true, timeoutMs: Math.min(provider.timeoutMs, 18000) },
        apiKey,
        modelOverride: modelUsed,
        systemInstruction: 'Reply strictly with OK.',
        userPrompt: 'ping',
        expectJson: false,
      });
      if (!pingText) {
        throw new AdapterCallError('模型响应内容为空', 'empty_response');
      }
    }

    const latencyMs = Date.now() - startedAt;
    await recordProviderProbeResult(provider.id, {
      status: 'connected',
      latencyMs,
    });
    return {
      ok: true,
      providerId: provider.id,
      providerName: provider.name,
      modelUsed,
      latencyMs,
      httpStatus: 200,
      modelsFound,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const normalized = normalizeThrownAdapterError(err, modelUsed ? 'completion' : 'models');
    await recordProviderProbeResult(provider.id, {
      status: 'error',
      error: normalized.message,
      latencyMs,
    });
    return {
      ok: false,
      providerId: provider.id,
      providerName: provider.name,
      modelUsed,
      latencyMs,
      httpStatus: normalized.httpStatus,
      errorCategory: normalized.category,
      error: normalized.message,
      modelsFound,
    };
  }
}

export function extractJsonFromLlmText<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Attempt extracting outermost JSON array or object
    const arrStart = candidate.indexOf('[');
    const arrEnd = candidate.lastIndexOf(']');
    const objStart = candidate.indexOf('{');
    const objEnd = candidate.lastIndexOf('}');
    if (arrStart >= 0 && arrEnd > arrStart && (objStart === -1 || arrStart < objStart)) {
      return JSON.parse(candidate.slice(arrStart, arrEnd + 1)) as T;
    }
    if (objStart >= 0 && objEnd > objStart) {
      return JSON.parse(candidate.slice(objStart, objEnd + 1)) as T;
    }
    throw new Error('模型返回内容不是有效的 JSON 格式');
  }
}
