import { createSim, near, KINDS, UNIT, BOND, MIN_FUNDING } from './sim.mjs';
import { drawScrawl, mountHero, mountDispatch } from './art.mjs';

const $ = id => document.getElementById(id);
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let sim = createSim(7);
for (let i = 0; i < 9; i++) sim.step(); // open on a market that is already moving
let paused = false, speed = 3, timer = null, jobFilter = 'All', openJob = null, lastEvent = 0;
const mine = new Set();

/* ---------- navigation ---------- */
const views = ['swarm', 'jobs', 'agents', 'console'];
function show(name, focus = false) {
  if (!views.includes(name)) name = 'swarm';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const a of document.querySelectorAll('[data-nav]')) a.toggleAttribute('aria-current', false);
  for (const a of document.querySelectorAll(`.top nav [data-nav="${name}"]`)) a.setAttribute('aria-current', 'page');
  document.title = name === 'swarm' ? 'SwarmGuild' : `${name[0].toUpperCase()}${name.slice(1)} · SwarmGuild`;
  if (focus) { scrollTo({ top: 0 }); $('main').querySelector('.view:not([hidden]) h1')?.setAttribute('tabindex', '-1'); }
  render();
}
addEventListener('hashchange', () => show(location.hash.slice(1), true));

/* ---------- rendering ---------- */
const PHASES = ['commit', 'reveal', 'award', 'work', 'review'];
const PHASE_TEXT = { commit: 'Agents are sealing bids', reveal: 'Bids are being revealed', award: 'Picking the lowest revealed price', work: 'Winner is working inside the TEE', review: 'Reviewers are voting' };
const TRACK = [
  ['Post', 'Poster', 'A job description and a NEAR bounty go into the contract. The bounty is escrowed.', null],
  ['Seal', 'Agents', 'Each agent commits a hash of its price and locks a 0.01 NEAR bond from its own balance.', 'commit'],
  ['Reveal', 'Agents', 'Prices come out and must match the hash. A bid that stays hidden loses its bond.', 'reveal'],
  ['Award', 'Anyone', 'The lowest revealed price wins. A tie goes to whoever committed first.', 'award'],
  ['Work', 'Winner', 'One model call inside NEAR AI\'s TEE, billed to the agent. The signed result goes on chain.', 'work'],
  ['Review', 'Reviewers', 'Guardrails first, then three reviewer agents vote. Two passes pay; two fails refund.', 'review'],
];
const votesHtml = job => `<span class="votes" aria-label="${job.reviews.filter(v => v.pass).length} pass, ${job.reviews.filter(v => !v.pass).length} fail">${[0, 1, 2].map(i => `<i data-v="${job.reviews[i] ? (job.reviews[i].pass ? 'pass' : 'fail') : ''}"></i>`).join('')}</span>`;
const nameOf = id => sim.agentOf(id)?.name ?? id;

function renderMetrics() {
  const st = sim.stats(), inv = sim.invariant();
  const cells = [['Jobs posted', st.jobs, st.jobs / Math.max(st.jobs, 40)], ['Paid after review', st.paid, st.paid / Math.max(1, st.jobs)],
    ['Rejected by reviewers', st.rejected, st.rejected / Math.max(1, st.jobs)], ['Agents able to bid', `${st.alive}/${st.agents}`, st.alive / st.agents],
    ['Earned by agents', `${near(st.earned)} N`, st.earned / Math.max(1, inv.deposited)], ['Inference billed', `${near(st.inference)} N`, st.inference / Math.max(1, st.earned)]];
  const el = $('metrics');
  if (!el.children.length) el.innerHTML = cells.map(([label]) => `<div class="metric"><small>${label}</small><b></b><span></span></div>`).join('');
  cells.forEach(([, value, share], i) => { el.children[i].querySelector('b').textContent = value; el.children[i].querySelector('span').style.width = `${Math.min(100, Math.max(2, share * 100))}%`; });
}

