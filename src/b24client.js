// REST-клиент Битрикс24 с тремя способами авторизации: oauth, webhook, vibe.

export class B24Error extends Error {
  constructor(method, code, description) {
    super(`${method}: ${code}${description ? ` — ${description}` : ''}`);
    this.code = code;
  }
}

export class B24Client {
  constructor(config, tokenStore, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.tokens = tokenStore;
    this.fetch = fetchImpl;
  }

  async call(method, params = {}, retried = false) {
    const { url, headers } = this.endpoint(method);
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(params),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new B24Error(method, `HTTP_${res.status}`, 'ответ не JSON');
    }
    if (body.error) {
      if (!retried && this.config.transport === 'oauth' && ['expired_token', 'invalid_token'].includes(body.error)) {
        await this.refreshToken();
        return this.call(method, params, true);
      }
      throw new B24Error(method, body.error, body.error_description);
    }
    if (!res.ok) throw new B24Error(method, `HTTP_${res.status}`);
    return body.result;
  }

  // Вызов от имени конкретного пользователя (токен из фрейма приложения).
  async callWithAuth(accessToken, method, params = {}) {
    const res = await this.fetch(
      `https://${this.config.domain}/rest/${method}.json?auth=${encodeURIComponent(accessToken)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
    );
    const body = await res.json();
    if (body.error) throw new B24Error(method, body.error, body.error_description);
    return body.result;
  }

  endpoint(method) {
    const { transport } = this.config;
    if (transport === 'webhook') {
      if (!this.config.webhookUrl) throw new Error('B24_WEBHOOK_URL не задан');
      return { url: `${this.config.webhookUrl.replace(/\/+$/, '')}/${method}.json`, headers: {} };
    }
    if (transport === 'vibe') {
      if (!this.config.vibeApiKey) throw new Error('VIBE_API_KEY не задан');
      return {
        url: `${this.config.vibeApiUrl}/${method}`,
        headers: { [this.config.vibeAuthHeader]: this.config.vibeApiKey },
      };
    }
    const auth = this.tokens.load();
    if (!auth?.access_token) throw new Error('Приложение не установлено: нет access_token (откройте приложение в Б24)');
    const endpoint = (auth.client_endpoint || `https://${auth.domain || this.config.domain}/rest/`).replace(/\/+$/, '');
    return { url: `${endpoint}/${method}.json?auth=${encodeURIComponent(auth.access_token)}`, headers: {} };
  }

  async refreshToken() {
    const auth = this.tokens.load();
    if (!auth?.refresh_token) throw new Error('Нет refresh_token — переустановите приложение');
    const qs = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: auth.refresh_token,
    });
    const res = await this.fetch(`https://oauth.bitrix.info/oauth/token/?${qs}`);
    const body = await res.json();
    if (body.error) throw new B24Error('oauth.refresh', body.error, body.error_description);
    this.tokens.save({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      client_endpoint: body.client_endpoint || auth.client_endpoint,
      expires: body.expires,
    });
  }
}
