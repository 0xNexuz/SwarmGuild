import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const commits = git('rev-list', '--all').trim().split(/\s+/).filter(Boolean);
const refs = ['WORKTREE', ...commits];
const findings = [];
const secretPattern = [
  ['NEAR_PRIVATE_KEY', /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g],
  ['PEM_PRIVATE_KEY', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
  ['GITHUB_TOKEN', /(?:gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{25,})/g],
  ['API_TOKEN', /(?:sk-[A-Za-z0-9_-]{25,}|NEAR_AI_KEY\s*=\s*['"]?[A-Za-z0-9_-]{25,})/g],
];
// Exact strings known to be fake would be listed here. There are none.
const KNOWN_FAKE = new Set();
const onlyKnownFakes = (text, pattern) => {
  const matches = text.match(new RegExp(pattern.source, 'g')) ?? [];
  return matches.length > 0 && matches.every(m => KNOWN_FAKE.has(m));
};
const credentialPath = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|[^/]*(?:private[-_]?key|secret)[^/]*\.(?:json|pem|key))$/i;
const credentialDirectory = /(?:^|\/)(?:\.near-credentials|SwarmGuild-Secrets)\//i;
const ignorePath = /(?:^|\/)\.env\.example$/i;

for (const ref of refs) {
  const files = (ref === 'WORKTREE' ? git('ls-files') : git('ls-tree', '-r', '--name-only', ref))
    .split(/\r?\n/).filter(Boolean);
  for (const file of files) {
    if ((credentialPath.test(file) || credentialDirectory.test(file)) && !ignorePath.test(file)) {
      findings.push({ ref: ref.slice(0, 12), file, kind: 'CREDENTIAL_PATH' });
    }
  }
  for (const [kind, pattern] of secretPattern) {
    let output = '';
    const args = ['grep', '-I', '-n', '-P', '-e', pattern.source];
    if (ref !== 'WORKTREE') args.push(ref);
    args.push('--');
    try { output = git(...args); }
    catch (error) {
      if (error.status !== 1) throw error;
    }
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const match = ref === 'WORKTREE' ? line.match(/^(.+?):(\d+):/) : line.match(/^[^:]+:(.+?):(\d+):/);
      if (match && onlyKnownFakes(line.slice(match.index + match[0].length), pattern)) continue;
      findings.push({ ref: ref.slice(0, 12), file: match?.[1] ?? 'UNKNOWN',
        line: match ? Number(match[2]) : null, kind });
    }
  }
}

// Never print matched content, even if the scanner finds a real credential.
console.log(JSON.stringify({ scannedCommits: commits.length, scannedCurrentTree: true,
  findingCount: findings.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
