import fs from 'node:fs';
import path from 'node:path';

// Хранит OAuth-токены и application_token, полученные при установке приложения.
export class TokenStore {
  constructor(dir) {
    this.file = path.join(dir, 'auth.json');
    this.dir = dir;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const merged = { ...(this.load() || {}), ...data };
    fs.writeFileSync(this.file, JSON.stringify(merged, null, 2), { mode: 0o600 });
    return merged;
  }
}
