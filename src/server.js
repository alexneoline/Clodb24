import http from 'node:http';
import { config } from './config.js';
import { TokenStore } from './tokenStore.js';
import { B24Client } from './b24client.js';
import { syncDeal, findProductIdBySku } from './dealSync.js';
import { parseNestedForm } from './formParser.js';
import { getSettings, saveSettings } from './settings.js';

const EVENT = 'ONCRMDEALUPDATE';
// Б24 может открыть приложение по любому из этих путей; события приходят туда же.
const APP_PATHS = new Set(['/', '/handler', '/install']);
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
  if (!accessToken) return null;
  const endpoint = `https://${config.domain}/rest/`;
  let info;
  try {
    const res = await fetch(`${endpoint}app.info.json?auth=${encodeURIComponent(accessToken)}`);
    const body = await res.json();
    if (!body.result) {
      log('Отклонены токены: app.info вернул', body.error || res.status);
      return null;
    }
    info = body.result;
  } catch (e) {
    log('Не удалось проверить токены:', e.message);
    return null;
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
  return info;
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function loadCatalogs(client) {
  const { catalogs = [] } = (await client.call('catalog.catalog.list', { select: ['iblockId', 'name', 'productIblockId'] })) || {};
  for (const cat of catalogs) {
    const { productProperties = [] } =
      (await client.call('catalog.productProperty.list', {
        filter: { iblockId: cat.iblockId },
        select: ['id', 'name', 'code', 'propertyType', 'multiple'],
      })) || {};
    // Артикул ищется точным совпадением значения — подходят только строки и числа
    // (не файлы, списки, привязки).
    cat.properties = productProperties.filter((p) => !p.propertyType || ['S', 'N'].includes(p.propertyType));
  }
  return catalogs;
}

// Страница настроек, которую видит пользователь при открытии приложения в Б24:
// выбор каталогов и поля, в котором у товаров хранится артикул.
export async function settingsPage(client, { authId, settings, message = '', error = '', finishInstall = false }) {
  let catalogs = [];
  let loadError = '';
  try {
    catalogs = await loadCatalogs(client);
  } catch (e) {
    loadError = e.message;
  }
  const selected = new Set(settings.catalogIblockIds.map(Number));
  // Поле ещё не выбрано — предлагаем свойство «Артикул», если оно есть.
  let skuField = settings.skuField;
  if (!skuField) {
    const art = catalogs.flatMap((c) => c.properties)
      .find((p) => p.code === 'ARTNUMBER' || /артикул/i.test(p.name || ''));
    if (art) skuField = `property${art.id}`;
  }
  const opt = (value, label) =>
    `<option value="${esc(value)}"${skuField === value ? ' selected' : ''}>${esc(label)}</option>`;
  const catalogBoxes = catalogs.map((c) =>
    `<label><input type="checkbox" name="iblock" value="${esc(c.iblockId)}"${selected.has(Number(c.iblockId)) ? ' checked' : ''}>
${esc(c.name)} <small>(ID ${esc(c.iblockId)}${c.productIblockId ? ', торговые предложения' : ''})</small></label>`).join('<br>');
  const propGroups = catalogs.map((c) => c.properties.length
    ? `<optgroup label="Свойства: ${esc(c.name)}">${c.properties.map((p) =>
        opt(`property${p.id}`, `${p.name}${p.code ? ` (${p.code})` : ''}`)).join('')}</optgroup>`
    : '').join('');
  const known = !skuField
    || catalogs.some((c) => c.properties.some((p) => `property${p.id}` === skuField))
    || ['xmlId', 'code'].includes(skuField);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#333;max-width:720px}
fieldset{border:1px solid #ddd;border-radius:6px;margin:0 0 16px;padding:12px 16px}legend{font-weight:600}
select,input[type=text]{font:inherit;padding:4px 6px;min-width:320px}button{font:inherit;padding:6px 16px;background:#2fc6f6;border:0;border-radius:4px;color:#fff;cursor:pointer}
.ok{background:#e6f7e6;padding:8px 12px;border-radius:4px}.err{background:#fde8e8;padding:8px 12px;border-radius:4px}small{color:#777}
</style>${finishInstall ? '<script src="//api.bitrix24.com/api/v1/"></script><script>BX24.init(function(){ BX24.installFinish(); });</script>' : ''}
</head><body>
<h2>SKU Sync — настройки</h2>
<p>При изменении сделки приложение берёт артикул из названия товара (например <code>[SKU-123]</code>),
ищет товар с таким артикулом в каталоге и привязывает позицию сделки к нему.</p>
${message ? `<p class="ok">${esc(message)}</p>` : ''}${error ? `<p class="err">${esc(error)}</p>` : ''}
${loadError ? `<p class="err">Не удалось загрузить каталоги: ${esc(loadError)}</p>` : ''}
<form method="post" action="settings">
<input type="hidden" name="AUTH_ID" value="${esc(authId)}">
<fieldset><legend>Где искать товары</legend>${catalogBoxes || '<small>Каталоги не найдены</small>'}</fieldset>
<fieldset><legend>Где в товаре лежит артикул</legend>
<select name="skuField">
${skuField ? '' : '<option value="" selected disabled>— выберите поле —</option>'}
${known ? '' : opt(skuField, `${skuField} (текущее значение)`)}
${propGroups}
<optgroup label="Поля товара">${opt('xmlId', 'Внешний код (XML_ID)')}${opt('code', 'Символьный код (CODE)')}</optgroup>
</select></fieldset>
<fieldset><legend>Проверка (необязательно)</legend>
<input type="text" name="testSku" placeholder="Артикул, например SKU-123"><br>
<small>После сохранения приложение попробует найти товар с этим артикулом.</small></fieldset>
<button type="submit">Сохранить</button>
</form>
<p><small>Настройки хранятся на портале и не теряются при обновлении приложения. Изменять их может только администратор.</small></p>
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
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, installed: Boolean(tokens.load()?.access_token) }));
      }
      // Корень отвечает 200 для healthcheck платформы и подсказывает, как открыть приложение.
      if (req.method === 'GET' && APP_PATHS.has(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset="utf-8"><title>SKU Sync</title>' +
          '<p style="font:15px system-ui;margin:24px">SKU Sync работает. Откройте приложение из меню Битрикс24 ' +
          `(${esc(config.domain)}), чтобы настроить каталог.</p>`);
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      const raw = await readBody(req);
      const body = parse(req, raw);

      // Сохранение настроек со страницы приложения. Только для администраторов портала.
      if (url.pathname === '/settings') {
        const form = new URLSearchParams(raw);
        const authId = form.get('AUTH_ID') || '';
        const html = (opts) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(opts);
        };
        let isAdmin = false;
        try {
          isAdmin = (await client.callWithAuth(authId, 'user.admin')) === true;
        } catch {
          isAdmin = false;
        }
        if (!isAdmin) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<!doctype html><meta charset="utf-8"><p>Изменять настройки может только администратор портала. Откройте приложение заново.</p>');
        }
        let settings = await getSettings(client, config);
        let message = '';
        let error = '';
        try {
          settings = await saveSettings(client, authId, config, {
            catalogIblockIds: form.getAll('iblock'),
            skuField: form.get('skuField') || '',
          });
          message = 'Настройки сохранены.';
          log(`Настройки: каталоги ${settings.catalogIblockIds.join(',')}, поле ${settings.skuField}`);
          const testSku = (form.get('testSku') || '').trim();
          if (testSku) {
            const id = await findProductIdBySku(client, { ...config, ...settings }, testSku);
            message += id ? ` Проверка: артикул ${testSku} → товар ID ${id}.` : ` Проверка: товар с артикулом ${testSku} не найден.`;
          }
        } catch (e) {
          error = e.message;
        }
        return html(await settingsPage(client, { authId, settings, message, error }));
      }

      if (APP_PATHS.has(url.pathname)) {
        const event = String(body.event || '').toUpperCase();
        const appToken = body.auth?.application_token;

        // Установка или открытие приложения в портале (Б24 может открыть любой из путей
        // приложения). Сохраняем свежие токены — после передеплоя data/ пуст — и
        // убеждаемся, что подписка на OnCrmDealUpdate есть.
        const authId = body.AUTH_ID || (!event && body.auth?.access_token);
        if (!event && authId) {
          const info = await saveAuth(body, tokens);
          if (!info) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('No valid auth data');
          }
          let error = '';
          try {
            await bindEvent(client);
          } catch (e) {
            log('Ошибка event.bind:', e.message);
            error = `Не удалось подписаться на изменения сделок: ${e.message}`;
          }
          const finishInstall = url.pathname === '/install' || info.INSTALLED === false;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(await settingsPage(client, {
            authId,
            settings: await getSettings(client, config),
            error,
            finishInstall,
          }));
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
          enqueue(dealId, async () =>
            syncDeal(client, { ...config, ...(await getSettings(client, config)) }, dealId, (s) =>
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
  createServer({ client, tokens }).listen(config.port, () => {
    log(`Сервер слушает :${config.port}. Обработчик событий: ${config.publicUrl || '<PUBLIC_URL>'}/handler, установка: /install`);
  });
}
