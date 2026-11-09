// Deploys SwarmGuild to NEAR Testnet in three stages. Nothing is sent without --approve-testnet-spend.
//   node scripts/setup.mjs plan --owner <account> --keys-dir <folder>     writes deployment/testnet.json, sends nothing
//   node scripts/setup.mjs run deploy|accounts|agents --approve-testnet-spend --keys-dir <folder>
//   node scripts/setup.mjs check                                          read-only comparison of chain and plan
import fs from 'node:fs';
import { ensureKey } from '../lib/chain.mjs';
import { buildPlan, checkDeployment, planCostYocto, runStage, STAGES } from '../lib/setup.mjs';
import { yoctoToNear } from '../lib/market.mjs';
import { at, keysDir, main, parseArgs, PLAN_FILE, RAW_BASE, readPlan, testnet, WASM_FILE, writeJson } from './common.mjs';

main(async () => {
  const { flags, words: [command, stage] } = parseArgs();
  if (command === 'plan') {
    const owner = flags.owner;
    if (!/^[a-z0-9_-]+\.testnet$/.test(owner ?? '')) throw new Error('Give the owner as --owner <name>.testnet');
    const dir = keysDir(flags);
    if (!fs.existsSync(`${dir}/${owner}.json`)) throw new Error(`The owner's key file ${owner}.json is not in the keys folder.`);
    const existing = fs.existsSync(PLAN_FILE) ? JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')) : null;
    if (existing && existing.owner !== owner) throw new Error(`deployment/testnet.json already plans a deployment for ${existing.owner}.`);
    const plan = buildPlan({ networkId: 'testnet', owner, wasm: fs.readFileSync(WASM_FILE), agentsDir: at('agents'), rawBase: RAW_BASE, publicKeyOf: id => ensureKey(dir, id) });
    writeJson(PLAN_FILE, { ...plan, transactions: existing?.transactions ?? [] });
    console.log(JSON.stringify({ wrote: 'deployment/testnet.json', owner, guild: plan.guild, wasmSha256: plan.wasm.sha256,
      newAccounts: plan.accounts.map(a => a.id), agents: plan.agents.map(a => `${a.id}${a.hosted ? ' (hosted)' : ''}`), ownerNeedsNear: yoctoToNear(planCostYocto(plan)) }, null, 2));
    return;
  }
  const plan = readPlan();
  if (command === 'check') {
    const results = await checkDeployment(plan, await testnet(flags, { signing: false }));
    for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.check}${r.ok ? '' : ` (${r.detail})`}`);
    if (results.some(r => !r.ok)) process.exitCode = 1;
    return;
  }
  if (command !== 'run' || !STAGES.includes(stage)) throw new Error(`Usage: setup.mjs plan | check | run <${STAGES.join('|')}> --approve-testnet-spend`);
  if (flags['approve-testnet-spend'] !== true) throw new Error('This sends Testnet transactions. Add --approve-testnet-spend once the owner has approved it.');
  const chain = await testnet(flags);
  const ownerKeys = await chain.keys(plan.owner);
  if (!ownerKeys.some(k => k.publicKey === chain.publicKey(plan.owner) && k.permission === 'FullAccess')) throw new Error('The owner key in the keys folder is not a full-access key of the owner account.');
  const owner = await chain.account(plan.owner);
  if (stage === 'deploy' && !(await chain.account(plan.guild)).found && BigInt(owner.balanceYocto) < planCostYocto(plan)) {
    throw new Error(`The owner holds ${yoctoToNear(owner.balanceYocto)} NEAR and the three stages need about ${yoctoToNear(planCostYocto(plan))}. Top it up first.`);
  }
  const done = await runStage(stage, plan, chain, { wasm: fs.readFileSync(WASM_FILE), log: line => console.log(line) });
  plan.transactions.push(...done.filter(d => d.txHash).map(d => ({ stage, ...d })));
  writeJson(PLAN_FILE, plan);
  console.log(JSON.stringify({ stage, sent: done.filter(d => d.txHash).length, alreadyDone: done.filter(d => d.skipped).length }));
});
