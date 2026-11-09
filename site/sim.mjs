// A simulation of the market in contracts/swarm/src/lib.rs with scripted agents: no chain and no model calls.
// Amounts are integers in units of 0.0001 NEAR. The rules (bond, sealed bids, review fee, slashing) match RULES.md.
export const UNIT = 10000; // units per NEAR
export const BOND = 100; // 0.01 NEAR
export const FEE_BPS = 1000;
export const MIN_FUNDING = 1000; // 0.1 NEAR
export const MIN_FLOOR = 60; // agents never bid below this; under it a job cannot pay for its own inference
export const near = units => (units / UNIT).toFixed(units % 100 ? 4 : 2);

export const KINDS = {
  audit: { label: 'Auditor', skills: ['contract', 'audit', 'risk'], floor: 1200,
    jobs: ['Audit this vault contract for risks before we fund it.', 'Review the access keys and owner methods of dao-treasury.testnet.', 'Check this escrow contract: can the callback double-pay?'] },
  summarize: { label: 'Summarizer', skills: ['summarize', 'summary', 'brief'], floor: 600,
    jobs: ['Summarize this governance proposal in five bullet points.', 'Give a brief of this 40-page validator report.', 'Summarize the changes in this release for token holders.'] },
  explain: { label: 'Explainer', skills: ['explain', 'what is', 'how does'], floor: 800,
    jobs: ['Explain how function-call access keys limit an agent.', 'What is a TEE attestation, for a newcomer?', 'How does a sealed-bid auction stop undercutting? Explain with an example.'] },
};
const POSTERS = ['dao-ops.testnet', 'mara.testnet', 'fund-desk.testnet', 'tunde.testnet', 'grants.testnet'];
export const REVIEWERS = ['Quality reviewer', 'Safety reviewer', 'Integrity reviewer'];

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function createSim(seed = 7, { agents: count = 20 } = {}) {
  const rand = rng(seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const between = (a, b) => Math.round(a + rand() * (b - a));
  const s = { seed, t: 0, agents: [], reviewers: REVIEWERS.map((name, i) => ({ id: `rev-${i + 1}`, name, balance: 2000, earned: 0, spent: 0, votes: 0 })),
    jobs: [], events: [], credits: {}, operator: 0, deposited: 0, charges: [], guard: [] };
  s.deposited += 6000;
  const log = (type, job, agent, text, amount = null) => { s.events.push({ t: s.t, type, job, agent, text, amount }); if (s.events.length > 400) s.events.shift(); };
  const credit = (who, amount) => { s.credits[who] = (s.credits[who] ?? 0) + amount; };
  const charge = (party, amount, receipt, job) => {
    const cost = Math.min(amount, party.balance);
    if (!cost) return;
    party.balance -= cost; party.spent += cost; s.operator += cost;
    s.charges.push({ t: s.t, who: party.id, name: party.name, amount: cost, receipt, job }); if (s.charges.length > 200) s.charges.shift();
  };

  function addAgent({ name, kind, floor, funding, quality, integrity = 0.99, backer = 'you.testnet', skills, specHash = null }) {
    const id = `agent-${s.agents.length + 1}`;
    const agent = { id, name: name || `${KINDS[kind].label} ${String(s.agents.length + 1).padStart(2, '0')}`, kind, skills: skills ?? KINDS[kind].skills,
      floor: floor ?? KINDS[kind].floor, balance: funding, locked: 0, earned: 0, spent: 0, won: 0, paid: 0, failed: 0,
      quality: quality ?? 0.8, integrity, reliability: 0.97, backer, specHash, history: [funding], x: rand(), y: rand() };
    s.agents.push(agent); s.deposited += funding;
    log('agent_added', null, id, `${agent.name} joined, funded with ${near(funding)} NEAR by ${backer}`, funding);
    return agent;
  }
  const kinds = Object.keys(KINDS);
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length];
    addAgent({ kind, floor: Math.round(KINDS[kind].floor * (0.8 + rand() * 0.45) / 10) * 10, funding: between(1200, 3000),
      quality: 0.5 + rand() * 0.48, integrity: i % 7 === 3 ? 0.55 : 0.99, backer: pick(['backer-a.testnet', 'backer-b.testnet', 'lab.testnet']) });
  }

  function postJob({ description, kind, bounty, poster } = {}) {
    kind = kind ?? pick(kinds);
    const job = { id: s.jobs.length, poster: poster ?? pick(POSTERS), kind, description: description ?? pick(KINDS[kind].jobs),
      bounty: bounty ?? between(15, 45) * 100, status: 'Open', phase: 'commit', bids: [], winner: null, price: null, work: null, reviews: [], postedAt: s.t, closedAt: null };
    s.jobs.push(job); s.deposited += job.bounty;
    log('job_posted', job.id, null, `${job.poster} posted job #${job.id} with a ${near(job.bounty)} NEAR bounty`, job.bounty);
    return job;
  }
  const agentOf = id => s.agents.find(a => a.id === id);
  const close = (job, status) => { job.status = status; job.phase = 'done'; job.closedAt = s.t; };

  function advance(job) {
    if (job.phase === 'commit') {
      for (const a of s.agents) {
        if (a.kind !== job.kind && !a.skills.some(k => job.description.toLowerCase().includes(k))) continue;
        if (a.balance < BOND * 2 || a.floor > job.bounty || job.bids.length >= 16) continue;
        a.balance -= BOND; a.locked += BOND;
        const price = Math.min(job.bounty, Math.round(a.floor * (0.9 + rand() * 0.2) / 10) * 10);
        job.bids.push({ agent: a.id, price, revealed: false, commitment: Array.from({ length: 4 }, () => Math.floor(rand() * 65536).toString(16).padStart(4, '0')).join('') });
      }
      log('bids_committed', job.id, null, `${job.bids.length} sealed bid${job.bids.length === 1 ? '' : 's'} committed on job #${job.id}`);
      job.phase = 'reveal';
    } else if (job.phase === 'reveal') {
      for (const bid of job.bids) bid.revealed = rand() < agentOf(bid.agent).reliability;
      log('bids_revealed', job.id, null, `${job.bids.filter(b => b.revealed).length} of ${job.bids.length} bids revealed on job #${job.id}`);
      job.phase = 'award';
    } else if (job.phase === 'award') {
      let best = null;
      for (const bid of job.bids) if (bid.revealed && (!best || bid.price < best.price)) best = bid;
      for (const bid of job.bids) {
        const a = agentOf(bid.agent);
        if (!bid.revealed) { a.locked -= BOND; credit(job.poster, BOND); log('bond_slashed', job.id, a.id, `${a.name} never revealed and lost its bond`, BOND); }
        else if (bid !== best) { a.locked -= BOND; a.balance += BOND; }
        // Scripted price discovery: losers shave their floor, the winner raises its own. No agent goes below cost.
        a.floor = bid === best ? Math.round(a.floor * 1.05) : Math.max(MIN_FLOOR, Math.round(a.floor * 0.97));
      }
      if (!best) { credit(job.poster, job.bounty); close(job, 'Cancelled'); log('job_cancelled', job.id, null, `Job #${job.id} had no revealed bid; bounty refunded`, job.bounty); return; }
      const w = agentOf(best.agent); w.won += 1;
      job.winner = w.id; job.price = best.price; job.status = 'Awarded'; job.phase = 'work';
      log('job_awarded', job.id, w.id, `${w.name} won job #${job.id} at ${near(best.price)} NEAR`, best.price);
    } else if (job.phase === 'work') {
      const w = agentOf(job.winner);
      charge(w, between(8, 28), `chat-${s.t}-${job.id} glm-5.3-flash`, job.id);
      const leaked = rand() > w.integrity;
      job.work = { resultHash: Array.from({ length: 4 }, () => Math.floor(rand() * 65536).toString(16).padStart(4, '0')).join(''), signed: true, leaked, good: rand() < w.quality };
      job.status = 'Submitted'; job.phase = 'review';
      log('work_submitted', job.id, w.id, `${w.name} submitted TEE-signed work for job #${job.id}`);
    } else if (job.phase === 'review') {
      const w = agentOf(job.winner);
      const guardFail = job.work.leaked;
      s.guard.push({ t: s.t, job: job.id, agent: w.name, pass: !guardFail, reason: guardFail ? 'Follows instructions hidden in the job text' : 'Signature, hash and secret scan passed' });
      if (s.guard.length > 120) s.guard.shift();
      for (const r of s.reviewers) {
        if (job.status !== 'Submitted') break;
        const pass = guardFail ? r.name !== 'Integrity reviewer' && rand() < 0.35 : job.work.good ? rand() < 0.93 : rand() < 0.2;
        charge(r, between(4, 12), `chat-${s.t}-${job.id}-${r.id} glm-5.3-flash`, job.id);
        r.votes += 1; job.reviews.push({ reviewer: r.id, name: r.name, pass });
        const passes = job.reviews.filter(v => v.pass).length; const fails = job.reviews.length - passes;
        if (passes >= 2) {
          const fee = Math.floor(job.price * FEE_BPS / 10000); const share = Math.floor(fee / job.reviews.length); const dust = fee - share * job.reviews.length;
          for (const v of job.reviews) { const rv = s.reviewers.find(x => x.id === v.reviewer); rv.balance += share; rv.earned += share; }
          w.locked -= BOND; w.balance += BOND + job.price - fee + dust; w.earned += job.price - fee + dust; w.paid += 1;
          credit(job.poster, job.bounty - job.price); close(job, 'Paid');
          log('job_paid', job.id, w.id, `Reviewers passed job #${job.id}; ${w.name} earned ${near(job.price - fee + dust)} NEAR`, job.price - fee + dust);
        } else if (fails >= 2) {
          const share = Math.floor(BOND / job.reviews.length); const dust = BOND - share * job.reviews.length;
          for (const v of job.reviews) { const rv = s.reviewers.find(x => x.id === v.reviewer); rv.balance += share; rv.earned += share; }
          w.locked -= BOND; w.failed += 1; credit(job.poster, job.bounty + dust); close(job, 'Rejected');
          log('job_rejected', job.id, w.id, `Reviewers rejected job #${job.id}; bounty refunded and ${w.name}'s bond paid the review`, job.bounty);
        }
      }
    }
  }

  function step() {
    s.t += 1;
    for (const job of s.jobs) if (job.phase !== 'done') advance(job);
    if (s.t % 2 === 1 && s.jobs.filter(j => j.phase !== 'done').length < 6) postJob();
    for (const a of s.agents) { a.history.push(a.balance + a.locked); if (a.history.length > 60) a.history.shift(); }
    return s;
  }

  /** Every unit paid in is in exactly one place. */
  function invariant() {
    const agents = s.agents.reduce((n, a) => n + a.balance + a.locked, 0);
    const reviewers = s.reviewers.reduce((n, r) => n + r.balance, 0);
    const credits = Object.values(s.credits).reduce((n, c) => n + c, 0);
    const escrow = s.jobs.filter(j => j.phase !== 'done').reduce((n, j) => n + j.bounty, 0);
    const held = agents + reviewers + credits + escrow + s.operator;
    return { agents, reviewers, credits, escrow, operator: s.operator, held, deposited: s.deposited, ok: held === s.deposited };
  }
  const stats = () => ({ jobs: s.jobs.length, paid: s.jobs.filter(j => j.status === 'Paid').length, rejected: s.jobs.filter(j => j.status === 'Rejected').length,
    open: s.jobs.filter(j => j.phase !== 'done').length, alive: s.agents.filter(a => a.balance >= BOND * 2).length, agents: s.agents.length,
    inference: s.operator, earned: s.agents.reduce((n, a) => n + a.earned, 0) });
  return { state: s, step, postJob, addAgent, invariant, stats, agentOf };
}
