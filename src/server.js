import http from 'node:http';
import { config } from './config.js';
import { TokenStore } from './tokenStore.js';
import { B24Client } from './b24client.js';
import { syncDeal } from './dealSync.js';
import { parseNestedForm } from './formParser.js';

const EVENT = 'ONCRMDEALUPDATE';
const log = (...args) => console.log(new Date().toISOString(), ...args);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parse(req, raw) {
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return parseNestedForm(raw);
}

export async function bindEvent(client) {
  const handler = `${config.publicUrl}/handler`;
  const bound = (await client.call('event.get')) || [];
  if (bound.some((e) => e.event?.toUpperCase() === EVENT && e.handler === handler)) {
    log(`Событие ${EVENT} уже привязано к ${handler}`);
    return;
  }
  await client.call('event.bind', { event: EVENT, handler });
  log(`Подписка ${EVENT} → ${handler} создана`);
}

// Сделки обрабатываются последовательно, повторное событие по той же сделке
// дожидается завершения предыдущего (productrows.set сам порождает OnCrmDealUpdate).
const queues = new Map();
function enqueue(dealId, job) {
  const prev = queues.get(dealId) || Promise.resolve();
  const next = prev.then(job, job).finally(() => {
    if (queues.get(dealId) === next) queues.delete(dealId);
  });
  queues.set(dealId, next);
  return next;
}

export function createServer({ client, tokens }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, installed: Boolean(tokens.load()?.access_token) }));
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      const body = parse(req, await readBody(req));

      // Установка локального приложения: Б24 открывает обработчик установки
      // с AUTH_ID/REFRESH_ID в теле и DOMAIN/member_id в query/теле.
      if (url.pathname === '/install') {
        const auth = body.auth || {};
        const accessToken = body.AUTH_ID || auth.access_token;
        if (!accessToken) {
          res.writeHead(400);
          return res.end('No auth data');
        }
        const domain = url.searchParams.get('DOMAIN') || auth.domain || config.domain;
        tokens.save({
          access_token: accessToken,
          refresh_token: body.REFRESH_ID || auth.refresh_token,
          member_id: body.member_id || auth.member_id,
          domain,
          client_endpoint: auth.client_endpoint || `https://${domain}/rest/`,
          ...(auth.application_token ? { application_token: auth.application_token } : {}),
        });
        let status = 'ok';
        try {
          await bindEvent(client);
        } catch (e) {
          status = e.message;
          log('Ошибка event.bind:', e.message);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html><head><meta charset="utf-8">
<script src="//api.bitrix24.com/api/v1/"></script></head><body>
<p>SKU-синхронизация: ${status === 'ok' ? 'установлено, подписка на OnCrmDealUpdate создана' : 'ошибка: ' + status.replace(/</g, '&lt;')}</p>
<script>BX24.init(function(){ BX24.installFinish(); });</script></body></html>`);
      }

      if (url.pathname === '/handler') {
        const event = String(body.event || '').toUpperCase();
        const appToken = body.auth?.application_token;

        // ONAPPINSTALL приходит с application_token — запоминаем его для проверки событий.
        if (event === 'ONAPPINSTALL' && appToken) {
          tokens.save({ application_token: appToken });
          res.writeHead(200);
          return res.end('ok');
        }

        const expected = config.appToken || tokens.load()?.application_token;
        if (expected && appToken !== expected) {
          log('Отклонено событие с неверным application_token');
          res.writeHead(403);
          return res.end('forbidden');
        }
        if (!expected && appToken) {
          // Первый пришедший токен запоминаем (Trust On First Use).
          tokens.save({ application_token: appToken });
        }

        const dealId = Number(body.data?.FIELDS?.ID);
        res.writeHead(200);
        res.end('ok');

        if (event === EVENT && dealId) {
          enqueue(dealId, () =>
            syncDeal(client, config, dealId, (s) =>
              log(`Сделка ${s.dealId}: обновлено позиций ${s.changed.length}` +
                (s.changed.length ? ` (${s.changed.map((c) => `${c.sku}→${c.to}`).join(', ')})` : '') +
                (s.notFound.length ? `; не найдены в каталоге: ${s.notFound.join(', ')}` : '')),
            ).catch((e) => log(`Сделка ${dealId}: ошибка`, e.message)),
          );
        }
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (e) {
      log('Ошибка запроса:', e.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tokens = new TokenStore(config.dataDir);
  const client = new B24Client(config, tokens);
  if (!config.catalogIblockIds.length) log('ВНИМАНИЕ: CATALOG_IBLOCK_IDS не задан — поиск по каталогу не будет работать');
  createServer({ client, tokens }).listen(config.port, () => {
    log(`Сервер слушает :${config.port}. Обработчик событий: ${config.publicUrl || '<PUBLIC_URL>'}/handler, установка: /install`);
  });
}
