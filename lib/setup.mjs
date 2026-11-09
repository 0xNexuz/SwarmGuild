// The Testnet deployment, as a plan anyone can read and three stages that each check the chain first,
// so running a stage twice never sends a transaction twice.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { actions, base58 } from './chain.mjs';
import { loadManifests } from './manifest.mjs';
import { nearToYocto } from './market.mjs';

export const STAGES = ['deploy', 'accounts', 'agents'];
export const METHODS = {
  operator: ['charge_inference', 'commit_bid', 'reveal_bid', 'submit_work', 'award', 'expire', 'withdraw_credit'],
  worker: ['commit_bid', 'reveal_bid', 'submit_work'],
  reviewer: ['review'],
};
// Two workers have their own account and key. Two are hosted: no account, the operator acts from their manifest.
const KEYED_WORKERS = ['auditor', 'summarizer'];
const FUNDING = { auditor: '0.3', summarizer: '0.3', explainer: '0.3', 'tamper-lab': '0.15' };

/** Everything public about the deployment. `publicKeyOf(accountId)` supplies each new account's key. */
export function buildPlan({ networkId, owner, wasm, agentsDir, rawBase, publicKeyOf }) {
  const sub = name => `${name}.${owner}`;
  const guild = sub('guild');
  const digest = createHash('sha256').update(wasm).digest();
  const account = (id, role, balanceNear, allowanceNear) => ({ id, role, publicKey: publicKeyOf(id), balanceNear, allowanceNear, methods: METHODS[role] });
  const workers = loadManifests(path.join(agentsDir, 'workers'));
  const reviewers = loadManifests(path.join(agentsDir, 'reviewers'));
  const agent = (kind, role, m, id, hosted, fundingNear) => ({ id, role, name: m.manifest.name, model: m.manifest.model,
    manifest: `agents/${kind}/${m.file}`, specHash: m.hash, specUrl: `${rawBase}/agents/${kind}/${m.file}`, hosted, fundingNear });
  return {
    network: networkId, owner, guild, operator: sub('operator'),
    reviewers: reviewers.map(r => sub(`rev-${r.slug}`)), reviewThreshold: 2, reviewWindowNs: String(60n * 60n * 10n ** 9n),
    wasm: { file: 'deployment/swarmguild.wasm', sha256: digest.toString('hex'), codeHash: base58(digest), bytes: wasm.length },
    guildBalanceNear: '5',
    accounts: [
      account(sub('operator'), 'operator', '0.6', '0.4'),
      ...workers.filter(w => KEYED_WORKERS.includes(w.slug)).map(w => account(sub(w.slug), 'worker', '0.25', '0.2')),
      ...reviewers.map(r => account(sub(`rev-${r.slug}`), 'reviewer', '0.25', '0.2')),
    ],
    agents: [
      ...workers.map(w => agent('workers', 'worker', w, sub(w.slug), !KEYED_WORKERS.includes(w.slug), FUNDING[w.slug] ?? '0.2')),
      ...reviewers.map(r => agent('reviewers', 'reviewer', r, sub(`rev-${r.slug}`), false, '0.15')),
    ],
  };
}

