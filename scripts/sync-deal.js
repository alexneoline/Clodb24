// Разовая синхронизация сделки: npm run sync -- 123
import { config } from '../src/config.js';
import { TokenStore } from '../src/tokenStore.js';
import { B24Client } from '../src/b24client.js';
import { syncDeal } from '../src/dealSync.js';

const dealId = Number(process.argv[2]);
if (!dealId) {
  console.error('Использование: npm run sync -- <ID сделки>');
  process.exit(1);
}
const client = new B24Client(config, new TokenStore(config.dataDir));
syncDeal(client, config, dealId)
  .then((s) => console.log(JSON.stringify(s, null, 2)))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
