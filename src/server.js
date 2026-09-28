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

// Сохраняет токены из запроса установки/открытия приложения. Токен предварительно
// проверяется вызовом app.info на портале из конфигурации, чтобы поддельный
// POST не мог подменить авторизацию.
async function saveAuth(body, tokens) {
  const auth = body.auth || {};
  const accessToken = body.AUTH_ID || auth.access_token;
  if (!accessToken) return false;
  const endpoint = `https://${config.domain}/rest/`;
  try {
    const res = await fetch(`${endpoint}app.info.json?auth=${encodeURIComponent(accessToken)}`);
    const info = await res.json();
    if (!info.result) {
      log('Отклонены токены: app.info вернул', info.error || res.status);
      return false;
    }
  } catch (e) {
    log('Не удалось проверить токены:', e.message);
    return false;
  }
  tokens.save({
    access_token: accessToken,
    refresh_token: body.REFRESH_ID || auth.refresh_token,
    member_id: body.member_id || auth.member_id,
    domain: config.domain,
    client_endpoint: endpoint,
    ...(auth.application_token ? { application_token: auth.application_token } : {}),
  });
  log('Токены приложения сохранены');
  return true;
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Страница, которую видит пользователь при открытии приложения в Б24:
// текущие настройки и справочник каталогов/свойств для CATALOG_IBLOCK_IDS и SKU_FIELD.
export async function statusPage(client) {
  const rows = [];
  try {
    const { catalogs = [] } = (await client.call('catalog.catalog.list', { select: ['iblockId', 'name', 'productIblockId'] })) || {};
    for (const cat of catalogs) {
      const { productProperties: props = [] } =
        (await client.call('catalog.productProperty.list', { filter: { iblockId: cat.iblockId }, select: ['id', 'name', 'code'] })) || {};
      rows.push(`<tr><td><b>${esc(cat.iblockId)}</b></td><td>${esc(cat.name)}${cat.productIblockId ? ' (торговые предложения)' : ''}</td><td>${
        props.map((p) => `<code>property${esc(p.id)}</code> — ${esc(p.name)}${p.code ? ` (${esc(p.code)})` : ''}`).join('<br>') || '—'
      }</td></tr>`);
    }
  } catch (e) {
    rows.push(`<tr><td colspan="3">Не удалось получить каталоги: ${esc(e.message)}</td></tr>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#333}table{border-collapse:collapse}
td,th{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top}code{background:#f3f3f3;padding:1px 4px}
</style></head><body>
<h2>SKU Sync работает</h2>
<p>Токены обновлены. Текущие настройки: <code>CATALOG_IBLOCK_IDS=${esc(config.catalogIblockIds.join(',')) || 'не задан'}</code>,
<code>SKU_FIELD=${esc(config.skuField)}</code>.</p>
<p>Поле с артикулом можно задать как <code>property&lt;ID&gt;</code> из таблицы ниже, <code>xmlId</code> (внешний код) или <code>code</code> (символьный код).</p>
<table><tr><th>iblockId</th><th>Каталог</th><th>Свойства товаров → SKU_FIELD</th></tr>${rows.join('')}</table>
</body></html>`;
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
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
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
        if (!(await saveAuth(body, tokens))) {
          res.writeHead(400);
          return res.end('No valid auth data');
        }
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

        // Открытие приложения в портале: сохраняем свежие токены (после
        // передеплоя data/ пуст — достаточно открыть приложение в Б24).
        if (!event && body.AUTH_ID) {
          const ok = await saveAuth(body, tokens);
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(ok ? await statusPage(client) : 'No valid auth data');
        }

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
