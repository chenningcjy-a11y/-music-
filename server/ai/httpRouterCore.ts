import { MDX_MODEL_CONFIG } from '../../src/audio/mdxDsp.ts';
import {
  AdapterCallError,
  extractJsonFromLlmText,
  fetchModelsWithAdapter,
  inferModelCapabilities,
  testProviderConnectionWithAdapter,
} from './adapters.ts';
import { proxyCoverImageBytes, searchOnlineCovers } from './coverSearch.ts';
import { isServerlessRuntime } from './cryptoSeal.ts';
import {
  clearProviderKey,
  ClientVaultSnapshot,
  deleteProvider,
  deleteStemService,
  EncryptedBackupSecretsEnvelope,
  exportEncryptedBackupSecrets,
  getActiveStemServiceWithKey,
  getStoredProviderWithKey,
  hydrateVaultFromClientSnapshot,
  importEncryptedBackupSecrets,
  listPublicProviders,
  listPublicStemServices,
  recordStemServiceProbeResult,
  setActiveStemService,
  setDefaultProvider,
  upsertProvider,
  upsertStemService,
} from './keyVault.ts';
import {
  executeLyricsTranslation,
  LyricsTranslationHttpError,
  searchOnlineLyricsCombined,
} from './lyricsCore.ts';
import { callProviderTextCompletion } from './providerClient.ts';

