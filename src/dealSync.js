import { extractSku } from './sku.js';

// Поля позиции, которые передаются обратно в crm.deal.productrows.set.
// Метод перезаписывает ВСЕ позиции сделки, поэтому переносим их целиком.
const ROW_FIELDS = [
  'PRODUCT_ID', 'PRODUCT_NAME', 'PRICE', 'PRICE_EXCLUSIVE', 'PRICE_NETTO', 'PRICE_BRUTTO',
  'QUANTITY', 'DISCOUNT_TYPE_ID', 'DISCOUNT_RATE', 'DISCOUNT_SUM', 'TAX_RATE', 'TAX_INCLUDED',
  'CUSTOMIZED', 'MEASURE_CODE', 'MEASURE_NAME', 'SORT',
];

export function toSetRow(row) {
  const out = {};
  for (const f of ROW_FIELDS) if (row[f] !== undefined && row[f] !== null) out[f] = row[f];
  return out;
}

// Варианты значения для поиска: как в названии («SKU-8808060009108») и без префикса
// («8808060009108») — в каталоге артикул часто хранится без «SKU-».
export function skuCandidates(sku) {
  const bare = String(sku).replace(/^SKU-/i, '');
  return bare && bare !== sku ? [sku, bare] : [sku];
}

export async function findProductIdBySku(client, config, sku) {
  if (!config.skuField) return null;
  for (const value of skuCandidates(sku)) {
    for (const iblockId of config.catalogIblockIds) {
      const result = await client.call('catalog.product.list', {
        select: ['id', 'iblockId', 'name'],
        filter: { iblockId, [config.skuField]: value },
        order: { id: 'asc' },
      });
      const product = result?.products?.[0];
      if (product) return Number(product.id);
    }
  }
  return null;
}

/**
 * Привязывает позиции сделки к товарам каталога по артикулу из названия.
 * Возвращает { dealId, changed: [{index, sku, from, to}], notFound: [sku], updated: bool }.
 */
export async function syncDeal(client, config, dealId, log = () => {}) {
  const rows = (await client.call('crm.deal.productrows.get', { id: dealId })) || [];
  const cache = new Map();
  const changed = [];
  const notFound = [];

  const newRows = [];
  for (const [index, row] of rows.entries()) {
    const out = toSetRow(row);
    const sku = extractSku(row.PRODUCT_NAME, config.skuRegex);
    if (sku) {
      if (!cache.has(sku)) cache.set(sku, await findProductIdBySku(client, config, sku));
      const productId = cache.get(sku);
      if (!productId) {
        notFound.push(sku);
      } else if (Number(row.PRODUCT_ID) !== productId) {
        changed.push({ index, sku, from: Number(row.PRODUCT_ID) || 0, to: productId });
        out.PRODUCT_ID = productId;
      }
    }
    newRows.push(out);
  }

  // Обновляем только при реальных изменениях — иначе productrows.set снова вызовет
  // OnCrmDealUpdate, и обработчик зациклится.
  if (changed.length) {
    await client.call('crm.deal.productrows.set', { id: dealId, rows: newRows });
  }
  const summary = { dealId, changed, notFound, updated: changed.length > 0 };
  log(summary);
  return summary;
}
