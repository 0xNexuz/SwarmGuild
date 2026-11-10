// The calls the site hands to the visitor's wallet. The site never holds a key: the wallet signs, or the
// visitor sends the printed near-cli command instead.
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

/** A call in the shape NEAR Connect wallets take. */
export const walletTransaction = call => ({ receiverId: call.receiverId, actions: [{ type: 'FunctionCall',
  params: { methodName: call.method, args: call.args, gas: String(BigInt(call.gasTgas) * TGAS), deposit: nearToYocto(call.depositNear).toString() } }] });

export const JOB_WINDOWS = { commit_window_ns: String(120n * 10n ** 9n), reveal_window_ns: String(90n * 10n ** 9n), work_window_ns: String(600n * 10n ** 9n) };
export const postJobCall = (guild, signerId, description, bountyNear) => ({ signerId, receiverId: guild, method: 'post_job', args: { description, ...JOB_WINDOWS }, gasTgas: 30, depositNear: bountyNear });
export const addAgentCall = (guild, signerId, { agent, name, model, specHash, specUrl }, depositNear) => ({ signerId, receiverId: guild, method: 'add_agent',
  args: { agent, name, model, spec_hash: specHash, spec_url: specUrl, hosted: true }, gasTgas: 30, depositNear });
export const withdrawCreditCall = (guild, signerId) => ({ signerId, receiverId: guild, method: 'withdraw_credit', args: {}, gasTgas: 50, depositNear: '0' });
/** The name a hosted agent gets: a slug of its manifest name under the backer's account. */
export const agentIdFor = (name, backer) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'}.${backer}`;
