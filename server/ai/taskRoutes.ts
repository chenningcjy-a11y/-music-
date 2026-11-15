import express, { Request, Router } from 'express';
import { AdapterCallError } from './adapters.ts';
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
} from './lyricsCore.ts';
import {
  callProviderTextCompletion,
  extractJsonFromLlmText,
  fetchModelsFromProvider,
  inferModelCapabilities,
  testProviderConnection,
} from './providerClient.ts';

function joinBaseAndPath(baseUrl: string, endpointPath: string): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '');
  const p = (endpointPath || '/separate').trim();
  if (!b) return '';
  return p.startsWith('/') ? `${b}${p}` : `${b}/${p}`;
}

function extractSnapshotFromExpressReq(req: Request): ClientVaultSnapshot | null {
  const bodySnap = (req.body as { providerSnapshot?: ClientVaultSnapshot } | undefined)
    ?.providerSnapshot;
  if (bodySnap) return bodySnap;
  const headerVal = req.headers['x-lumina-provider-snapshot'];
  const raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as ClientVaultSnapshot;
  } catch {
    try {
      return JSON.parse(raw) as ClientVaultSnapshot;
    } catch {
      return null;
    }
  }
}

export function createAiRouter(): Router {
  const router = Router();

  // Remote stem separation proxy (accepts raw audio binary, forwards multipart to configured remote Demucs/Spleeter server)
  router.post(
    '/stem-remote/separate',
    express.raw({ type: '*/*', limit: '150mb' }),
    async (req, res) => {
      try {
        const snapshot = extractSnapshotFromExpressReq(req);
        if (snapshot) await hydrateVaultFromClientSnapshot(snapshot);
        const active = await getActiveStemServiceWithKey();
        if (!active || !active.service.enabled || active.service.kind === 'none') {
          res.status(400).json({
            error:
              '尚未配置或启用独立音源分离服务。请前往「设置 → AI 智能中心 → API 服务管理」配置内置模型或外部 Demucs 服务。',
          });
          return;
        }
        if (active.service.kind === 'builtin-mdx') {
          res.status(400).json({
            error: '当前激活的是内置 UVR MDX-Net 引擎，请直接调用 /api/stems/separate 或本地推理。',
          });
          return;
        }

        const targetUrl = joinBaseAndPath(
          active.service.baseUrl,
          active.service.endpointPath
        );
        if (!targetUrl) {
          res.status(400).json({ error: '外部音源分离服务的 Base URL 不能为空' });
          return;
        }

        const audioBuf = req.body as Buffer;
        if (!Buffer.isBuffer(audioBuf) || audioBuf.length === 0) {
          res.status(400).json({ error: '未收到音频文件数据' });
          return;
        }

        const filename =
          typeof req.query.filename === 'string'
            ? req.query.filename.slice(0, 120)
            : 'audio.wav';

        const form = new FormData();
        form.append(
          'file',
          new Blob([new Uint8Array(audioBuf)], { type: 'application/octet-stream' }),
          filename
        );

        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error('外部分离服务请求超时')),
          active.service.timeoutMs || 180000
        );

        try {
          const headers: Record<string, string> = {};
          if (active.apiKey) {
            headers.Authorization = `Bearer ${active.apiKey}`;
          }
          const upstream = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: form,
            signal: controller.signal,
          });
          if (!upstream.ok) {
            const errTxt = await upstream.text().catch(() => '');
            res.status(upstream.status).json({
              error: `外部分离服务返回错误 (${upstream.status}): ${errTxt.slice(0, 200)}`,
            });
            return;
          }

          const json = (await upstream.json()) as {
            vocalBase64?: string;
            instrumentalBase64?: string;
            vocalUrl?: string;
            instrumentalUrl?: string;
            error?: string;
          };

          if (json.error) {
            res.status(502).json({ error: json.error });
            return;
          }

          let vocalBase64 = json.vocalBase64;
          let instrumentalBase64 = json.instrumentalBase64;

          if ((!vocalBase64 || !instrumentalBase64) && json.vocalUrl && json.instrumentalUrl) {
            const [vRes, iRes] = await Promise.all([
              fetch(json.vocalUrl, { headers, signal: controller.signal }),
              fetch(json.instrumentalUrl, { headers, signal: controller.signal }),
            ]);
            if (!vRes.ok || !iRes.ok) {
              res.status(502).json({ error: '从外部分离服务下载分轨音频失败' });
              return;
            }
            const [vBuf, iBuf] = await Promise.all([
              vRes.arrayBuffer(),
              iRes.arrayBuffer(),
            ]);
            vocalBase64 = Buffer.from(vBuf).toString('base64');
            instrumentalBase64 = Buffer.from(iBuf).toString('base64');
          }

          if (!vocalBase64 || !instrumentalBase64) {
            res.status(502).json({
              error:
                '外部分离服务响应缺少 vocalBase64 / instrumentalBase64 或 vocalUrl / instrumentalUrl 字段',
            });
            return;
          }

          res.json({
            vocalBase64,
            instrumentalBase64,
            serviceName: active.service.name,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : '调用外部音源分离服务失败',
        });
      }
    }
  );

  // JSON body parser for all other /api/ai/* routes (supports up to 18mb for inline audio clip analysis)
  router.use(express.json({ limit: '18mb' }));

  // 1. Provider & Key Management
  router.post('/providers/hydrate', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req) || (req.body as ClientVaultSnapshot);
      await hydrateVaultFromClientSnapshot(snapshot);
      const data = await listPublicProviders();
      res.json(data);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '同步 AI 服务配置失败',
      });
    }
  });

  router.get('/providers', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      if (snapshot) await hydrateVaultFromClientSnapshot(snapshot);
      const data = await listPublicProviders();
      res.json(data);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '读取 AI 服务配置失败',
      });
    }
  });

  router.post('/providers', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      if (snapshot) await hydrateVaultFromClientSnapshot(snapshot);
      const body = req.body || {};
      if (!body.kind || !body.baseUrl) {
        res.status(400).json({ error: '请填写服务商类型与 API Base URL' });
        return;
      }
      const result = await upsertProvider({
        id: typeof body.id === 'string' ? body.id : undefined,
        name: typeof body.name === 'string' ? body.name : 'AI 服务',
        kind: body.kind,
        baseUrl: body.baseUrl,
        model: typeof body.model === 'string' ? body.model : '',
        availableModels: Array.isArray(body.availableModels)
          ? body.availableModels
          : undefined,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
        timeoutMs: Number(body.timeoutMs) || 30000,
        maxRequestsPerDay: Number(body.maxRequestsPerDay) || 0,
        customHeadersJson:
          typeof body.customHeadersJson === 'string'
            ? body.customHeadersJson
            : undefined,
        setAsDefault: Boolean(body.setAsDefault),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '保存 AI 服务商配置失败',
      });
    }
  });

  router.delete('/providers/:id', async (req, res) => {
    const ok = await deleteProvider(req.params.id);
    if (!ok) {
      res.status(404).json({ error: '未找到指定服务商' });
      return;
    }
    res.json({ ok: true });
  });

  router.delete('/providers/:id/key', async (req, res) => {
    const updated = await clearProviderKey(req.params.id);
    if (!updated) {
      res.status(404).json({ error: '未找到指定服务商' });
      return;
    }
    res.json({ provider: updated });
  });

  router.post('/providers/:id/default', async (req, res) => {
    const ok = await setDefaultProvider(req.params.id);
    if (!ok) {
      res.status(404).json({ error: '未找到指定服务商' });
      return;
    }
    res.json({ ok: true, defaultProviderId: req.params.id });
  });

  router.post('/providers/:id/test', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      const result = await testProviderConnection(req.params.id, snapshot);
      const list = await listPublicProviders();
      const updated = list.providers.find((p) => p.id === req.params.id);
      res.json({ ...result, provider: updated });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : '连接测试失败',
      });
    }
  });

  const handleGetModels = async (req: Request, res: express.Response) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      const result = await fetchModelsFromProvider(String(req.params.id), snapshot);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : '获取模型列表失败',
        errorCategory: err instanceof AdapterCallError ? err.category : undefined,
      });
    }
  };
  router.get('/providers/:id/models', handleGetModels);
  router.post('/providers/:id/models', handleGetModels);

  // Encrypted Backup Key Export / Import
  router.post('/backup/export-sealed', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      const passphrase =
        typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
      const envelope = await exportEncryptedBackupSecrets(passphrase, snapshot);
      res.json({ encryptedSecrets: envelope });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : '导出加密密钥失败',
      });
    }
  });

  router.post('/backup/import-sealed', async (req, res) => {
    try {
      const result = await importEncryptedBackupSecrets({
        aiConfigMetadata: req.body?.aiConfigMetadata as ClientVaultSnapshot | undefined,
        encryptedSecrets: req.body?.encryptedSecrets as
          | EncryptedBackupSecretsEnvelope
          | undefined,
        passphrase: typeof req.body?.passphrase === 'string' ? req.body.passphrase : '',
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : '解密并恢复 API 密钥失败',
      });
    }
  });

  // 2. Independent Stem Separation Service Management
  router.get('/stem-services', async (_req, res) => {
    const data = await listPublicStemServices();
    res.json(data);
  });

  router.post('/stem-services', async (req, res) => {
    try {
      const body = req.body || {};
      const result = await upsertStemService({
        id: typeof body.id === 'string' ? body.id : undefined,
        name: typeof body.name === 'string' ? body.name : '音源分离服务',
        kind: body.kind || 'remote-demucs-http',
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
        endpointPath:
          typeof body.endpointPath === 'string' ? body.endpointPath : '/separate',
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        clearKey: Boolean(body.clearKey),
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
        timeoutMs: Number(body.timeoutMs) || 180000,
        setActive: Boolean(body.setActive),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '保存音源分离服务失败',
      });
    }
  });

  router.post('/stem-services/active', async (req, res) => {
    const serviceId =
      req.body?.serviceId === null || typeof req.body?.serviceId === 'string'
        ? req.body.serviceId
        : null;
    const ok = await setActiveStemService(serviceId);
    if (!ok) {
      res.status(404).json({ error: '未找到指定音源分离服务' });
      return;
    }
    res.json({ ok: true, activeStemServiceId: serviceId });
  });

  router.delete('/stem-services/:id', async (req, res) => {
    const ok = await deleteStemService(req.params.id);
    if (!ok) {
      res.status(400).json({ error: '无法删除内置分离服务或服务不存在' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/stem-services/:id/test', async (req, res) => {
    const list = await listPublicStemServices();
    const target = list.services.find((s) => s.id === req.params.id);
    if (!target) {
      res.status(404).json({ ok: false, error: '未找到指定音源分离服务' });
      return;
    }
    if (target.kind === 'builtin-mdx') {
      const updated = await recordStemServiceProbeResult(target.id, {
        status: 'connected',
      });
      res.json({
        ok: true,
        message: '内置 UVR MDX-Net (Kim_Vocal_2) 推理服务就绪',
        service: updated,
      });
      return;
    }
    if (!target.baseUrl) {
      const updated = await recordStemServiceProbeResult(target.id, {
        status: 'error',
        error: '请先填写外部 Demucs / Spleeter 服务的 Base URL',
      });
      res.json({ ok: false, error: updated?.lastError, service: updated });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const probeUrl = target.baseUrl.replace(/\/+$/, '');
      const resp = await fetch(probeUrl, { method: 'GET', signal: controller.signal });
      if (resp.status >= 500) {
        throw new Error(`服务响应异常 (HTTP ${resp.status})`);
      }
      const updated = await recordStemServiceProbeResult(target.id, {
        status: 'connected',
      });
      res.json({
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
      res.json({ ok: false, error: errMsg, service: updated });
    } finally {
      clearTimeout(timer);
    }
  });

  // 3. AI Lyrics Assistant Task Proxy
  router.post('/tasks/lyrics', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      const {
        providerId,
        model,
        action,
        rawLyrics,
        trackTitle,
        artistName,
        targetLanguage = 'zh-CN',
        style = 'poetic',
        customStylePrompt = '',
        force = false,
        durationSec,
      } = req.body || {};

      if (!rawLyrics || typeof rawLyrics !== 'string' || !rawLyrics.trim()) {
        res.status(400).json({ error: '当前歌曲暂无歌词文本可供处理' });
        return;
      }

      if (action === 'translate') {
        const result = await executeLyricsTranslation({
          rawLyrics,
          trackTitle: typeof trackTitle === 'string' ? trackTitle : '',
          artistName: typeof artistName === 'string' ? artistName : '',
          targetLanguage: typeof targetLanguage === 'string' ? targetLanguage : 'zh-CN',
          style: typeof style === 'string' ? style : 'poetic',
          customStylePrompt: typeof customStylePrompt === 'string' ? customStylePrompt : '',
          providerId: typeof providerId === 'string' ? providerId : '',
          modelName: typeof model === 'string' ? model : '',
          force: Boolean(force),
          snapshot,
        });
        res.json({
          action,
          ...result,
          summary: `已完成 ${result.translatedCount} 句逐行翻译`,
        });
        return;
      }

      const explicitId = typeof providerId === 'string' ? providerId.trim() : '';
      const resolved = await getStoredProviderWithKey(explicitId || undefined, {
        strict: Boolean(explicitId),
        snapshot,
      });
      if (!resolved) {
        res.status(400).json({
          error: '尚未配置可用 AI 服务商，请先前往「API 服务管理」添加并启用服务商及 API Key。',
        });
        return;
      }

      const { provider, apiKey } = resolved;
      const effectiveModel = model || provider.model;
      const caps = inferModelCapabilities(provider.kind, effectiveModel);
      if (!caps.lyricsProcessing) {
        res.status(400).json({
          error: `模型「${effectiveModel}」不支持歌词文本处理，请选择对话/文本推理模型。`,
        });
        return;
      }

      const hasTimestamps = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(rawLyrics);
      const hasWordTags = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/.test(rawLyrics);

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
        const parsed = extractJsonFromLlmText<Record<string, unknown>>(raw);
        res.json({
          action,
          providerName: provider.name,
          modelUsed: effectiveModel,
          isTimedLrc: hasTimestamps,
          hasWordTags,
          result: parsed,
        });
        return;
      }

      if (action === 'proofread') {
        const raw = await callProviderTextCompletion({
          provider,
          apiKey,
          modelOverride: effectiveModel,
          systemInstruction: `Proofread the lyrics for obvious OCR/typo mistakes, broken punctuation, or formatting inconsistencies.
CRITICAL: NEVER alter, shift, or invent [mm:ss.xx] or <mm:ss.xx> timestamps! If input is plain text, do NOT add timestamps.
Return JSON: {"correctedLyrics": string, "changes": string[], "summary": string}. Respond in Simplified Chinese.`,
          userPrompt: JSON.stringify({
            song: trackTitle || '',
            artist: artistName || '',
            isTimedLrc: hasTimestamps,
            rawLyrics,
          }),
          expectJson: true,
        });
        const parsed = extractJsonFromLlmText<{
          correctedLyrics: string;
          changes?: string[];
          summary?: string;
        }>(raw);
        res.json({
          action,
          providerName: provider.name,
          modelUsed: effectiveModel,
          isTimedLrc: hasTimestamps,
          correctedLyrics: parsed.correctedLyrics || rawLyrics,
          changes: parsed.changes || [],
          summary: parsed.summary || '歌词校对完成',
        });
        return;
      }

      if (action === 'explain') {
        const raw = await callProviderTextCompletion({
          provider,
          apiKey,
          modelOverride: effectiveModel,
          systemInstruction:
            'You are a literary music critic. Explain the poetic imagery, emotional arc, metaphors, and core theme of these lyrics in refined Simplified Chinese. Return JSON: {"theme": string, "imagery": string[], "emotionalArc": string, "highlights": [{"line": string, "meaning": string}]}',
          userPrompt: JSON.stringify({
            song: trackTitle || '',
            artist: artistName || '',
            rawLyrics,
          }),
          expectJson: true,
        });
        const parsed = extractJsonFromLlmText<Record<string, unknown>>(raw);
        res.json({
          action,
          providerName: provider.name,
          modelUsed: effectiveModel,
          isTimedLrc: hasTimestamps,
          result: parsed,
        });
        return;
      }

      if (action === 'timeline-align') {
        const raw = await callProviderTextCompletion({
          provider,
          apiKey,
          modelOverride: effectiveModel,
          systemInstruction: `Analyze the LRC timeline integrity of the provided lyrics (given track duration ${
            durationSec || 'unknown'
          } seconds).
STRICT INTEGRITY RULE:
- Do NOT invent or fabricate word-level <mm:ss.xx> timestamps.
- If the input is plain text without timestamps, clearly report that plain text lacks timing markers and recommend importing an LRC source or marking lines manually in the Lyrics Editor while listening; you may suggest an estimated overall offsetMs ONLY if timestamps already exist and show obvious global drift or negative/exceeding-duration anomalies.
Return JSON: {"isTimedLrc": boolean, "hasWordSync": boolean, "issues": string[], "recommendedOffsetMs": number, "advice": string}. Respond in Simplified Chinese.`,
          userPrompt: JSON.stringify({
            song: trackTitle || '',
            durationSec,
            isTimedLrc: hasTimestamps,
            hasWordTags,
            rawLyrics,
          }),
          expectJson: true,
        });
        const parsed = extractJsonFromLlmText<Record<string, unknown>>(raw);
        res.json({
          action,
          providerName: provider.name,
          modelUsed: effectiveModel,
          isTimedLrc: hasTimestamps,
          hasWordTags,
          result: parsed,
        });
        return;
      }

      res.status(400).json({ error: `不支持的歌词任务类型: ${String(action)}` });
    } catch (err) {
      if (err instanceof LyricsTranslationHttpError) {
        res.status(err.status).json({ error: err.message, errorCategory: err.errorCategory });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'AI 歌词任务处理失败',
      });
    }
  });

  // 4. AI Smart Tuning (DSP Plan) Proxy
  router.post('/tasks/dsp-plan', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      const {
        providerId,
        model,
        instruction,
        currentSettings,
        trackInfo,
        hasSeparatedStems,
      } = req.body || {};

      if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
        res.status(400).json({ error: '请输入自然语言调音指令' });
        return;
      }

      const explicitId = typeof providerId === 'string' ? providerId.trim() : '';
      const resolved = await getStoredProviderWithKey(explicitId || undefined, {
        strict: Boolean(explicitId),
        snapshot,
      });
      if (!resolved) {
        res.status(400).json({
          error: '尚未配置可用 AI 服务商，请先前往「API 服务管理」配置并启用 API Key。',
        });
        return;
      }

      const { provider, apiKey } = resolved;
      const effectiveModel = model || provider.model;

      const systemInstruction = `You are LUMINA MUSIC's professional Web Audio DSP mastering engineer.
Translate the user's natural-language tuning instruction into a precise, valid JSON patch for the real AudioDspSettings engine.

Available AudioDspSettings fields & valid ranges:
- masterEnabled: boolean
- qualityMode: "original" | "high" | "lossless" | "auto"
- eqPreset: "标准" | "流行" | "摇滚" | "古典" | "爵士" | "电子" | "人声增强" | "低音增强" | "自定义"
- eqGains: array of 7 numbers in [-12, 12] dB corresponding to [60Hz, 150Hz, 400Hz, 1kHz, 2.4kHz, 6kHz, 15kHz]
- bassBoost: number in [0, 12] dB
- trebleBoost: number in [0, 12] dB
- vocalEnhance: number in [0, 10] dB (2.8kHz vocal clarity peaking boost)
- reverbMix: number in [0, 100] % (spatial convolution reverb)
- stereoWidth: number in [0, 100] % (50 is neutral natural stereo)
- surroundEnabled: boolean
- surroundWidth: number in [0, 100]
- surroundIntensity: number in [0, 100]
- headphoneOptimize: boolean
- loudnessNormalization: boolean
- stemModeActive: boolean (ONLY set true if hasSeparatedStems === true!)
- vocalGain: number in [0, 200] % (effective when stemModeActive is true)
- instrumentalGain: number in [0, 200] % (effective when stemModeActive is true)
- vocalAccompanimentBalance: number in [-100, 100] (ONLY used when hasSeparatedStems === false as fallback M/S vocal vs background balance: +val lowers background, -val lowers center vocal)

CRITICAL HONESTY RULES:
1. If user asks to independently adjust vocal vs accompaniment volume (e.g. "让人声更加清晰，降低伴奏音量") AND hasSeparatedStems is true: set stemModeActive: true and tune vocalGain / instrumentalGain directly (0..200).
2. If hasSeparatedStems is false and user asks to lower accompaniment/increase vocal: you may combine vocalEnhance + moderate positive vocalAccompanimentBalance OR EQ midrange clarity, AND set "suggestStemSeparation": true so the UI recommends running real AI stem separation! Never claim EQ alone achieves true AI stem separation.
3. Always ensure masterEnabled: true and qualityMode !== "original" if applying DSP changes.
4. Only include fields that should change inside "patch".
5. Return strictly valid JSON:
{
  "explanation": string (clear Simplified Chinese explanation of what will change and why),
  "patch": { ... },
  "suggestStemSeparation": boolean,
  "warnings": string[]
}`;

      const raw = await callProviderTextCompletion({
        provider,
        apiKey,
        modelOverride: effectiveModel,
        systemInstruction,
        userPrompt: JSON.stringify({
          instruction: instruction.trim(),
          hasSeparatedStems: Boolean(hasSeparatedStems),
          trackInfo: trackInfo || {},
          currentSettings: currentSettings || {},
        }),
        expectJson: true,
      });

      const parsed = extractJsonFromLlmText<{
        explanation?: string;
        patch?: Record<string, unknown>;
        suggestStemSeparation?: boolean;
        warnings?: string[];
      }>(raw);

      res.json({
        providerName: provider.name,
        modelUsed: effectiveModel,
        explanation: parsed.explanation || '已根据指令生成音效调整建议',
        patch: parsed.patch || {},
        suggestStemSeparation: Boolean(parsed.suggestStemSeparation),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '生成智能调音方案失败',
      });
    }
  });

  // 5. AI Music Analysis (enforces strict multimodal capability check for audio-signal tasks)
  router.post('/tasks/analyze-audio', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      const {
        providerId,
        model,
        analysisType = 'comprehensive',
        trackInfo,
        audioBase64,
        audioMimeType,
        hasAudioClip,
      } = req.body || {};

      const explicitId = typeof providerId === 'string' ? providerId.trim() : '';
      const resolved = await getStoredProviderWithKey(explicitId || undefined, {
        strict: Boolean(explicitId),
        snapshot,
      });
      if (!resolved) {
        res.status(400).json({
          error: '尚未配置可用 AI 服务商，请先前往「API 服务管理」配置服务商与 API Key。',
        });
        return;
      }

      const { provider, apiKey } = resolved;
      const effectiveModel = model || provider.model;
      const caps = inferModelCapabilities(provider.kind, effectiveModel);

      const requiresAudioSignal =
        analysisType === 'instruments' || analysisType === 'rhythm-audio';

      if (requiresAudioSignal && !caps.audioInputAnalysis) {
        res.status(400).json({
          error: `模型「${effectiveModel}」(${provider.name}) 为纯文本模型，无法直接接收并听辨音频波形来识别真实乐器或音频节拍。请切换为支持音频输入的多模态模型（如 Google Gemini）后再执行此项分析。`,
          capabilityError: true,
        });
        return;
      }

      if (requiresAudioSignal && (!audioBase64 || !audioMimeType)) {
        res.status(400).json({
          error: '未获取到音频采样片段，无法执行基于真实音频信号的乐器与节奏分析。',
        });
        return;
      }

      const usingRealAudio = Boolean(
        caps.audioInputAnalysis && audioBase64 && audioMimeType
      );

      const systemInstruction = `You are a professional musicologist and audio analyst.
${
  usingRealAudio
    ? 'You have been provided with an actual audio recording segment alongside track metadata. Base instrument recognition, rhythm/BPM feel, timbre, and sonic character directly on what you hear in the audio.'
    : 'You are provided ONLY with track metadata and lyrics (no audio stream). Analyze song style, mood, background, and curation insights based strictly on the provided metadata/lyrics—do NOT claim to have listened to the audio waveform or hallucinate exact audio-only instrument mixes.'
}
Return strictly valid JSON in Simplified Chinese:
{
  "genre": string,
  "mood": string,
  "instruments": string[],
  "rhythmAndTempo": string,
  "curatedSummary": string,
  "tags": string[],
  "analyzedFromAudio": boolean
}`;

      const raw = await callProviderTextCompletion({
        provider,
        apiKey,
        modelOverride: effectiveModel,
        systemInstruction,
        userPrompt: JSON.stringify({
          analysisType,
          hasAudioClip: Boolean(hasAudioClip && usingRealAudio),
          trackInfo: trackInfo || {},
        }),
        expectJson: true,
        audioInline: usingRealAudio
          ? { mimeType: String(audioMimeType), base64Data: String(audioBase64) }
          : undefined,
      });

      const parsed = extractJsonFromLlmText<Record<string, unknown>>(raw);
      res.json({
        providerName: provider.name,
        modelUsed: effectiveModel,
        analyzedFromAudio: usingRealAudio,
        result: {
          ...parsed,
          analyzedFromAudio: usingRealAudio,
        },
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'AI 音乐分析失败',
      });
    }
  });

  // 6. Unified AI Task Manager Intent Router
  router.post('/tasks/route-intent', async (req, res) => {
    try {
      const snapshot = extractSnapshotFromExpressReq(req);
      const {
        providerId,
        model,
        prompt,
        trackInfo,
        hasLyrics,
        hasSeparatedStems,
        currentSettings,
      } = req.body || {};

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        res.status(400).json({ error: '请输入指令或问题' });
        return;
      }

      const explicitId = typeof providerId === 'string' ? providerId.trim() : '';
      const resolved = await getStoredProviderWithKey(explicitId || undefined, {
        strict: Boolean(explicitId),
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
        res.status(400).json({
          error:
            '当前默认 AI 服务商未启用或尚未填写 API Key。请前往「设置 → AI 智能中心 → API 服务管理」配置并测试连接。',
        });
        return;
      }

      const { provider, apiKey } = resolved;
      const effectiveModel = model || provider.model;
      const caps = inferModelCapabilities(provider.kind, effectiveModel);

      const systemInstruction = `You are LUMINA MUSIC's AI Task Manager router.
Classify the user's natural-language request into ONE primary taskType and evaluate capability availability based on the provided system capabilities.
Task types:
- "stem_separation": User asks to separate vocals and accompaniment/instrumental tracks (e.g., "把人声和伴奏分开", "提取人声", "制作伴奏").
- "dsp_tuning": User asks to adjust audio effects, EQ, bass, treble, vocal clarity, reverb, surround, or vocal/instrumental mix volume.
- "lyrics_assistant": User asks to search, translate, detect language, proofread, explain, or check timing of lyrics.
- "audio_analysis": User asks to analyze song style, mood, instruments, rhythm, or track background.
- "general_qa": General music conversation or guidance.

System capability state provided in input:
- stemServiceReady: boolean (${stemReady})
- stemServiceName: "${activeStem?.name || '未配置'}"
- modelSupportsAudioInput: boolean (${caps.audioInputAnalysis})
- hasTrack: boolean
- hasLyrics: boolean
- hasSeparatedStems: boolean

CRITICAL RULES:
1. For "stem_separation", NEVER say the LLM itself separates audio. Check stemServiceReady: if false, set canExecute: false and explain clearly that an independent stem separation service must be configured first. If true and hasTrack, set canExecute: true, requiresConfirmation: true, and ask whether to begin separation.
2. For "audio_analysis" involving audio-only tasks (instruments / audio tempo), if !modelSupportsAudioInput, note honestly that current model is text-only and can only analyze metadata/lyrics unless switched to Gemini multimodal.
3. For "dsp_tuning", provide "dspInstruction": string summarizing the tuning goal so the tuning planner can generate exact parameters for user confirmation.
4. For "lyrics_assistant", set "lyricsAction": "translate" | "detect-language" | "proofread" | "explain" | "timeline-align" | "search".
5. Respond strictly in JSON (Simplified Chinese replyMessage):
{
  "taskType": "stem_separation" | "dsp_tuning" | "lyrics_assistant" | "audio_analysis" | "general_qa",
  "canExecute": boolean,
  "requiresConfirmation": boolean,
  "replyMessage": string,
  "lyricsAction": string | null,
  "dspInstruction": string | null,
  "analysisType": "comprehensive" | "instruments" | "rhythm-audio" | null
}`;

      const raw = await callProviderTextCompletion({
        provider,
        apiKey,
        modelOverride: effectiveModel,
        systemInstruction,
        userPrompt: JSON.stringify({
          prompt: prompt.trim(),
          stemServiceReady: stemReady,
          stemServiceName: activeStem?.name || null,
          modelSupportsAudioInput: caps.audioInputAnalysis,
          hasTrack: Boolean(trackInfo?.id),
          trackInfo: trackInfo || null,
          hasLyrics: Boolean(hasLyrics),
          hasSeparatedStems: Boolean(hasSeparatedStems),
          currentSettings: currentSettings || null,
        }),
        expectJson: true,
      });

      const plan = extractJsonFromLlmText<Record<string, unknown>>(raw);
      res.json({
        providerName: provider.name,
        modelUsed: effectiveModel,
        capabilities: caps,
        stemServiceReady: stemReady,
        stemServiceName: activeStem?.name || null,
        plan,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'AI 任务调度解析失败',
      });
    }
  });

  return router;
}
