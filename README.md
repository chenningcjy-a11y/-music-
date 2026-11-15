# LUMINA MUSIC

沉浸式智能音乐播放器，集成实时 Web Audio 音频可视化、10 段均衡器与 3D 环绕 DSP 引擎、UVR MDX-Net 音轨分离，以及基于已有服务商体系的诗意双语 AI 歌词翻译系统。

## 核心功能特性

1. **AI 歌词翻译系统（统一接入现有服务商）**
   - 直接读取「AI 智能中心 · API 服务管理」中已配置的 **DeepSeek / OpenAI / Google Gemini / OpenAI 兼容 / 自定义 API**，不额外创建重复配置系统。
   - 支持手动切换或设置为**默认歌词翻译服务商与模型**，实时展示连接状态与 API Key 就绪状态；未配置或不可用时给出明确错误与引导，**绝不伪造翻译结果或静默回退到其他服务商**。
   - 内置 **5 种翻译风格**（默认推荐「诗意翻译」）：
     1. 诗意翻译（文学感、画面感、情绪与意境忠实还原）
     2. 自然翻译（符合中文自然语感）
     3. 忠实直译（逐句精准保留字面原意）
     4. 文学润色（凝练修辞并忠于原意）
     5. 自定义风格（支持自定义翻译提示词）
   - **原文与译文独立存储**：逐句保留 `[mm:ss.xx]` 时间戳与对应关系，支持双语对照、仅看原文、仅看译文、逐句独立编辑、重新翻译、仅保留原歌词、恢复最初 AI 翻译。播放歌曲时直接读取本地 IndexedDB 已保存歌词，不重复消耗 API 配额。

2. **音乐导入：轻量导入 vs 完整导入**
   - **轻量导入（默认推荐）**：仅导入音源文件与专辑封面（优先提取内嵌封面，支持手动上传、主动点击「在线搜索封面」或默认封面），绝不自动导入目录中无关图片、`.lrc`、`.txt` 或外挂翻译文件，同时完整解析歌名、歌手、专辑、时长、格式、采样率、比特率与声道信息。
   - **完整导入**：保留原有自动关联同目录 `.lrc` 歌词与内嵌歌词的完整导入方式。

3. **独立 AI 任务队列与安全加密备份**
   - 每项歌词翻译与音轨分离任务独立保存于 `TaskCenterContext` 与 IndexedDB，记录 `taskId`、来源曲目信息、服务商、模型、翻译风格、进度、结果与错误详情，切换歌曲不中断任务。
   - 支持 **v3 完整备份导出/还原**：默认不包含任何密钥信息；若填写备份口令，使用 **PBKDF2-SHA256 + AES-256-GCM** 对 API 密钥进行本地密文封装导出，明文 Key 永不落地到 `localStorage`、日志、Git 或未加密备份中。

---

## 本地开发运行

```bash
npm install
cp .env.example .env
npm run dev
```

开发服务器将在 `http://localhost:3000` 启动（同时运行 Vite 开发中间件与 Express API 代理）。

---

## 环境变量说明（`.env.example`）

| 变量名 | 用途 | 必填 |
| --- | --- | --- |
| `PORT` | 本地 Express 服务端口（默认 `3000`） | 否 |
| `LUMINA_VAULT_SECRET` | 服务端 AES-256-GCM 密钥库主密钥（生产环境建议设置高强度随机字符串） | 生产推荐 |
| `GEMINI_API_KEY` | 服务端环境变量兜底 Gemini API Key | 否（可在页面 UI 配置） |
| `DEEPSEEK_API_KEY` | 服务端环境变量兜底 DeepSeek API Key | 否（可在页面 UI 配置） |
| `OPENAI_API_KEY` | 服务端环境变量兜底 OpenAI API Key | 否（可在页面 UI 配置） |

> 安全声明：请勿使用 `VITE_*` 前缀暴露任何 API Key；所有密钥均由服务端密钥库与 AES-256-GCM 密文代理保管，绝不以明文形式存储于浏览器 `localStorage` 或提交至 Git。

---

## Google AI Studio 与 GitHub / Netlify 生产部署

### Google AI Studio 预览环境
- 直接运行 `npm run dev` 或通过 AI Studio 预览即可使用所有播放器、DSP、轻量导入、AI 翻译与浏览器端 WebAssembly 音轨分离能力。

### Netlify 生产部署
仓库已内置 `netlify.toml` 与 Netlify Function（`netlify/functions/api.ts`）：

1. 将代码推送至 GitHub 仓库后，在 Netlify 中关联该仓库。
2. 构建配置（已在 `netlify.toml` 中声明）：
   - **Build command**: `npm run build`
   - **Publish directory**: `dist`
   - **Functions directory**: `netlify/functions`
3. 在 Netlify Site Environment Variables 中按需配置 `LUMINA_VAULT_SECRET`（建议至少 32 位随机字符，保证跨 Serverless 冷启动密文持久化稳定解密）。
4. 构建过程会自动将 `onnxruntime-web` 的 `.wasm` 与 `.mjs` 文件复制到 `dist/ort-wasm/`，确保无服务器生产环境中的浏览器端 Web Worker 音轨分离与本地开发一致。
