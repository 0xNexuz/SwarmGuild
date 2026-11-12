import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rpcChain } from '../lib/chain.mjs';

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
