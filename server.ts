import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyCoverImageBytes, searchOnlineCovers } from './server/ai/coverSearch.ts';
import { ClientVaultSnapshot } from './server/ai/keyVault.ts';
import {
  executeLyricsTranslation,
  LyricsTranslationHttpError,
  searchOnlineLyricsCombined,
} from './server/ai/lyricsCore.ts';
import {
  cancelServerStemJob,
  deleteServerStemJob,
  enqueueServerStemJob,
  ensureServerModelCached,
  getServerModelStatus,
  getServerStemDownloadPath,
  getServerStemJob,
  initStemJobQueue,
  listServerStemJobs,
  pauseServerStemJob,
  resumeServerStemJob,
} from './server/ai/stemJobQueue.ts';
import { createAiRouter } from './server/ai/taskRoutes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
let customPort = Number(process.env.PORT) || 3000;
let customHost = '0.0.0.0';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    customPort = Number(args[i + 1]) || customPort;
    i++;
  } else if (args[i] === '--host' && args[i + 1]) {
    customHost = args[i + 1];
    i++;
  }
}
const PORT = customPort;
const HOST = customHost;
const isProd = process.env.NODE_ENV === 'production';

async function startServer() {
  await initStemJobQueue();
  const app = express();
  const httpServer = http.createServer(app);

  // Serve ONNX Runtime Web WASM & worker modules cleanly from node_modules
  const ortDistDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
  app.use(
    '/ort-wasm',
    express.static(ortDistDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        } else if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        }
        res.setHeader('Cache-Control', 'public, max-age=604800');
      },
    })
  );

  // Runtime health & capability detection
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      runtime: 'node-express',
      stemServerAvailable: true,
      browserWorkerStemAvailable: true,
      securityMode: 'backend-encrypted-proxy',
    });
  });

  // Model metadata & cached ONNX weights download endpoint (avoids HuggingFace browser CORS)
  app.get('/api/stems/model/status', async (_req, res) => {
    const status = await getServerModelStatus();
    res.json(status);
  });

  app.get('/api/stems/model', async (_req, res) => {
    try {
      const modelPath = await ensureServerModelCached();
      const stat = await fsp.stat(modelPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(modelPath).pipe(res);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : '无法加载 AI 分离模型',
      });
    }
  });

  // Persistent queued server-side AI stem separation endpoints
  app.post(
    '/api/stems/separate',
    express.raw({ type: '*/*', limit: '150mb' }),
    async (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: '未收到音频文件数据' });
          return;
        }

        const ext = typeof req.query.ext === 'string' ? req.query.ext : 'bin';
        const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
        const sourceTrackId =
          typeof req.query.trackId === 'string' ? req.query.trackId : undefined;
        const sourceTrackTitle =
          typeof req.query.title === 'string' ? req.query.title : undefined;
        const sourceTrackArtist =
          typeof req.query.artist === 'string' ? req.query.artist : undefined;

        const job = await enqueueServerStemJob({
          audioBuffer: body,
          ext,
          taskId,
          sourceTrackId,
          sourceTrackTitle,
          sourceTrackArtist,
        });

        res.json({ jobId: job.id, job });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : '创建分离任务失败',
        });
      }
    }
  );

  app.get('/api/stems/jobs', async (_req, res) => {
    const jobs = await listServerStemJobs();
    res.json({ jobs });
  });

  app.get('/api/stems/job/:jobId', async (req, res) => {
    const job = await getServerStemJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: '分离任务不存在或已过期' });
      return;
    }
    res.json(job);
  });

  app.post('/api/stems/job/:jobId/pause', async (req, res) => {
    const job = await pauseServerStemJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: '分离任务不存在' });
      return;
    }
    res.json({ ok: true, job });
  });

  app.post('/api/stems/job/:jobId/resume', async (req, res) => {
    try {
      const job = await resumeServerStemJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: '分离任务不存在' });
        return;
      }
      res.json({ ok: true, job });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : '恢复任务失败',
      });
    }
  });

  app.post('/api/stems/job/:jobId/cancel', async (req, res) => {
    const job = await cancelServerStemJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: '分离任务不存在' });
      return;
    }
    res.json({ ok: true, job });
  });

  app.delete('/api/stems/job/:jobId', async (req, res) => {
    const ok = await deleteServerStemJob(req.params.jobId);
    res.json({ ok });
  });

  app.get('/api/stems/job/:jobId/download/:stem', async (req, res) => {
    const targetPath = await getServerStemDownloadPath(
      req.params.jobId,
      req.params.stem
    );
    if (!targetPath) {
      res.status(404).json({ error: '分离音轨尚未就绪或不存在' });
      return;
    }
    const stat = await fsp.stat(targetPath);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(targetPath).pipe(res);
  });

  app.use('/api/ai', createAiRouter());

  app.use(express.json({ limit: '4mb' }));

  // Cover search & CORS-clean cover image proxy
  app.get('/api/covers/search', async (req, res) => {
    const title =
      typeof req.query.title === 'string'
        ? req.query.title.trim()
        : typeof req.query.q === 'string'
        ? req.query.q.trim()
        : '';
    const artist = typeof req.query.artist === 'string' ? req.query.artist.trim() : '';
    if (!title && !artist) {
      res.status(400).json({ error: '请输入歌曲名称或歌手关键词搜索封面' });
      return;
    }
    const candidates = await searchOnlineCovers(title, artist);
    res.json({ candidates });
  });

  app.get('/api/covers/proxy', async (req, res) => {
    const targetUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!targetUrl) {
      res.status(400).json({ error: '缺少封面图片 URL' });
      return;
    }
    try {
      const { buffer, contentType } = await proxyCoverImageBytes(targetUrl);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(buffer));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : '封面代理失败',
      });
    }
  });

  // Multi-source lyric search (aggregates native bilingual sources + LRCLIB)
  app.get('/api/lyrics/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.status(400).json({ error: '缺少搜索关键词' });
      return;
    }

    try {
      const combined = await searchOnlineLyricsCombined(q);
      res.json(combined);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : '歌词检索服务暂时不可用',
      });
    }
  });

  // Strict, model-selectable poetic AI lyrics translation (no silent fallback)
  app.post('/api/lyrics/translate', async (req, res) => {
    try {
      const body = req.body || {};
      let headerSnap: ClientVaultSnapshot | null = null;
      const headerVal = req.headers['x-lumina-provider-snapshot'];
      const rawSnap = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      if (rawSnap && typeof rawSnap === 'string') {
        try {
          headerSnap = JSON.parse(
            Buffer.from(rawSnap, 'base64').toString('utf8')
          ) as ClientVaultSnapshot;
        } catch {
          // ignore malformed header snapshot
        }
      }

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
        snapshot: (body.providerSnapshot as ClientVaultSnapshot | undefined) || headerSnap,
      });

      res.json(result);
    } catch (err) {
      if (err instanceof LyricsTranslationHttpError) {
        res.status(err.status).json({
          error: err.message,
          errorCategory: err.errorCategory,
        });
        return;
      }
      console.error('Lyrics translate error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : '歌词翻译失败，请稍后重试',
      });
    }
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: !disableHmr,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`LUMINA MUSIC server listening on http://${HOST}:${PORT}`);
  });
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
