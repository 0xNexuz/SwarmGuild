import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = file => fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

test('the live page reads the contract named in the deployment plan', () => {
  const plan = JSON.parse(read('deployment/testnet.json'));
  const guild = /export const GUILD = '([^']+)'/.exec(read('site/live.mjs'))[1];
  assert.equal(guild, plan.guild);
  assert.ok(read('README.md').includes(plan.guild));
});

test('the page keeps the simulation and the live data apart', () => {
  const html = read('site/index.html'), live = read('site/live.mjs'), app = read('site/app.mjs');
  assert.match(html, /data-view="live"/); assert.match(html, /data-view="simulation"/);
  assert.match(app, /Simulation: no chain, no model calls/);
  assert.ok(!/from '\.\/sim\.mjs'/.test(live), 'the live code never imports the simulation');
  const simulation = html.slice(html.indexOf('id="view-simulation"'));
  for (const id of ['live-jobs', 'post-form', 'agent-form', 'real-flight']) assert.ok(html.includes(`id="${id}"`) && !simulation.includes(`id="${id}"`), `${id} is outside the simulation page`);
  assert.ok(!/private_key|secretKey|KeyPair/.test(live + read('site/tx.mjs')), 'the site has no code that holds a key');
  assert.match(read('site/vendor/near-connect.js').slice(0, 200), /@hot-labs\/near-connect 0\.12\.0, MIT/);
});

test('the call handed to the wallet is the contract call the form describes', async () => {
  const { walletTransaction, postJobCall, addAgentCall, nearToYocto } = await import('../site/tx.mjs');
  const tx = walletTransaction(postJobCall('guild.example.testnet', 'alice.testnet', 'Summarize: it\'s "quoted" ✓', '0.3'));
  assert.equal(tx.receiverId, 'guild.example.testnet');
  assert.deepEqual(tx.actions.map(a => a.type), ['FunctionCall']);
  const p = tx.actions[0].params;
  assert.equal(p.methodName, 'post_job'); assert.equal(p.deposit, '300000000000000000000000'); assert.equal(p.gas, '30000000000000');
  assert.equal(p.args.description, 'Summarize: it\'s "quoted" ✓'); assert.equal(p.args.commit_window_ns, '120000000000');
  const add = walletTransaction(addAgentCall('guild.example.testnet', 'alice.testnet', { agent: 'bot.alice.testnet', name: 'Bot', model: 'm', specHash: 'a'.repeat(64), specUrl: 'https://x.test/a.json' }, '0.2')).actions[0].params;
  assert.equal(add.methodName, 'add_agent'); assert.equal(add.args.hosted, true); assert.equal(add.deposit, nearToYocto('0.2').toString());
  assert.throws(() => nearToYocto('1e3')); assert.throws(() => nearToYocto('-1'));
});