/** What the owner account must hold before the first stage, in yoctoNEAR, with a margin for gas. */
export function planCostYocto(plan) {
  const sum = list => list.reduce((total, near) => total + nearToYocto(near), 0n);
  return nearToYocto(plan.guildBalanceNear) + sum(plan.accounts.map(a => a.balanceNear)) + sum(plan.agents.map(a => a.fundingNear)) + nearToYocto('0.5');
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Read-only: compares the chain with the plan. Returns [{ check, ok, detail }]. */
export async function checkDeployment(plan, chain) {
  const out = [];
  const add = (check, ok, detail = '') => out.push({ check, ok: Boolean(ok), detail });
  const guild = await chain.account(plan.guild);
  add('The guild account exists and runs the planned WASM', guild.found && guild.codeHash === plan.wasm.codeHash, guild.found ? guild.codeHash : 'account not found');
  if (!guild.found) return out;
  add('The guild account has no access keys, so nobody can change its code or move its funds by key', (await chain.keys(plan.guild)).length === 0);
  const config = await chain.view(plan.guild, 'get_config');
  add('Owner, operator, reviewers and threshold match the plan',
    config.owner === plan.owner && config.operator === plan.operator && same(config.reviewers, plan.reviewers) && config.review_threshold === plan.reviewThreshold,
    JSON.stringify({ owner: config.owner, operator: config.operator, reviewers: config.reviewers, threshold: config.review_threshold }));
  for (const a of plan.accounts) {
    const account = await chain.account(a.id);
    if (!account.found) { add(`${a.id} exists`, false, 'account not found'); continue; }
    const keys = await chain.keys(a.id);
    const fc = keys[0]?.permission?.FunctionCall;
    add(`${a.id} has one key, and it can only call ${a.methods.join(', ')} on the guild`,
      keys.length === 1 && keys[0].publicKey === a.publicKey && fc?.receiver_id === plan.guild && same([...fc.method_names].sort(), [...a.methods].sort()) && fc.allowance !== null,
      JSON.stringify(keys.map(k => k.permission)));
  }
  for (const a of plan.agents) {
    const agent = await chain.view(plan.guild, 'get_agent', { agent: a.id });
    add(`${a.id} is registered with its manifest hash${a.hosted ? ' as a hosted agent' : ''}`,
      agent && agent.spec_hash === a.specHash && agent.hosted === a.hosted && agent.backer === plan.owner, agent ? `spec_hash ${agent.spec_hash}` : 'not registered');
  }
  return out;
}

/** Runs one stage. Returns [{ step, txHash }] for what was sent and [{ step, skipped }] for what was already true. */
export async function runStage(stage, plan, chain, { wasm, log = () => {} } = {}) {
  const done = [];
  const sent = (step, r) => { done.push({ step, txHash: r.txHash }); log(`${step}: ${r.txHash}`); };
  const skip = (step, why) => { done.push({ step, skipped: why }); log(`${step}: skipped, ${why}`); };
  if (stage === 'deploy') {
    const existing = await chain.account(plan.guild);
    if (existing.found) {
      if (existing.codeHash !== plan.wasm.codeHash) throw new Error(`${plan.guild} already exists with different code (${existing.codeHash}).`);
      skip('deploy', 'the guild account already runs the planned WASM');
    } else {
      if (createHash('sha256').update(wasm).digest('hex') !== plan.wasm.sha256) throw new Error('The WASM file does not match the plan.');
      // One transaction creates the account, deploys and initialises. The account never has a key.
      sent('deploy', await chain.send(plan.owner, plan.guild, [
        actions.createAccount(), actions.transfer(nearToYocto(plan.guildBalanceNear)), actions.deploy(wasm),
        actions.functionCall('new', { owner: plan.owner, operator: plan.operator, reviewers: plan.reviewers,
          review_threshold: plan.reviewThreshold, review_window_ns: plan.reviewWindowNs }, 50),
      ], 'deploy'));
    }
  } else if (stage === 'accounts') {
    for (const a of plan.accounts) {
      if ((await chain.account(a.id)).found) { skip(`create ${a.id}`, 'the account exists'); continue; }
      // Created with a single function-call key: it can call the listed guild methods and nothing else.
      sent(`create ${a.id}`, await chain.send(plan.owner, a.id, [
        actions.createAccount(), actions.transfer(nearToYocto(a.balanceNear)),
        actions.addFunctionCallKey(a.publicKey, plan.guild, a.methods, nearToYocto(a.allowanceNear)),
      ], `create ${a.id}`));
    }
  } else if (stage === 'agents') {
    for (const a of plan.agents) {
      if (await chain.view(plan.guild, 'get_agent', { agent: a.id })) { skip(`add_agent ${a.id}`, 'the agent is registered'); continue; }
      sent(`add_agent ${a.id}`, await chain.call(plan.owner, plan.guild, 'add_agent',
        { agent: a.id, name: a.name, model: a.model, spec_hash: a.specHash, spec_url: a.specUrl, hosted: a.hosted },
        { depositYocto: nearToYocto(a.fundingNear) }));
    }
  } else throw new Error(`Unknown stage ${stage}. Stages: ${STAGES.join(', ')}.`);
  return done;
}
