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
});

test('the site encodes a transaction byte for byte as near-api-js does', async () => {
  const { transactions, utils, KeyPair } = await import('near-api-js');
  const { encodeFunctionCallTx, postJobCall, nearToYocto, TGAS, base58Decode } = await import('../site/tx.mjs');
  const publicKey = KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const blockHash = utils.serialize.base_encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
  for (const [description, bounty, nonce] of [['Summarize: it\'s "quoted" — ünïcödé ✓', '0.3', 1], ['x'.repeat(2000), '123.000000000000000000000001', 2n ** 53n + 5n]]) {
    const call = postJobCall('guild.example.testnet', 'alice.testnet', description, bounty);
    const mine = encodeFunctionCallTx({ signerId: call.signerId, publicKey, nonce, receiverId: call.receiverId, blockHash, method: call.method, args: call.args, gas: 30n * TGAS, deposit: nearToYocto(bounty) });
    const theirs = transactions.createTransaction(call.signerId, utils.PublicKey.fromString(publicKey), call.receiverId, nonce,
      [transactions.functionCall(call.method, call.args, 30n * TGAS, nearToYocto(bounty))], utils.serialize.base_decode(blockHash)).encode();
    assert.deepEqual(Buffer.from(mine), Buffer.from(theirs));
  }
  assert.deepEqual(Buffer.from(base58Decode('11111111111111111111111111111111')), Buffer.alloc(32));
  assert.throws(() => nearToYocto('1e3')); assert.throws(() => nearToYocto('-1'));
});

test('the printed near-cli command survives quotes in the job text, and agent names are namespaced under the backer', async () => {
  const { cliCommand, postJobCall, agentIdFor, isAccountId, walletSignUrl } = await import('../site/tx.mjs');
  const command = cliCommand(postJobCall('guild.example.testnet', 'alice.testnet', "it's a job", '0.2'));
  assert.match(command, /json-args '\{"description":"it'\\''s a job"/);
  assert.match(command, /attached-deposit '0\.2 NEAR' sign-as alice\.testnet network-config testnet/);
  assert.equal(agentIdFor('Limerick Bot!', 'alice.testnet'), 'limerick-bot.alice.testnet');
  assert.ok(isAccountId('alice.testnet') && !isAccountId('Alice.testnet') && !isAccountId('a b.testnet') && !isAccountId('x'));
  const url = new URL(walletSignUrl('https://testnet.mynearwallet.com/', Uint8Array.of(1, 2, 3), 'https://swarmguild.vercel.app/#live'));
  assert.equal(url.origin + url.pathname, 'https://testnet.mynearwallet.com/sign');
  assert.equal(url.searchParams.get('transactions'), 'AQID'); assert.equal(url.searchParams.get('callbackUrl'), 'https://swarmguild.vercel.app/#live');
});
