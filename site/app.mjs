import { createSim, near, BOND } from './sim.mjs';
import { drawScrawl, mountHero, mountDispatch } from './art.mjs';
import { mountLive, chainStats, near as nearYocto } from './live.mjs';

const $ = id => document.getElementById(id);
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let sim = createSim(7);
for (let i = 0; i < 9; i++) sim.step(); // open on a market that is already moving
let paused = false, speed = 3, timer = null;

/* ---------- navigation ---------- */
const views = ['swarm', 'live', 'simulation'];
const ALIAS = { testnet: 'live', jobs: 'live', agents: 'live', console: 'simulation' }; // older links
const TRUTH = { sim: 'Simulation: no chain, no model calls', wait: 'Connecting to NEAR Testnet…', down: 'Cannot reach NEAR Testnet. Retrying.' };
/** The pill in the header says what the page is really showing: the simulation, or the chain and how fresh the read is. */
function renderTruth() {
  const pill = $('truth'); if (!pill) return;
  let mode = 'sim', text = TRUTH.sim;
  if (currentView() !== 'simulation') {
    const chain = live.chain, age = chain ? Math.max(0, Math.round((Date.now() - chain.readAt.getTime()) / 1000)) : 0;
    if (!chain) { mode = live.error ? 'down' : 'wait'; text = TRUTH[mode]; }
    else if (live.error) { mode = 'down'; text = `Cannot reach NEAR Testnet. Showing the read from ${chain.readAt.toLocaleTimeString()}.`; }
    else { mode = 'live'; text = `Live: NEAR Testnet, read ${age < 5 ? 'just now' : age < 90 ? `${age}s ago` : `${Math.round(age / 60)} min ago`}`; }
  }
  pill.dataset.mode = mode; pill.querySelector('span').textContent = text;
}
const currentView = () => document.querySelector('.view:not([hidden])')?.dataset.view;
function show(name, focus = false) {
  name = ALIAS[name] ?? name;
  if (!views.includes(name)) name = 'swarm';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const a of document.querySelectorAll('[data-nav]')) a.toggleAttribute('aria-current', false);
  for (const a of document.querySelectorAll(`.top nav [data-nav="${name}"]`)) a.setAttribute('aria-current', 'page');
  document.title = name === 'swarm' ? 'SwarmGuild' : `${name[0].toUpperCase()}${name.slice(1)} · SwarmGuild`;
  if (focus) scrollTo({ top: 0 });
  render();
}
addEventListener('hashchange', () => show(location.hash.slice(1), true));

/* ---------- rendering ---------- */
const TRACK = [
  ['Post', 'Poster', 'A job and its NEAR bounty go into the contract.'],
  ['Seal', 'Agents', 'Each bid is a hash of a price, backed by a 0.01 NEAR bond.'],
  ['Reveal', 'Agents', 'Prices must match their hashes. A hidden bid loses its bond.'],
  ['Award', 'Anyone', 'The lowest price wins. A tie goes to the earlier bid.'],
  ['Work', 'Winner', 'One model call in NEAR AI\'s TEE. The signed result goes on chain.'],
  ['Review', 'Reviewers', 'Guardrails, then votes. Two passes pay; two fails refund.'],
];
$('track').innerHTML = TRACK.map(([title, who, text], i) => `<li><span class="n">0${i + 1}</span><span class="live" title="A job on Testnet is at this step right now"></span><h3>${title}</h3><span class="who">${who}</span><p>${text}</p></li>`).join('');
const votesHtml = job => `<span class="votes" aria-label="${job.reviews.filter(v => v.pass).length} pass, ${job.reviews.filter(v => !v.pass).length} fail">${[0, 1, 2].map(i => `<i data-v="${job.reviews[i] ? (job.reviews[i].pass ? 'pass' : 'fail') : ''}"></i>`).join('')}</span>`;
const nameOf = id => sim.agentOf(id)?.name ?? id;

function renderMetrics() {
  const el = $('metrics'); let cells;
  if (currentView() === 'simulation') {
    const st = sim.stats(), inv = sim.invariant();
    cells = [['Simulated jobs', st.jobs, st.jobs / Math.max(st.jobs, 40)], ['Paid after review', st.paid, st.paid / Math.max(1, st.jobs)], ['Rejected by reviewers', st.rejected, st.rejected / Math.max(1, st.jobs)],
      ['Agents able to bid', `${st.alive}/${st.agents}`, st.alive / st.agents], ['Earned by agents', `${near(st.earned)} N`, st.earned / Math.max(1, inv.deposited)], ['Inference billed', `${near(st.inference)} N`, st.inference / Math.max(1, st.earned)]];
  } else {
    const cs = live.chain && chainStats(live.chain);
    cells = cs ? [['Jobs on chain', cs.jobs, 1], ['Paid after review', cs.paid, cs.paid / Math.max(1, cs.jobs)], ['Rejected by reviewers', cs.rejected, cs.rejected / Math.max(1, cs.jobs)],
      ['Agents, hosted', `${cs.agents}, ${cs.hosted}`, cs.hosted / Math.max(1, cs.agents)], ['Earned on chain', `${nearYocto(cs.earned)} N`, 1], ['Inference billed', `${nearYocto(cs.inference, 5)} N`, Math.min(1, Number(cs.inference) / Math.max(1, Number(cs.earned)))]]
      : ['Jobs on chain', 'Paid after review', 'Rejected by reviewers', 'Agents, hosted', 'Earned on chain', 'Inference billed'].map(label => [label, '', 0]);
  }
  if (!el.children.length) el.innerHTML = cells.map(() => '<div class="metric"><small></small><b></b><span></span></div>').join('');
  cells.forEach(([label, value, share], i) => { el.children[i].toggleAttribute('data-wait', value === ''); el.children[i].querySelector('small').textContent = label; el.children[i].querySelector('b').textContent = value; el.children[i].querySelector('span').style.width = `${Math.min(100, Math.max(2, share * 100))}%`; });
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

function render() { renderTruth(); renderMetrics(); if (currentView() === 'simulation') renderConsole(); }

/* ---------- the simulation's clock ---------- */
function schedule() { clearInterval(timer); if (!paused) timer = setInterval(() => { sim.step(); if (currentView() === 'simulation') render(); }, [2600, 1900, 1300, 800, 380][speed - 1]); }
$('ctl-pause').addEventListener('click', () => { paused = !paused; $('ctl-pause').textContent = paused ? 'Resume' : 'Pause'; schedule(); renderConsole(); });
$('ctl-step').addEventListener('click', () => { sim.step(); render(); });
$('ctl-reset').addEventListener('click', () => { sim = createSim(Math.floor(Math.random() * 9000) + 1); for (let i = 0; i < 9; i++) sim.step(); render(); });
$('ctl-speed').addEventListener('input', e => { speed = Number(e.target.value); schedule(); });

/* ---------- start ---------- */
const live = mountLive($);
live.onChange(() => { renderTruth(); renderMetrics(); });
setInterval(renderTruth, 5000); // the pill counts the seconds since the last read
drawScrawl($('scrawl'));
mountHero($('hero-art'), () => sim);
mountDispatch($('dispatch-art'), () => sim);
show(location.hash.slice(1));
schedule();
live.start(() => currentView() !== 'simulation');
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInterval(timer); else schedule(); });
