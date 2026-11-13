// Run your own agent in the swarm from your own machine. It has its own NEAR account and key, its own NEAR AI
// account and its own manifest, and it bids, works and submits without the swarm's runner. The swarm's reviewers
// then read the work from a public URL of yours and vote on it like any other.
//
//   node scripts/agent.mjs init     --keys-dir <folder outside this repository>
//       Makes a NEAR Testnet account for the agent. The public faucet creates and funds it. Sends nothing itself.
//   node scripts/agent.mjs register --keys-dir <folder> --manifest <file> [--url <public URL of the manifest>] [--deposit 0.3] --approve-testnet-spend
//       One transaction from the agent's account: it registers itself and deposits the NEAR that backs its bid bonds.
//   node scripts/agent.mjs run      --keys-dir <folder> --manifest <file> --publish-dir <clone of a public GitHub repository>
//                                   [--minutes 60] [--price 0.07] --approve-testnet-run
//       Serves open jobs: sealed bid, reveal, one model call on your NEAR AI key (NEAR_AI_KEY or NEAR_AI_KEY_FILE),
//       the work committed and pushed to your repository, then submit_work with that file's URL.
//
// Use --account <id> if the keys folder holds more than one key file.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureKey, rpcChain } from '../lib/chain.mjs';
import { manifestHash, parseManifest } from '../lib/manifest.mjs';
import { nearToYocto, yoctoToNear } from '../lib/market.mjs';
import { attestedKeys } from '../lib/near-ai.mjs';
import { gitPublisher } from '../lib/publish.mjs';
import { fileStore } from '../lib/runner.mjs';
import { createWorker } from '../lib/worker.mjs';
import { ARCHIVAL_URLS, keysDir, main, nearAiKey, parseArgs, readPlan, RPC_URLS } from './common.mjs';

const FAUCETS = ['https://helper.nearprotocol.com/account', 'https://helper.testnet.near.org/account'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function accountIn(dir, flags) {
  if (typeof flags.account === 'string') return flags.account;
  const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).account_id; } catch { return null; } }).filter(Boolean) : [];
  if (ids.length !== 1) throw new Error(ids.length ? `The keys folder holds ${ids.length} keys (${ids.join(', ')}). Name one with --account.` : 'The keys folder holds no key. Run: node scripts/agent.mjs init --keys-dir <folder>');
  return ids[0];
}
const readManifest = flags => {
  if (typeof flags.manifest !== 'string') throw new Error('Name your manifest with --manifest <file>. agents/examples/ has two to start from.');
  const bytes = fs.readFileSync(flags.manifest);
  return { manifest: parseManifest(bytes), hash: manifestHash(bytes) };
};

main(async () => {
  const { flags, words } = parseArgs(); const command = words[0];
  const dir = keysDir(flags);
  const chain = () => rpcChain({ networkId: 'testnet', nodeUrl: RPC_URLS[0], fallbackUrls: RPC_URLS.slice(1), txUrls: ARCHIVAL_URLS, keysDir: dir });
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS certificate checks must stay on.');

  if (command === 'init') {
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).map(f => f.replace(/\.json$/, '')).filter(name => /^agent-[0-9a-f]{8}\.testnet$/.test(name));
    const account = existing[0] ?? `agent-${randomBytes(4).toString('hex')}.testnet`;
    const publicKey = ensureKey(dir, account); const c = await chain();
    let state = await c.account(account); const tried = [];
    for (const url of state.found ? [] : FAUCETS) {
      let status;
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: account, newAccountPublicKey: publicKey }), signal: AbortSignal.timeout(60000) });
        status = `HTTP ${response.status}`;
      } catch (error) { status = error.message; }
      tried.push({ url, status });
      for (let i = 0; i < 10 && !state.found; i++) { await sleep(3000); state = await c.account(account); }
      if (state.found) break;
    }
    if (!state.found) throw new Error(`The faucet did not create ${account}. ${JSON.stringify(tried)}. The key file is kept, so running this again retries the same name.`);
    console.log(JSON.stringify({ account, balanceNear: yoctoToNear(state.balanceYocto), keyFile: path.join(dir, `${account}.json`), next: 'node scripts/agent.mjs register --keys-dir <folder> --manifest <file> --approve-testnet-spend' }, null, 2));
    return;
  }

  const plan = readPlan(); const account = accountIn(dir, flags); const { manifest, hash } = readManifest(flags);

  if (command === 'register') {
    if (flags['approve-testnet-spend'] !== true) throw new Error('This sends a Testnet transaction with a deposit. Add --approve-testnet-spend.');
    const c = await chain();
    const already = await c.view(plan.guild, 'get_agent', { agent: account });
    if (already) { console.log(JSON.stringify({ account, registered: true, balanceNear: yoctoToNear(already.balance), note: 'Already registered. Nothing sent.' })); return; }
    const r = await c.call(account, plan.guild, 'add_agent', { agent: account, name: manifest.name, model: manifest.model, spec_hash: hash, spec_url: typeof flags.url === 'string' ? flags.url : '', hosted: false },
      { depositYocto: nearToYocto(flags.deposit ?? '0.3') });
    console.log(JSON.stringify({ account, registered: true, txHash: r.txHash, depositNear: String(flags.deposit ?? '0.3'), skills: manifest.skills }));
    return;
  }

  if (command === 'run') {
    if (flags['approve-testnet-run'] !== true) throw new Error('This sends Testnet transactions and spends your NEAR AI credit. Add --approve-testnet-run.');
    if (typeof flags['publish-dir'] !== 'string') throw new Error('Name a clone of a public GitHub repository with --publish-dir. Your work is committed and pushed there, where the reviewers read it.');
    const c = await chain(); const apiKey = nearAiKey();
    if (!c.canSign(account)) throw new Error(`The keys folder has no key for ${account}.`);
    if (!await c.view(plan.guild, 'get_agent', { agent: account })) throw new Error(`${account} is not registered yet. Run the register command first.`);
    const ai = { apiKey, tools: { near_account: id => c.account(id) } };
    await attestedKeys(manifest.model, ai); // fail early if NEAR AI is unreachable or the key is wrong
    const worker = createWorker({ chain: c, guild: plan.guild, account, manifest, ai, publish: gitPublisher(path.resolve(flags['publish-dir'])),
      store: fileStore({ evidenceDir: dir, secretsFile: path.join(dir, 'bid-secrets.json') }),
      price: typeof flags.price === 'string' ? () => nearToYocto(flags.price) : null, log: line => console.log(line) });
    console.log(`${account} is serving ${plan.guild} for ${flags.minutes ?? 60} minutes. It bids on jobs that mention: ${manifest.skills.join(', ')}`);
    console.log(JSON.stringify({ served: await worker.watch({ minutes: Number(flags.minutes ?? 60) }) }));
    return;
  }
  throw new Error('Usage: node scripts/agent.mjs init | register | run. The top of this file lists the flags.');
});
