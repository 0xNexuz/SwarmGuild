// Runs jobs on NEAR Testnet with real NEAR AI model calls. Nothing is sent without --approve-testnet-run.
//   node scripts/run.mjs --scenario summary|audit|injection|tamper --approve-testnet-run
//   node scripts/run.mjs --post "<job text>" --bounty 0.3 --approve-testnet-run
//   node scripts/run.mjs --job <id> --approve-testnet-run            resume a job
//   node scripts/run.mjs --post "<job text>" --bounty 0.3 --post-only --approve-testnet-run   post it and leave it to the always-on runner
//   node scripts/run.mjs --watch --minutes 30 --approve-testnet-run  serve every open job, including other people's
//   Extra flags for --watch: --max-jobs N, and --publish to commit and push each job's evidence as it settles.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadManifests } from '../lib/manifest.mjs';
import { nearToYocto, yoctoToNear } from '../lib/market.mjs';
import { attestedKeys } from '../lib/near-ai.mjs';
import { createRunner, fileStore } from '../lib/runner.mjs';
import { at, EVIDENCE_DIR, keysDir, main, nearAiKey, parseArgs, RAW_BASE, readPlan, testnet } from './common.mjs';

main(async () => {
  const { flags } = parseArgs();
  if (flags['approve-testnet-run'] !== true) throw new Error('This sends Testnet transactions and spends NEAR AI credit. Add --approve-testnet-run once the owner has approved it.');
  const plan = readPlan(); const chain = await testnet(flags); const apiKey = nearAiKey();
  const workers = loadManifests(at('agents', 'workers')); const reviewers = loadManifests(at('agents', 'reviewers'));
  const ai = { apiKey, tools: { near_account: id => chain.account(id) } };
  await attestedKeys(workers[0].manifest.model, ai); // fail early if NEAR AI or its attestation is unreachable
  const runner = createRunner({ chain, guild: plan.guild, operator: plan.operator, ai,
    manifests: new Map(workers.map(w => [w.hash, w.manifest])),
    reviewers: reviewers.map(r => ({ account: `rev-${r.slug}.${plan.owner}`, manifest: r.manifest })),
    store: fileStore({ evidenceDir: EVIDENCE_DIR, secretsFile: path.join(keysDir(flags), 'bid-secrets.json') }),
    resultUrl: id => `${RAW_BASE}/evidence/testnet/jobs/${id}.json`, log: line => console.log(line) });

  if (flags.watch) {
    // A runner should hold only limited keys. Refuse to serve with a full-access key loaded.
    for (const id of [plan.operator, ...plan.accounts.map(a => a.id)]) {
      if (chain.canSign(id) && (await chain.keys(id)).some(k => k.publicKey === chain.publicKey(id) && k.permission === 'FullAccess')) throw new Error(`${id} is loaded with a full-access key. The runner only takes function-call keys.`);
    }
    if (chain.canSign(plan.owner)) console.log('Note: the owner key is in the keys folder. A runner left serving should not have it.');
    // A function-call key's gas allowance cannot be refilled, so stop before the operator's runs out mid-job.
    const canServe = async () => {
      const allowance = BigInt((await chain.keys(plan.operator))[0]?.permission?.FunctionCall?.allowance ?? 0);
      if (allowance < nearToYocto('0.03')) { console.log(`The operator key has ${yoctoToNear(allowance)} NEAR of gas allowance left: too little to serve another job.`); return false; }
      return true;
    };
    // With no allowance there is nothing to serve, so stop now instead of idling until the time is up.
    if (!await canServe()) { console.log(JSON.stringify({ served: [], stopped: 'no gas allowance left on the operator key' })); return; }
    const publish = flags.publish === true ? async (jobId, status) => publishEvidence(jobId, status, keysDir(flags)) : undefined;
    const served = await runner.watch({ minutes: Number(flags.minutes ?? 10), maxJobs: flags['max-jobs'] ? Number(flags['max-jobs']) : Infinity, canServe, onSettled: publish });
    console.log(JSON.stringify({ served }));
    return;
  }
  let jobId = flags.job !== undefined ? Number(flags.job) : null;
  if (jobId === null) {
    const scenario = flags.scenario ? JSON.parse(fs.readFileSync(at('jobs', 'scenarios.json'), 'utf8'))[flags.scenario] : null;
    if (flags.scenario && !scenario) throw new Error(`Unknown scenario ${flags.scenario}.`);
    const description = scenario?.description ?? flags.post; const bounty = scenario?.bountyNear ?? flags.bounty ?? '0.3';
    if (typeof description !== 'string') throw new Error('Give --scenario <name>, --post "<job text>", --job <id> or --watch.');
    jobId = await runner.postJob(flags.poster ?? plan.owner, description, nearToYocto(bounty));
    if (flags['post-only'] === true) { console.log(JSON.stringify({ jobId, status: 'Open', note: 'Posted. The always-on runner will serve it.' })); return; }
  }
  const end = await runner.runJob(jobId);
  console.log(JSON.stringify({ jobId, status: end.status, ...(end.undecided ? { undecided: true, resumeAfter: end.expiresAt } : {}), evidence: `evidence/testnet/jobs/${jobId}.json` }));
});

/** Commits one settled job's evidence file and pushes it, so the job's on-chain result URL resolves. */
function publishEvidence(jobId, status, secretsDir) {
  const git = (...args) => execFileSync('git', args, { cwd: at(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const file = `evidence/testnet/jobs/${jobId}.json`;
  try {
    git('add', file, 'evidence/testnet/intents.jsonl');
    if (!git('diff', '--cached', '--name-only').trim()) return;
    git('commit', '-q', '-m', `Record Testnet job ${jobId}: ${status}`);
    try { execFileSync(process.execPath, [at('scripts', 'scan-secrets.mjs')], { cwd: at(), stdio: 'ignore' }); }
    catch { // a job can make a model print key-shaped text; such a file is kept out of the repository
      git('reset', '-q', '--hard', 'HEAD~1');
      fs.renameSync(at(file), path.join(secretsDir, `withheld-job-${jobId}.json`));
      console.log(`job ${jobId}: its evidence contains key-shaped text and was not published.`);
      return;
    }
    git('pull', '-q', '--rebase', 'origin', 'main');
    git('push', '-q', 'origin', 'HEAD:main');
    console.log(`job ${jobId}: evidence published.`);
  } catch (error) { console.log(`job ${jobId}: could not publish the evidence yet: ${String(error.stderr ?? error.message).trim().split('\n').pop()}`); }
}
