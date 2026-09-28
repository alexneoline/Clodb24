// Форматы артикула в названии товара. Посторонний текст в скобках («[Wi-Fi]», «[2 шт]»)
// ни под один формат не подходит.
const SKU_PREFIXED = /\[\s*(SKU-[^\]\s]+)\s*\]/gi; // [SKU-8808060009108]
const DIGITS = /\[\s*(\d{4,})\s*\]/g; // [8808060009108]

export const SKU_FORMATS = {
  sku_or_digits: { label: '[SKU-…] или [цифры]', patterns: [SKU_PREFIXED, DIGITS] },
  sku: { label: 'Только [SKU-…]', patterns: [SKU_PREFIXED] },
  digits: { label: 'Только [цифры]', patterns: [DIGITS] },
};
export const DEFAULT_SKU_FORMAT = 'sku_or_digits';

// Все артикулы-кандидаты из названия в порядке появления:
// «Регистратор [Wi-Fi] [8808060009108]» → ["8808060009108"].
export function extractSkus(name, format = DEFAULT_SKU_FORMAT) {
  if (!name) return [];
  const { patterns } = SKU_FORMATS[format] || SKU_FORMATS[DEFAULT_SKU_FORMAT];
  const found = [];
  for (const re of patterns) {
    for (const m of String(name).matchAll(re)) found.push({ at: m.index, sku: m[1] });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.sku))];
}