function renderSwarm() {
  const live = sim.state.jobs.filter(j => j.phase !== 'done');
  const track = $('track');
  if (!track.children.length) track.innerHTML = TRACK.map(([title, who, text], i) => `<li><span class="n">0${i + 1}</span><span class="live" title="Jobs at this step right now">0</span><h3>${title}</h3><span class="who">${who}</span><p>${text}</p></li>`).join('');
  TRACK.forEach(([, , , phase], i) => {
    const n = phase ? live.filter(j => j.phase === phase).length : sim.state.jobs.filter(j => j.postedAt === sim.state.t).length;
    track.children[i].dataset.busy = n > 0; track.children[i].querySelector('.live').textContent = n;
  });
  $('flight').innerHTML = live.slice(-5).reverse().map(job => {
    const at = PHASES.indexOf(job.phase);
    return `<li><span class="id">#${job.id}</span><span class="desc">${esc(job.description)}</span><span class="bounty">${near(job.bounty)} NEAR</span>
      <span class="phases">${PHASES.map((p, i) => `<i data-on="${i < at}" data-now="${i === at}"></i>`).join('')}</span>
      <span class="phase-name">${PHASE_TEXT[job.phase]}${job.winner ? ` · ${esc(nameOf(job.winner))} at ${near(job.price)}` : job.bids.length ? ` · ${job.bids.length} bids` : ''}</span></li>`;
  }).join('') || '<li><span class="id">—</span><span class="desc">No job is open. The next one posts in a moment.</span></li>';
  const events = sim.state.events.filter(e => e.type !== 'agent_added').slice(-9).reverse();
  const newest = sim.state.events.length ? sim.state.events.at(-1).t : 0;
  $('feed').innerHTML = events.map(e => `<li data-type="${e.type}" class="${e.t > lastEvent ? 'new' : ''}"><time>t${String(e.t).padStart(3, '0')}</time><span>${esc(e.text)}</span></li>`).join('');
  lastEvent = newest;
}

