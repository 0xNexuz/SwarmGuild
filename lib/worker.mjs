// An independent agent: one worker with its own NEAR account and key, its own NEAR AI account and its own
// manifest, run by whoever owns it. It needs nothing from the swarm's runner to bid, reveal, work or submit.
// The swarm's reviewers then check what it published, exactly as they check a hosted agent's work.
// Like the runner, it is re-entrant: all state is read from the chain each time.
import { decideBid, doWork } from './agents.mjs';
import { commitment, newSalt } from './market.mjs';

const SECOND = 10n ** 9n;
const OPEN_STATES = ['Open', 'Awarded'];

/**
 * chain: see lib/chain.mjs, holding the key for `account`. manifest: this agent's own manifest.
 * ai: options for NEAR AI calls (this agent's own key). store: getSecret/putSecret for bid salts.
 * publish(jobId, payload): makes the payload public and resolves to its https URL once it can be fetched.
 * price(decision, job, me): optional; return a price in yocto to bid something other than the manifest's rule.
 */
export function createWorker({ chain, guild, account, manifest, ai, store, publish, price = null, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const view = (method, args) => chain.view(guild, method, args);
  const send = async (jobId, step, method, args) => { const r = await chain.call(account, guild, method, args); log(`job ${jobId}: ${step} ${r.txHash}`); return r; };
  const work = new Map(); // job id -> the work this process has done, kept so a failed submit does not pay for a second model call
  const waitUntil = (status, ns) => ({ status, done: false, waitUntilNs: BigInt(ns) });

  async function tick(jobId) {
    const job = await view('get_job', { job_id: jobId });
    if (!job) throw new Error(`Job ${jobId} does not exist.`);
    const now = await chain.nowNs();
    const mine = job.bidders.includes(account);

    if (job.status === 'Open') {
      const commitEnd = BigInt(job.commit_end_ns), revealEnd = BigInt(job.reveal_end_ns);
      if (now < commitEnd) {
        if (!mine && !store.getSecret(jobId, account)) {
          const me = await view('get_agent', { agent: account });
          if (!me) throw new Error(`${account} is not registered as an agent on ${guild}.`);
          const decision = decideBid(manifest, { id: jobId, description: job.description, bounty: job.bounty }, me);
          if (!decision.bid) { log(`job ${jobId}: not bidding. ${decision.reason}`); return { status: job.status, done: true, bid: false }; }
          if (now > commitEnd - 8n * SECOND) return { status: job.status, done: true, bid: false }; // too close to the deadline to land a commit
          const own = price ? BigInt(await price(decision, job, me)) : decision.priceYocto;
          const priceYocto = (own > BigInt(job.bounty) ? BigInt(job.bounty) : own).toString(); const salt = newSalt();
          store.putSecret(jobId, account, { priceYocto, salt }); // saved before the commit is sent: without it the bid can never be revealed
          await send(jobId, 'sealed a bid', 'commit_bid', { job_id: jobId, commitment: commitment(jobId, account, priceYocto, salt), agent: null });
        }
        return waitUntil(job.status, commitEnd + 2n * SECOND);
      }
      if (!mine) return { status: job.status, done: true, bid: false };
      if (now < revealEnd) {
        const bid = await view('get_bid', { job_id: jobId, agent: account }); const secret = store.getSecret(jobId, account);
        if (bid.price === null && secret) await send(jobId, 'revealed its price', 'reveal_bid', { job_id: jobId, price: secret.priceYocto, salt: secret.salt, agent: null });
        if (bid.price === null && !secret) { log(`job ${jobId}: the salt for this bid is gone, so it cannot be revealed and its bond is lost.`); return { status: job.status, done: true, bid: true }; }
      }
      // Anyone may award once every bid is revealed or the reveal window is over. Do it if nobody has.
      if (now < revealEnd) {
        const prices = await Promise.all(job.bidders.map(async b => (await view('get_bid', { job_id: jobId, agent: b })).price));
        if (prices.some(p => p === null)) return waitUntil(job.status, revealEnd + 2n * SECOND);
      }
      try { await send(jobId, 'asked the contract to award', 'award', { job_id: jobId }); } catch { /* someone else awarded first */ }
      return waitUntil(job.status, now + 3n * SECOND);
    }

    if (job.status === 'Awarded' && job.winner === account) {
      if (now >= BigInt(job.work_due_ns)) { log(`job ${jobId}: the work deadline has passed.`); return { status: job.status, done: true, won: true }; }
      if (!work.has(jobId)) {
        let made;
        try {
          made = await doWork(manifest, { id: jobId, description: job.description }, ai);
          if (!made.verification.verified) made = await doWork(manifest, { id: jobId, description: job.description }, ai); // one retry for a reply that came back unsigned
        } catch (error) { log(`job ${jobId}: the model call failed, will retry: ${error.message}`); return waitUntil(job.status, now + 15n * SECOND); }
        work.set(jobId, { made, url: null });
      }
      const entry = work.get(jobId); const w = entry.made;
      // The reviewers read the result and the signed bytes from this URL, so it must be public before the hash goes on chain.
      entry.url ??= await publish(jobId, { jobId, guild, network: chain.networkId, agent: account,
        work: { agent: account, result: w.result, resultHash: w.resultHash, proof: w.proof, transcript: w.transcript, usage: w.usage } });
      await send(jobId, 'submitted its work', 'submit_work', { job_id: jobId, result_hash: w.resultHash, result_url: entry.url,
        model: w.proof.model, signed_text: w.proof.signedText ?? '', signature: w.proof.signature ?? '', signing_address: w.proof.signingAddress ?? '', agent: null });
      return { status: 'Submitted', done: true, won: true, submitted: true };
    }
    return { status: job.status, done: true, won: job.winner === account };
  }

  /** Serves every open job for `minutes`: bids where the manifest matches, and does the work for each job it wins. */
  async function watch({ minutes = 60, pollMs = 8000, graceMinutes = 12 } = {}) {
    const until = Date.now() + minutes * 60_000; const hardStop = until + graceMinutes * 60_000;
    const finished = new Set(); const wakeNs = new Map(); const served = [];
    for (;;) {
      let count = 0, now = 0n;
      try { ({ job_count: count } = await view('get_config')); now = await chain.nowNs(); }
      catch (error) { log(`could not read the contract, will retry: ${error.message}`); await sleep(pollMs); continue; }
      let active = 0;
      for (let id = 0; id < count; id++) {
        if (finished.has(id)) continue;
        try {
          const first = !wakeNs.has(id);
          if (first) { const job = await view('get_job', { job_id: id }); if (!OPEN_STATES.includes(job.status)) { finished.add(id); continue; } }
          const bidding = store.getSecret(id, account) !== null;
          if (Date.now() > until && !bidding) { finished.add(id); continue; } // out of time: finish only the jobs it already bid on
          if ((wakeNs.get(id) ?? 0n) > now) { active++; continue; }
          const step = await tick(id);
          if (step.done) { finished.add(id); if (step.won || step.bid !== false) served.push({ jobId: id, status: step.status, won: Boolean(step.won), submitted: Boolean(step.submitted) }); continue; }
          wakeNs.set(id, step.waitUntilNs); active++;
        } catch (error) { log(`job ${id}: ${error.message}; trying again shortly`); wakeNs.set(id, now + 20n * SECOND); active++; }
      }
      if ((Date.now() > until && !active) || Date.now() > hardStop) return served;
      await sleep(active ? 2000 : pollMs);
    }
  }

  return { tick, watch };
}
