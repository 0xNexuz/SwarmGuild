import test from 'node:test';
import assert from 'node:assert/strict';
import { BOND, createSim } from '../site/sim.mjs';

test('the simulation conserves every unit over hundreds of jobs, for several seeds', () => {
  for (const seed of [1, 7, 42, 2026]) {
    const sim = createSim(seed);
    for (let i = 0; i < 600; i++) { sim.step(); assert.equal(sim.invariant().ok, true, `seed ${seed} tick ${i}`); }
    const st = sim.stats();
    assert.ok(st.jobs > 150 && st.paid > 50 && st.rejected > 5, JSON.stringify(st));
    assert.ok(sim.state.agents.every(a => a.balance >= 0 && a.locked >= 0));
  }
});

test('it is deterministic for a seed, uses 20 agents, and no bid ever exceeds its bounty', () => {
  const a = createSim(7); const b = createSim(7);
  for (let i = 0; i < 100; i++) { a.step(); b.step(); }
  assert.deepEqual(a.stats(), b.stats());
  assert.equal(a.state.agents.length, 20);
  for (const job of a.state.jobs) for (const bid of job.bids) assert.ok(bid.price <= job.bounty && bid.price > 0);
});

test('lowest revealed bid wins, and an economy emerges: prices fall and good work pays', () => {
  const sim = createSim(7);
  for (let i = 0; i < 800; i++) sim.step();
  for (const job of sim.state.jobs.filter(j => j.winner)) {
    const revealed = job.bids.filter(b => b.revealed);
    assert.equal(job.price, Math.min(...revealed.map(b => b.price)));
  }
  const byQuality = [...sim.state.agents].sort((x, y) => y.quality - x.quality);
  const mean = list => list.reduce((n, a) => n + a.balance, 0) / list.length;
  assert.ok(mean(byQuality.slice(0, 10)) > mean(byQuality.slice(10)), 'agents whose work passes review end up richer');
  const balances = sim.state.agents.map(a => a.balance);
  assert.ok(Math.max(...balances) > 3 * Math.min(...balances), 'the same starting rules produce very unequal agents');
  assert.ok(sim.state.agents.every(a => a.floor < 400), 'sealed lowest-price bidding drove prices down toward cost');
});

test('a posted job and a newly funded agent enter the market', () => {
  const sim = createSim(3);
  const agent = sim.addAgent({ name: 'Mine', kind: 'audit', floor: 500, funding: 2000, quality: 0.99 });
  const job = sim.postJob({ kind: 'audit', description: 'Audit my contract', bounty: 3000, poster: 'you.testnet' });
  for (let i = 0; i < 6; i++) sim.step();
  assert.equal(job.winner, agent.id, 'the cheapest matching agent wins');
  assert.equal(sim.invariant().ok, true);
});
