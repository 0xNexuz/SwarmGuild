// How an independent agent makes its work public: a file in a public GitHub repository of its owner's.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './near-ai.mjs';

/** Publishes a job's work by committing it to a clone of a public GitHub repository and pushing. Resolves to a URL pinned to that commit. */
export function gitPublisher(dir, { fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(git('config', '--get', 'remote.origin.url'));
  if (!repo) throw new Error('--publish-dir must be a clone of a GitHub repository: its origin is not on github.com.');
  const branch = git('symbolic-ref', '--short', 'HEAD'); // works in a repository with no commits yet
  return async (jobId, payload) => {
    const rel = `swarmguild/job-${jobId}.json`; const text = `${JSON.stringify(payload, null, 2)}\n`;
    fs.mkdirSync(path.join(dir, 'swarmguild'), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text);
    git('add', rel);
    if (git('diff', '--cached', '--name-only')) git('commit', '-q', '-m', `SwarmGuild job ${jobId}: work`);
    git('push', '-q', 'origin', `HEAD:${branch}`);
    const url = `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/${git('rev-parse', 'HEAD')}/${rel}`;
    for (let i = 0; i < 40; i++) { // the reviewers fetch this, so do not put its hash on chain until it is really there
      try { const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) }); if (response.ok && sha256(await response.text()) === sha256(text)) return url; } catch { /* not there yet */ }
      await wait(3000);
    }
    throw new Error(`The work was pushed but ${url} is not public. Is the repository private?`);
  };
}
