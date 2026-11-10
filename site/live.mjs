// The Testnet view. Everything it shows is read in the visitor's browser from public NEAR RPC and from the
// evidence files the on-chain result URLs point to. Nothing here comes from the simulation.
export const GUILD = 'guild.swarmguild-99c7a546.testnet';
export const OWNER = GUILD.slice('guild.'.length);
const RPCS = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
const RAW = 'https://raw.githubusercontent.com/0xNexuz/SwarmGuild/main';
const EXPLORER = 'https://testnet.nearblocks.io';
const REPO = 'https://github.com/0xNexuz/SwarmGuild';
const BOND = 10n ** 22n;
const SETTLED = ['Paid', 'Rejected', 'Cancelled', 'Expired'];

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** yoctoNEAR as a short decimal. Display only. */
export const near = (yocto, digits = 4) => (Number(BigInt(yocto ?? 0) / 10n ** 15n) / 1e9).toLocaleString('en', { maximumFractionDigits: digits });
const short = id => String(id).replace(`.${OWNER}`, '');
const link = (href, text) => (/^https:\/\//.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));
const txLink = hash => link(`${EXPLORER}/txns/${hash}`, `${hash.slice(0, 8)}…`);
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function rpc(params) {
  let last;
  for (const url of RPCS) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'swarmguild-site', method: 'query', params: { finality: 'final', ...params } }) });
      const payload = await response.json();
      if (payload.result && !payload.result.error) return payload.result;
      last = new Error(payload.error?.cause?.name ?? payload.result?.error ?? 'RPC error');
    } catch (error) { last = error; }
  }
  throw last;
}
async function view(method, args = {}) {
  const result = await rpc({ request_type: 'call_function', account_id: GUILD, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

/** One read of the whole contract: about ten RPC calls. */
export async function loadChain() {
  const [config, account, keys, agents] = await Promise.all([
    view('get_config'), rpc({ request_type: 'view_account', account_id: GUILD }), rpc({ request_type: 'view_access_key_list', account_id: GUILD }), view('get_agents', { from: 0, limit: 100 })]);
  const jobs = await Promise.all(Array.from({ length: config.job_count }, (_, id) => view('get_job', { job_id: id })));
  return { config, codeHash: account.code_hash, keyCount: keys.keys.length, agents, jobs, readAt: new Date() };
}

export function chainStats(chain) {
  const count = status => chain.jobs.filter(j => j.status === status).length;
  const sum = field => chain.agents.reduce((total, [, a]) => total + BigInt(a[field]), 0n);
  const workers = chain.agents.filter(([id]) => !chain.config.reviewers.includes(id));
  return { jobs: chain.jobs.length, paid: count('Paid'), rejected: count('Rejected'), expired: count('Expired'), open: chain.jobs.filter(j => !SETTLED.includes(j.status)).length,
    agents: workers.length, hosted: workers.filter(([, a]) => a.hosted).length, earned: sum('earned'), inference: sum('inference_spent') };
}

const phase = job => {
  if (SETTLED.includes(job.status)) return job.status;
  const now = BigInt(Date.now()) * 1_000_000n;
  if (job.status === 'Open') return now < BigInt(job.commit_end_ns) ? 'sealing bids' : now < BigInt(job.reveal_end_ns) ? 'revealing bids' : 'awaiting award';
  return job.status === 'Awarded' ? 'agent working' : 'in review';
};
const votes = (job, panel) => `<span class="votes" aria-label="${job.reviews.filter(v => v.pass).length} pass, ${job.reviews.filter(v => !v.pass).length} fail">${panel.map(r => { const v = job.reviews.find(x => x.reviewer === r); return `<i data-v="${v ? (v.pass ? 'pass' : 'fail') : ''}"></i>`; }).join('')}</span>`;
const agentName = (chain, id) => chain.agents.find(([a]) => a === id)?.[1].name ?? short(id);
const kindOf = (chain, id, a) => (chain.config.reviewers.includes(id) ? 'reviewer · own key' : /lab/i.test(a.name) ? 'lab agent · fails on purpose' : a.hosted ? 'hosted · no key of its own' : 'own account and key');

function money(job) {
  const bounty = BigInt(job.bounty), price = BigInt(job.price ?? 0), row = (k, v) => `<li><span>${k}</span><span>${v}</span></li>`;
  if (job.status === 'Paid') return row('To the agent', `${near(price - price / 10n)} NEAR`) + row('To the reviewers who voted', `${near(price / 10n)} NEAR`) + row('Back to the poster', `${near(bounty - price)} NEAR`);
  if (job.status === 'Rejected') return row('Back to the poster', `${near(bounty)} NEAR`) + row('Agent\'s bond, to the reviewers', `${near(BOND)} NEAR`);
  if (job.status === 'Expired') return job.work ? row('Back to the poster', `${near(bounty)} NEAR`) + row('Agent\'s bond', 'returned: it did its part')
    : row('Back to the poster', `${near(bounty + BOND)} NEAR`) + row('Agent\'s bond', 'lost: no work by the deadline');
  if (job.status === 'Cancelled') return row('Back to the poster', `${near(bounty)} NEAR`);
  return row('Held by the contract', `${near(bounty)} NEAR`);
}

/** Bids from the chain, plus the evidence file the on-chain result URL points to, checked in the browser. */
async function loadDetail(job) {
  const bids = await Promise.all(job.bidders.map(async agent => [agent, await view('get_bid', { job_id: job.id, agent })]));
  const url = job.work?.result_url?.startsWith(`${RAW}/`) ? job.work.result_url : `${RAW}/evidence/testnet/jobs/${job.id}.json`;
  let evidence = null; const checks = {};
  try { const response = await fetch(url); if (response.ok) evidence = await response.json(); } catch { /* shown as unavailable */ }
  const work = evidence?.work;
  if (job.work && work) checks.result = await sha256(work.result ?? '') === job.work.result_hash;
  checks.reports = {};
  for (const r of job.reviews) {
    const mine = evidence?.reviews?.find(x => x.reviewer === r.reviewer);
    if (mine) checks.reports[r.reviewer] = await sha256(JSON.stringify(mine.report)) === r.report_hash;
  }
  return { status: job.status, bids, evidence, checks, url };
}

function detailHtml(chain, job, d) {
  const ev = d.evidence, tick = ok => (ok === undefined ? '' : ok ? ' <b class="ok">✓ matches chain</b>' : ' <b class="bad">✗ does not match chain</b>');
  const bids = d.bids.map(([agent, bid]) => `<li><span>${esc(agentName(chain, agent))}</span><span>${bid.price === null ? 'never revealed' : `${near(bid.price)} NEAR`}</span></li>`).join('') || '<li><span>No agent bid</span></li>';
  const passed = Object.entries(ev?.bids ?? {}).filter(([, b]) => !b.bid).map(([agent, b]) => `<li class="muted"><span>${esc(agentName(chain, agent))}</span><span>${esc(b.reason)}</span></li>`).join('');
  const reviews = job.reviews.map(r => { const mine = ev?.reviews?.find(x => x.reviewer === r.reviewer);
    return `<li class="stack"><span>${esc(agentName(chain, r.reviewer))}: <b class="${r.pass ? 'ok' : 'bad'}">${r.pass ? 'pass' : 'fail'}</b> · ${mine?.report?.stage === 'guardrails' ? 'guardrails, no model call' : 'its own model'}${tick(d.checks.reports[r.reviewer])}</span><span class="why">${esc(mine?.report?.reasons?.[0] ?? r.note)}</span></li>`; }).join('');
  const abstained = [...(ev?.abstentions ?? []), ...(ev?.reviews ?? []).filter(x => x.vote === 'abstain')];
  const abst = abstained.length ? `<li class="stack"><span>${abstained.length} review call${abstained.length > 1 ? 's' : ''} gave no verdict, so no vote was cast</span><span class="why">${esc(abstained[0].report?.reasons?.[0] ?? '')}</span></li>` : '';
  const work = job.work ? `<li><span>Result hash on chain</span><span>${esc(job.work.result_hash.slice(0, 16))}…${tick(d.checks.result)}</span></li>
    <li><span>TEE signing key</span><span>${esc(job.work.signing_address.slice(0, 12))}…</span></li><li><span>Model</span><span>${esc(job.work.model)}</span></li>${reviews}${abst}` : '<li><span>No work was submitted</span></li>';
  const txs = (ev?.txs ?? []).map(t => `<li><span>${esc(t.step.replace(`.${OWNER}`, ''))}</span><span>${txLink(t.txHash)}</span></li>`).join('') || '<li><span>Transaction list unavailable</span></li>';
  const charges = (ev?.charges ?? []).map(c => `<li><span>${esc(agentName(chain, c.agent))}, ${esc(c.what)} call</span><span>${near(c.amountYocto, 6)} NEAR</span></li>`).join('');
  const result = ev?.work?.result ? `<div class="result"><h3>What the agent returned${ev.work.lab === 'tamper' ? ' (the last line was added after the model signed, on purpose)' : ''}</h3><pre>${esc(ev.work.result)}</pre></div>` : '';
  return `<div class="detail-grid">
    <div><h3>Sealed bids, now revealed</h3><ul>${bids}${passed}</ul><h3 class="gap">Where the money went</h3><ul>${money(job)}</ul>${charges ? `<h3 class="gap">Model calls, billed to the caller</h3><ul>${charges}</ul>` : ''}</div>
    <div><h3>Work and review</h3><ul>${work}</ul></div>
    <div><h3>Transactions</h3><ul>${txs}</ul><p class="muted gap">${link(d.url, 'Evidence file')} · ${link(`${REPO}/actions/workflows/verify-testnet.yml`, 'daily recheck')}</p></div>
  </div>${result}`;
}

export function mountLive($) {
  let chain = null, error = null, open = null, timer = null, loading = false;
  const details = new Map(); const listeners = new Set();

  function render() {
    const facts = $('live-facts'), rows = $('live-jobs'), grid = $('live-agents'), band = $('live-band');
    if (!chain) {
      const text = error ? `Could not reach NEAR Testnet RPC from your browser (${esc(error.message)}). Retrying.` : 'Reading the contract from NEAR Testnet…';
      rows.innerHTML = `<tr><td colspan="7" class="muted">${text}</td></tr>`; band.querySelector('.live-line').innerHTML = text; return;
    }
    const st = chainStats(chain);
    band.querySelector('.live-line').innerHTML = `<b>${st.jobs}</b> jobs posted · <b>${st.paid}</b> paid after review · <b>${st.rejected}</b> rejected · <b>${st.expired}</b> expired undecided · <b>${st.agents}</b> agents, ${st.hosted} hosted · read from ${esc(GUILD)} just now`;
    facts.innerHTML = [['Contract account', link(`${EXPLORER}/address/${GUILD}`, GUILD)], ['Access keys on it', `${chain.keyCount}${chain.keyCount === 0 ? ' — nobody can change its code or move its funds by key' : ''}`],
      ['Code hash', esc(chain.codeHash)], ['Review panel', `${chain.config.reviewers.length} reviewer agents, ${chain.config.review_threshold} must agree`],
      ['Operator', esc(chain.config.operator)], ['Read at', esc(chain.readAt.toLocaleTimeString())]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    rows.innerHTML = [...chain.jobs].reverse().map(job => {
      const row = `<tr class="row" data-job="${job.id}" tabindex="0" aria-expanded="${open === job.id}"><td class="num">#${job.id}</td><td>${esc(job.description.length > 150 ? `${job.description.slice(0, 150)}…` : job.description)}<br><span class="muted">${esc(job.poster)}</span></td>
        <td class="num">${near(job.bounty)}</td><td class="num">${job.bidders.length}</td>
        <td>${job.winner ? `${esc(agentName(chain, job.winner))}<br><span class="num">${near(job.price)} NEAR</span>` : '<span class="muted">not yet</span>'}</td>
        <td>${job.work ? votes(job, chain.config.reviewers) : '<span class="muted">—</span>'}</td><td><span class="status" data-s="${job.status}">${esc(phase(job))}</span></td></tr>`;
      if (open !== job.id) return row;
      const d = details.get(job.id);
      return `${row}<tr class="detail"><td colspan="7">${d && d.status === job.status ? detailHtml(chain, job, d) : '<p class="muted">Reading bids and the evidence file…</p>'}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No job has been posted yet.</td></tr>';
    grid.innerHTML = chain.agents.map(([id, a]) => `<li><h3>${esc(a.name)}</h3><span class="kind">${esc(kindOf(chain, id, a))}</span>
      <p class="bal">${near(BigInt(a.balance) + BigInt(a.locked))} <small>NEAR${a.locked !== '0' ? ' · bond locked' : ''}</small></p>
      <dl><div><dt>Won</dt><dd>${a.jobs_won}</dd></div><div><dt>Paid</dt><dd>${a.jobs_paid}</dd></div><div><dt>Failed</dt><dd>${a.jobs_failed}</dd></div></dl>
      <p class="facts">earned ${near(a.earned, 5)} · inference ${near(a.inference_spent, 5)}<br>${esc(short(id))} · ${link(a.spec_url, 'manifest')} ${esc(a.spec_hash.slice(0, 10))}…</p></li>`).join('');
    for (const fn of listeners) fn(chain);
  }

  async function refresh() {
    if (loading) return; loading = true;
    try { chain = await loadChain(); error = null; } catch (e) { error = e; }
    loading = false; render();
    if (open !== null && chain) openDetail(open);
  }
  async function openDetail(id) {
    const job = chain?.jobs[id]; if (!job) return;
    if (details.get(id)?.status === job.status && SETTLED.includes(job.status)) return;
    try { details.set(id, await loadDetail(job)); } catch { details.set(id, { status: job.status, bids: [], evidence: null, checks: { reports: {} }, url: `${RAW}/evidence/testnet/jobs/${id}.json` }); }
    render();
  }
  const toggle = e => {
    const row = e.target.closest('tr.row'); if (!row || e.target.closest('a') || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault(); const id = Number(row.dataset.job); open = open === id ? null : id; render(); if (open !== null) openDetail(open);
  };
  $('live-jobs').addEventListener('click', toggle); $('live-jobs').addEventListener('keydown', toggle);

  return {
    get chain() { return chain; },
    onChange: fn => listeners.add(fn),
    refresh,
    /** Reads now, then every 30 seconds while `visible()` is true, so a job in progress moves on screen. */
    start(visible) { refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden && visible()) refresh(); }, 30000); },
  };
}
