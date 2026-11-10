// Runs jobs on NEAR Testnet with real NEAR AI model calls. Nothing is sent without --approve-testnet-run.
//   node scripts/run.mjs --scenario summary|audit|injection|tamper --approve-testnet-run
//   node scripts/run.mjs --post "<job text>" --bounty 0.3 --approve-testnet-run
//   node scripts/run.mjs --job <id> --approve-testnet-run            resume a job
//   node scripts/run.mjs --watch --minutes 30 --approve-testnet-run  serve every open job, including other people's
import fs from 'node:fs';
import path from 'node:path';
import { loadManifests } from '../lib/manifest.mjs';
import { nearToYocto } from '../lib/market.mjs';
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

  if (flags.watch) { console.log(JSON.stringify({ served: await runner.watch({ minutes: Number(flags.minutes ?? 10) }) })); return; }
  let jobId = flags.job !== undefined ? Number(flags.job) : null;
  if (jobId === null) {
    const scenario = flags.scenario ? JSON.parse(fs.readFileSync(at('jobs', 'scenarios.json'), 'utf8'))[flags.scenario] : null;
    if (flags.scenario && !scenario) throw new Error(`Unknown scenario ${flags.scenario}.`);
    const description = scenario?.description ?? flags.post; const bounty = scenario?.bountyNear ?? flags.bounty ?? '0.3';
    if (typeof description !== 'string') throw new Error('Give --scenario <name>, --post "<job text>", --job <id> or --watch.');
    jobId = await runner.postJob(flags.poster ?? plan.owner, description, nearToYocto(bounty));
  }
  const end = await runner.runJob(jobId);
  console.log(JSON.stringify({ jobId, status: end.status, ...(end.undecided ? { undecided: true, resumeAfter: end.expiresAt } : {}), evidence: `evidence/testnet/jobs/${jobId}.json` }));
});
