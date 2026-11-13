// Everything real on the site. It is read in the visitor's browser from public NEAR RPC and from the evidence
// files the on-chain result URLs point to. Posting a job or adding an agent hands a transaction to the
// visitor's own wallet through NEAR Connect; the site holds no key. Nothing here comes from the simulation.
import { manifestProblems, MAX_MANIFEST_BYTES } from './manifest-rules.mjs';
import { auctionHistory, decideBid } from './bid-rule.mjs';
import { addAgentCall, agentIdFor, cliCommand, isAccountId, nearToYocto, postJobCall, walletTransaction, withdrawCreditCall } from './tx.mjs';
import nearConnect from './vendor/near-connect.js'; // a CommonJS package, bundled: its exports are on the default export
const { NearConnector } = nearConnect;

export const GUILD = 'guild.swarmguild-99c7a546.testnet';
export const OWNER = GUILD.slice('guild.'.length);
const RPCS = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
const RAW = 'https://raw.githubusercontent.com/0xNexuz/SwarmGuild/main';
const EXPLORER = 'https://testnet.nearblocks.io';
const REPO = 'https://github.com/0xNexuz/SwarmGuild';
const RUNNER_RUNS = 'https://api.github.com/repos/0xNexuz/SwarmGuild/actions/workflows/runner.yml/runs?per_page=1';
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

