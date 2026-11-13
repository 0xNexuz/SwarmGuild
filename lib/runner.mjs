// The swarm's runner. For one job it does whatever can be done next on chain: sealed bids for every agent it
// can act for, reveals, the award, the winner's model call and submission, and the reviewers' votes.
// It is re-entrant: all state is read from the chain each time, so it can stop and resume at any point.
import fs from 'node:fs';
import path from 'node:path';
import { ADAPT_WINDOW, auctionHistory, decideBid, doWork, MAX_RESULT_CHARS, reviewWork } from './agents.mjs';
import { fetchManifest } from './manifest.mjs';
import { commitment, newSalt } from './market.mjs';
import { attestedKeys, sha256 } from './near-ai.mjs';

export const MAX_CHARGE = 5n * 10n ** 22n; // the contract's cap per inference charge
export const MAX_REVIEW_ATTEMPTS = 3; // per reviewer and job: a reviewer that abstains is asked again, but not forever
export const MAX_FETCH_ATTEMPTS = 5; // times the runner asks for an independent agent's published work before treating it as missing
const SECOND = 10n ** 9n;
const OPEN_STATES = ['Open', 'Awarded', 'Submitted'];
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Set ? [...v] : v)));

/** Evidence goes in the repository; bid salts stay outside it until they are revealed on chain. */
export function fileStore({ evidenceDir, secretsFile }) {
  const jobFile = id => path.join(evidenceDir, 'jobs', `${id}.json`);
  const secrets = () => (fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')) : {});
  return {
    readJob: id => (fs.existsSync(jobFile(id)) ? JSON.parse(fs.readFileSync(jobFile(id), 'utf8')) : null),
    writeJob(id, record) { fs.mkdirSync(path.dirname(jobFile(id)), { recursive: true }); fs.writeFileSync(jobFile(id), JSON.stringify(plain(record), null, 2) + '\n'); },
    getSecret: (id, agent) => secrets()[`${id}:${agent}`] ?? null,
    putSecret(id, agent, secret) { const all = secrets(); all[`${id}:${agent}`] = secret; fs.mkdirSync(path.dirname(secretsFile), { recursive: true }); fs.writeFileSync(secretsFile, JSON.stringify(all) + '\n', { mode: 0o600 }); },
  };
}
export function memoryStore() {
  const jobs = new Map(); const secrets = new Map();
  return { jobs, readJob: id => jobs.get(id) ?? null, writeJob: (id, r) => jobs.set(id, plain(r)),
    getSecret: (id, a) => secrets.get(`${id}:${a}`) ?? null, putSecret: (id, a, s) => secrets.set(`${id}:${a}`, s) };
}

/**
 * chain: see lib/chain.mjs. manifests: Map of spec hash -> manifest for the agents shipped in this repository.
 * reviewers: [{ account, manifest }]. ai: options for NEAR AI calls. resultUrl(jobId): where the evidence file will be public.
 */
export function createRunner({ chain, guild, operator, manifests, reviewers, ai, store, resultUrl, fetchImpl = fetch, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const hosted = new Map();
  const view = (method, args) => chain.view(guild, method, args);

  async function manifestFor(agent) {
    if (manifests.has(agent.spec_hash)) return manifests.get(agent.spec_hash);
    if (!agent.hosted) return null; // a self-run agent keeps its own manifest and key
    if (!hosted.has(agent.spec_hash)) {
      try { hosted.set(agent.spec_hash, await fetchManifest(agent.spec_url, agent.spec_hash, { fetchImpl })); }
      catch (error) { log(`Not hosting an agent with manifest ${agent.spec_url}: ${error.message}`); hosted.set(agent.spec_hash, null); }
    }
    return hosted.get(agent.spec_hash);
  }
  // An agent with its own key signs for itself. A hosted agent has no key: the operator signs and names it.
  const signerFor = (id, agent) => (chain.canSign(id) ? { signer: id, agent: null } : agent.hosted && chain.canSign(operator) ? { signer: operator, agent: id } : null);

  // Past auctions, for agents whose price adapts to how they went. A settled job never changes, so it is read once.
  const settledJobs = new Map();
  async function pastAuctions(beforeJobId) {
    const jobs = [];
    for (let id = Math.max(0, beforeJobId - ADAPT_WINDOW); id < beforeJobId; id++) {
      let job = settledJobs.get(id);
      if (!job) { job = { ...await view('get_job', { job_id: id }), id }; if (['Paid', 'Rejected', 'Expired', 'Cancelled'].includes(job.status)) settledJobs.set(id, job); }
      jobs.push(job);
    }
    return jobs;
  }

  async function allAgents() {
    const out = [];
    for (let from = 0; ; from += 100) { const page = await view('get_agents', { from, limit: 100 }); out.push(...page); if (page.length < 100) return out; }
  }

  async function tick(jobId) {
    let job = await view('get_job', { job_id: jobId });
    if (!job) throw new Error(`Job ${jobId} does not exist.`);
    const record = store.readJob(jobId) ?? { jobId, guild, network: chain.networkId, description: job.description, poster: job.poster, bountyYocto: job.bounty, txs: [], bids: {}, work: null, reviews: [], charges: [] };
    const save = () => store.writeJob(jobId, record);
    const send = async (step, signer, method, args, options) => {
      const r = await chain.call(signer, guild, method, args, options);
      record.txs.push({ step, signer, method, txHash: r.txHash }); save();
      log(`job ${jobId}: ${step} ${r.txHash}`);
      return r;
    };
    const attempt = async (step, fn) => { try { return await fn(); } catch (error) { log(`job ${jobId}: ${step} did not go through: ${error.message}`); record.notes = [...(record.notes ?? []), `${step}: ${error.message}`]; save(); return null; } };
    const charge = async (agentId, costYocto, what, chatId) => {
      if (!costYocto || !chain.canSign(operator)) return;
      const agent = await view('get_agent', { agent: agentId });
      if (!agent) return;
      const balance = BigInt(agent.balance);
      const amount = [BigInt(costYocto), MAX_CHARGE, balance].reduce((a, b) => (a < b ? a : b));
      if (amount === 0n) return;
      const r = await attempt(`charge ${agentId}`, () => send(`charge ${agentId} for ${what}`, operator, 'charge_inference', { agent: agentId, amount: amount.toString(), receipt: `job=${jobId} ${what} chat=${chatId}`.slice(0, 300) }));
      if (r) { record.charges.push({ agent: agentId, what, amountYocto: amount.toString(), chatId, txHash: r.txHash }); save(); }
    };
    const now = await chain.nowNs();
    const done = () => { record.final = job; save(); return { status: job.status, done: true }; };
    const waitUntil = ns => ({ status: job.status, done: false, waitUntilNs: BigInt(ns) });

    if (job.status === 'Open') {
      const commitEnd = BigInt(job.commit_end_ns), revealEnd = BigInt(job.reveal_end_ns);
      if (now < commitEnd) {
        const config = await view('get_config');
        for (const [id, agent] of await allAgents()) {
          if (config.reviewers.includes(id) || job.bidders.includes(id) || record.bids[id]) continue;
          const who = signerFor(id, agent); const manifest = who && await manifestFor(agent);
          if (!manifest) continue;
          const history = manifest.pricing?.adaptive === true ? auctionHistory(await pastAuctions(jobId), id, jobId) : [];
          const decision = decideBid(manifest, { id: jobId, description: job.description, bounty: job.bounty }, agent, history);
          if (!decision.bid) { record.bids[id] = { bid: false, reason: decision.reason }; save(); continue; }
          if (await chain.nowNs() > commitEnd - 8n * SECOND) break; // too close to the deadline to land a commit
          const salt = newSalt(); const priceYocto = decision.priceYocto.toString();
          store.putSecret(jobId, id, { priceYocto, salt }); // saved before the commit is sent: without it the bid can never be revealed
          const r = await attempt(`commit ${id}`, () => send(`commit ${id}`, who.signer, 'commit_bid', { job_id: jobId, commitment: commitment(jobId, id, priceYocto, salt), agent: who.agent }));
          record.bids[id] = r ? { bid: true, hosted: agent.hosted, matched: decision.matched, ...(decision.adaptive ? { adaptive: { steps: decision.adaptive.steps, wonLast: history.at(-1) ?? null } } : {}), commitTx: r.txHash } : { bid: false, reason: 'The commit transaction failed.' };
          save();
        }
        return waitUntil(commitEnd + 2n * SECOND);
      }
      if (now < revealEnd) {
        let hidden = 0;
        for (const id of job.bidders) {
          const bid = await view('get_bid', { job_id: jobId, agent: id });
          if (bid.price !== null) continue;
          const agent = await view('get_agent', { agent: id }); const who = signerFor(id, agent); const secret = store.getSecret(jobId, id);
          if (!who || !secret) { hidden++; continue; } // someone else's agent: it reveals for itself
          const r = await attempt(`reveal ${id}`, () => send(`reveal ${id}`, who.signer, 'reveal_bid', { job_id: jobId, price: secret.priceYocto, salt: secret.salt, agent: who.agent }));
          if (r) { Object.assign(record.bids[id] ??= { bid: true }, { priceYocto: secret.priceYocto, salt: secret.salt, revealTx: r.txHash }); save(); } else hidden++;
        }
        if (hidden) return waitUntil(revealEnd + 2n * SECOND);
      }
      await attempt('award', () => send('award', operator, 'award', { job_id: jobId }));
      return { status: 'Open', done: false, waitUntilNs: 0n };
    }

    if (job.status === 'Awarded') {
      const winner = job.winner; const agent = await view('get_agent', { agent: winner });
      const who = signerFor(winner, agent); const manifest = who && await manifestFor(agent);
      const due = BigInt(job.work_due_ns);
      if (now >= due) { await attempt('expire', () => send('expire late work', operator, 'expire', { job_id: jobId })); return { status: 'Awarded', done: false, waitUntilNs: 0n }; }
      if (!manifest) return waitUntil(due + 2n * SECOND); // a self-run agent does its own work
      if (!record.work || record.work.agent !== winner) {
        let work;
        try {
          work = await doWork(manifest, { id: jobId, description: job.description }, ai);
          if (!work.verification.verified) work = await doWork(manifest, { id: jobId, description: job.description }, ai); // one retry for a reply that came back unsigned
        } catch (error) { log(`job ${jobId}: the model call failed, will retry: ${error.message}`); return waitUntil(now + 15n * SECOND); }
        if (manifest.lab === 'tamper') { // the lab agent that fails on purpose: its result is changed after the model signed it
          work.result = `${work.result}\n(This line was added after the model signed its reply.)`; work.resultHash = sha256(work.result);
        }
        record.work = { agent: winner, hosted: agent.hosted, lab: manifest.lab ?? null, result: work.result, resultHash: work.resultHash, proof: work.proof,
          transcript: work.transcript, usage: work.usage, costYocto: work.costYocto, selfCheck: work.verification };
        save();
      }
      const w = record.work;
      const r = await attempt('submit', () => send(`submit ${winner}`, who.signer, 'submit_work', { job_id: jobId, result_hash: w.resultHash, result_url: resultUrl(jobId),
        model: w.proof.model, signed_text: w.proof.signedText ?? '', signature: w.proof.signature ?? '', signing_address: w.proof.signingAddress ?? '', agent: who.agent }));
      if (!r) return waitUntil(now + 10n * SECOND);
      await charge(winner, w.costYocto, 'work', w.proof.chatId);
      return { status: 'Awarded', done: false, waitUntilNs: 0n };
    }

    if (job.status === 'Submitted') {
      const due = BigInt(job.review_due_ns);
      if (now >= due) { await attempt('expire', () => send('expire undecided review', operator, 'expire', { job_id: jobId })); return { status: 'Submitted', done: false, waitUntilNs: 0n }; }
      const onChain = job.work;
      let published = record.work?.resultHash === onChain.result_hash ? record.work : null;
      if (!published) { // an independent agent: read what it published at its result URL, and keep a copy as evidence
        try {
          if (!/^https:\/\//.test(onChain.result_url)) throw new Error('The result URL must start with https://');
          const response = await fetchImpl(onChain.result_url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = JSON.parse(Buffer.from(await response.arrayBuffer()).subarray(0, 200_000).toString('utf8'));
          published = body.work ?? body;
          const result = typeof published.result === 'string' ? published.result.slice(0, 2 * MAX_RESULT_CHARS) : '';
          record.work = { agent: job.winner, independent: true, resultUrl: onChain.result_url, result, resultHash: sha256(result),
            transcript: published.transcript ?? null, proof: { signatureKind: published.proof?.signatureKind ?? null } };
          save();
        } catch (error) {
          // A slow or briefly unreachable host must not cost the agent its bond: ask again a few times first.
          record.fetchAttempts = (record.fetchAttempts ?? 0) + 1; save();
          log(`job ${jobId}: could not read the work at ${onChain.result_url} (try ${record.fetchAttempts} of ${MAX_FETCH_ATTEMPTS}): ${error.message}`);
          if (record.fetchAttempts < MAX_FETCH_ATTEMPTS && now + 60n * SECOND < due) return waitUntil(now + 20n * SECOND);
          published = {};
          record.work = { agent: job.winner, independent: true, unreadable: true, resultUrl: onChain.result_url, result: '', resultHash: sha256(''), transcript: null, proof: { signatureKind: null } };
          save();
        }
      }
      let attested;
      try { attested = [...(await attestedKeys(onChain.model, ai)).keys]; }
      catch (error) { log(`job ${jobId}: no attestation report, will retry: ${error.message}`); return waitUntil(now + 15n * SECOND); }
      // The reviewers check the published text against what is on chain, never against the worker's own claims.
      const submission = { result: published.result ?? '', resultHash: onChain.result_hash, transcript: published.transcript, attestedKeys: attested,
        proof: { model: onChain.model, signedText: onChain.signed_text, signature: onChain.signature, signingAddress: onChain.signing_address, signatureKind: published.proof?.signatureKind ?? null } };
      const tries = (record.reviewAttempts ??= {});
      let abstainedNow = false;
      // Two matching votes settle a job, so the reviewer who would go third rarely votes. The first reviewer in the
      // contract's panel (integrity: it checks the signature and looks for obeyed injected instructions) votes on
      // every job. The others take turns at second place by job number, so each of them votes on every other job.
      const [lead, ...others] = reviewers;
      const panel = [lead, ...others.map((_, i) => others[(i + jobId) % others.length])];
      for (const reviewer of panel) {
        if (!chain.canSign(reviewer.account) || job.reviews.some(r => r.reviewer === reviewer.account)) continue;
        if ((tries[reviewer.account] ?? 0) >= MAX_REVIEW_ATTEMPTS) continue;
        tries[reviewer.account] = (tries[reviewer.account] ?? 0) + 1; save();
        let out;
        try { out = await reviewWork(reviewer.manifest, { id: jobId, description: job.description }, submission, ai); }
        catch (error) { log(`job ${jobId}: ${reviewer.account} could not review, will retry: ${error.message}`); return waitUntil(now + 15n * SECOND); }
        const entry = { reviewer: reviewer.account, vote: out.vote, report: out.report, reportHash: out.reportHash, transcript: out.transcript, costYocto: out.costYocto };
        if (out.proof) await charge(reviewer.account, out.costYocto, 'review', out.proof.chatId);
        if (out.vote === 'abstain') { // no vote goes on chain; the attempt is kept in the evidence and the reviewer is asked again
          log(`job ${jobId}: ${reviewer.account} abstained (attempt ${tries[reviewer.account]} of ${MAX_REVIEW_ATTEMPTS}): ${out.report.reasons[0]}`);
          (record.abstentions ??= []).push({ ...entry, attempt: tries[reviewer.account] }); save(); abstainedNow = true;
          continue;
        }
        const r = await attempt(`review ${reviewer.account}`, () => send(`review ${reviewer.account} ${out.vote}`, reviewer.account, 'review',
          { job_id: jobId, pass: out.vote === 'pass', report_hash: out.reportHash, note: String(out.report.reasons?.[0] ?? '').slice(0, 200) }));
        if (!r) continue;
        record.reviews = [...record.reviews.filter(x => x.reviewer !== reviewer.account), { ...entry, txHash: r.txHash }]; save();
        job = await view('get_job', { job_id: jobId });
        if (job.status !== 'Submitted') return done();
      }
      const canRetry = reviewers.some(r => chain.canSign(r.account) && !job.reviews.some(v => v.reviewer === r.account) && (tries[r.account] ?? 0) < MAX_REVIEW_ATTEMPTS);
      if (abstainedNow && canRetry) return waitUntil(now + 10n * SECOND);
      // Every reviewer this runner speaks for has voted or given up, and the panel has not decided. Only the deadline can settle it now.
      return { ...waitUntil(due + 2n * SECOND), undecided: true };
    }
    return done();
  }

  /** Runs one job until it is settled. Sleeps on the chain's clock, in steps short enough to notice other agents. */
  async function runJob(jobId, { maxMinutes = 30 } = {}) {
    const deadline = Date.now() + maxMinutes * 60_000;
    for (;;) {
      const step = await tick(jobId);
      if (step.done) return step;
      if (Date.now() > deadline) throw new Error(`Job ${jobId} was not settled after ${maxMinutes} minutes (status ${step.status}).`);
      const waitNs = step.waitUntilNs - await chain.nowNs();
      if (step.undecided && waitNs > 120n * SECOND) { // do not sit idle for the rest of the review window
        const expiresAt = new Date(Number(step.waitUntilNs / 1_000_000n)).toISOString();
        log(`job ${jobId}: the review panel has not decided. Anyone can expire the job after ${expiresAt}; resume it then.`);
        return { status: step.status, done: false, undecided: true, expiresAt };
      }
      await sleep(Math.min(20_000, Math.max(1000, Number(waitNs / 1_000_000n))));
    }
  }

  async function postJob(poster, description, bountyYocto, { commitSeconds = 90, revealSeconds = 90, workSeconds = 600 } = {}) {
    const ns = s => (BigInt(s) * SECOND).toString();
    const r = await chain.call(poster, guild, 'post_job', { description, commit_window_ns: ns(commitSeconds), reveal_window_ns: ns(revealSeconds), work_window_ns: ns(workSeconds) }, { depositYocto: bountyYocto });
    const jobId = r.value;
    store.writeJob(jobId, { jobId, guild, network: chain.networkId, description, poster, bountyYocto: String(bountyYocto), txs: [{ step: 'post', signer: poster, method: 'post_job', txHash: r.txHash }], bids: {}, work: null, reviews: [], charges: [] });
    log(`job ${jobId}: posted ${r.txHash}`);
    return jobId;
  }

  /**
   * The serving loop. It serves every unsettled job, including ones posted by other people, and works on all
   * of them in turn, so a job posted while another is in review still gets its bids in time. It starts no new
   * job after `minutes` or `maxJobs`, then finishes the ones it has started, because a bid it sealed can only be
   * revealed by this process. `onSettled(jobId, status)` runs after each job; `canServe()` can refuse a new one.
   */
  async function watch({ minutes = 10, pollMs = 8000, maxJobs = Infinity, graceMinutes = 12, onSettled = async () => {}, canServe = async () => true } = {}) {
    const until = Date.now() + minutes * 60_000; const hardStop = until + graceMinutes * 60_000;
    const settled = new Set(); const started = new Set(); const parked = new Set(); const wakeNs = new Map(); const served = [];
    const active = () => [...started].filter(id => !settled.has(id) && !parked.has(id));
    let closed = false; // set when the runner can no longer serve, for example when a key's gas allowance is used up
    for (;;) {
      const accepting = !closed && Date.now() < until && started.size < maxJobs;
      if (!accepting && !active().length) return served;
      if (Date.now() > hardStop) { log(`stopping with jobs still open: ${active().join(', ')}`); return served; }
      let count = 0, now = 0n;
      try { ({ job_count: count } = await view('get_config')); if (active().length) now = await chain.nowNs(); }
      catch (error) { log(`could not read the contract, will retry: ${error.message}`); await sleep(pollMs); continue; }
      for (let id = 0; id < count; id++) {
        if (settled.has(id)) continue;
        try {
          if (!started.has(id)) {
            const job = await view('get_job', { job_id: id });
            if (!OPEN_STATES.includes(job.status)) { settled.add(id); continue; }
            if (!accepting || started.size >= maxJobs) continue;
            if (!await canServe()) { closed = true; log('the runner cannot take new jobs; finishing the ones it has'); continue; }
            started.add(id); log(`job ${id}: picked up (${job.status})`);
          } else if ((wakeNs.get(id) ?? 0n) > now) continue;
          const step = await tick(id);
          if (step.done) { settled.add(id); parked.delete(id); served.push({ jobId: id, status: step.status }); await onSettled(id, step.status); continue; }
          wakeNs.set(id, step.waitUntilNs);
          if (step.undecided && !parked.has(id)) { parked.add(id); log(`job ${id}: the review panel has not decided; it will be expired after its review deadline.`); }
        } catch (error) { log(`job ${id}: ${error.message}; trying again shortly`); wakeNs.set(id, now + 30n * SECOND); }
      }
      await sleep(active().length ? 2000 : pollMs);
    }
  }

  return { tick, runJob, postJob, watch };
}