function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function normalizeApiPath(rawPathname: string): string {
  let p = rawPathname || '/';
  p = p.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '');
  p = p.replace(/^\/api(?=\/|$)/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function parseSnapshotHeader(req: Request): ClientVaultSnapshot | null {
  const raw = req.headers.get('x-lumina-provider-snapshot');
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(decoded) as ClientVaultSnapshot;
  } catch {
    try {
      return JSON.parse(raw) as ClientVaultSnapshot;
    } catch {
      return null;
    }
  }
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text().catch(() => '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function joinBaseAndPath(baseUrl: string, endpointPath: string): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '');
  const p = (endpointPath || '/separate').trim();
  if (!b) return '';
  return p.startsWith('/') ? `${b}${p}` : `${b}/${p}`;
}

/**
 * Shared Web-standard API router powering Netlify Functions (`/.netlify/functions/api/*` -> `/api/*`)
 * and testable directly in Node.js with standard `Request` / `Response`.
 */
export async function handleApiWebRequest(req: Request): Promise<Response> {
  const url = new URL(req.url, 'http://localhost');
  const pathname = normalizeApiPath(url.pathname);
  const method = req.method.toUpperCase();
  const headerSnapshot = parseSnapshotHeader(req);

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Lumina-Provider-Snapshot',
      },
    });
  }

  // Health & runtime capabilities
  if (method === 'GET' && pathname === '/health') {
    const serverless = isServerlessRuntime();
    return jsonResponse({
      ok: true,
      runtime: serverless ? 'netlify-serverless' : 'node-express',
      stemServerAvailable: !serverless,
      browserWorkerStemAvailable: true,
      securityMode: serverless ? 'serverless-sealed-proxy' : 'backend-encrypted-proxy',
    });
  }

  // Covers Search & Proxy
  if (method === 'GET' && pathname === '/covers/search') {
    const title = (url.searchParams.get('title') || url.searchParams.get('q') || '').trim();
    const artist = (url.searchParams.get('artist') || '').trim();
    if (!title && !artist) {
      return jsonResponse({ error: '请输入歌曲名或歌手关键词以搜索封面' }, 400);
    }
    const candidates = await searchOnlineCovers(title, artist);
    return jsonResponse({ candidates });
  }

  if (method === 'GET' && pathname === '/covers/proxy') {
    const targetUrl = (url.searchParams.get('url') || '').trim();
    if (!targetUrl) {
      return jsonResponse({ error: '缺少封面图片 URL' }, 400);
    }
    try {
      const { buffer, contentType } = await proxyCoverImageBytes(targetUrl);
      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : '封面代理失败' },
        502
      );
    }
  }

  // Lyrics Search & Translation
  if (method === 'GET' && pathname === '/lyrics/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) {
      return jsonResponse({ error: '缺少搜索关键词' }, 400);
    }
    try {
      const combined = await searchOnlineLyricsCombined(q);
      return jsonResponse(combined);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : '歌词检索服务暂时不可用' },
        502
      );
    }
  }

  if (method === 'POST' && pathname === '/lyrics/translate') {
    const body = await readJsonBody(req);
    const snapshot =
      (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
    try {
      const result = await executeLyricsTranslation({
        rawLyrics: typeof body.rawLyrics === 'string' ? body.rawLyrics : '',
        trackTitle: typeof body.trackTitle === 'string' ? body.trackTitle : '',
        artistName: typeof body.artistName === 'string' ? body.artistName : '',
        targetLanguage:
          typeof body.targetLanguage === 'string' ? body.targetLanguage : 'zh-CN',
        style: typeof body.style === 'string' ? body.style : 'poetic',
        customStylePrompt:
          typeof body.customStylePrompt === 'string' ? body.customStylePrompt : '',
        providerId: typeof body.providerId === 'string' ? body.providerId : '',
        modelName: typeof body.modelName === 'string' ? body.modelName : '',
        force: Boolean(body.force),
        snapshot,
      });
      return jsonResponse(result);
    } catch (err) {
      if (err instanceof LyricsTranslationHttpError) {
        return jsonResponse(
          { error: err.message, errorCategory: err.errorCategory },
          err.status
        );
      }
      return jsonResponse(
        { error: err instanceof Error ? err.message : '歌词翻译失败，请稍后重试' },
        500
      );
    }
  }

  // Serverless stem model redirect & fallback guidance
  if (method === 'GET' && pathname === '/stems/model') {
    return Response.redirect(MDX_MODEL_CONFIG.modelUrl, 302);
  }
  if (method === 'GET' && pathname === '/stems/model/status') {
    return jsonResponse({
      cached: false,
      serverless: true,
      modelUrl: MDX_MODEL_CONFIG.modelUrl,
    });
  }
  if (pathname.startsWith('/stems/')) {
    return jsonResponse(
      {
        error:
          '当前部署为无服务器（Netlify Serverless）环境，已自动启用浏览器端 Web Worker + WebAssembly 音轨分离引擎，或可在 AI 服务管理中接入外部 Demucs 服务。',
        serverless: true,
      },
      501
    );
  }

  // Hydrate vault snapshot explicitly
  if (method === 'POST' && pathname === '/ai/providers/hydrate') {
    const body = await readJsonBody(req);
    const snapshot =
      (body.providerSnapshot as ClientVaultSnapshot | undefined) ||
      (body as unknown as ClientVaultSnapshot) ||
      headerSnapshot;
    await hydrateVaultFromClientSnapshot(snapshot);
    const data = await listPublicProviders();
    return jsonResponse(data);
  }

  // Providers CRUD
  if (method === 'GET' && pathname === '/ai/providers') {
    if (headerSnapshot) {
      await hydrateVaultFromClientSnapshot(headerSnapshot);
    }
    const data = await listPublicProviders();
    return jsonResponse(data);
  }

  if (method === 'POST' && pathname === '/ai/providers') {
    const body = await readJsonBody(req);
    const snapshot =
      (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
    if (snapshot) {
      await hydrateVaultFromClientSnapshot(snapshot);
    }
    if (!body.kind || !body.baseUrl) {
      return jsonResponse({ error: '请填写服务商类型与 API Base URL' }, 400);
    }
    const result = await upsertProvider({
      id: typeof body.id === 'string' ? body.id : undefined,
      name: typeof body.name === 'string' ? body.name : 'AI 服务',
      kind: body.kind as never,
      baseUrl: String(body.baseUrl),
      model: typeof body.model === 'string' ? body.model : '',
      availableModels: Array.isArray(body.availableModels)
        ? (body.availableModels as string[])
        : undefined,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      timeoutMs: Number(body.timeoutMs) || 30000,
      maxRequestsPerDay: Number(body.maxRequestsPerDay) || 0,
      customHeadersJson:
        typeof body.customHeadersJson === 'string' ? body.customHeadersJson : undefined,
      setAsDefault: Boolean(body.setAsDefault),
    });
    const list = await listPublicProviders();
    return jsonResponse({ ...result, providers: list.providers });
  }

  const providerMatch = pathname.match(/^\/ai\/providers\/([^/]+)(?:\/(key|default|test|models))?$/);
  if (providerMatch) {
    const providerId = decodeURIComponent(providerMatch[1]);
    const subAction = providerMatch[2];

    if (method === 'DELETE' && !subAction) {
      if (headerSnapshot) await hydrateVaultFromClientSnapshot(headerSnapshot);
      const ok = await deleteProvider(providerId);
      return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: '未找到指定服务商' }, 404);
    }
    if (method === 'DELETE' && subAction === 'key') {
      if (headerSnapshot) await hydrateVaultFromClientSnapshot(headerSnapshot);
      const updated = await clearProviderKey(providerId);
      return updated
        ? jsonResponse({ provider: updated })
        : jsonResponse({ error: '未找到指定服务商' }, 404);
    }
    if (method === 'POST' && subAction === 'default') {
      if (headerSnapshot) await hydrateVaultFromClientSnapshot(headerSnapshot);
      const ok = await setDefaultProvider(providerId);
      return ok
        ? jsonResponse({ ok: true, defaultProviderId: providerId })
        : jsonResponse({ error: '未找到指定服务商' }, 404);
    }
    if (method === 'POST' && subAction === 'test') {
      const body = await readJsonBody(req);
      const snapshot =
        (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
      const result = await testProviderConnectionWithAdapter(providerId, snapshot);
      const list = await listPublicProviders();
      const updated = list.providers.find((p) => p.id === providerId);
      return jsonResponse({ ...result, provider: updated });
    }
    if ((method === 'GET' || method === 'POST') && subAction === 'models') {
      const body = method === 'POST' ? await readJsonBody(req) : {};
      const snapshot =
        (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
      try {
        const result = await fetchModelsWithAdapter(providerId, snapshot);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse(
          {
            error: err instanceof Error ? err.message : '获取模型列表失败',
            errorCategory: err instanceof AdapterCallError ? err.category : undefined,
          },
          400
        );
      }
    }
  }

  // Encrypted Backup Key Vault Export / Import
  if (method === 'POST' && pathname === '/ai/backup/export-sealed') {
    const body = await readJsonBody(req);
    const snapshot =
      (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
    try {
      const envelope = await exportEncryptedBackupSecrets(
        typeof body.passphrase === 'string' ? body.passphrase : '',
        snapshot
      );
      return jsonResponse({ encryptedSecrets: envelope });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : '导出加密密钥失败' },
        400
      );
    }
  }

  if (method === 'POST' && pathname === '/ai/backup/import-sealed') {
    const body = await readJsonBody(req);
    try {
      const res = await importEncryptedBackupSecrets({
        aiConfigMetadata: body.aiConfigMetadata as ClientVaultSnapshot | undefined,
        encryptedSecrets: body.encryptedSecrets as
          | EncryptedBackupSecretsEnvelope
          | undefined,
        passphrase: typeof body.passphrase === 'string' ? body.passphrase : '',
      });
      return jsonResponse(res);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : '解密并恢复 API 密钥失败' },
        400
      );
    }
  }

  // Stem Services CRUD
  if (method === 'GET' && pathname === '/ai/stem-services') {
    if (headerSnapshot) await hydrateVaultFromClientSnapshot(headerSnapshot);
    return jsonResponse(await listPublicStemServices());
  }

  if (method === 'POST' && pathname === '/ai/stem-services') {
    if (headerSnapshot) await hydrateVaultFromClientSnapshot(headerSnapshot);
    const body = await readJsonBody(req);
    const result = await upsertStemService({
      id: typeof body.id === 'string' ? body.id : undefined,
      name: typeof body.name === 'string' ? body.name : '音源分离服务',
      kind: (body.kind as never) || 'remote-demucs-http',
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
      endpointPath: typeof body.endpointPath === 'string' ? body.endpointPath : '/separate',
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      clearKey: Boolean(body.clearKey),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      timeoutMs: Number(body.timeoutMs) || 180000,
      setActive: Boolean(body.setActive),
    });
    return jsonResponse(result);
  }

  if (method === 'POST' && pathname === '/ai/stem-services/active') {
    if (headerSnapshot) await hydrateVaultFromClientSnapshot(headerSnapshot);
    const body = await readJsonBody(req);
    const serviceId =
      body.serviceId === null || typeof body.serviceId === 'string'
        ? body.serviceId
        : null;
    const ok = await setActiveStemService(serviceId);
    return ok
      ? jsonResponse({ ok: true, activeStemServiceId: serviceId })
      : jsonResponse({ error: '未找到指定音源分离服务' }, 404);
  }

  const stemSvcMatch = pathname.match(/^\/ai\/stem-services\/([^/]+)(?:\/(test))?$/);
  if (stemSvcMatch) {
    if (headerSnapshot) await hydrateVaultFromClientSnapshot(headerSnapshot);
    const serviceId = decodeURIComponent(stemSvcMatch[1]);
    const subAction = stemSvcMatch[2];
    if (method === 'DELETE' && !subAction) {
      const ok = await deleteStemService(serviceId);
      return ok
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: '无法删除内置分离服务或服务不存在' }, 400);
    }
    if (method === 'POST' && subAction === 'test') {
      const list = await listPublicStemServices();
      const target = list.services.find((s) => s.id === serviceId);
      if (!target) {
        return jsonResponse({ ok: false, error: '未找到指定音源分离服务' }, 404);
      }
      if (target.kind === 'builtin-mdx') {
        const updated = await recordStemServiceProbeResult(target.id, {
          status: 'connected',
        });
        return jsonResponse({
          ok: true,
          message: '内置 UVR MDX-Net 浏览器端 Worker 引擎就绪',
          service: updated,
        });
      }
      if (!target.baseUrl) {
        const updated = await recordStemServiceProbeResult(target.id, {
          status: 'error',
          error: '请先填写外部 Demucs / Spleeter 服务的 Base URL',
        });
        return jsonResponse({ ok: false, error: updated?.lastError, service: updated });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const resp = await fetch(target.baseUrl.replace(/\/+$/, ''), {
          method: 'GET',
          signal: controller.signal,
        });
        if (resp.status >= 500) throw new Error(`服务响应异常 (HTTP ${resp.status})`);
        const updated = await recordStemServiceProbeResult(target.id, {
          status: 'connected',
        });
        return jsonResponse({
          ok: true,
          message: `已连接至分离服务 (HTTP ${resp.status})`,
          service: updated,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : '无法连接外部音源分离服务';
        const updated = await recordStemServiceProbeResult(target.id, {
          status: 'error',
          error: errMsg,
        });
        return jsonResponse({ ok: false, error: errMsg, service: updated });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // Remote stem separation proxy
  if (method === 'POST' && pathname === '/ai/stem-remote/separate') {
    if (headerSnapshot) await hydrateVaultFromClientSnapshot(headerSnapshot);
    const active = await getActiveStemServiceWithKey();
    if (!active || !active.service.enabled || active.service.kind === 'none') {
      return jsonResponse(
        { error: '尚未配置或启用外部音源分离服务。' },
        400
      );
    }
    if (active.service.kind === 'builtin-mdx') {
      return jsonResponse(
        { error: '当前激活的是内置 UVR MDX-Net 引擎，请使用本地浏览器 Worker 分离。' },
        400
      );
    }
    const targetUrl = joinBaseAndPath(active.service.baseUrl, active.service.endpointPath);
    if (!targetUrl) {
      return jsonResponse({ error: '外部音源分离服务的 Base URL 不能为空' }, 400);
    }
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) {
      return jsonResponse({ error: '未收到音频文件数据' }, 400);
    }
    const filename = (url.searchParams.get('filename') || 'audio.wav').slice(0, 120);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' }),
      filename
    );
    const headers: Record<string, string> = {};
    if (active.apiKey) headers.Authorization = `Bearer ${active.apiKey}`;
    const upstream = await fetch(targetUrl, { method: 'POST', headers, body: form });
    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => '');
      return jsonResponse(
        { error: `外部分离服务返回错误 (${upstream.status}): ${errTxt.slice(0, 200)}` },
        upstream.status
      );
    }
    const json = (await upstream.json()) as {
      vocalBase64?: string;
      instrumentalBase64?: string;
      error?: string;
    };
    if (json.error || !json.vocalBase64 || !json.instrumentalBase64) {
      return jsonResponse(
        { error: json.error || '外部分离服务未返回完整人声/伴奏数据' },
        502
      );
    }
    return jsonResponse({
      vocalBase64: json.vocalBase64,
      instrumentalBase64: json.instrumentalBase64,
      serviceName: active.service.name,
    });
  }

  // AI Tasks: Lyrics / DSP / Analyze / Intent Router
  if (method === 'POST' && pathname === '/ai/tasks/lyrics') {
    const body = await readJsonBody(req);
    const snapshot =
      (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const action = typeof body.action === 'string' ? body.action : '';
    const rawLyrics = typeof body.rawLyrics === 'string' ? body.rawLyrics : '';
    const trackTitle = typeof body.trackTitle === 'string' ? body.trackTitle : '';
    const artistName = typeof body.artistName === 'string' ? body.artistName : '';
    const targetLanguage =
      typeof body.targetLanguage === 'string' ? body.targetLanguage : 'zh-CN';
    const durationSec = body.durationSec;

    if (!rawLyrics.trim()) {
      return jsonResponse({ error: '当前歌曲暂无歌词文本可供处理' }, 400);
    }

    if (action === 'translate') {
      try {
        const res = await executeLyricsTranslation({
          rawLyrics,
          trackTitle,
          artistName,
          targetLanguage,
          style: typeof body.style === 'string' ? body.style : 'poetic',
          customStylePrompt:
            typeof body.customStylePrompt === 'string' ? body.customStylePrompt : '',
          providerId,
          modelName: typeof body.model === 'string' ? body.model : '',
          force: Boolean(body.force),
          snapshot,
        });
        return jsonResponse({
          action,
          ...res,
          summary: `已完成${res.translatedCount}句逐行翻译`,
        });
      } catch (err) {
        if (err instanceof LyricsTranslationHttpError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse(
          { error: err instanceof Error ? err.message : '歌词翻译失败' },
          500
        );
      }
    }

    const resolved = await getStoredProviderWithKey(providerId || undefined, {
      strict: Boolean(providerId),
      snapshot,
    });
    if (!resolved || !resolved.apiKey || !resolved.provider.enabled) {
      return jsonResponse(
        { error: '尚未配置可用 AI 服务商或 API Key，请前往「API 服务管理」检查。' },
        400
      );
    }
    const { provider, apiKey } = resolved;
    const effectiveModel =
      (typeof body.model === 'string' && body.model.trim()) || provider.model;
    const hasTimestamps = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(rawLyrics);
    const hasWordTags = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/.test(rawLyrics);

    try {
      if (action === 'detect-language') {
        const raw = await callProviderTextCompletion({
          provider,
          apiKey,
          modelOverride: effectiveModel,
          systemInstruction:
            'Identify the languages and script distribution in the lyrics. Return JSON: {"primaryLanguage": string, "secondaryLanguages": string[], "hasBilingualContent": boolean, "formatType": "lrc-word"|"lrc-line"|"plain-text", "notes": string}. Write notes in Simplified Chinese.',
          userPrompt: rawLyrics,
          expectJson: true,
        });
        return jsonResponse({
          action,
          providerName: provider.name,
          modelUsed: effectiveModel,
          isTimedLrc: hasTimestamps,
          hasWordTags,
          result: extractJsonFromLlmText<Record<string, unknown>>(raw),
        });
      }
      if (action === 'proofread') {
        const raw = await callProviderTextCompletion({
          provider,
          apiKey,
          modelOverride: effectiveModel,
          systemInstruction: `Proofread the lyrics for obvious OCR/typo mistakes, broken punctuation, or formatting inconsistencies.
CRITICAL: NEVER alter, shift, or invent [mm:ss.xx] or <mm:ss.xx> timestamps! If input is plain text, do NOT add timestamps.
Return JSON: {"correctedLyrics": string, "changes": string[], "summary": string}. Respond in Simplified Chinese.`,
          userPrompt: JSON.stringify({ song: trackTitle, artist: artistName, isTimedLrc: hasTimestamps, rawLyrics }),
          expectJson: true,
        });
        const parsed = extractJsonFromLlmText<{
          correctedLyrics: string;
          changes?: string[];
          summary?: string;
        }>(raw);
        return jsonResponse({
          action,
          providerName: provider.name,
          modelUsed: effectiveModel,
          isTimedLrc: hasTimestamps,
          correctedLyrics: parsed.correctedLyrics || rawLyrics,
          changes: parsed.changes || [],
          summary: parsed.summary || '歌词校对完成',
        });
      }
      if (action === 'explain') {
        const raw = await callProviderTextCompletion({
          provider,
          apiKey,
          modelOverride: effectiveModel,
          systemInstruction:
            'You are a literary music critic. Explain the poetic imagery, emotional arc, metaphors, and core theme of these lyrics in refined Simplified Chinese. Return JSON: {"theme": string, "imagery": string[], "emotionalArc": string, "highlights": [{"line": string, "meaning": string}]}',
          userPrompt: JSON.stringify({ song: trackTitle, artist: artistName, rawLyrics }),
          expectJson: true,
        });
        return jsonResponse({
          action,
          providerName: provider.name,
          modelUsed: effectiveModel,
          isTimedLrc: hasTimestamps,
          result: extractJsonFromLlmText<Record<string, unknown>>(raw),
        });
      }
      if (action === 'timeline-align') {
        const raw = await callProviderTextCompletion({
          provider,
          apiKey,
          modelOverride: effectiveModel,
          systemInstruction: `Analyze the LRC timeline integrity of the provided lyrics (given track duration ${
            durationSec || 'unknown'
          } seconds). Return JSON: {"isTimedLrc": boolean, "hasWordSync": boolean, "issues": string[], "recommendedOffsetMs": number, "advice": string}. Respond in Simplified Chinese.`,
          userPrompt: JSON.stringify({
            song: trackTitle,
            durationSec,
            isTimedLrc: hasTimestamps,
            hasWordTags,
            rawLyrics,
          }),
          expectJson: true,
        });
        return jsonResponse({
          action,
          providerName: provider.name,
          modelUsed: effectiveModel,
          isTimedLrc: hasTimestamps,
          hasWordTags,
          result: extractJsonFromLlmText<Record<string, unknown>>(raw),
        });
      }
      return jsonResponse({ error: `不支持的歌词任务类型: ${action}` }, 400);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'AI 歌词任务处理失败' },
        500
      );
    }
  }

  if (method === 'POST' && pathname === '/ai/tasks/dsp-plan') {
    const body = await readJsonBody(req);
    const snapshot =
      (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    if (!instruction) {
      return jsonResponse({ error: '请输入自然语言调音指令' }, 400);
    }
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const resolved = await getStoredProviderWithKey(providerId || undefined, {
      strict: Boolean(providerId),
      snapshot,
    });
    if (!resolved || !resolved.apiKey || !resolved.provider.enabled) {
      return jsonResponse(
        { error: '尚未配置可用 AI 服务商或 API Key，请前往「API 服务管理」配置并启用。' },
        400
      );
    }
    const { provider, apiKey } = resolved;
    const effectiveModel =
      (typeof body.model === 'string' && body.model.trim()) || provider.model;
    try {
      const systemInstruction = `You are LUMINA MUSIC's professional Web Audio DSP mastering engineer.
Translate the user's natural-language tuning instruction into a precise, valid JSON patch for the real AudioDspSettings engine.
Return strictly valid JSON: {"explanation": string, "patch": {...}, "suggestStemSeparation": boolean, "warnings": string[]}`;
      const raw = await callProviderTextCompletion({
        provider,
        apiKey,
        modelOverride: effectiveModel,
        systemInstruction,
        userPrompt: JSON.stringify({
          instruction,
          hasSeparatedStems: Boolean(body.hasSeparatedStems),
          trackInfo: body.trackInfo || {},
          currentSettings: body.currentSettings || {},
        }),
        expectJson: true,
      });
      const parsed = extractJsonFromLlmText<{
        explanation?: string;
        patch?: Record<string, unknown>;
        suggestStemSeparation?: boolean;
        warnings?: string[];
      }>(raw);
      return jsonResponse({
        providerName: provider.name,
        modelUsed: effectiveModel,
        explanation: parsed.explanation || '已根据指令生成音效调整建议',
        patch: parsed.patch || {},
        suggestStemSeparation: Boolean(parsed.suggestStemSeparation),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : '生成智能调音方案失败' },
        500
      );
    }
  }

  if (method === 'POST' && pathname === '/ai/tasks/analyze-audio') {
    const body = await readJsonBody(req);
    const snapshot =
      (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const resolved = await getStoredProviderWithKey(providerId || undefined, {
      strict: Boolean(providerId),
      snapshot,
    });
    if (!resolved || !resolved.apiKey || !resolved.provider.enabled) {
      return jsonResponse(
        { error: '尚未配置可用 AI 服务商，请先前往「API 服务管理」配置服务商与 API Key。' },
        400
      );
    }
    const { provider, apiKey } = resolved;
    const effectiveModel =
      (typeof body.model === 'string' && body.model.trim()) || provider.model;
    const caps = inferModelCapabilities(provider.kind, effectiveModel);
    const analysisType = typeof body.analysisType === 'string' ? body.analysisType : 'comprehensive';
    const requiresAudioSignal =
      analysisType === 'instruments' || analysisType === 'rhythm-audio';
    if (requiresAudioSignal && !caps.audioInputAnalysis) {
      return jsonResponse(
        {
          error: `模型「${effectiveModel}」(${provider.name}) 为纯文本模型，无法直接接收并听辨音频波形。请切换为支持音频输入的多模态模型（如 Google Gemini）。`,
          capabilityError: true,
        },
        400
      );
    }
    const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
    const audioMimeType = typeof body.audioMimeType === 'string' ? body.audioMimeType : '';
    const usingRealAudio = Boolean(caps.audioInputAnalysis && audioBase64 && audioMimeType);
    try {
      const raw = await callProviderTextCompletion({
        provider,
        apiKey,
        modelOverride: effectiveModel,
        systemInstruction: `You are a professional musicologist and audio analyst. Return strictly valid JSON in Simplified Chinese: {"genre": string, "mood": string, "instruments": string[], "rhythmAndTempo": string, "curatedSummary": string, "tags": string[], "analyzedFromAudio": boolean}`,
        userPrompt: JSON.stringify({
          analysisType,
          hasAudioClip: Boolean(body.hasAudioClip && usingRealAudio),
          trackInfo: body.trackInfo || {},
        }),
        expectJson: true,
        audioInline: usingRealAudio
          ? { mimeType: audioMimeType, base64Data: audioBase64 }
          : undefined,
      });
      const parsed = extractJsonFromLlmText<Record<string, unknown>>(raw);
      return jsonResponse({
        providerName: provider.name,
        modelUsed: effectiveModel,
        analyzedFromAudio: usingRealAudio,
        result: { ...parsed, analyzedFromAudio: usingRealAudio },
      });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'AI 音乐分析失败' },
        500
      );
    }
  }

  if (method === 'POST' && pathname === '/ai/tasks/route-intent') {
    const body = await readJsonBody(req);
    const snapshot =
      (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnapshot;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return jsonResponse({ error: '请输入指令或问题' }, 400);
    }
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const resolved = await getStoredProviderWithKey(providerId || undefined, {
      strict: Boolean(providerId),
      snapshot,
    });
    const stemData = await listPublicStemServices();
    const activeStem = stemData.services.find(
      (s) => s.id === stemData.activeStemServiceId
    );
    const stemReady = Boolean(
      activeStem &&
        activeStem.enabled &&
        activeStem.kind !== 'none' &&
        (activeStem.kind === 'builtin-mdx' || Boolean(activeStem.baseUrl))
    );
    if (!resolved || !resolved.apiKey || !resolved.provider.enabled) {
      return jsonResponse(
        {
          error:
            '当前默认 AI 服务商未启用或尚未填写 API Key。请前往「设置 → AI 智能中心 → API 服务管理」配置并测试连接。',
        },
        400
      );
    }
    const { provider, apiKey } = resolved;
    const effectiveModel =
      (typeof body.model === 'string' && body.model.trim()) || provider.model;
    const caps = inferModelCapabilities(provider.kind, effectiveModel);
    try {
      const systemInstruction = `You are LUMINA MUSIC's AI Task Manager router.
Classify into one taskType ("stem_separation" | "dsp_tuning" | "lyrics_assistant" | "audio_analysis" | "general_qa").
System capability state: stemServiceReady=${stemReady}, stemServiceName="${activeStem?.name || '浏览器端 MDX-Net'}", modelSupportsAudioInput=${caps.audioInputAnalysis}.
Respond strictly in JSON: {"taskType": string, "canExecute": boolean, "requiresConfirmation": boolean, "replyMessage": string, "lyricsAction": string|null, "dspInstruction": string|null, "analysisType": string|null}`;
      const raw = await callProviderTextCompletion({
        provider,
        apiKey,
        modelOverride: effectiveModel,
        systemInstruction,
        userPrompt: JSON.stringify({
          prompt,
          stemServiceReady: stemReady,
          stemServiceName: activeStem?.name || null,
          modelSupportsAudioInput: caps.audioInputAnalysis,
          hasTrack: Boolean((body.trackInfo as { id?: string } | undefined)?.id),
          trackInfo: body.trackInfo || null,
          hasLyrics: Boolean(body.hasLyrics),
          hasSeparatedStems: Boolean(body.hasSeparatedStems),
          currentSettings: body.currentSettings || null,
        }),
        expectJson: true,
      });
      return jsonResponse({
        providerName: provider.name,
        modelUsed: effectiveModel,
        capabilities: caps,
        stemServiceReady: stemReady,
        stemServiceName: activeStem?.name || null,
        plan: extractJsonFromLlmText<Record<string, unknown>>(raw),
      });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'AI 任务调度解析失败' },
        500
      );
    }
  }

  return jsonResponse({ error: `未找到 API 路径: ${pathname}` }, 404);
}
