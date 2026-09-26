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
