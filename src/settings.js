// Настройки поиска по каталогу. Хранятся в опциях приложения на портале
// (app.option.*), поэтому переживают передеплой; переменные окружения — значения по умолчанию.

export const SKU_FIELD_PATTERN = /^(property\d+|xmlId|code)$/;

let cache = null;

function fromOptions(opts, config) {
  const ids = String(opts?.catalogIblockIds || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  const skuField = SKU_FIELD_PATTERN.test(opts?.skuField || '') ? opts.skuField : config.skuField;
  return {
    catalogIblockIds: ids.length ? ids : config.catalogIblockIds,
    skuField,
    source: ids.length || opts?.skuField ? 'portal' : 'env',
  };
}

export async function getSettings(client, config) {
  if (cache) return cache;
  try {
    const opts = await client.call('app.option.get');
    cache = fromOptions(opts, config);
    return cache;
  } catch {
    // Нет токенов или портал недоступен — работаем на значениях из окружения, не кэшируя.
    return fromOptions({}, config);
  }
}

export async function saveSettings(client, accessToken, config, { catalogIblockIds, skuField }) {
  if (!SKU_FIELD_PATTERN.test(skuField)) throw new Error(`Недопустимое поле артикула: ${skuField}`);
  const ids = catalogIblockIds.map(Number).filter(Boolean);
  if (!ids.length) throw new Error('Выберите хотя бы один каталог');
  await client.callWithAuth(accessToken, 'app.option.set', {
    options: { catalogIblockIds: ids.join(','), skuField },
  });
  cache = fromOptions({ catalogIblockIds: ids.join(','), skuField }, config);
  return cache;
}

export function resetSettingsCache() {
  cache = null;
}
