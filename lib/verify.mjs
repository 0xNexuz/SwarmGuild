// Rechecks one job's evidence file against the chain. Nothing here trusts the file: every hash and
// signature is recomputed and compared with what the contract stored.
import { MAX_RESULT_CHARS, jobMessage } from './agents.mjs';
import { failureText } from './chain.mjs';
import { readTranscript, sha256, verifyProof } from './near-ai.mjs';

export async function verifyJob(record, chain, { guild, checkTransactions = true } = {}) {
  const out = [];
  const add = (check, ok, detail = '') => out.push({ job: record.jobId, check, ok: Boolean(ok), detail: String(detail) });
  const job = await chain.view(guild, 'get_job', { job_id: record.jobId });
  if (!job) { add('The job exists on chain', false); return out; }
  add('The job text and bounty on chain match the evidence file', job.description === record.description && job.bounty === record.bountyYocto);
  add(`The job is settled on chain as ${job.status}`, ['Paid', 'Rejected', 'Cancelled', 'Expired'].includes(job.status) && record.final?.status === job.status, job.status);

  if (checkTransactions) {
    for (const t of record.txs) {
      const outcome = await chain.tx(t.txHash, t.signer);
      const failure = outcome && (outcome.status?.Failure ?? outcome.receipts_outcome?.map(r => r.outcome?.status?.Failure).find(Boolean));
      const call = outcome?.transaction?.actions?.[0]?.FunctionCall;
      add(`${t.step}: final, successful, signed by ${t.signer}`,
        outcome && !failure && outcome.transaction.signer_id === t.signer && outcome.transaction.receiver_id === guild && call?.method_name === t.method,
        `${t.txHash}${failure ? ` ${failureText(failure)}` : outcome ? '' : ' not found'}`);
    }
  }

  for (const [agent, bid] of Object.entries(record.bids ?? {})) {
    if (!bid.bid) continue;
    const onChain = await chain.view(guild, 'get_bid', { job_id: record.jobId, agent });
    add(`${agent}'s revealed price matches its sealed commitment`, onChain && onChain.price === bid.priceYocto && onChain.commitment === sha256(`${record.jobId}:${agent}:${bid.priceYocto}:${bid.salt}`), bid.priceYocto);
  }
  if (job.winner) {
    const prices = await Promise.all(job.bidders.map(async b => [b, (await chain.view(guild, 'get_bid', { job_id: record.jobId, agent: b })).price]));
    const lowest = prices.filter(([, p]) => p !== null).reduce((m, [, p]) => (BigInt(p) < m ? BigInt(p) : m), BigInt(job.price));
    add('The winner had the lowest revealed price', BigInt(job.price) === lowest, `${job.winner} at ${job.price}`);
  }

  if (job.work) {
    const w = record.work ?? {};
    const signed = w.transcript ? readTranscript(job.work.model, w.transcript) : null;
    const proof = { model: job.work.model, signedText: job.work.signed_text, signature: job.work.signature, signingAddress: job.work.signing_address,
      signatureKind: w.proof?.signatureKind, expectedText: signed?.expectedText ?? null };
    const sig = verifyProof(proof);
    add('The published result has the hash stored on chain', sha256(w.result ?? '') === job.work.result_hash, job.work.result_hash);
    add('The signature on chain is a valid TEE signature over the published request and reply', signed && sig.verified, job.work.signing_address);
    add('The signed request is this job, sent to the model named on chain', signed && signed.request?.model === job.work.model && String(signed.request?.messages?.at(-1)?.content ?? '').startsWith(jobMessage({ id: record.jobId, description: job.description })));
    const isReply = Boolean(signed) && signed.replyText.trim().slice(0, MAX_RESULT_CHARS) === w.result;
    if (job.status === 'Paid') add('Paid work is exactly the reply the model signed', isReply);
    else if (w.lab === 'tamper') add('The lab agent\'s result is not the reply the model signed, which is why it was rejected', !isReply);
  }

  for (const review of job.reviews) {
    const mine = (record.reviews ?? []).find(r => r.reviewer === review.reviewer);
    const okHash = mine && mine.reportHash === review.report_hash && sha256(JSON.stringify(mine.report)) === review.report_hash && (mine.vote === 'pass') === review.pass;
    add(`${review.reviewer}'s vote (${review.pass ? 'pass' : 'fail'}) matches its published report`, okHash, review.report_hash);
    if (mine?.report?.stage === 'model') {
      const p = mine.report.reviewProof; const signed = mine.transcript ? readTranscript(p.model, mine.transcript) : null;
      add(`${review.reviewer}'s verdict came from a TEE-signed model reply about this job's work`,
        signed && verifyProof({ ...p, expectedText: signed.expectedText }).verified && String(signed.request?.messages?.at(-1)?.content ?? '').includes(record.work?.result ?? '\u0000'), p.signingAddress);
    }
  }
  if (job.status === 'Paid' || job.status === 'Rejected') {
    const passes = job.reviews.filter(r => r.pass).length;
    add('The outcome follows the votes', job.status === 'Paid' ? passes >= 2 : job.reviews.length - passes >= 2, `${passes} pass, ${job.reviews.length - passes} fail`);
  }
  return out;
}
