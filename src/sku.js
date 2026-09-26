// Извлекает артикул из названия товара: "Фильтр масляный [SKU-123-A]" → "SKU-123-A".
export function extractSku(name, regex) {
  if (!name) return null;
  const m = String(name).match(regex);
  return m ? m[1].trim() : null;
}
