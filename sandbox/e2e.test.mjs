// The real contract WASM on a local NEAR Sandbox chain, driven by the same setup stages, runner and
// verifier that are used on Testnet. Only NEAR AI is replaced, by a stand-in that signs like the real TEE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';
import { actions, ensureKey, rpcChain } from '../lib/chain.mjs';
import { loadManifests, manifestHash } from '../lib/manifest.mjs';
import { nearToYocto as N } from '../lib/market.mjs';
import { forgetAttestations } from '../lib/near-ai.mjs';
import { createRunner, fileStore } from '../lib/runner.mjs';
import { buildPlan, checkDeployment, runStage, STAGES } from '../lib/setup.mjs';
import { nearAccountTool } from '../lib/tools.mjs';
import { verifyJob } from '../lib/verify.mjs';
import { createWorker } from '../lib/worker.mjs';
import { fakeCloud } from '../tests/fake-cloud.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmFile = process.env.SWARMGUILD_WASM ?? path.join(here, '../contracts/swarm/target/wasm32-unknown-unknown/release/swarmguild.wasm');
const agentsDir = path.join(here, '../agents');

test('SwarmGuild on NEAR Sandbox: deploy, run jobs, add an outside agent, verify', { timeout: 900_000 }, async t => {
  const worker = await Worker.init();
  t.after(() => worker.tearDown());
  const root = worker.rootAccount; const owner = root.accountId;
  const nodeUrl = worker.provider.connection.url;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmguild-'));
  const keysDir = path.join(tmp, 'keys'); fs.mkdirSync(keysDir);
  const saveKey = async account => { const pair = await account.getKey(); fs.writeFileSync(path.join(keysDir, `${account.accountId}.json`),
    JSON.stringify({ account_id: account.accountId, public_key: pair.getPublicKey().toString(), private_key: pair.toString() })); };
  await saveKey(root);
  const alice = await root.createSubAccount('alice', { initialBalance: (N('5')).toString() });
  await saveKey(alice);

  const wasm = fs.readFileSync(wasmFile);
  const plan = buildPlan({ networkId: 'sandbox', owner, wasm, agentsDir, rawBase: 'https://example.test', publicKeyOf: id => ensureKey(keysDir, id) });
  const intents = [];
  const chain = await rpcChain({ networkId: 'sandbox', nodeUrl, keysDir, onSigned: i => intents.push(i) });

  await t.test('three stages deploy it, and running them again sends nothing', async () => {
    for (const stage of STAGES) {
      const first = await runStage(stage, plan, chain, { wasm });
      assert.ok(first.every(s => s.txHash), `${stage} sends its transactions`);
      const again = await runStage(stage, plan, chain, { wasm });
      assert.ok(again.length === first.length && again.every(s => s.skipped), `${stage} is idempotent`);
    }
    const checks = await checkDeployment(plan, chain);
    assert.deepEqual(checks.filter(c => !c.ok), []);
    assert.ok(checks.length >= 3 + plan.accounts.length + plan.agents.length);
  });

  await t.test('an agent key can call its three methods and nothing else', async () => {
    const summarizer = `summarizer.${owner}`;
    await assert.rejects(chain.call(summarizer, plan.guild, 'withdraw_agent', { agent: summarizer, amount: '1' }), e => e.refused === true, 'a method outside the key is refused by the node');
    await assert.rejects(chain.send(summarizer, owner, [actions.transfer(1n)]), e => e.refused === true, 'the key cannot move NEAR');
    await assert.rejects(chain.call(summarizer, plan.guild, 'review', { job_id: 0, pass: true, report_hash: 'a'.repeat(64), note: '' }), e => e.refused === true);
    await assert.rejects(chain.call(`rev-quality.${owner}`, plan.guild, 'commit_bid', { job_id: 0, commitment: 'a'.repeat(64), agent: null }), e => e.refused === true, 'a reviewer key cannot bid');
    await assert.rejects(chain.call(plan.operator, plan.guild, 'withdraw_agent', { agent: summarizer, amount: '1' }), e => e.refused === true, 'the operator key cannot withdraw an agent\'s balance');
  });

  const workers = loadManifests(path.join(agentsDir, 'workers')); const reviewers = loadManifests(path.join(agentsDir, 'reviewers'));
  const aliceManifest = Buffer.from(JSON.stringify({ name: 'Limerick bot', model: 'z-ai/glm-5.3-flash', prompt: 'You write one limerick about the topic.', skills: ['limerick'], pricing: { floorNear: '0.05' } }));
  const published = new Map(); // what an independent agent has made public, by URL
  const cloud = fakeCloud(request => (request.messages[0].content.includes('You are reviewing another AI agent') ? '{"pass": true, "reasons": ["Does the job."]}' : '- Accounts have names.\n- Keys can be limited.'));
  forgetAttestations();
  const store = fileStore({ evidenceDir: path.join(tmp, 'evidence'), secretsFile: path.join(keysDir, 'bid-secrets.json') });
  const runner = createRunner({ chain, guild: plan.guild, operator: plan.operator, store,
    manifests: new Map(workers.map(w => [w.hash, w.manifest])),
    reviewers: reviewers.map(r => ({ account: `rev-${r.slug}.${owner}`, manifest: r.manifest })),
    ai: { apiKey: 'placeholder-test-key-not-real', fetchImpl: cloud.fetchImpl, delay: async () => {}, tools: { near_account: nearAccountTool(chain) } },
    resultUrl: id => `https://example.test/jobs/${id}.json`, fetchImpl: async url => new Response(published.get(url) ?? aliceManifest), log: line => console.log(line) });
  const windows = { commitSeconds: 25, revealSeconds: 25, workSeconds: 300 };
  const agent = id => chain.view(plan.guild, 'get_agent', { agent: id });
  const verified = async jobId => {
    const results = await verifyJob(store.readJob(jobId), chain, { guild: plan.guild });
    assert.deepEqual(results.filter(r => !r.ok), []);
    return results.length;
  };

  await t.test('a summary job is bid on by a keyed and a hosted agent, done, reviewed and paid', async () => {
    const jobId = await runner.postJob(owner, 'Summarize this brief: NEAR accounts have names and keys can be limited. Give a summary.', N('0.3'), windows);
    assert.equal((await runner.runJob(jobId)).status, 'Paid');
    const job = await chain.view(plan.guild, 'get_job', { job_id: jobId });
    assert.equal(job.winner, `summarizer.${owner}`);
    assert.deepEqual([...job.bidders].sort(), [`explainer.${owner}`, `summarizer.${owner}`]);
    const s = await agent(`summarizer.${owner}`);
    assert.equal(BigInt(s.earned), BigInt(job.price) - BigInt(job.price) / 10n);
    assert.ok(BigInt(s.inference_spent) > 0n && s.locked === '0' && s.jobs_paid === 1);
    assert.equal(await chain.view(plan.guild, 'get_credit', { account: owner }), (N('0.3') - BigInt(job.price)).toString());
    assert.ok(await verified(jobId) > 12);
  });

  await t.test('work changed after signing is rejected on chain and the bond pays the reviewers', async () => {
    const jobId = await runner.postJob(owner, 'Write a haiku about sealed bids.', N('0.2'), windows);
    assert.equal((await runner.runJob(jobId)).status, 'Rejected');
    const lab = await agent(`tamper-lab.${owner}`);
    assert.equal(lab.jobs_failed, 1); assert.equal(lab.earned, '0'); assert.equal(lab.locked, '0');
    await verified(jobId);
  });

  await t.test('an outsider adds a hosted agent with one transaction and it wins, is paid, and only its backer can cash out', async () => {
    await chain.call(alice.accountId, plan.guild, 'add_agent', { agent: `limerick.${alice.accountId}`, name: 'Limerick bot', model: 'z-ai/glm-5.3-flash',
      spec_hash: manifestHash(aliceManifest), spec_url: 'https://example.test/limerick.json', hosted: true }, { depositYocto: N('0.2') });
    const jobId = await runner.postJob(alice.accountId, 'Write a limerick about sealed bids.', N('0.2'), windows);
    assert.equal((await runner.runJob(jobId)).status, 'Paid');
    const bot = await agent(`limerick.${alice.accountId}`);
    assert.ok(BigInt(bot.earned) > 0n && BigInt(bot.inference_spent) > 0n);
    await verified(jobId);
    await assert.rejects(chain.call(owner, plan.guild, 'withdraw_agent', { agent: `limerick.${alice.accountId}`, amount: bot.balance }), /ONLY_BACKER/);
    await chain.call(alice.accountId, plan.guild, 'withdraw_agent', { agent: `limerick.${alice.accountId}`, amount: bot.balance });
    const before = BigInt((await chain.account(alice.accountId)).balanceYocto);
    await chain.call(alice.accountId, plan.guild, 'withdraw_credit', {}, { gasTgas: 50 });
    assert.ok(BigInt((await chain.account(alice.accountId)).balanceYocto) > before + BigInt(bot.balance) - N('0.01'), 'the NEAR arrived in the backer\'s account');
  });

  await t.test('an independent agent with its own key and process outbids the house Auditor, is paid, and is billed nothing', async () => {
    const bob = await root.createSubAccount('bob', { initialBalance: (N('5')).toString() });
    const bobKeys = path.join(tmp, 'bob-keys'); fs.mkdirSync(bobKeys);
    const pair = await bob.getKey();
    fs.writeFileSync(path.join(bobKeys, `${bob.accountId}.json`), JSON.stringify({ account_id: bob.accountId, public_key: pair.getPublicKey().toString(), private_key: pair.toString() }));
    const bobChain = await rpcChain({ networkId: 'sandbox', nodeUrl, keysDir: bobKeys });
    assert.equal(chain.canSign(bob.accountId), false, 'the swarm\'s runner holds no key for it');
    const bytes = fs.readFileSync(path.join(agentsDir, 'examples', 'contract-auditor.json')); const manifest = JSON.parse(bytes);
    await bobChain.call(bob.accountId, plan.guild, 'add_agent', { agent: bob.accountId, name: 'Bob\'s auditor', model: manifest.model, spec_hash: manifestHash(bytes), spec_url: '', hosted: false }, { depositYocto: N('0.3') });
    const worker = createWorker({ chain: bobChain, guild: plan.guild, account: bob.accountId, manifest,
      ai: { apiKey: 'bobs-own-placeholder-key', fetchImpl: cloud.fetchImpl, delay: async () => {}, tools: { near_account: nearAccountTool(bobChain) } },
      store: fileStore({ evidenceDir: path.join(tmp, 'bob-evidence'), secretsFile: path.join(bobKeys, 'bid-secrets.json') }),
      publish: async (jobId, payload) => { const url = `https://bob.example/swarmguild/job-${jobId}.json`; published.set(url, JSON.stringify(payload)); return url; },
      log: line => console.log(`[bob] ${line}`) });
    const jobId = await runner.postJob(owner, `Security audit of the near-sdk contract at ${plan.guild}: who can call withdraw_credit?`, N('0.3'), windows);
    const serve = (async () => { for (;;) { const step = await worker.tick(jobId); if (step.done) return step; await new Promise(r => setTimeout(r, 1500)); } })();
    const [end, mine] = await Promise.all([runner.runJob(jobId), serve]);
    assert.equal(end.status, 'Paid'); assert.equal(mine.submitted, true);
    const job = await chain.view(plan.guild, 'get_job', { job_id: jobId });
    assert.deepEqual([...job.bidders].sort(), [`auditor.${owner}`, bob.accountId].sort(), 'a real price contest on chain');
    assert.equal(job.winner, bob.accountId);
    assert.equal(job.work.result_url, `https://bob.example/swarmguild/job-${jobId}.json`);
    const me = await agent(bob.accountId);
    assert.equal(me.inference_spent, '0', 'it paid for its own model call, so the operator billed it nothing');
    assert.equal(BigInt(me.earned), BigInt(job.price) - BigInt(job.price) / 10n); assert.equal(me.jobs_paid, 1);
    assert.equal(store.readJob(jobId).work.independent, true);
    await verified(jobId);
  });

  await t.test('the operator and the reviewers can withdraw what they earned, and the contract still covers everything it owes', async () => {
    const operatorCredit = BigInt(await chain.view(plan.guild, 'get_credit', { account: plan.operator }));
    assert.ok(operatorCredit > 0n, 'inference charges accrued to the operator');
    await chain.call(plan.operator, plan.guild, 'withdraw_credit', {}, { gasTgas: 50 });
    assert.equal(await chain.view(plan.guild, 'get_credit', { account: plan.operator }), '0');
    const agents = await chain.view(plan.guild, 'get_agents', { from: 0, limit: 100 });
    const owed = agents.reduce((sum, [, a]) => sum + BigInt(a.balance) + BigInt(a.locked), 0n)
      + BigInt(await chain.view(plan.guild, 'get_credit', { account: owner })) + BigInt(await chain.view(plan.guild, 'get_credit', { account: alice.accountId }));
    const guild = await chain.account(plan.guild);
    assert.ok(BigInt(guild.balanceYocto) - BigInt(guild.storageUsage) * 10n ** 19n >= owed, 'balance above the storage stake covers every agent balance and credit');
    assert.ok(intents.length > 30 && intents.every(i => i.txHash && i.signerId), 'every transaction was announced before it was sent');
  });
});
