// Tools an agent's manifest can ask for. A tool runs before the model call and its output is handed to the
// model as data, never as instructions. Everything here is read from public chain state.

/** The names a WASM module exports as functions: for a NEAR contract, the methods anyone can try to call. */
export function wasmExports(bytes) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100) return [];
  let p = 8;
  const leb = () => { let value = 0, shift = 0, byte; do { byte = bytes[p++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80 && p < bytes.length); return value; };
  while (p < bytes.length) {
    const section = bytes[p++]; const size = leb(); const end = p + size;
    if (section !== 7) { p = end; continue; } // 7 is the export section
    const names = [];
    for (let n = leb(); n > 0 && p < end; n--) {
      const length = leb(); const name = bytes.toString('utf8', p, p + length); p += length;
      const kind = bytes[p++]; leb();
      if (kind === 0) names.push(name); // 0 is a function
    }
    return names;
  }
  return [];
}

const SAFE_NAME = /^[A-Za-z0-9_]{1,64}$/; // export names come from whoever deployed the contract, so only plain identifiers reach the model
const MAX_METHODS = 80, MAX_KEYS = 6;

/**
 * `near_account`: what anyone can see about a NEAR account. Its balance and code hash, who holds keys to it and
 * what each key may do, and, if it is a contract, the methods it exposes. `chain` is lib/chain.mjs.
 */
export function nearAccountTool(chain) {
  return async accountId => {
    const account = await chain.account(accountId);
    if (!account.found) return { found: false };
    const out = { found: true, balanceYocto: account.balanceYocto, storageUsageBytes: account.storageUsage, hasContract: account.hasContract, codeHash: account.codeHash };
    try {
      const keys = await chain.keys(accountId);
      const limited = keys.filter(k => k.permission !== 'FullAccess').map(k => k.permission.FunctionCall ?? {});
      out.accessKeys = { fullAccess: keys.length - limited.length, functionCallOnly: limited.length,
        functionCallKeys: limited.slice(0, MAX_KEYS).map(k => ({ canCall: k.receiver_id, methods: (k.method_names ?? []).filter(m => SAFE_NAME.test(m)).slice(0, 12), anyMethod: !(k.method_names ?? []).length })) };
    } catch { out.accessKeys = { error: 'lookup failed' }; }
    if (account.hasContract) {
      try {
        const names = wasmExports(await chain.code(accountId)).filter(n => SAFE_NAME.test(n) && !n.startsWith('__'));
        out.contractMethods = { count: names.length, names: names.slice(0, MAX_METHODS) };
      } catch { out.contractMethods = { error: 'lookup failed' }; }
    }
    return out;
  };
}
