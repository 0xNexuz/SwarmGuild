// The one place that talks to a NEAR RPC node. Every transaction's hash is reported before it is sent,
// and a transaction counts as done only when it is final and no receipt failed.
import fs from 'node:fs';
import path from 'node:path';
import { connect, keyStores, KeyPair, transactions, utils } from 'near-api-js';

export const TGAS = 10n ** 12n;
export const DEFAULT_GAS_TGAS = 30;
export class ChainError extends Error {
  constructor(message, detail = {}) { super(message); Object.assign(this, detail); }
}

/** Reads `<keysDir>/<account>.json` files: { account_id, public_key, private_key }. Keys never leave this process. */
export function readKeys(keysDir) {
  const keys = new Map();
  if (!keysDir || !fs.existsSync(keysDir)) return keys;
  for (const file of fs.readdirSync(keysDir).filter(f => f.endsWith('.json'))) {
    const k = JSON.parse(fs.readFileSync(path.join(keysDir, file), 'utf8'));
    if (k.account_id && k.private_key) keys.set(k.account_id, KeyPair.fromString(k.private_key));
  }
  return keys;
}

/** Creates a key file for `accountId` if there is none, and returns the public key. The private key is never returned. */
export function ensureKey(keysDir, accountId) {
  const file = path.join(keysDir, `${accountId}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).public_key;
  const pair = KeyPair.fromRandom('ed25519');
  fs.mkdirSync(keysDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: pair.getPublicKey().toString(), private_key: pair.toString() }) + '\n', { flag: 'wx', mode: 0o600 });
  return pair.getPublicKey().toString();
}

const failureOf = outcome => outcome?.status?.Failure
  ?? outcome?.transaction_outcome?.outcome?.status?.Failure
  ?? outcome?.receipts_outcome?.map(r => r.outcome?.status?.Failure).find(Boolean) ?? null;
/** The contract's own error word (for example COMMIT_CLOSED) from a failed outcome, or the raw failure. */
export function failureText(failure) {
  const text = JSON.stringify(failure);
  return /Smart contract panicked: ([^"\\]+)/.exec(text)?.[1] ?? text;
}

export async function rpcChain({ networkId, nodeUrl, fallbackUrls = [], keysDir, onSigned = () => {}, txUrls = [] }) {
  const keys = readKeys(keysDir);
  const keyStore = new keyStores.InMemoryKeyStore();
  for (const [accountId, pair] of keys) await keyStore.setKey(networkId, accountId, pair);
  const near = await connect({ networkId, nodeUrl, keyStore });
  const provider = near.connection.provider;

  async function rpcOnce(method, params, url, timeoutMs = 30000) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'swarmguild', method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new ChainError(`RPC returned HTTP ${response.status}`, { httpStatus: response.status });
    return response.json();
  }
  /** One read. A node that is busy, rate-limiting or unreachable is retried, then the next node is tried. */
  async function rpc(method, params, url = null) {
    const urls = url ? [url] : [nodeUrl, ...fallbackUrls];
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { return await rpcOnce(method, params, urls[attempt % urls.length]); }
      catch (error) { last = error; if (error.httpStatus && error.httpStatus < 500 && error.httpStatus !== 429 && error.httpStatus !== 408) throw error; }
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
    throw last;
  }
  const query = async params => {
    const payload = await rpc('query', { finality: 'final', ...params });
    if (payload.error) throw new ChainError(payload.error.cause?.name ?? payload.error.message ?? 'RPC query failed', { rpcError: payload.error });
    if (payload.result?.error) throw new ChainError(payload.result.error);
    return payload.result;
  };

  /**
   * Looks a transaction up, trying the main node and then any archival nodes. Returns null if none has it final.
   * Ordinary nodes drop transactions after a few days and then wait a long time before answering "unknown", so the
   * node that last had one is asked first: a recheck of old jobs settles on an archival node after one slow lookup.
   */
  let txNode = null;
  async function tx(txHash, signerId, { timeoutMs = 30000 } = {}) {
    const all = [nodeUrl, ...fallbackUrls, ...txUrls];
    for (const url of txNode ? [txNode, ...all.filter(u => u !== txNode)] : all) {
      try {
        const payload = await rpcOnce('tx', { tx_hash: txHash, sender_account_id: signerId, wait_until: 'FINAL' }, url, timeoutMs);
        if (payload.result?.final_execution_status === 'FINAL') { txNode = url; return payload.result; }
      } catch { /* try the next node */ }
    }
    return null;
  }

  async function send(signerId, receiverId, actions, label = '') {
    if (!keys.has(signerId)) throw new ChainError(`No key for ${signerId} in the keys folder.`);
    const account = await near.account(signerId);
    const [hashBytes, signed] = await account.signTransaction(receiverId, actions);
    const txHash = utils.serialize.base_encode(hashBytes);
    onSigned({ txHash, signerId, receiverId, label });
    let outcome;
    try {
      outcome = await provider.sendTransactionUntil(signed, 'FINAL');
    } catch (error) {
      // A transaction the node refused outright was never included. Anything else may still land, so look it up.
      const refused = /InvalidTx|InvalidAccessKey|access key|MethodNameMismatch|ReceiverMismatch|RequiresFullAccess|NotEnough|InvalidNonce|Expired|InvalidSignature|LackBalance/i.test(`${error.type ?? ''} ${error.message}`);
      if (refused) throw new ChainError(`${label || 'Transaction'} was refused before inclusion: ${error.message}`, { txHash, refused: true });
      for (let attempt = 0; attempt < 10 && !outcome; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        outcome = await tx(txHash, signerId);
      }
      if (!outcome) throw new ChainError(`${label || 'Transaction'} ${txHash} could not be confirmed final: ${error.message}`, { txHash, unknown: true });
    }
    const failure = failureOf(outcome);
    if (failure) throw new ChainError(`${label || 'Transaction'} failed: ${failureText(failure)}`, { txHash, failed: true, reason: failureText(failure) });
    const raw = outcome.status?.SuccessValue;
    let value = null;
    if (raw) { try { value = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { value = null; } }
    return { txHash, value, outcome };
  }

  return {
    networkId, nodeUrl, send, tx,
    canSign: accountId => keys.has(accountId),
    publicKey: accountId => keys.get(accountId)?.getPublicKey().toString() ?? null,
    call: (signerId, contract, method, args, { depositYocto = 0n, gasTgas = DEFAULT_GAS_TGAS } = {}) =>
      send(signerId, contract, [transactions.functionCall(method, args, BigInt(gasTgas) * TGAS, BigInt(depositYocto))], method),
    async view(contract, method, args = {}) {
      const result = await query({ request_type: 'call_function', account_id: contract, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
      return JSON.parse(Buffer.from(result.result).toString('utf8'));
    },
    async account(accountId) {
      try {
        const a = await query({ request_type: 'view_account', account_id: accountId });
        return { found: true, balanceYocto: a.amount, codeHash: a.code_hash, storageUsage: a.storage_usage,
          hasContract: a.code_hash !== '11111111111111111111111111111111' };
      } catch (error) {
        if (/UNKNOWN_ACCOUNT|does not exist/i.test(`${error.message} ${JSON.stringify(error.rpcError ?? '')}`)) return { found: false };
        throw error;
      }
    },
    /** The WASM deployed at an account, or an empty buffer if it has none. */
    async code(accountId) {
      const result = await query({ request_type: 'view_code', account_id: accountId });
      return Buffer.from(result.code_base64 ?? '', 'base64');
    },
    async keys(accountId) {
      const result = await query({ request_type: 'view_access_key_list', account_id: accountId });
      return result.keys.map(k => ({ publicKey: k.public_key, permission: k.access_key.permission }));
    },
    async nowNs() {
      const payload = await rpc('block', { finality: 'final' });
      if (!payload.result) throw new ChainError('Could not read the latest block.');
      return BigInt(payload.result.header.timestamp_nanosec);
    },
  };
}

export const actions = {
  createAccount: () => transactions.createAccount(),
  transfer: yocto => transactions.transfer(BigInt(yocto)),
  deploy: wasm => transactions.deployContract(wasm),
  functionCall: (method, args, gasTgas = DEFAULT_GAS_TGAS, depositYocto = 0n) => transactions.functionCall(method, args, BigInt(gasTgas) * TGAS, BigInt(depositYocto)),
  addFunctionCallKey: (publicKey, receiverId, methods, allowanceYocto) =>
    transactions.addKey(utils.PublicKey.fromString(publicKey), transactions.functionCallAccessKey(receiverId, methods, BigInt(allowanceYocto))),
};
export const base58 = bytes => utils.serialize.base_encode(bytes);