test('the printed near-cli command survives quotes in the job text, and agent names are namespaced under the backer', async () => {
  const { cliCommand, postJobCall, agentIdFor, isAccountId } = await import('../site/tx.mjs');
  const command = cliCommand(postJobCall('guild.example.testnet', 'alice.testnet', "it's a job", '0.2'));
  assert.match(command, /json-args '\{"description":"it'\\''s a job"/);
  assert.match(command, /attached-deposit '0\.2 NEAR' sign-as alice\.testnet network-config testnet/);
  assert.equal(agentIdFor('Limerick Bot!', 'alice.testnet'), 'limerick-bot.alice.testnet');
  assert.ok(isAccountId('alice.testnet') && !isAccountId('Alice.testnet') && !isAccountId('a b.testnet') && !isAccountId('x'));
});

test('the site and the runner decide bids with the same rule', async () => {
  const site = await import('../site/bid-rule.mjs'); const runner = await import('../lib/agents.mjs');
  assert.equal(runner.decideBid, site.decideBid);
  const limerick = JSON.parse(read('agents/examples/limerick-bot.json')); const summarizer = JSON.parse(read('agents/workers/summarizer.json'));
  const job = { description: 'Write a limerick about sealed bids', bounty: '200000000000000000000000' }, funded = { balance: '200000000000000000000000' };
  assert.equal(site.decideBid(summarizer, job, funded).bid, false); // why Testnet job 5 was cancelled: no agent on chain had the skill
  assert.equal(site.decideBid(limerick, job, funded).bid, true);
  assert.equal(site.decideBid(limerick, job, { balance: '1' }).bid, false);
  assert.equal(site.decideBid(limerick, { ...job, bounty: '1' }, funded).bid, false);
});

test('the example manifests pass the rules, and the example auditor underbids the house Auditor on an audit', async () => {
  const { manifestProblems } = await import('../site/manifest-rules.mjs'); const { decideBid } = await import('../site/bid-rule.mjs');
  for (const name of ['limerick-bot', 'contract-auditor']) assert.deepEqual(manifestProblems(JSON.parse(read(`agents/examples/${name}.json`))), [], name);
  const job = { description: 'Security audit of two methods from the near-sdk contract deployed at guild.example.testnet.', bounty: '200000000000000000000000' }, funded = { balance: '200000000000000000000000' };
  const mine = decideBid(JSON.parse(read('agents/examples/contract-auditor.json')), job, funded), house = decideBid(JSON.parse(read('agents/workers/auditor.json')), job, funded);
  assert.ok(mine.bid && house.bid, 'both auditors bid, so the job shows a real price contest');
  assert.ok(mine.priceYocto < house.priceYocto);
});

test('adaptive pricing: one step up per win, one down per loss, between the base price and the ceiling', async () => {
  const { decideBid, auctionHistory, adaptiveSteps } = await import('../site/bid-rule.mjs'); const { manifestProblems } = await import('../site/manifest-rules.mjs');
  const m = JSON.parse(read('agents/examples/adaptive-summarizer.json')); assert.deepEqual(manifestProblems(m), []);
  const job = { description: 'Summarize this text.', bounty: '300000000000000000000000' }, funded = { balance: '500000000000000000000000' };
  const at = history => Number(decideBid(m, job, funded, history).priceYocto / 10n ** 21n);
  assert.equal(at([]), 40); assert.equal(at([true]), 44); assert.equal(at([true, true, false]), 44); assert.equal(at([false, false, false]), 40, 'never below its base price');
  assert.equal(at(Array(30).fill(true)), 120, 'never above its ceiling');
  assert.equal(adaptiveSteps([true, true, false, false, false, true]), 1);
  assert.equal(Number(decideBid(m, { ...job, bounty: '50000000000000000000000' }, funded, Array(5).fill(true)).priceYocto / 10n ** 21n), 50, 'a small bounty is taken at the bounty, not refused');
  assert.equal(decideBid(m, { ...job, bounty: '30000000000000000000000' }, funded, []).bid, false);
  // Its history is read from the chain: only auctions it bid in that had a winner, oldest first.
  const jobs = [{ id: 0, bidders: ['a', 'b'], winner: 'a' }, { id: 1, bidders: ['b'], winner: 'b' }, { id: 2, bidders: ['a'], winner: null }, { id: 3, bidders: ['a', 'b'], winner: 'b' }, { id: 4, bidders: ['a'], winner: 'a' }];
  assert.deepEqual(auctionHistory(jobs, 'a', 4), [true, false]); assert.deepEqual(auctionHistory(jobs, 'a', 9), [true, false, true]);
  // A fixed-price manifest is untouched by history, and an adaptive one must name a ceiling at or above its floor.
  const fixed = JSON.parse(read('agents/workers/summarizer.json'));
  assert.equal(decideBid(fixed, job, funded, [true, true, true]).priceYocto, decideBid(fixed, job, funded).priceYocto);
  assert.ok(manifestProblems({ ...m, pricing: { floorNear: '0.04', adaptive: true } }).some(p => p.includes('ceilingNear')));
  assert.ok(manifestProblems({ ...m, pricing: { floorNear: '0.04', ceilingNear: '0.03', adaptive: true } }).some(p => p.includes('ceilingNear')));
});
