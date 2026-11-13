import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { keyFromSeed, readKeys, rpcChain } from '../lib/chain.mjs';

/** A stand-in RPC node that answers `tx` with `reply(hash)` and counts the calls it gets. */
async function node(reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      const { params } = JSON.parse(body); calls.push(params.tx_hash);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: 'x', ...reply(params.tx_hash) }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(resolve => server.close(resolve)) };
}

test('a transaction lookup remembers the node that has the history, so old jobs are rechecked without waiting on the others', async () => {
  const unknown = () => ({ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
  const main = await node(unknown), fallback = await node(unknown);
  const archival = await node(hash => ({ result: { final_execution_status: 'FINAL', transaction: { hash } } }));
  try {
    const chain = await rpcChain({ networkId: 'testnet', nodeUrl: main.url, fallbackUrls: [fallback.url], txUrls: [archival.url], keysDir: null });
    assert.equal((await chain.tx('old-1', 'a.testnet')).transaction.hash, 'old-1');
    assert.deepEqual([main.calls.length, fallback.calls.length, archival.calls.length], [1, 1, 1], 'the first lookup tries each node in order');
    for (const hash of ['old-2', 'old-3']) assert.equal((await chain.tx(hash, 'a.testnet')).transaction.hash, hash);
    assert.deepEqual([main.calls.length, fallback.calls.length, archival.calls.length], [1, 1, 3], 'later lookups go straight to the node that answered');
  } finally { await Promise.all([main.close(), fallback.close(), archival.close()]); }
});

test('a transaction no node has is reported as not found, and a node that never answers is given up on', async () => {
  const unknown = () => ({ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
  const main = await node(unknown);
  const silent = http.createServer(() => { /* never answers, like a node holding a request open */ });
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  try {
    const chain = await rpcChain({ networkId: 'testnet', nodeUrl: `http://127.0.0.1:${silent.address().port}`, fallbackUrls: [main.url], keysDir: null });
    const started = Date.now();
    assert.equal(await chain.tx('missing', 'a.testnet', { timeoutMs: 300 }), null);
    assert.ok(Date.now() - started < 5000, 'the silent node was abandoned at its timeout');
  } finally { silent.closeAllConnections(); await Promise.all([main.close(), new Promise(resolve => silent.close(resolve))]); }
});

test('a secret phrase always gives the same agent key, and its account is the implicit one that key names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmguild-seed-'));
  try {
    const account = keyFromSeed(dir, '  a phrase long enough to be a key, 0123  ');
    assert.match(account, /^[0-9a-f]{64}$/);
    assert.equal(keyFromSeed(dir, 'a phrase long enough to be a key, 0123'), account, 'the same phrase, trimmed, is the same account');
    assert.notEqual(keyFromSeed(dir, 'a phrase long enough to be a key, 0124'), account);
    const pair = readKeys(dir).get(account);
    assert.equal(Buffer.from(pair.getPublicKey().data).toString('hex'), account, 'the account id is the public key in hex, which is what NEAR creates on a first transfer');
    const message = new TextEncoder().encode('swarmguild'); assert.ok(pair.verify(message, pair.sign(message).signature));
    assert.throws(() => keyFromSeed(dir, 'too short'), /at least 24 characters/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
