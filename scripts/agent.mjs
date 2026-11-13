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
//   node scripts/agent.mjs serve    --manifest <file> --publish-dir <clone> [--minutes 30] [--price 0.05] [--name "My agent"] --approve-testnet-run
//       All of the above in one step, with no keys folder: the key is derived from the secret phrase in AGENT_SEED,
//       or from your NEAR AI key if you set no phrase, so the same secret is always the same account. The account is an implicit one (64 hex characters) that
//       exists once anyone sends it NEAR. Unfunded, this prints the address to fund and stops. Funded, it registers
//       once and serves. The "My agent" GitHub workflow runs exactly this in a fork.
//
// Use --account <id> if the keys folder holds more than one key file.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureKey, keyFromSeed, rpcChain } from '../lib/chain.mjs';
import { manifestHash, parseManifest } from '../lib/manifest.mjs';
import { nearToYocto, yoctoToNear } from '../lib/market.mjs';
import { attestedKeys } from '../lib/near-ai.mjs';
import { gitPublisher } from '../lib/publish.mjs';
import { fileStore } from '../lib/runner.mjs';
import { nearAccountTool } from '../lib/tools.mjs';
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

// Shown in the terminal and, in a GitHub workflow, on the run's summary page.
function tell(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
}

async function register(c, plan, account, manifest, hash, flags) {
  const already = await c.view(plan.guild, 'get_agent', { agent: account });
  if (already) return { account, registered: true, balanceNear: yoctoToNear(already.balance), note: 'Already registered. Nothing sent.' };
  const r = await c.call(account, plan.guild, 'add_agent', { agent: account, name: typeof flags.name === 'string' && flags.name.trim() ? flags.name.trim() : manifest.name, model: manifest.model, spec_hash: hash,
    spec_url: typeof flags.url === 'string' ? flags.url : '', hosted: false }, { depositYocto: nearToYocto(flags.deposit ?? '0.3') });
  return { account, registered: true, txHash: r.txHash, depositNear: String(flags.deposit ?? '0.3'), skills: manifest.skills };
}

async function run(c, plan, account, manifest, flags, stateDir) {
  if (typeof flags['publish-dir'] !== 'string') throw new Error('Name a clone of a public GitHub repository with --publish-dir. Your work is committed and pushed there, where the reviewers read it.');
  const apiKey = nearAiKey();
  if (!c.canSign(account)) throw new Error(`There is no key for ${account}.`);
  if (!await c.view(plan.guild, 'get_agent', { agent: account })) throw new Error(`${account} is not registered yet. Run the register command first.`);
  const ai = { apiKey, tools: { near_account: nearAccountTool(c) } };
  await attestedKeys(manifest.model, ai); // fail early if NEAR AI is unreachable or the key is wrong
  const worker = createWorker({ chain: c, guild: plan.guild, account, manifest, ai, publish: gitPublisher(path.resolve(flags['publish-dir'])),
    store: fileStore({ evidenceDir: stateDir, secretsFile: path.join(stateDir, 'bid-secrets.json') }),
    price: typeof flags.price === 'string' && flags.price.trim() ? () => nearToYocto(flags.price.trim()) : null, log: line => console.log(line) });
  const minutes = Number(flags.minutes ?? 60);
  tell(`${account} is serving ${plan.guild} for ${minutes} minutes. It bids on jobs that mention: ${manifest.skills.join(', ')}`);
  const served = await worker.watch({ minutes });
  tell(served.length ? `Served: ${served.map(j => `job ${j.jobId} (${j.submitted ? 'won, work submitted' : j.won ? 'won' : 'bid, did not win'})`).join(', ')}.` : 'No job it could bid on was posted while it was serving.');
  console.log(JSON.stringify({ served }));
}

main(async () => {
  const { flags, words } = parseArgs(); const command = words[0];
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS certificate checks must stay on.');
  const chainWith = keys => rpcChain({ networkId: 'testnet', nodeUrl: RPC_URLS[0], fallbackUrls: RPC_URLS.slice(1), txUrls: ARCHIVAL_URLS, keysDir: keys });

  if (command === 'serve') {
    if (flags['approve-testnet-run'] !== true) throw new Error('This sends Testnet transactions and spends your NEAR AI credit. Add --approve-testnet-run.');
    const { manifest, hash } = readManifest(flags); const plan = readPlan(); nearAiKey(); // stop before anything is sent if the key is missing
    const keys = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmguild-agent-')); // the key lives only for this run; the phrase rebuilds it
    try {
      // With no phrase of its own, the agent's key is derived from the NEAR AI key, which is already a secret only
      // its owner holds. Nothing about that key can be read back from the agent's account.
      const seed = (process.env.AGENT_SEED ?? '').trim() || `from-near-ai-key:${createHash('sha256').update(`swarmguild-agent-seed:${nearAiKey()}`).digest('hex')}`;
      const account = keyFromSeed(keys, seed);
      const c = await chainWith(keys);
      const [state, agent] = [await c.account(account), await c.view(plan.guild, 'get_agent', { agent: account })];
      const needYocto = nearToYocto(agent ? '0.05' : '0.5'); // the first run pays a 0.3 NEAR deposit that backs its bid bonds
      if (!state.found || BigInt(state.balanceYocto) < needYocto) {
        tell(`**Your agent's account needs test NEAR before it can start.**\n\nSend ${agent ? '0.2' : '1'} NEAR on **Testnet** from any wallet (Meteor works) to this address, then run this again:\n\n\`${account}\`\n\nIt holds ${state.found ? yoctoToNear(state.balanceYocto) : '0'} NEAR now.`);
        if (process.env.GITHUB_ACTIONS) console.log(`::warning::Not started. Send test NEAR to ${account} and run again.`);
        return;
      }
      const reg = await register(c, plan, account, manifest, hash, flags);
      tell(reg.txHash ? `Registered ${account} as an agent: https://testnet.nearblocks.io/txns/${reg.txHash}` : `${account} is already registered.`);
      await run(c, plan, account, manifest, flags, keys);
    } finally { fs.rmSync(keys, { recursive: true, force: true }); }
    return;
  }

  const dir = keysDir(flags);
  const chain = () => chainWith(dir);

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
    console.log(JSON.stringify(await register(await chain(), plan, account, manifest, hash, flags)));
    return;
  }

  if (command === 'run') {
    if (flags['approve-testnet-run'] !== true) throw new Error('This sends Testnet transactions and spends your NEAR AI credit. Add --approve-testnet-run.');
    await run(await chain(), plan, account, manifest, flags, dir);
    return;
  }
  throw new Error('Usage: node scripts/agent.mjs init | register | run | serve. The top of this file lists the flags.');
});
