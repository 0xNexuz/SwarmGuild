// Moves the runner's keys between a keys folder and one secret value, for the runner on GitHub Actions.
// Only the limited function-call keys go in: the operator, the two self-keyed agents and the three reviewers.
// The owner's full-access key is never included.
//   node scripts/runner-keys.mjs export --keys-dir <folder> --out <file outside the repository>
//   SWARMGUILD_RUNNER_KEYS=<that file's contents> node scripts/runner-keys.mjs import --keys-dir <folder>
import fs from 'node:fs';
import path from 'node:path';
import { keysDir, main, parseArgs, readPlan, root } from './common.mjs';

main(async () => {
  const { flags, words: [command] } = parseArgs();
  const plan = readPlan(); const dir = keysDir(flags); const allowed = plan.accounts.map(a => a.id);
  if (command === 'export') {
    const out = path.resolve(String(flags.out ?? ''));
    const rel = path.relative(root, out);
    if (!flags.out || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('Give --out a file outside this repository.');
    const keys = allowed.map(id => {
      const file = path.join(dir, `${id}.json`);
      if (!fs.existsSync(file)) throw new Error(`${id}.json is not in the keys folder.`);
      const k = JSON.parse(fs.readFileSync(file, 'utf8'));
      const planned = plan.accounts.find(a => a.id === id).publicKey;
      if (k.account_id !== id || k.public_key !== planned) throw new Error(`${id}.json does not hold the key in the deployment plan.`);
      return k;
    });
    fs.writeFileSync(out, JSON.stringify({ keys }), { mode: 0o600 });
    console.log(JSON.stringify({ wrote: path.basename(out), accounts: allowed, ownerIncluded: false }));
    return;
  }
  if (command === 'import') {
    const bundle = JSON.parse(process.env.SWARMGUILD_RUNNER_KEYS ?? 'null');
    if (!Array.isArray(bundle?.keys)) throw new Error('SWARMGUILD_RUNNER_KEYS is not set or is not a runner key bundle.');
    fs.mkdirSync(dir, { recursive: true });
    for (const k of bundle.keys) {
      if (!allowed.includes(k.account_id)) throw new Error('The bundle holds a key for an account that is not one of the runner\'s.');
      fs.writeFileSync(path.join(dir, `${k.account_id}.json`), JSON.stringify(k), { mode: 0o600 });
    }
    console.log(JSON.stringify({ imported: bundle.keys.length }));
    return;
  }
  throw new Error('Usage: runner-keys.mjs export --keys-dir <folder> --out <file> | import --keys-dir <folder>');
});
