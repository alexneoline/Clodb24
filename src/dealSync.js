import { extractSkus } from './sku.js';

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

/**
 * Ищет товар по артикулу в выбранных каталогах.
 * Возвращает { id } — найден ровно один товар, { ambiguous: [id, ...] } — несколько товаров
 * с одинаковым артикулом (не привязываем, чтобы не выбрать наугад), или null.
 */
export async function findProductBySku(client, config, sku) {
  if (!config.skuField) return null;
  for (const value of skuCandidates(sku)) {
    const ids = [];
    for (const iblockId of config.catalogIblockIds) {
      const result = await client.call('catalog.product.list', {
        select: ['id', 'iblockId', 'name'],
        filter: { iblockId, [config.skuField]: value },
        order: { id: 'asc' },
      });
      for (const p of result?.products || []) ids.push(Number(p.id));
    }
    if (ids.length === 1) return { id: ids[0] };
    if (ids.length > 1) return { ambiguous: ids };
  }
  return null;
}

/**
 * Привязывает позиции сделки к товарам каталога по артикулу из названия.
 * Возвращает { dealId, changed: [{index, sku, from, to}], notFound: [sku],
 *              ambiguous: [{sku, ids}], updated: bool }.
 */
export async function syncDeal(client, config, dealId, log = () => {}) {
  const rows = (await client.call('crm.deal.productrows.get', { id: dealId })) || [];
  const cache = new Map();
  const lookup = async (sku) => {
    if (!cache.has(sku)) cache.set(sku, await findProductBySku(client, config, sku));
    return cache.get(sku);
  };
  const changed = [];
  const notFound = [];
  const ambiguous = [];

  const newRows = [];
  for (const [index, row] of rows.entries()) {
    const out = toSetRow(row);
    const skus = extractSkus(row.PRODUCT_NAME, config.skuFormat);
    // Если в названии несколько подходящих скобок — берём первую, по которой есть товар.
    let match = null;
    for (const sku of skus) {
      const found = await lookup(sku);
      if (found?.id) { match = { sku, id: found.id }; break; }
      if (found?.ambiguous) ambiguous.push({ sku, ids: found.ambiguous });
    }
    if (match && Number(row.PRODUCT_ID) !== match.id) {
      changed.push({ index, sku: match.sku, from: Number(row.PRODUCT_ID) || 0, to: match.id });
      out.PRODUCT_ID = match.id;
    } else if (!match && skus.length && !ambiguous.some((a) => skus.includes(a.sku))) {
      notFound.push(skus.join(' / '));
    }
    newRows.push(out);
  }

  // Обновляем только при реальных изменениях — иначе productrows.set снова вызовет
  // OnCrmDealUpdate, и обработчик зациклится.
  if (changed.length) {
    await client.call('crm.deal.productrows.set', { id: dealId, rows: newRows });
  }
  const summary = { dealId, changed, notFound, ambiguous, updated: changed.length > 0 };
  log(summary);
  return summary;
}