async function rpcCall(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'swarmguild-site', method, params }) });
      const payload = await response.json();
      if (payload.result && !payload.result.error) return payload.result;
      last = new Error(payload.error?.cause?.name ?? payload.result?.error ?? 'RPC error');
      if (payload.error?.cause?.name === 'UNKNOWN_ACCOUNT') throw last; // a real answer, not a node problem
    } catch (error) { last = error; if (error.message === 'UNKNOWN_ACCOUNT') throw error; }
  }
  throw last;
}
const rpc = params => rpcCall('query', { finality: 'final', ...params });
async function view(method, args = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  const result = await rpc({ request_type: 'call_function', account_id: GUILD, method_name: method, args_base64: btoa(String.fromCharCode(...bytes)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

/** Confirms the signer exists on Testnet and returns the call as a near-cli command. */
export async function prepare(call) {
  await rpc({ request_type: 'view_account', account_id: call.signerId });
  return { command: cliCommand(call) };
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
const kindOf = (chain, id, a) => (chain.config.reviewers.includes(id) ? 'reviewer · own key' : /lab/i.test(a.name) ? 'lab · fails on purpose' : a.hosted ? 'hosted · no own key' : 'own account and key');

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
    <li><span>TEE signing key</span><span>${esc(job.work.signing_address.slice(0, 12))}…</span></li><li><span>Model</span><span>${esc(job.work.model)}</span></li>${ev?.work?.independent && /^https:\/\//.test(job.work.result_url) ? `<li><span>Published by the agent itself</span><span><a href="${esc(job.work.result_url)}" target="_blank" rel="noopener">its own copy</a></span></li>` : ''}${reviews}${abst}` : `<li><span>${SETTLED.includes(job.status) ? 'No work was submitted' : 'No work yet'}</span></li>`;
  const step = text => text.split(' ').map(word => chain.agents.some(([a]) => a === word) ? agentName(chain, word) : word).join(' '); // account ids read better as agent names
  const txs = (ev?.txs ?? []).map(t => `<li><span>${esc(step(t.step))}</span><span>${txLink(t.txHash)}</span></li>`).join('') || `<li><span>${SETTLED.includes(job.status) ? 'The runner publishes these a few minutes after a job settles. Check back shortly.' : 'Listed here once the job settles.'}</span></li>`;
  const charges = (ev?.charges ?? []).map(c => `<li><span>${esc(agentName(chain, c.agent))}, ${esc(c.what)} call</span><span>${near(c.amountYocto, 6)} NEAR</span></li>`).join('');
  const result = ev?.work?.result ? `<div class="result"><h3>What the agent returned${ev.work.lab === 'tamper' ? ' (the last line was added after the model signed, on purpose)' : ''}</h3><pre>${esc(ev.work.result)}</pre></div>` : '';
  return `<div class="detail-grid">
    <div><h3>Sealed bids, now revealed</h3><ul>${bids}${passed}</ul><h3 class="gap">Where the money went</h3><ul>${money(job)}</ul>${charges ? `<h3 class="gap">Model calls, billed to the caller</h3><ul>${charges}</ul>` : ''}</div>
    <div><h3>Work and review</h3><ul>${work}</ul></div>
    <div><h3>Transactions</h3><ul>${txs}</ul><p class="muted gap">${link(d.url, 'Evidence file')} · ${link(`${REPO}/actions/workflows/verify-testnet.yml`, 'daily recheck')}</p></div>
  </div>${result}`;
}

export function mountLive($) {
  let chain = null, error = null, open = null, loading = false;
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
      ['Operator', esc(chain.config.operator)], ['Runner', '<span id="runner-state"></span>'], ['Read at', esc(chain.readAt.toLocaleTimeString())]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
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
      <p class="facts"><span>earned ${near(a.earned, 5)} NEAR</span><span>inference ${near(a.inference_spent, 5)} NEAR</span><span>${link(a.spec_url, 'manifest')} ${esc(a.spec_hash.slice(0, 12))}…</span></p></li>`).join('');
    for (const fn of listeners) fn(chain);
  }

  const PHASE_AT = { 'sealing bids': 0, 'revealing bids': 1, 'awaiting award': 2, 'agent working': 3, 'in review': 4 };
  function renderLanding() {
    const flight = $('real-flight'), feed = $('real-feed'), track = $('track');
    const newest = [...chain.jobs].reverse();
    flight.innerHTML = newest.slice(0, 5).map(job => { const p = phase(job), at = PHASE_AT[p] ?? 5;
      return `<li><span class="id">#${job.id}</span><span class="desc">${esc(job.description)}</span><span class="bounty">${near(job.bounty)} NEAR</span>
        <span class="phases">${[0, 1, 2, 3, 4].map(i => `<i data-on="${i < at}" data-now="${i === at}"></i>`).join('')}</span>
        <span class="phase-name">${esc(p)}${job.winner ? ` · ${esc(agentName(chain, job.winner))} at ${near(job.price)} NEAR` : job.bidders.length ? ` · ${job.bidders.length} sealed bids` : ''}</span></li>`; }).join('')
      || '<li><span class="id">—</span><span class="desc">No job has been posted yet.</span></li>';
    feed.innerHTML = newest.slice(0, 8).map(job => {
      const who = job.winner ? esc(agentName(chain, job.winner)) : '', bounty = BigInt(job.bounty), price = BigInt(job.price ?? 0);
      const line = job.status === 'Paid' ? `Paid after review. ${who} earned ${near(price - price / 10n)} NEAR and ${near(bounty - price)} went back to the poster.`
        : job.status === 'Rejected' ? `Rejected by the reviewers. The ${near(bounty)} NEAR bounty went back and ${who}'s bond was slashed.`
        : job.status === 'Expired' ? (job.work ? `Expired undecided. The bounty went back and ${who} kept its bond.` : `Expired: ${who} delivered nothing in time and lost its bond.`)
        : job.status === 'Cancelled' ? 'No agent bid. The bounty went back.' : `In progress: ${esc(phase(job))}.`;
      return `<li data-type="${job.status === 'Paid' ? 'job_paid' : job.status === 'Rejected' ? 'job_rejected' : ''}"><time>#${job.id}</time><span>${line}</span></li>`; }).join('');
    const busy = new Set(chain.jobs.map(j => PHASE_AT[phase(j)]).filter(n => n !== undefined));
    [...track.children].forEach((li, i) => { li.dataset.busy = i > 0 && busy.has(i - 1); });
  }
  listeners.add(renderLanding);

  /* ---------- the visitor's own wallet, account, credit and transactions ---------- */
  // NEAR Connect shows the wallets that work on Testnet (Meteor, Intear, Ledger and others) and runs each in its own sandbox.
  const connector = new NearConnector({ network: 'testnet', features: { testnet: true, signAndSendTransaction: true }, footerBranding: null });
  let walletAccount = null, walletRef = null, walletBusy = '';
  const accountInputs = [...document.querySelectorAll('[data-account]')];
  const account = () => accountInputs[0].value.trim().toLowerCase();
  const remember = value => { for (const input of accountInputs) if (input.value !== value) input.value = value; try { localStorage.setItem('swarmguild.account', value); } catch { /* private mode */ } };
  try { remember(localStorage.getItem('swarmguild.account') ?? ''); } catch { /* private mode */ }
  function showWallet() {
    for (const el of document.querySelectorAll('[data-wallet-state]')) el.textContent = walletBusy || (walletAccount ? `Connected: ${walletAccount}` : 'No wallet connected');
    for (const el of document.querySelectorAll('[data-connect]')) { el.textContent = walletAccount ? 'Disconnect' : 'Connect wallet'; el.disabled = Boolean(walletBusy); }
    for (const input of accountInputs) input.readOnly = Boolean(walletAccount);
  }
  const busy = text => { walletBusy = text; showWallet(); };
  function setWallet(id, wallet) { walletAccount = id || null; walletRef = walletAccount ? wallet ?? walletRef : null; if (walletAccount) remember(walletAccount); showWallet(); showCredit(); }
  connector.on('wallet:signIn', t => setWallet(t.accounts?.[0]?.accountId, t.wallet));
  connector.on('wallet:signOut', () => setWallet(null));
  connector.getConnectedWallet().then(({ wallet, accounts }) => setWallet(accounts?.[0]?.accountId, wallet)).catch(() => showWallet());

  // A wallet's code is fetched the first time it is picked (Meteor's is about 0.7 MB), which made the first connect slow.
  // Fetch it ahead, once, when the forms come into view; NEAR Connect keeps it in the browser after that.
  const warming = {};
  const warm = id => (warming[id] ??= (async () => {
    try {
      await connector.whenManifestLoaded;
      const wallet = connector.wallets.find(w => w.manifest.id === id);
      if (!wallet?.executor?.loadCode || navigator.connection?.saveData) return;
      if (!await connector.db.getItem(`${id}:${wallet.manifest.version}`).catch(() => null)) await wallet.executor.loadCode();
    } catch { /* the wallet still loads when it is picked */ }
  })());
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { seen.disconnect(); warm('meteor-wallet'); } });
    seen.observe($('post-form'));
  }

  async function connectWallet() {
    try {
      busy('Choose a wallet…');
      const walletId = await connector.selectWallet();
      busy(`Opening ${connector.wallets.find(w => w.manifest.id === walletId)?.manifest.name ?? 'your wallet'}…`);
      await warming[walletId]; // a fetch already under way: use it instead of starting a second one
      const wallet = await connector.connect({ walletId }); // signs in and emits wallet:signIn, which records the account
      if (!walletAccount) setWallet((await wallet.getAccounts())[0]?.accountId, wallet);
      return walletAccount;
    } finally { busy(''); }
  }
  for (const el of document.querySelectorAll('[data-connect]')) el.addEventListener('click', async () => {
    try { if (!walletAccount) await connectWallet(); else { busy('Disconnecting…'); await connector.disconnect(walletRef ?? undefined); } } catch { /* the visitor closed the picker */ } finally { busy(''); }
  });

  async function showCredit() {
    const box = $('credit'); const id = account();
    if (!isAccountId(id)) { box.hidden = true; return; }
    try {
      const credit = BigInt(await view('get_credit', { account: id }));
      box.hidden = credit === 0n;
      box.querySelector('b').textContent = `${near(credit, 5)} NEAR`;
    } catch { box.hidden = true; }
  }
  for (const input of accountInputs) input.addEventListener('change', () => { remember(input.value.trim().toLowerCase()); showCredit(); });

  /** Shows a prepared call: a button that signs it in the visitor's wallet, and the same call as a terminal command. */
  async function offer(out, call, summary) {
    out.hidden = false; out.innerHTML = '<p class="muted">Preparing the transaction…</p>';
    try {
      const { command } = await prepare(call);
      out.innerHTML = `<p>${summary}</p><p class="actions"><button class="btn" type="button" data-sign>Sign with your wallet</button><button class="btn ghost small" type="button" data-copy>Copy near-cli command</button></p><pre class="code cmd"></pre>
        <p class="muted" data-status>Your wallet shows the call and the deposit before you approve. This site never sees your key.</p>`;
      out.querySelector('pre').textContent = command;
      out.querySelector('[data-copy]').addEventListener('click', async e => { try { await navigator.clipboard.writeText(command); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select the text below'; } });
      const button = out.querySelector('[data-sign]'), status = out.querySelector('[data-status]');
      button.addEventListener('click', async () => {
        try {
          const id = walletAccount ?? await connectWallet();
          if (!id) return;
          if (id !== call.signerId) { out.innerHTML = `<p>Your wallet is connected as <b>${esc(id)}</b>. Press the button above again to prepare the transaction for that account.</p>`; return; }
          button.disabled = true; button.textContent = 'Waiting for your wallet…';
          const result = await (walletRef ?? await connector.wallet()).signAndSendTransaction(walletTransaction(call));
          const hash = result?.transaction?.hash ?? result?.transaction_outcome?.id;
          out.innerHTML = `<p class="ok">Sent${hash ? `: ${txLink(hash)}` : ''}. It shows up on this page within a few seconds.</p>`;
          refresh(); showCredit();
        } catch (error) {
          button.disabled = false; button.textContent = 'Sign with your wallet';
          status.className = 'bad'; status.textContent = `The wallet did not send it: ${error?.message ?? error}. You can try again, or use the near-cli command.`;
        }
      });
    } catch (e) {
      out.innerHTML = `<p class="bad">${e.message === 'UNKNOWN_ACCOUNT' ? `${esc(call.signerId)} does not exist on NEAR Testnet.` : `Could not prepare the transaction: ${esc(e.message)}`}</p>`;
    }
  }
  /** Which agents on chain will bid on this job: the runner's own rule, run on each agent's manifest once its bytes match the hash on chain. */
  const manifests = new Map();
  async function manifestOf(agent) {
    if (!manifests.has(agent.spec_hash)) {
      const bytes = await (await fetch(agent.spec_url)).arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== agent.spec_hash) throw new Error('The manifest no longer matches its hash on chain.');
      manifests.set(agent.spec_hash, JSON.parse(new TextDecoder().decode(bytes)));
    }
    return manifests.get(agent.spec_hash);
  }
  async function bidders(description, bountyNear) {
    const found = [], skills = new Set(); let independent = 0;
    const workers = chain ? chain.agents.filter(([id]) => !chain.config.reviewers.includes(id)) : [];
    await Promise.all(workers.map(async ([id, agent]) => {
      try {
        const manifest = await manifestOf(agent);
        for (const skill of manifest.skills ?? []) skills.add(skill);
        // An adaptive agent's price depends on how its past auctions went, which is on chain too.
        const decision = decideBid(manifest, { description, bounty: nearToYocto(bountyNear) }, agent, auctionHistory(chain.jobs, id, chain.jobs.length));
        if (decision.bid) found.push({ name: agent.name, price: decision.priceYocto });
      } catch { if (!agent.hosted) independent++; /* an independent agent keeps its manifest and its price to itself; a hosted one that cannot be read is not hosted */ }
    }));
    return { found: found.sort((x, y) => (x.price < y.price ? -1 : x.price > y.price ? 1 : x.name.localeCompare(y.name))), skills: [...skills].sort(), independent };
  }

  const needAccount = out => { const id = account(); if (isAccountId(id) && id.endsWith('.testnet')) return id; out.hidden = false; out.innerHTML = '<p class="bad">Connect your wallet, or enter your NEAR Testnet account, for example you.testnet.</p>'; return null; };

  $('post-form').addEventListener('submit', async e => {
    e.preventDefault(); const out = $('post-out'); const data = new FormData(e.target); const id = needAccount(out); if (!id) return;
    const description = String(data.get('description')).trim(); const bounty = String(data.get('bounty')).trim();
    if (!description || description.length > 2000 || !(Number(bounty) >= 0.05)) { out.hidden = false; out.innerHTML = '<p class="bad">Describe the job in up to 2,000 characters and offer at least 0.05 NEAR.</p>'; return; }
    out.hidden = false; out.innerHTML = '<p class="muted">Checking which agents will bid…</p>';
    const { found, skills, independent } = await bidders(description, bounty);
    const also = independent ? ` ${independent} independent agent${independent > 1 ? 's' : ''} may bid too, at a price only ${independent > 1 ? 'they know' : 'it knows'}.` : '';
    const who = found.length
      ? `${found.map(f => `<b>${esc(f.name)}</b> at ${near(f.price)} NEAR`).join(', ').replace(/, (?=[^,]*$)/, ' and ')} will bid.${also} Bids seal for two minutes, then the work and the review take about two more.`
      : `<span class="bad">No agent with public rules is set to bid on this job${independent ? '' : ', so it would be cancelled and the bounty returned to you as credit'}.</span>${also} Agents bid when the job mentions one of their skills${skills.length ? `: ${esc(skills.join(', '))}` : ''}, and when the bounty covers their floor price.`;
    const offline = /^(offline|not started)/.test(runner) ? ' <span class="bad">The runner that hosts the agents is offline right now, so nobody will bid until it is back.</span>' : '';
    offer(out, postJobCall(GUILD, id, description, bounty), `This posts your job with <b>${esc(bounty)} NEAR</b> held by the contract. ${who}${offline}`);
  });
  $('credit').querySelector('button').addEventListener('click', () => { const out = $('post-out'); const id = needAccount(out); if (id) offer(out, withdrawCreditCall(GUILD, id), 'This moves your credit from the contract to your account.'); });

  $('use-example').addEventListener('click', () => { $('agent-form').querySelector('[name=url]').value = `${RAW}/agents/examples/limerick-bot.json`; });

  $('agent-form').addEventListener('submit', async e => {
    e.preventDefault(); const out = $('agent-out'); const data = new FormData(e.target); const id = needAccount(out); if (!id) return;
    const url = String(data.get('url')).trim(); const funding = String(data.get('funding')).trim();
    out.hidden = false; out.innerHTML = '<p class="muted">Fetching and checking the manifest…</p>';
    try {
      if (!/^https:\/\//.test(url)) throw new Error('The manifest URL must start with https://');
      if (!(Number(funding) >= 0.1)) throw new Error('Fund the agent with at least 0.1 NEAR.');
      const response = await fetch(url); if (!response.ok) throw new Error(`The URL returned HTTP ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('The manifest is over 20,000 bytes.');
      let manifest; try { manifest = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('The file at that URL is not valid JSON.'); }
      const problems = manifestProblems(manifest); if (problems.length) throw new Error(`The manifest needs fixing: ${problems.join(' ')}`);
      const specHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      const agent = agentIdFor(manifest.name, id);
      if (await view('get_agent', { agent })) throw new Error(`${agent} is already in the swarm. Change the manifest's name to add another.`);
      await offer(out, addAgentCall(GUILD, id, { agent, name: manifest.name, model: manifest.model, specHash, specUrl: url }, funding),
        `The manifest is valid. <b>${esc(manifest.name)}</b> will join as <b>${esc(agent)}</b> with ${esc(funding)} NEAR, and bid ${esc(manifest.pricing.floorNear)} NEAR on jobs that mention: ${esc(manifest.skills.join(', '))}.<br><span class="muted">Manifest SHA-256 ${esc(specHash)}</span>`);
    } catch (error) { out.innerHTML = `<p class="bad">${esc(error instanceof TypeError ? 'The browser could not fetch that URL. Use a host that allows cross-origin reads, such as a GitHub gist raw link.' : error.message)}</p>`; }
  });

  // Back from the wallet: it appends the transaction hash, or an error, to the callback URL.
  (() => {
    const q = new URLSearchParams(location.search); const hashes = q.get('transactionHashes'); const failed = q.get('errorCode');
    if (!hashes && !failed) return;
    const note = $('wallet-note'); note.hidden = false;
    note.innerHTML = hashes ? `Your transaction was sent: ${hashes.split(',').map(h => txLink(h)).join(', ')}. It appears below within a few seconds.` : `The wallet did not send the transaction (${esc(failed)}).`;
    note.dataset.ok = Boolean(hashes);
    history.replaceState(null, '', `${location.pathname}#live`);
  })();

  /* ---------- is the runner serving jobs right now? ---------- */
  let runner = 'checking…';
  async function checkRunner() {
    try {
      const run = (await (await fetch(RUNNER_RUNS)).json()).workflow_runs?.[0];
      runner = !run ? 'not started yet' : run.status === 'in_progress' ? 'online: serving jobs now' : ['queued', 'pending', 'waiting', 'requested'].includes(run.status) ? 'starting' : `offline since ${new Date(run.updated_at).toLocaleString()}`;
    } catch { runner = 'status unknown'; }
    const cell = $('runner-state'); if (cell) cell.textContent = runner;
  }
  listeners.add(() => { const cell = $('runner-state'); if (cell) cell.textContent = runner; });

  async function refresh() {
    if (loading) return; loading = true;
    try { chain = await loadChain(); error = null; } catch (e) { error = e; }
    loading = false; render();
    if (open !== null && chain) openDetail(open);
  }
  async function openDetail(id) {
    const job = chain?.jobs[id]; if (!job) return;
    if (details.get(id)?.status === job.status && SETTLED.includes(job.status) && details.get(id).evidence) return; // a settled job is final once its evidence file has loaded
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
    /** Reads now, then every 30 seconds, or every 6 while a job is in progress, so it moves on screen. */
    start(visible) {
      refresh(); showCredit(); checkRunner(); setInterval(checkRunner, 120000);
      let last = Date.now();
      setInterval(() => {
        if (document.hidden || !visible()) return;
        const moving = chain?.jobs.some(j => !SETTLED.includes(j.status));
        if (Date.now() - last >= (moving ? 6000 : 30000)) { last = Date.now(); refresh(); showCredit(); }
      }, 2000);
    },
  };
}
