import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = file => fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

test('the live page reads the contract named in the deployment plan', () => {
  const plan = JSON.parse(read('deployment/testnet.json'));
  const guild = /export const GUILD = '([^']+)'/.exec(read('site/live.mjs'))[1];
  assert.equal(guild, plan.guild);
  assert.ok(read('README.md').includes(plan.guild));
});

test('the page keeps the simulation and the live data apart', () => {
  const html = read('site/index.html'), live = read('site/live.mjs');
  assert.match(html, /data-view="testnet"/);
  assert.match(html, /Simulation: no chain, no model calls/);
  assert.ok(!/from '\.\/sim\.mjs'/.test(live), 'the live view never imports the simulation');
});
