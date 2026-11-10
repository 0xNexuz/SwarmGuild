// Builds the transactions the site hands to a wallet. The site never holds a key: it prepares an unsigned
// transaction, and the visitor signs it in their own wallet or sends the printed near-cli command instead.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(text) {
  let n = 0n;
  for (const c of text) { const i = B58.indexOf(c); if (i < 0) throw new Error('Not base58.'); n = n * 58n + BigInt(i); }
  const bytes = []; while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of text) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
const le = (value, bytes) => { let n = BigInt(value); const out = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) { out[i] = Number(n & 255n); n >>= 8n; } return out; };
const text = s => { const b = new TextEncoder().encode(s); return [le(b.length, 4), b]; };
const concat = parts => { const flat = parts.flat(); const out = new Uint8Array(flat.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of flat) { out.set(p, at); at += p.length; } return out; };

/** Borsh bytes of a NEAR transaction with one FunctionCall action, exactly as near-api-js encodes it. */
export function encodeFunctionCallTx({ signerId, publicKey, nonce, receiverId, blockHash, method, args, gas, deposit }) {
  const key = base58Decode(publicKey.replace(/^ed25519:/, '')); const hash = base58Decode(blockHash);
  if (key.length !== 32 || hash.length !== 32) throw new Error('The public key and block hash must be 32 bytes.');
  const argBytes = new TextEncoder().encode(JSON.stringify(args));
  return concat([text(signerId), Uint8Array.of(0), key, le(nonce, 8), text(receiverId), hash,
    le(1, 4), Uint8Array.of(2), text(method), le(argBytes.length, 4), argBytes, le(gas, 8), le(deposit, 16)]);
}
export const toBase64 = bytes => btoa(String.fromCharCode(...bytes));

/** NEAR amount as typed ("0.3") to yoctoNEAR. */
export function nearToYocto(near) {
  if (!/^\d{1,6}(\.\d{1,24})?$/.test(String(near))) throw new Error('Give the amount as a decimal number of NEAR.');
  const [whole, frac = ''] = String(near).split('.');
  return BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, '0'));
}
export const TGAS = 10n ** 12n;
export const isAccountId = id => /^(?=.{2,64}$)[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/.test(id);

/** The call a visitor can send from a terminal instead of a wallet (near-cli-rs). */
export function cliCommand({ signerId, receiverId, method, args, gasTgas, depositNear }) {
  const json = JSON.stringify(args).replace(/'/g, `'\\''`);
  return `near contract call-function as-transaction ${receiverId} ${method} json-args '${json}' prepaid-gas '${gasTgas} Tgas' attached-deposit '${depositNear} NEAR' sign-as ${signerId} network-config testnet sign-with-keychain send`;
}

/** MyNearWallet's sign page: it shows the transaction and signs it with the visitor's own key. */
export const walletSignUrl = (walletBase, txBytes, callbackUrl) => {
  const url = new URL('sign', walletBase);
  url.searchParams.set('transactions', toBase64(txBytes));
  url.searchParams.set('callbackUrl', callbackUrl);
  return url.toString();
};

export const JOB_WINDOWS = { commit_window_ns: String(120n * 10n ** 9n), reveal_window_ns: String(90n * 10n ** 9n), work_window_ns: String(600n * 10n ** 9n) };
export const postJobCall = (guild, signerId, description, bountyNear) => ({ signerId, receiverId: guild, method: 'post_job', args: { description, ...JOB_WINDOWS }, gasTgas: 30, depositNear: bountyNear });
export const addAgentCall = (guild, signerId, { agent, name, model, specHash, specUrl }, depositNear) => ({ signerId, receiverId: guild, method: 'add_agent',
  args: { agent, name, model, spec_hash: specHash, spec_url: specUrl, hosted: true }, gasTgas: 30, depositNear });
export const withdrawCreditCall = (guild, signerId) => ({ signerId, receiverId: guild, method: 'withdraw_credit', args: {}, gasTgas: 50, depositNear: '0' });
/** The name a hosted agent gets: a slug of its manifest name under the backer's account. */
export const agentIdFor = (name, backer) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'}.${backer}`;