function renderJobs() {
  const filters = ['All', 'Open', 'Paid', 'Rejected', 'Cancelled'];
  $('job-filters').innerHTML = filters.map(f => `<button type="button" aria-pressed="${f === jobFilter}" data-filter="${f}">${f}</button>`).join('');
  const jobs = sim.state.jobs.filter(j => jobFilter === 'All' || (jobFilter === 'Open' ? j.phase !== 'done' : j.status === jobFilter)).slice(-40).reverse();
  $('job-rows').innerHTML = jobs.map(job => {
    const revealed = job.bids.filter(b => b.revealed).length, sealed = job.phase === 'commit' || job.phase === 'reveal';
    const row = `<tr class="row" data-job="${job.id}" tabindex="0" aria-expanded="${openJob === job.id}"><td class="num">#${job.id}</td><td>${esc(job.description)}<br><span class="muted">${esc(job.poster)}${mine.has(`job-${job.id}`) ? ' · yours' : ''}</span></td>
      <td class="num">${near(job.bounty)}</td><td class="num">${job.bids.length}${job.bids.length && !sealed ? ` (${revealed} shown)` : job.bids.length ? ' sealed' : ''}</td>
      <td>${job.winner ? `${esc(nameOf(job.winner))}<br><span class="num">${near(job.price)} NEAR</span>` : '<span class="muted">not yet</span>'}</td>
      <td>${job.work ? votesHtml(job) : '<span class="muted">—</span>'}</td><td><span class="status" data-s="${job.status}">${job.phase === 'done' ? job.status : job.phase}</span></td></tr>`;
    if (openJob !== job.id) return row;
    const fee = job.price ? Math.floor(job.price / 10) : 0;
    return `${row}<tr class="detail"><td colspan="7"><div class="detail-grid">
      <div><h3>Bids</h3><ul>${job.bids.map(b => `<li><span>${esc(nameOf(b.agent))}</span><span>${sealed ? `sealed ${b.commitment}…` : b.revealed ? `${near(b.price)} NEAR` : 'never revealed'}</span></li>`).join('') || '<li><span>No bids yet</span></li>'}</ul></div>
      <div><h3>Work and review</h3><ul>${job.work ? `<li><span>Result hash</span><span>${job.work.resultHash}…</span></li><li><span>TEE signature</span><span>${job.work.signed ? 'checked' : 'missing'}</span></li>
        <li><span>Guardrails</span><span>${job.work.leaked ? 'flagged' : 'passed'}</span></li>${job.reviews.map(v => `<li><span>${esc(v.name)}</span><span>${v.pass ? 'pass' : 'fail'}</span></li>`).join('')}` : '<li><span>No work submitted yet</span></li>'}</ul></div>
      <div><h3>Where the money went</h3><ul>${job.status === 'Paid' ? `<li><span>To the agent</span><span>${near(job.price - fee)} NEAR</span></li><li><span>To the reviewers</span><span>${near(fee)} NEAR</span></li><li><span>Back to the poster</span><span>${near(job.bounty - job.price)} NEAR</span></li>`
        : job.status === 'Rejected' ? `<li><span>Back to the poster</span><span>${near(job.bounty)} NEAR</span></li><li><span>Agent's bond, to reviewers</span><span>${near(BOND)} NEAR</span></li>`
        : job.status === 'Cancelled' ? `<li><span>Back to the poster</span><span>${near(job.bounty)} NEAR</span></li>` : `<li><span>In escrow</span><span>${near(job.bounty)} NEAR</span></li>`}</ul></div>
    </div></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">No jobs match this filter yet.</td></tr>';
}

function spark(history) {
  const max = Math.max(...history, 1), min = Math.min(...history), span = Math.max(1, max - min);
  return `<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${history.map((v, i) => `${(i / Math.max(1, history.length - 1) * 100).toFixed(1)},${(28 - (v - min) / span * 26).toFixed(1)}`).join(' ')}"/></svg>`;
}
function renderAgents() {
  const agents = [...sim.state.agents].sort((a, b) => (mine.has(b.id) - mine.has(a.id)) || (b.balance + b.locked) - (a.balance + a.locked));
  $('agent-count').textContent = `${sim.stats().alive} of ${agents.length} can afford to bid`;
  $('agent-grid').innerHTML = agents.map(a => `<li data-dry="${a.balance < BOND * 2}">${mine.has(a.id) ? '<span class="mine">yours</span>' : ''}
    <h3>${esc(a.name)}</h3><span class="kind">${KINDS[a.kind].label} · floor ${near(a.floor)}</span>
    <p class="bal">${near(a.balance + a.locked)} <small>NEAR${a.locked ? ' · bond locked' : ''}</small></p>${spark(a.history)}
    <dl><div><dt>Won</dt><dd>${a.won}</dd></div><div><dt>Paid</dt><dd>${a.paid}</dd></div><div><dt>Failed</dt><dd>${a.failed}</dd></div></dl>
    <p class="hash">${a.specHash ? `manifest ${a.specHash}` : `inference spent ${near(a.spent)} NEAR · backer ${esc(a.backer)}`}</p></li>`).join('');
}

function renderConsole() {
  const inv = sim.invariant(), s = sim.state;
  $('clock').innerHTML = `<dt>Tick</dt><dd>${s.t}</dd><dt>Seed</dt><dd>${s.seed}</dd><dt>Open jobs</dt><dd>${sim.stats().open}</dd><dt>State</dt><dd>${paused ? 'paused' : 'running'}</dd>`;
  $('books').innerHTML = [['Agent balances', inv.agents], ['Reviewer balances', inv.reviewers], ['Bounties in escrow', inv.escrow], ['Credits to withdraw', inv.credits], ['Operator, for inference', inv.operator]]
    .map(([k, v]) => `<dt>${k}</dt><dd>${near(v)}</dd>`).join('') + `<dt class="total">Held</dt><dd class="total">${near(inv.held)}</dd><dt>Paid in</dt><dd>${near(inv.deposited)}</dd><dt>Balanced</dt><dd class="${inv.ok ? 'ok' : 'bad'}">${inv.ok ? 'yes, to the unit' : 'NO'}</dd>`;
  const reviewed = s.jobs.filter(j => j.work).slice(-12).reverse();
  $('review-rows').innerHTML = reviewed.map(j => `<tr><td class="num">#${j.id}</td><td>${esc(nameOf(j.winner))}</td><td>${j.work.leaked ? '<span class="status" data-s="Rejected">flagged</span>' : 'passed'}</td><td>${votesHtml(j)}</td><td><span class="status" data-s="${j.status}">${j.phase === 'done' ? j.status : 'voting'}</span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No work has been submitted yet.</td></tr>';
  $('ledger-rows').innerHTML = s.charges.slice(-14).reverse().map(c => `<tr><td class="num">t${c.t}</td><td>${esc(c.name)}</td><td class="num">#${c.job}</td><td class="num">${esc(c.receipt)}</td><td class="num">${near(c.amount)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No model call has been billed yet.</td></tr>';
  $('guard-rows').innerHTML = s.guard.slice(-14).reverse().map(g => `<tr><td class="num">t${g.t}</td><td class="num">#${g.job}</td><td>${esc(g.agent)}</td><td>${g.pass ? 'passed' : '<span class="status" data-s="Rejected">flagged</span>'}</td><td class="muted">${esc(g.reason)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing has reached the guardrails yet.</td></tr>';
  const busy = new Map();
  for (const j of s.jobs) if (j.phase !== 'done') { if (j.phase === 'work') busy.set(j.winner, 'working'); else if (j.phase === 'review') busy.set(j.winner, 'in review'); else for (const b of j.bids) if (!busy.has(b.agent)) busy.set(b.agent, 'bidding'); }
  const reviewing = s.jobs.some(j => j.phase === 'review');
  const max = Math.max(...s.agents.map(a => a.balance + a.locked), 1);
  $('dispatch-list').innerHTML = [...s.agents.map(a => ({ name: a.name, state: a.balance < BOND * 2 ? 'dry' : busy.get(a.id) ?? 'idle', bal: a.balance + a.locked })),
    ...s.reviewers.map(r => ({ name: r.name, state: reviewing ? 'reviewing' : 'idle', bal: r.balance }))]
    .map(p => `<li><b>${esc(p.name)}</b><span class="num">${near(p.bal)}</span><span class="state" data-s="${p.state}">${p.state}</span><span></span><span class="bar"><i style="width:${Math.min(100, p.bal / max * 100).toFixed(1)}%"></i></span></li>`).join('');
}

function render() {
  renderMetrics();
  const view = document.querySelector('.view:not([hidden])')?.dataset.view;
  if (view === 'swarm') renderSwarm(); else if (view === 'jobs') renderJobs(); else if (view === 'agents') renderAgents(); else if (view === 'console') renderConsole();
}

/* ---------- clock ---------- */
function schedule() { clearInterval(timer); if (!paused) timer = setInterval(() => { sim.step(); render(); }, [2600, 1900, 1300, 800, 380][speed - 1]); }

/* ---------- interactions ---------- */
$('job-filters').addEventListener('click', e => { const f = e.target.closest('[data-filter]'); if (f) { jobFilter = f.dataset.filter; renderJobs(); } });
const toggleJob = e => { const row = e.target.closest('tr.row'); if (!row || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); const id = Number(row.dataset.job); openJob = openJob === id ? null : id; renderJobs(); };
$('job-rows').addEventListener('click', toggleJob); $('job-rows').addEventListener('keydown', toggleJob);

$('job-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = new FormData(e.target);
  const job = sim.postJob({ description: String(data.get('description')).trim().slice(0, 2000), kind: data.get('kind'), bounty: Math.round(Number(data.get('bounty')) * UNIT), poster: 'you.testnet' });
  mine.add(`job-${job.id}`); openJob = job.id; jobFilter = 'All';
  $('job-note').textContent = `Job #${job.id} is posted with ${near(job.bounty)} NEAR in escrow. Watch its row: bids are sealing now.`; $('job-note').classList.add('ok');
  e.target.reset(); renderJobs(); renderMetrics();
});

$('agent-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = new FormData(e.target);
  const manifest = { name: String(data.get('name')).trim(), model: 'z-ai/glm-5.3-flash', prompt: String(data.get('prompt')).trim(),
    knowledge: String(data.get('knowledge')).split('\n').map(k => k.trim()).filter(Boolean), tools: [], skills: KINDS[data.get('kind')].skills, pricing: { floorNear: String(data.get('floor')) } };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(manifest)));
  const specHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const funding = Math.max(MIN_FUNDING, Math.round(Number(data.get('funding')) * UNIT));
  const agent = sim.addAgent({ name: manifest.name.slice(0, 40), kind: data.get('kind'), floor: Math.round(Number(data.get('floor')) * UNIT), funding, quality: 0.86, specHash });
  mine.add(agent.id);
  $('agent-note').textContent = `${agent.name} is in the swarm with ${near(funding)} NEAR. Its manifest hash is ${specHash.slice(0, 16)}…`; $('agent-note').classList.add('ok');
  e.target.reset(); renderAgents(); renderMetrics();
});

$('ctl-pause').addEventListener('click', () => { paused = !paused; $('ctl-pause').textContent = paused ? 'Resume' : 'Pause'; schedule(); renderConsole(); });
$('ctl-step').addEventListener('click', () => { sim.step(); render(); });
$('ctl-reset').addEventListener('click', () => { sim = createSim(Math.floor(Math.random() * 9000) + 1); mine.clear(); openJob = null; lastEvent = 0; for (let i = 0; i < 9; i++) sim.step(); render(); });
$('ctl-speed').addEventListener('input', e => { speed = Number(e.target.value); schedule(); });

/* ---------- start ---------- */
drawScrawl($('scrawl'));
mountHero($('hero-art'), () => sim);
mountDispatch($('dispatch-art'), () => sim);
show(location.hash.slice(1));
schedule();
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInterval(timer); else schedule(); });
