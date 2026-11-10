// Creates the deployment's owner account on NEAR Testnet through the public faucet service, which funds it.
// The private key is written to the keys folder and never printed. Sends no transaction of its own.
//   node scripts/create-owner.mjs --keys-dir <folder outside the repository>
// Run it again to check the balance: it reuses the owner it already made and never creates a second one.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { ensureKey } from '../lib/chain.mjs';
import { yoctoToNear, nearToYocto } from '../lib/market.mjs';
import { keysDir, main, parseArgs, testnet } from './common.mjs';

// The faucet service near-cli uses for `create-account sponsor-by-faucet-service`, then the older address.
const FAUCETS = ['https://helper.nearprotocol.com/account', 'https://helper.testnet.near.org/account'];
const OWNER = /^swarmguild-[0-9a-f]{8}\.testnet$/;
const NEEDED = nearToYocto('8.85') + nearToYocto('1.15'); // the three setup stages, then four job bounties

main(async () => {
  const { flags } = parseArgs();
  const dir = keysDir(flags);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).map(f => f.replace(/\.json$/, '')).filter(name => OWNER.test(name));
  if (existing.length > 1) throw new Error(`The keys folder holds more than one owner key (${existing.join(', ')}). Keep one.`);
  const owner = existing[0] ?? `swarmguild-${randomBytes(4).toString('hex')}.testnet`;
  const publicKey = ensureKey(dir, owner);
  const chain = await testnet(flags, { signing: false });
  let account = await chain.account(owner);
  const tried = [];
  if (!account.found) {
    for (const url of FAUCETS) {
      let status;
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ newAccountId: owner, newAccountPublicKey: publicKey }), signal: AbortSignal.timeout(60000) });
        status = `HTTP ${response.status} ${(await response.text()).slice(0, 200)}`;
      } catch (error) { status = error.message; }
      tried.push({ url, status });
      for (let i = 0; i < 10 && !account.found; i++) { await new Promise(r => setTimeout(r, 3000)); account = await chain.account(owner); }
      if (account.found) break;
    }
  }
  if (!account.found) throw new Error(`The faucet did not create ${owner}. ${JSON.stringify(tried)}. The key file is kept, so running this again retries the same name.`);
  const keys = await chain.keys(owner);
  const fullAccess = keys.some(k => k.publicKey === publicKey && k.permission === 'FullAccess');
  console.log(JSON.stringify({ owner, publicKey, fullAccessKeyOnChain: fullAccess, balanceNear: yoctoToNear(account.balanceYocto),
    enoughForSetupAndJobs: BigInt(account.balanceYocto) >= NEEDED, neededNear: yoctoToNear(NEEDED), faucet: tried }, null, 2));
  if (!fullAccess) process.exitCode = 1;
});
