import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitPublisher } from '../lib/publish.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('an independent agent publishes its work by pushing to its own repository, and waits until the file is public', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmguild-publish-'));
  const bare = path.join(tmp, 'remote.git').replace(/\\/g, '/'); const clone = path.join(tmp, 'clone');
  execFileSync('git', ['init', '-q', '--bare', bare]); execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  for (const [k, v] of [['user.name', 'alice'], ['user.email', 'alice@example.test'], ['commit.gpgsign', 'false'],
    ['remote.origin.url', 'git@github.com:alice/agent-work.git'], [`url.${bare}.insteadOf`, 'git@github.com:alice/agent-work.git']]) git(clone, 'config', k, v);
  // Stands in for raw.githubusercontent.com: serves the file from the pushed commit, and is slow to show it the first time.
  let asked = 0; const waits = [];
  const fetchImpl = async url => {
    const m = /^https:\/\/raw\.githubusercontent\.com\/alice\/agent-work\/([0-9a-f]{40})\/(.+)$/.exec(url); assert.ok(m, url);
    if (++asked === 1) return new Response('404: Not Found', { status: 404 });
    return new Response(execFileSync('git', ['-C', bare, 'show', `${m[1]}:${m[2]}`], { encoding: 'utf8' }));
  };
  try {
    const publish = gitPublisher(clone, { fetchImpl, wait: async ms => { waits.push(ms); } });
    const payload = { jobId: 7, agent: 'alice.testnet', work: { result: 'Three findings.', transcript: { request: '{}', response: 'e30=' } } };
    const url = await publish(7, payload);
    assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/alice\/agent-work\/[0-9a-f]{40}\/swarmguild\/job-7\.json$/);
    assert.ok(url.length <= 300, 'the URL fits the contract\'s limit');
    assert.equal(waits.length, 1, 'it did not return the URL until the file could be fetched');
    assert.deepEqual(JSON.parse(execFileSync('git', ['-C', bare, 'show', 'main:swarmguild/job-7.json'], { encoding: 'utf8' })), payload);
    assert.equal(await publish(7, payload), url, 'publishing the same work again is harmless');
    // Someone else pushes to the same branch in the meantime (the swarm's runner does, in a shared repository).
    const other = path.join(tmp, 'other'); execFileSync('git', ['clone', '-q', '-b', 'main', bare, other]);
    for (const [k, v] of [['user.name', 'runner'], ['user.email', 'runner@example.test'], ['commit.gpgsign', 'false']]) git(other, 'config', k, v);
    fs.writeFileSync(path.join(other, 'evidence.json'), '{}\n'); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'evidence'); git(other, 'push', '-q', 'origin', 'HEAD:main');
    const next = await publish(8, { ...payload, jobId: 8 });
    assert.match(next, /swarmguild\/job-8\.json$/);
    assert.equal(execFileSync('git', ['-C', bare, 'show', 'main:evidence.json'], { encoding: 'utf8' }), '{}\n', 'their commit is kept');
    assert.equal(JSON.parse(execFileSync('git', ['-C', bare, 'show', 'main:swarmguild/job-8.json'], { encoding: 'utf8' })).jobId, 8, 'and the work went on top of it');
    git(clone, 'config', 'remote.origin.url', 'https://gitlab.example/alice/agent-work.git');
    assert.throws(() => gitPublisher(clone), /GitHub repository/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
