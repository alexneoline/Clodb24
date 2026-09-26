import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Минимальный загрузчик .env без зависимостей. Переменные окружения имеют приоритет.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  domain: env.B24_DOMAIN || 'neoline.bitrix24.ru',
  transport: env.B24_TRANSPORT || 'oauth',
  clientId: env.B24_CLIENT_ID || '',
  clientSecret: env.B24_CLIENT_SECRET || '',
  webhookUrl: env.B24_WEBHOOK_URL || '',
  vibeApiUrl: (env.VIBE_API_URL || 'https://vibecode.bitrix24.tech/v1').replace(/\/+$/, ''),
  vibeApiKey: env.VIBE_API_KEY || '',
  vibeAuthHeader: env.VIBE_AUTH_HEADER || 'X-Api-Key',
  appToken: env.B24_APP_TOKEN || '',
  catalogIblockIds: (env.CATALOG_IBLOCK_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean),
  skuField: env.SKU_FIELD || 'property105',
  skuRegex: new RegExp(env.SKU_REGEX || '\\[(SKU-[A-Za-z0-9._\\/-]+)\\]', 'i'),
  dataDir: path.join(ROOT, 'data'),
};
