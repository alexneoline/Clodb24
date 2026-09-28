import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSku } from '../src/sku.js';
import { syncDeal } from '../src/dealSync.js';
import { parseNestedForm } from '../src/formParser.js';
import { createServer } from '../src/server.js';

const regex = /\[(SKU-[A-Za-z0-9._\/-]+)\]/i;
const config = { catalogIblockIds: [14], skuField: 'property105', skuRegex: regex };

function mockClient(rows, catalog) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'crm.deal.productrows.get') return rows;
      if (method === 'catalog.product.list') {
        const id = catalog[params.filter.property105];
        return { products: id ? [{ id, iblockId: 14 }] : [] };
      }
      if (method === 'crm.deal.productrows.set') return true;
      throw new Error(`unexpected ${method}`);
    },
  };
}

test('extractSku', () => {
  assert.equal(extractSku('Фильтр масляный [SKU-123]', regex), 'SKU-123');
  assert.equal(extractSku('[sku-12-AB.3] Датчик', regex), 'sku-12-AB.3');
  assert.equal(extractSku('Без артикула', regex), null);
  assert.equal(extractSku(null, regex), null);
});

test('parseNestedForm', () => {
  const body = 'event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=42&auth%5Bapplication_token%5D=tok';
  assert.deepEqual(parseNestedForm(body), {
    event: 'ONCRMDEALUPDATE',
    data: { FIELDS: { ID: '42' } },
    auth: { application_token: 'tok' },
  });
});

test('syncDeal подставляет PRODUCT_ID и сохраняет остальные позиции', async () => {
  const rows = [
    { ID: 1, OWNER_ID: 7, PRODUCT_ID: 0, PRODUCT_NAME: 'Видеорегистратор [SKU-100]', PRICE: 5000, QUANTITY: 2 },
    { ID: 2, OWNER_ID: 7, PRODUCT_ID: 0, PRODUCT_NAME: 'Доставка', PRICE: 300, QUANTITY: 1 },
    { ID: 3, OWNER_ID: 7, PRODUCT_ID: 0, PRODUCT_NAME: 'Кабель [SKU-404]', PRICE: 10, QUANTITY: 1 },
    { ID: 4, OWNER_ID: 7, PRODUCT_ID: 0, PRODUCT_NAME: 'Ещё регистратор [SKU-100]', PRICE: 4900, QUANTITY: 1 },
  ];
  const client = mockClient(rows, { 'SKU-100': 555 });
  const s = await syncDeal(client, config, 7);

  assert.equal(s.updated, true);
  assert.deepEqual(s.notFound, ['SKU-404']);
  assert.equal(s.changed.length, 2);
  // Кэш: каталог запрошен один раз на уникальный артикул
  assert.equal(client.calls.filter((c) => c.method === 'catalog.product.list').length, 2);

  const set = client.calls.find((c) => c.method === 'crm.deal.productrows.set');
  assert.equal(set.params.id, 7);
  assert.equal(set.params.rows.length, 4);
  assert.equal(set.params.rows[0].PRODUCT_ID, 555);
  assert.equal(set.params.rows[0].PRICE, 5000);
  assert.equal(set.params.rows[0].PRODUCT_NAME, 'Видеорегистратор [SKU-100]');
  assert.equal(set.params.rows[0].ID, undefined);
  assert.equal(set.params.rows[1].PRODUCT_NAME, 'Доставка');
  assert.equal(set.params.rows[3].PRODUCT_ID, 555);
});

test('syncDeal не вызывает set, если всё уже привязано (защита от зацикливания)', async () => {
  const rows = [{ PRODUCT_ID: 555, PRODUCT_NAME: 'Видеорегистратор [SKU-100]', PRICE: 5000, QUANTITY: 1 }];
  const client = mockClient(rows, { 'SKU-100': 555 });
  const s = await syncDeal(client, config, 7);
  assert.equal(s.updated, false);
  assert.ok(!client.calls.some((c) => c.method === 'crm.deal.productrows.set'));
});

test('обработчик событий проверяет application_token и запускает синхронизацию', async () => {
  const rows = [{ PRODUCT_ID: 0, PRODUCT_NAME: 'X [SKU-1]', PRICE: 1, QUANTITY: 1 }];
  const client = mockClient(rows, { 'SKU-1': 9 });
  let stored = { application_token: 'good' };
  const tokens = { load: () => stored, save: (d) => (stored = { ...stored, ...d }) };
  const { config: appConfig } = await import('../src/config.js');
  Object.assign(appConfig, config, { appToken: '' });

  const server = createServer({ client, tokens });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (token) =>
    fetch(`${base}/handler`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `event=ONCRMDEALUPDATE&data[FIELDS][ID]=77&auth[application_token]=${token}`,
    });

  assert.equal((await post('bad')).status, 403);
  assert.equal((await post('good')).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  server.close();

  const set = client.calls.find((c) => c.method === 'crm.deal.productrows.set');
  assert.equal(set.params.id, 77);
  assert.equal(set.params.rows[0].PRODUCT_ID, 9);
});

