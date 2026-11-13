// Read-only. Rechecks the Testnet deployment and every recorded job against public RPC. Needs no keys.
//   node scripts/verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { failureText } from '../lib/chain.mjs';
import { manifestHash } from '../lib/manifest.mjs';
import { checkDeployment } from '../lib/setup.mjs';
import { verifyJob } from '../lib/verify.mjs';
import { EVIDENCE_DIR, main, parseArgs, RAW_BASE, readPlan, testnet } from './common.mjs';

main(async () => {
  const { flags } = parseArgs();
  const plan = readPlan(); const chain = await testnet(flags, { signing: false });
  const results = (await checkDeployment(plan, chain)).map(r => ({ job: 'deployment', ...r }));
  for (const t of plan.transactions ?? []) {
    const outcome = await chain.tx(t.txHash, plan.owner, { timeoutMs: 12000 });
    const failure = outcome && (outcome.status?.Failure ?? outcome.receipts_outcome?.map(r => r.outcome?.status?.Failure).find(Boolean));
    results.push({ job: 'deployment', check: `${t.step}: final and successful`, ok: Boolean(outcome) && !failure, detail: `${t.txHash}${failure ? ` ${failureText(failure)}` : ''}` });
  }
  for (const a of plan.agents) { // the manifest anyone can fetch is the one whose hash is on chain
    let detail = ''; let ok = false;
    try { const response = await fetch(a.specUrl, { signal: AbortSignal.timeout(15000) }); ok = response.ok && manifestHash(Buffer.from(await response.arrayBuffer())) === a.specHash; detail = `HTTP ${response.status}`; }
    catch (error) { detail = error.message; }
    results.push({ job: 'deployment', check: `${a.id}: the manifest at its public URL has the hash on chain`, ok, detail });
  }
  const jobsDir = path.join(EVIDENCE_DIR, 'jobs');
  const files = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter(f => f.endsWith('.json')).sort((a, b) => parseInt(a) - parseInt(b)) : [];
  for (const file of files) results.push(...await verifyJob(JSON.parse(fs.readFileSync(path.join(jobsDir, file), 'utf8')), chain, { guild: plan.guild, ownResultUrl: id => `${RAW_BASE}/evidence/testnet/jobs/${id}.json` }));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} [${r.job}] ${r.check}${r.ok ? '' : ` (${r.detail})`}`);
  const failed = results.filter(r => !r.ok).length;
  const allowance = (await chain.keys(plan.operator))[0]?.permission?.FunctionCall?.allowance;
  console.log(JSON.stringify({ guild: plan.guild, jobs: files.length, checks: results.length, failed, operatorGasAllowanceLeftYocto: allowance ?? null }));
  console.log(JSON.stringify({ agents: await chain.view(plan.guild, 'get_agents', { from: 0, limit: 100 }) })); // public state, for the record
  if (failed || flags.json) fs.writeFileSync(path.join(EVIDENCE_DIR, 'verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + '\n');
  if (failed) process.exitCode = 1;
});
