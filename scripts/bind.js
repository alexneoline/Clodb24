// Ручная подписка на OnCrmDealUpdate (например, после смены PUBLIC_URL).
import { config } from '../src/config.js';
import { TokenStore } from '../src/tokenStore.js';
import { B24Client } from '../src/b24client.js';
import { bindEvent } from '../src/server.js';

const client = new B24Client(config, new TokenStore(config.dataDir));
bindEvent(client).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