function settingsClient({ admin = true, options = {} } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'app.option.get') return options;
      if (method === 'catalog.catalog.list') return { catalogs: [{ iblockId: 14, name: 'Товары' }] };
      if (method === 'catalog.productProperty.list') return { productProperties: [{ id: 105, name: 'Артикул', code: 'ARTNUMBER' }] };
      if (method === 'catalog.product.list') return { products: params.filter.property105 === 'SKU-1' ? [{ id: 9 }] : [] };
      throw new Error(`unexpected ${method}`);
    },
    async callWithAuth(token, method, params) {
      calls.push({ method, params, token });
      if (method === 'user.admin') return admin;
      if (method === 'app.option.set') return true;
      throw new Error(`unexpected ${method}`);
    },
  };
}

test('settingsPage показывает каталоги и свойства с текущим выбором', async () => {
  const { settingsPage } = await import('../src/server.js');
  const html = await settingsPage(settingsClient(), {
    authId: 'tok',
    settings: { catalogIblockIds: [14], skuField: 'property105' },
  });
  assert.match(html, /name="iblock" value="14" checked/);
  assert.match(html, /<option value="property105" selected>Артикул \(ARTNUMBER\)<\/option>/);
  assert.match(html, /name="AUTH_ID" value="tok"/);
});

async function postSettings(client, body) {
  const { createServer } = await import('../src/server.js');
  const { resetSettingsCache } = await import('../src/settings.js');
  resetSettingsCache();
  const server = createServer({ client, tokens: { load: () => ({}), save() {} } });
  await new Promise((r) => server.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  server.close();
  return { status: res.status, text };
}

test('/settings сохраняет выбор администратора в опции приложения и проверяет артикул', async () => {
  const client = settingsClient();
  const { status, text } = await postSettings(client, 'AUTH_ID=tok&iblock=14&skuField=property105&testSku=SKU-1');
  assert.equal(status, 200);
  const set = client.calls.find((c) => c.method === 'app.option.set');
  assert.equal(set.token, 'tok');
  assert.deepEqual(set.params.options, { catalogIblockIds: '14', skuField: 'property105' });
  assert.match(text, /Настройки сохранены/);
  assert.match(text, /SKU-1 → товар ID 9/);

  const { getSettings } = await import('../src/settings.js');
  assert.deepEqual(await getSettings(client, config), { catalogIblockIds: [14], skuField: 'property105', source: 'portal' });
});

test('/settings отклоняет не-администратора и недопустимое поле', async () => {
  const client = settingsClient({ admin: false });
  assert.equal((await postSettings(client, 'AUTH_ID=tok&iblock=14&skuField=property105')).status, 403);
  assert.ok(!client.calls.some((c) => c.method === 'app.option.set'));

  const admin = settingsClient();
  const { text } = await postSettings(admin, 'AUTH_ID=tok&iblock=14&skuField=NAME');
  assert.match(text, /Недопустимое поле артикула/);
  assert.ok(!admin.calls.some((c) => c.method === 'app.option.set'));
});

test('getSettings берёт настройки портала, иначе значения из окружения', async () => {
  const { getSettings, resetSettingsCache } = await import('../src/settings.js');
  resetSettingsCache();
  const env = { catalogIblockIds: [], skuField: 'property105' };
  assert.deepEqual(await getSettings(settingsClient({ options: { catalogIblockIds: '14,20', skuField: 'xmlId' } }), env),
    { catalogIblockIds: [14, 20], skuField: 'xmlId', source: 'portal' });
  resetSettingsCache();
  const failing = { async call() { throw new Error('no tokens'); } };
  assert.deepEqual(await getSettings(failing, env), { catalogIblockIds: [], skuField: 'property105', source: 'env' });
});

test('открытие приложения по корню / сохраняет токены, подписывается и завершает установку', async () => {
  const { createServer } = await import('../src/server.js');
  const { resetSettingsCache } = await import('../src/settings.js');
  resetSettingsCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) =>
    String(url).includes('/rest/app.info.json')
      ? new Response(JSON.stringify({ result: { INSTALLED: false } }))
      : realFetch(url, opts);

  const client = settingsClient();
  const origCall = client.call;
  client.call = async (method, params) => {
    if (method === 'event.get') return [];
    if (method === 'event.bind') { client.calls.push({ method, params }); return true; }
    return origCall(method, params);
  };
  let stored = {};
  const server = createServer({ client, tokens: { load: () => stored, save: (d) => (stored = { ...stored, ...d }) } });
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/?DOMAIN=neoline.bitrix24.ru`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'AUTH_ID=tok&REFRESH_ID=ref&member_id=m1',
    });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(stored.access_token, 'tok');
    assert.equal(stored.refresh_token, 'ref');
    assert.ok(client.calls.some((c) => c.method === 'event.bind' && c.params.event === 'ONCRMDEALUPDATE'));
    assert.match(html, /SKU Sync — настройки/);
    assert.match(html, /BX24\.installFinish/);

    const get = await realFetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(get.status, 200);
    assert.match(await get.text(), /Откройте приложение из меню Битрикс24/);
  } finally {
    server.close();
    globalThis.fetch = realFetch;
  }
});
