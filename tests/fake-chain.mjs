// A small in-memory stand-in for the guild contract, with the same method names, error words and payouts as
// contracts/swarm/src/lib.rs, so the runner can be tested offline. The CI job in sandbox/ runs the same
// runner against the real WASM.
import { commitment } from '../lib/market.mjs';

const BOND = 10n ** 22n, MAX_CHARGE = 5n * 10n ** 22n;
const fail = word => { throw Object.assign(new Error(`failed: ${word}`), { failed: true, reason: word }); };

export function fakeChain({ guild = 'guild.test', owner = 'owner.test', operator = 'operator.test', reviewers, threshold = 2, signers }) {
  const state = { agents: new Map(), jobs: [], bids: new Map(), credits: new Map(), txs: [], nowNs: 1_000n * 10n ** 9n };
  const credit = (who, amount) => state.credits.set(who, (state.credits.get(who) ?? 0n) + amount);
  const payReviewers = (voters, total) => {
    const share = total / BigInt(voters.length);
    for (const v of voters) { const a = state.agents.get(v); if (a) { a.balance += share; a.earned += share; } else credit(v, share); }
    return total - share * BigInt(voters.length);
  };
  const actingFor = (caller, agent) => {
    if (!agent || agent === caller) return caller;
    if (caller !== operator) fail('ONLY_OPERATOR_FOR_HOSTED');
    if (!state.agents.get(agent)?.hosted) fail('NOT_HOSTED');
    return agent;
  };
  const job = id => state.jobs[id] ?? fail('NO_JOB');
  const methods = {
    add_agent(caller, a, deposit) {
      if (deposit < 10n ** 23n) fail('MIN_AGENT_FUNDING');
      if (state.agents.has(a.agent)) fail('AGENT_EXISTS');
      if (a.hosted && a.agent !== caller && !a.agent.endsWith(`.${caller}`)) fail('HOSTED_NAME_NOT_YOURS');
      state.agents.set(a.agent, { backer: caller, name: a.name, model: a.model, spec_hash: a.spec_hash, spec_url: a.spec_url, hosted: a.hosted,
        balance: deposit, locked: 0n, earned: 0n, inference_spent: 0n, jobs_won: 0, jobs_paid: 0, jobs_failed: 0 });
    },
    charge_inference(caller, { agent, amount, receipt }) {
      if (caller !== operator) fail('ONLY_OPERATOR');
      const n = BigInt(amount); const a = state.agents.get(agent) ?? fail('NO_AGENT');
      if (n <= 0n || n > MAX_CHARGE) fail('CHARGE_OUT_OF_RANGE');
      if (receipt.length > 300) fail('TEXT_TOO_LONG');
      if (n > a.balance) fail('INSUFFICIENT_BALANCE');
      a.balance -= n; a.inference_spent += n; credit(operator, n);
    },
    post_job(caller, a, deposit) {
      if (deposit < 5n * 10n ** 22n) fail('MIN_BOUNTY');
      const id = state.jobs.length; const commitEnd = state.nowNs + BigInt(a.commit_window_ns);
      state.jobs.push({ id, poster: caller, description: a.description, bounty: deposit, commit_end_ns: commitEnd, reveal_end_ns: commitEnd + BigInt(a.reveal_window_ns),
        work_window_ns: BigInt(a.work_window_ns), status: 'Open', bidders: [], winner: null, price: null, work_due_ns: null, review_due_ns: null, work: null, reviews: [] });
      return id;
    },
    commit_bid(caller, a) {
      const id = actingFor(caller, a.agent); const j = job(a.job_id);
      if (reviewers.includes(id)) fail('REVIEWERS_CANNOT_BID');
      if (j.status !== 'Open' || state.nowNs >= j.commit_end_ns) fail('COMMIT_CLOSED');
      if (j.bidders.includes(id)) fail('ALREADY_BID');
      const agent = state.agents.get(id) ?? fail('NOT_AN_AGENT');
      if (agent.balance < BOND) fail('INSUFFICIENT_BALANCE');
      agent.balance -= BOND; agent.locked += BOND; j.bidders.push(id);
      state.bids.set(`${a.job_id}:${id}`, { commitment: a.commitment, price: null, committed_at: state.nowNs });
    },
    reveal_bid(caller, a) {
      const id = actingFor(caller, a.agent); const j = job(a.job_id);
      if (j.status !== 'Open' || state.nowNs < j.commit_end_ns || state.nowNs >= j.reveal_end_ns) fail('NOT_REVEAL_PHASE');
      const price = BigInt(a.price); if (price <= 0n || price > j.bounty) fail('PRICE_OUT_OF_RANGE');
      const bid = state.bids.get(`${a.job_id}:${id}`) ?? fail('NO_BID');
      if (bid.price !== null) fail('ALREADY_REVEALED');
      if (commitment(a.job_id, id, price, a.salt) !== bid.commitment) fail('COMMITMENT_MISMATCH');
      bid.price = price;
    },
    award(_caller, a) {
      const j = job(a.job_id); if (j.status !== 'Open') fail('NOT_OPEN');
      const prices = j.bidders.map(b => state.bids.get(`${a.job_id}:${b}`).price);
      if (!(state.nowNs >= j.reveal_end_ns || (state.nowNs >= j.commit_end_ns && prices.every(p => p !== null)))) fail('REVEAL_NOT_OVER');
      let best = -1;
      prices.forEach((p, i) => { if (p !== null && (best < 0 || p < prices[best])) best = i; });
      j.bidders.forEach((b, i) => {
        const agent = state.agents.get(b);
        if (prices[i] === null) { agent.locked -= BOND; credit(j.poster, BOND); } else if (i !== best) { agent.locked -= BOND; agent.balance += BOND; }
      });
      if (best < 0) { j.status = 'Cancelled'; credit(j.poster, j.bounty); return; }
      j.status = 'Awarded'; j.winner = j.bidders[best]; j.price = prices[best]; j.work_due_ns = state.nowNs + j.work_window_ns;
      state.agents.get(j.winner).jobs_won++;
    },
    submit_work(caller, a) {
      const id = actingFor(caller, a.agent); const j = job(a.job_id);
      if (j.status !== 'Awarded') fail('NOT_AWARDED');
      if (j.winner !== id) fail('ONLY_WINNER');
      if (state.nowNs >= j.work_due_ns) fail('WORK_LATE');
      if (!/^[0-9a-f]{64}$/i.test(a.result_hash)) fail('BAD_RESULT_HASH');
      if ([a.result_url, a.model, a.signed_text, a.signature, a.signing_address].some(s => s.length > 300)) fail('TEXT_TOO_LONG');
      j.work = { result_hash: a.result_hash, result_url: a.result_url, model: a.model, signed_text: a.signed_text, signature: a.signature, signing_address: a.signing_address, submitted_at: state.nowNs };
      j.status = 'Submitted'; j.review_due_ns = state.nowNs + 3600n * 10n ** 9n;
    },
    review(caller, a) {
      if (!reviewers.includes(caller)) fail('ONLY_REVIEWER');
      if (a.report_hash.length !== 64 || a.note.length > 300) fail('BAD_REPORT');
      const j = job(a.job_id); if (j.status !== 'Submitted') fail('NOT_SUBMITTED');
      if (state.nowNs >= j.review_due_ns) fail('REVIEW_LATE');
      if (j.reviews.some(r => r.reviewer === caller)) fail('ALREADY_REVIEWED');
      j.reviews.push({ reviewer: caller, pass: a.pass, report_hash: a.report_hash, note: a.note });
      const passes = j.reviews.filter(r => r.pass).length, fails = j.reviews.length - passes;
      const voters = j.reviews.map(r => r.reviewer); const agent = state.agents.get(j.winner);
      if (passes >= threshold) {
        const fee = j.price / 10n; const dust = payReviewers(voters, fee);
        agent.locked -= BOND; agent.balance += BOND + j.price - fee + dust; agent.earned += j.price - fee + dust; agent.jobs_paid++;
        credit(j.poster, j.bounty - j.price); j.status = 'Paid';
      } else if (fails > reviewers.length - threshold) {
        agent.locked -= BOND; agent.jobs_failed++;
        credit(j.poster, j.bounty + payReviewers(voters, BOND)); j.status = 'Rejected';
      }
    },
    expire(_caller, a) {
      const j = job(a.job_id); const agent = state.agents.get(j.winner) ?? fail('NOT_EXPIRABLE');
      if (j.status === 'Awarded') { if (state.nowNs < j.work_due_ns) fail('NOT_DUE'); agent.locked -= BOND; agent.jobs_failed++; credit(j.poster, j.bounty + BOND); }
      else if (j.status === 'Submitted') { if (state.nowNs < j.review_due_ns) fail('NOT_DUE'); agent.locked -= BOND; agent.balance += BOND; credit(j.poster, j.bounty); }
      else fail('NOT_EXPIRABLE');
      j.status = 'Expired';
    },
  };
  const json = value => JSON.parse(JSON.stringify(value ?? null, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const views = {
    get_config: () => ({ owner, operator, reviewers, review_threshold: threshold, job_count: state.jobs.length }),
    get_agent: a => state.agents.get(a.agent) ?? null,
    get_agents: a => [...state.agents].slice(a.from ?? 0, (a.from ?? 0) + (a.limit ?? 50)),
    get_job: a => state.jobs[a.job_id] ?? null,
    get_bid: a => state.bids.get(`${a.job_id}:${a.agent}`) ?? null,
    get_credit: a => state.credits.get(a.account) ?? 0n,
  };
  /** Every yoctoNEAR paid in is in an agent's balance or bond, a credit, or an unsettled job's escrow. */
  const held = () => [...state.agents.values()].reduce((t, a) => t + a.balance + a.locked, 0n) + [...state.credits.values()].reduce((t, c) => t + c, 0n)
    + state.jobs.filter(j => ['Open', 'Awarded', 'Submitted'].includes(j.status)).reduce((t, j) => t + j.bounty, 0n);
  return {
    state, held, networkId: 'fake',
    advance(seconds) { state.nowNs += BigInt(Math.round(seconds * 1e9)); },
    canSign: id => signers.includes(id),
    nowNs: async () => state.nowNs,
    view: async (_contract, method, args = {}) => json(views[method](args)),
    async call(signer, _contract, method, args, { depositYocto = 0n, gasTgas = 30 } = {}) {
      if (!signers.includes(signer)) throw new Error(`No key for ${signer}`);
      state.nowNs += 10n ** 9n; // a block passes
      const txHash = `tx${state.txs.length + 1}`;
      state.txs.push({ txHash, signer, method, args: json(args), gasTgas });
      const value = methods[method](signer, args, BigInt(depositYocto));
      return { txHash, value: value ?? null };
    },
  };
}
