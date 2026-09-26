// Разбор application/x-www-form-urlencoded с вложенными ключами вида data[FIELDS][ID]=5,
// в таком формате Битрикс24 присылает события и данные установки.
export function parseNestedForm(body) {
  const result = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const parts = rawKey.split(/[[\]]+/).filter((p, i) => p !== '' || i === 0);
    let node = result;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = value;
      else node = node[part] = typeof node[part] === 'object' ? node[part] : {};
    });
  }
  return result;
}
