import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function isServerlessRuntime(): boolean {
  return Boolean(
    process.env.NETLIFY ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      process.env.VERCEL
  );
}

export function getCacheDir(): string {
  if (isServerlessRuntime()) {
    return path.join(os.tmpdir(), 'lumina-music-cache');
  }
  return path.resolve(__dirname, '../../.cache');
}

let cachedMasterKey: Buffer | null = null;

function deriveDeterministicKey(seed: string): Buffer {
  return crypto.createHash('sha256').update(`lumina-vault-v1:${seed}`).digest();
}

export async function getVaultMasterKey(): Promise<Buffer> {
  if (cachedMasterKey) return cachedMasterKey;

  const envSecret = (process.env.LUMINA_VAULT_SECRET || '').trim();
  if (envSecret) {
    cachedMasterKey = deriveDeterministicKey(envSecret);
    return cachedMasterKey;
  }

  // In Netlify / Serverless without explicit LUMINA_VAULT_SECRET, derive a site-scoped
  // deterministic key so sealed tokens stay valid across cold starts on the same site.
  if (isServerlessRuntime()) {
    const siteSeed =
      process.env.SITE_ID ||
      process.env.NETLIFY_SITE_ID ||
      process.env.URL ||
      process.env.GEMINI_API_KEY ||
      'lumina-serverless-site-default';
    cachedMasterKey = deriveDeterministicKey(siteSeed);
    return cachedMasterKey;
  }

  const cacheDir = getCacheDir();
  const keyFile = path.join(cacheDir, '.vault-key');
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    if (fs.existsSync(keyFile)) {
      const existing = (await fsp.readFile(keyFile, 'utf8')).trim();
      if (/^[0-9a-f]{64}$/i.test(existing)) {
        cachedMasterKey = Buffer.from(existing, 'hex');
        return cachedMasterKey;
      }
    }
    const fresh = crypto.randomBytes(32);
    await fsp.writeFile(keyFile, fresh.toString('hex'), { mode: 0o600 });
    cachedMasterKey = fresh;
    return fresh;
  } catch {
    const fallbackSeed =
      process.env.GEMINI_API_KEY ||
      process.env.HOSTNAME ||
      'lumina-local-ephemeral-fallback';
    cachedMasterKey = deriveDeterministicKey(fallbackSeed);
    return cachedMasterKey;
  }
}

export async function sealSecret(plain: string): Promise<string> {
  if (!plain) return '';
  const key = await getVaultMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export async function unsealSecret(serialized?: string): Promise<string> {
  if (!serialized || typeof serialized !== 'string') return '';
  const parts = serialized.trim().split(':');
  if (parts.length !== 3) return '';
  try {
    const key = await getVaultMasterKey();
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const data = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

export function maskSecretKey(rawKey: string): string {
  const trimmed = (rawKey || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}••••`;
  }
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function sanitizeSecretError(err: unknown, fallback = 'AI 接口调用失败'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : fallback;
  return raw
    .replace(/sk-[a-zA-Z0-9_-]{6,}/g, 'sk-***')
    .replace(/AIza[a-zA-Z0-9_-]{6,}/g, 'AIza***')
    .replace(/Bearer\s+[a-zA-Z0-9._-]{8,}/gi, 'Bearer ***');
}
