// The artwork. Four sources merged into one drawing that is driven by the market's own data:
// a hand-scrawled title, a flock (the agents), a ring of radiating bars (their balances),
// a crowd with one figure made of binary (the agent among people), and a hub that links what is near it.
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function fit(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: width, h: height };
}

/* ---------- the scrawled title ---------- */
const LETTERS = {
  S: [[[.92, .14], [.55, 0], [.12, .2], [.3, .48], [.78, .58], [.9, .84], [.5, 1], [.04, .86]]],
  W: [[[0, .04], [.2, 1], [.5, .34], [.76, 1], [1, 0]]],
  A: [[[0, 1], [.46, 0], [.96, 1]], [[.2, .64], [.76, .58]]],
  R: [[[.1, 1], [.1, 0], [.7, .08], [.86, .3], [.6, .5], [.14, .56]], [[.42, .52], [.92, 1]]],
  M: [[[0, 1], [.1, 0], [.5, .62], [.86, 0], [1, 1]]],
};
export function drawScrawl(svg, word = 'SWARM') {
  const rand = rng(11);
  const ns = 'http://www.w3.org/2000/svg';
  let x = 14, delay = 0.15;
  for (const ch of word) {
    const width = ch === 'W' || ch === 'M' ? 150 : 118, height = 150 + rand() * 30, top = 30 + rand() * 34, tilt = (rand() - .5) * .16;
    for (const stroke of LETTERS[ch]) {
      const pts = stroke.map(([px, py]) => {
        const lx = px * width + (rand() - .5) * 12, ly = py * height + (rand() - .5) * 12;
        return [x + lx + ly * tilt, top + ly];
      });
      let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
      }
      d += ` L${pts.at(-1)[0].toFixed(1)} ${pts.at(-1)[1].toFixed(1)}`;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d); path.setAttribute('pathLength', '1'); path.setAttribute('stroke-width', (9 + rand() * 4).toFixed(1));
      path.style.animationDelay = `${delay}s`; svg.append(path);
      // ink blots where the pen rested
      for (const [bx, by] of [pts[0], pts.at(-1), pts[Math.floor(pts.length / 2)]]) {
        if (rand() < .3) continue;
        const blot = document.createElementNS(ns, 'circle');
        blot.setAttribute('cx', bx.toFixed(1)); blot.setAttribute('cy', by.toFixed(1)); blot.setAttribute('r', (6 + rand() * 6).toFixed(1));
        blot.style.animationDelay = `${delay + .55}s`; svg.append(blot);
      }
      delay += .22;
    }
    x += width + 18;
  }
}

/* ---------- hero ---------- */
function figure(cx, base, s) {
  const p = new Path2D();
  p.ellipse(cx, base - 2.05 * s, .46 * s, .56 * s, 0, 0, Math.PI * 2);
  p.moveTo(cx - .3 * s, base - 1.72 * s);
  p.bezierCurveTo(cx - 1.35 * s, base - 1.45 * s, cx - 1.5 * s, base - .6 * s, cx - 1.55 * s, base + .2 * s);
  p.lineTo(cx + 1.55 * s, base + .2 * s);
  p.bezierCurveTo(cx + 1.5 * s, base - .6 * s, cx + 1.35 * s, base - 1.45 * s, cx + .3 * s, base - 1.72 * s);
  p.closePath();
  return p;
}

export function mountHero(canvas, getSim) {
  let ctx, w, h, backdrop, people, ring, crowd = [], cells = [], birds = [], frame = 0, raf = 0;
  const pointer = { x: null, y: null, active: false };
  const hub = { x: 0, y: 0 };
  const bars = new Map();

  function layout() {
    ({ ctx, w, h } = fit(canvas));
    const narrow = w < 700;
    ring = { x: w * (narrow ? .1 : .3), y: h * .46, r: Math.max(h * .5, 240) };
    hub.x = ring.x + ring.r * .78; hub.y = h * .34;
    const rand = rng(5);
    // crowd along the bottom right, backs to us
    crowd = []; const n = narrow ? 5 : 9; const s = (narrow ? w * .13 : Math.min(w * .05, h * .105));
    for (let i = 0; i < n; i++) {
      const cx = w * (narrow ? .1 : .42) + i * s * 1.95 + (rand() - .5) * s * .5, size = s * (.9 + rand() * .3);
      crowd.push({ path: figure(cx, h + size * .1, size), cx, s: size, shade: 20 + Math.floor(rand() * 50), binary: i === (narrow ? 2 : 5) });
    }
    // the cells of the binary figure
    cells = []; const b = crowd.find(c => c.binary); const step = Math.max(9, b.s * .135);
    for (let y = h - b.s * 3; y < h + 4; y += step) for (let x = b.cx - b.s * 1.7; x < b.cx + b.s * 1.7; x += step * .78) {
      if (ctx.isPointInPath(b.path, x * (canvas.width / w), y * (canvas.height / h))) cells.push({ x, y, v: rand() < .5 ? '0' : '1', a: .45 + rand() * .55 });
    }
    cells.step = step;
    birds = Array.from({ length: narrow ? 70 : 130 }, (_, i) => ({ x: rand() * w, y: rand() * h * .8, vx: rand() - .5, vy: rand() - .5, size: 2.5 + rand() * rand() * 9, phase: rand() * 6.28, agent: i % 20 }));
    paintBackdrop();
  }

  function paintBackdrop() {
    backdrop = document.createElement('canvas'); backdrop.width = canvas.width; backdrop.height = canvas.height;
    let b = backdrop.getContext('2d'); b.scale(canvas.width / w, canvas.height / h);
    const rand = rng(21);
    b.fillStyle = '#f2f1ec'; b.fillRect(0, 0, w, h);
    // paper grain
    for (let i = 0; i < w * h / 260; i++) { b.fillStyle = `rgba(12,12,11,${rand() * .09})`; b.fillRect(rand() * w, rand() * h, 1, 1); }
    // the tangle inside the ring
    b.save(); b.beginPath(); b.arc(ring.x, ring.y, ring.r - 8, 0, Math.PI * 2); b.clip();
    b.lineWidth = .5;
    for (let i = 0; i < 150; i++) {
      b.strokeStyle = `rgba(12,12,11,${.1 + rand() * .32})`;
      const a1 = rand() * 6.28, a2 = a1 + 1.4 + rand() * 3.2, r1 = ring.r * (.4 + rand() * .7), r2 = ring.r * (.4 + rand() * .7);
      b.beginPath(); b.moveTo(ring.x + Math.cos(a1) * r1, ring.y + Math.sin(a1) * r1);
      b.quadraticCurveTo(ring.x + (rand() - .5) * ring.r * 1.5, ring.y + (rand() - .5) * ring.r * 1.5, ring.x + Math.cos(a2) * r2, ring.y + Math.sin(a2) * r2);
      b.stroke();
    }
    for (let i = 0; i < 26; i++) { b.beginPath(); b.arc(ring.x + (rand() - .5) * ring.r * 1.4, ring.y + (rand() - .5) * ring.r * 1.4, 1.5 + rand() * 3, 0, 6.28); b.strokeStyle = 'rgba(12,12,11,.55)'; b.stroke(); }
    b.restore();
    // the ring itself, with ticks and tiny labels
    b.strokeStyle = '#0c0c0b'; b.lineWidth = 1.2; b.beginPath(); b.arc(ring.x, ring.y, ring.r, -1.25, 1.25); b.stroke();
    b.lineWidth = .6; b.beginPath(); b.arc(ring.x, ring.y, ring.r + 9, -1.25, 1.25); b.stroke();
    b.font = '6.5px "Martian Mono", monospace'; b.fillStyle = 'rgba(12,12,11,.7)';
    for (let a = -1.22; a < 1.23; a += .028) {
      const long = Math.round(a * 1000) % 5 === 0; const r1 = ring.r + 9, r2 = r1 + (long ? 7 : 3);
      b.beginPath(); b.moveTo(ring.x + Math.cos(a) * r1, ring.y + Math.sin(a) * r1); b.lineTo(ring.x + Math.cos(a) * r2, ring.y + Math.sin(a) * r2); b.stroke();
    }
    // faint filler rays, like a print's texture
    for (let i = 0; i < 260; i++) {
      const a = -1.15 + rand() * 2.3, r1 = ring.r + 22 + rand() * 30, len = 20 + rand() * rand() * w * .42;
      b.strokeStyle = `rgba(12,12,11,${.05 + rand() * .16})`; b.lineWidth = .5;
      b.beginPath(); b.moveTo(ring.x + Math.cos(a) * r1, ring.y + Math.sin(a) * r1); b.lineTo(ring.x + Math.cos(a) * (r1 + len), ring.y + Math.sin(a) * (r1 + len)); b.stroke();
    }
    // the crowd, in halftone, on its own layer so it stands in front of the bars
    people = document.createElement('canvas'); people.width = canvas.width; people.height = canvas.height;
    b = people.getContext('2d'); b.scale(canvas.width / w, canvas.height / h);
    for (const c of crowd) {
      if (c.binary) continue;
      b.save(); b.clip(c.path);
      const g = b.createLinearGradient(0, h - c.s * 3, 0, h); g.addColorStop(0, `rgb(${c.shade + 40},${c.shade + 40},${c.shade + 38})`); g.addColorStop(1, `rgb(${c.shade},${c.shade},${c.shade})`);
      b.fillStyle = g; b.fillRect(c.cx - c.s * 2, h - c.s * 3.2, c.s * 4, c.s * 3.4);
      for (let i = 0; i < 900; i++) { b.fillStyle = `rgba(242,241,236,${rand() * .22})`; b.fillRect(c.cx - c.s * 2 + rand() * c.s * 4, h - c.s * 3.2 + rand() * c.s * 3.4, 1.4, 1.4); }
      b.restore();
    }
  }

  function draw(time) {
    frame++;
    const sim = getSim();
    ctx.drawImage(backdrop, 0, 0, w, h);
    // balance bars radiating from the ring: one per agent, then the reviewers
    const parties = [...sim.state.agents, ...sim.state.reviewers];
    const max = Math.max(4000, ...parties.map(p => p.balance + (p.locked ?? 0)));
    parties.forEach((p, i) => {
      const target = (p.balance + (p.locked ?? 0)) / max;
      const now = bars.get(p.id) ?? 0; const v = now + (target - now) * .06; bars.set(p.id, v);
      const a = -1.08 + (i / (parties.length - 1)) * 2.16, r1 = ring.r + 20, len = 14 + v * w * .36;
      ctx.strokeStyle = '#0c0c0b'; ctx.lineWidth = p.locked ? 3.4 : 2;
      ctx.beginPath(); ctx.moveTo(ring.x + Math.cos(a) * r1, ring.y + Math.sin(a) * r1); ctx.lineTo(ring.x + Math.cos(a) * (r1 + len), ring.y + Math.sin(a) * (r1 + len)); ctx.stroke();
      if (p.locked) { ctx.fillStyle = '#0b8a26'; ctx.beginPath(); ctx.arc(ring.x + Math.cos(a) * (r1 + len + 6), ring.y + Math.sin(a) * (r1 + len + 6), 2.6, 0, 6.28); ctx.fill(); }
    });
    ctx.drawImage(people, 0, 0, w, h);
    // the binary figure: paper behind it, so the bars do not cut through
    const bin = crowd.find(c => c.binary); ctx.fillStyle = '#f2f1ec'; ctx.fill(bin.path);
    ctx.font = `600 ${Math.round(cells.step * .95)}px "Martian Mono", monospace`; ctx.textBaseline = 'top';
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if ((i * 7 + frame) % 97 === 0) c.v = c.v === '0' ? '1' : '0';
      ctx.fillStyle = `rgba(11,138,38,${c.a})`; ctx.fillText(c.v, c.x, c.y);
    }
    // the flock
    const t = time / 1000;
    const ax = w * .62 + Math.cos(t * .23) * w * .26, ay = h * .36 + Math.sin(t * .31) * h * .2;
    for (const b of birds) {
      let fx = (ax - b.x) * .00035 + Math.cos(t * .7 + b.phase) * .012, fy = (ay - b.y) * .00035 + Math.sin(t * .9 + b.phase) * .012;
      for (const o of birds) { if (o === b) continue; const dx = b.x - o.x, dy = b.y - o.y, d2 = dx * dx + dy * dy; if (d2 < 420 && d2 > 0) { fx += dx / d2 * .32; fy += dy / d2 * .32; } }
      b.vx = (b.vx + fx) * .992; b.vy = (b.vy + fy) * .992;
      const speed = Math.hypot(b.vx, b.vy), cap = 1.5; if (speed > cap) { b.vx *= cap / speed; b.vy *= cap / speed; }
      b.x += b.vx; b.y += b.vy;
      const angle = Math.atan2(b.vy, b.vx), flap = Math.sin(t * 9 + b.phase) * .35;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(angle); ctx.fillStyle = '#0c0c0b';
      ctx.beginPath(); ctx.moveTo(b.size, 0); ctx.lineTo(-b.size * .7, -b.size * (.75 + flap)); ctx.lineTo(-b.size * .25, 0); ctx.lineTo(-b.size * .7, b.size * (.75 - flap)); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    // the hub: links the agents nearest to it and reads out where they are
    const tx = pointer.active ? pointer.x : ring.x + ring.r * .8 + Math.cos(t * .4) * 40, ty = pointer.active ? pointer.y : h * .32 + Math.sin(t * .5) * 30;
    hub.x += (tx - hub.x) * .08; hub.y += (ty - hub.y) * .08;
    const near = birds.map(b => ({ b, d: Math.hypot(b.x - hub.x, b.y - hub.y) })).sort((p, q) => p.d - q.d).slice(0, w < 700 ? 7 : 13);
    ctx.font = '8px "Martian Mono", monospace'; ctx.textBaseline = 'alphabetic';
    for (const { b } of near) {
      ctx.strokeStyle = 'rgba(12,12,11,.55)'; ctx.lineWidth = .7; ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = '#f2f1ec'; ctx.strokeStyle = '#0c0c0b'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(b.x, b.y, 3.4, 0, 6.28); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(12,12,11,.8)'; ctx.fillText(`${(b.x - hub.x).toFixed(2)},${(b.y - hub.y).toFixed(2)}`, b.x + 7, b.y - 6);
    }
    ctx.fillStyle = '#0b8a26'; ctx.beginPath(); ctx.arc(hub.x, hub.y, 4.5, 0, 6.28); ctx.fill();
    if (!reduced()) raf = requestAnimationFrame(draw);
  }

  const move = e => { const r = canvas.getBoundingClientRect(); pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.active = pointer.y >= 0 && pointer.y <= r.height; };
  canvas.parentElement.addEventListener('pointermove', move);
  canvas.parentElement.addEventListener('pointerleave', () => { pointer.active = false; });
  let resizeTimer; addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { layout(); if (reduced()) draw(0); }, 120); });
  layout();
  document.fonts?.ready.then(() => { paintBackdrop(); if (reduced()) draw(0); });
  if (reduced()) { for (let i = 0; i < 40; i++) bars.clear(); draw(4000); } else raf = requestAnimationFrame(draw);
  return { redraw: () => { if (reduced()) draw(4000); }, stop: () => cancelAnimationFrame(raf) };
}

/* ---------- console: the dispatch map ---------- */
export function mountDispatch(canvas, getSim) {
  let ctx, w, h, hover = null;
  const pos = new Map();
  const place = (id, tx, ty) => { const p = pos.get(id) ?? { x: tx, y: ty }; p.x += (tx - p.x) * .08; p.y += (ty - p.y) * .08; pos.set(id, p); return p; };
  function draw() {
    if (!canvas.offsetParent) { requestAnimationFrame(draw); return; }
    if (!ctx || Math.abs(canvas.getBoundingClientRect().width - w) > 1) ({ ctx, w, h } = fit(canvas));
    const sim = getSim();
    ctx.fillStyle = '#070707'; ctx.fillRect(0, 0, w, h);
    const pad = 38;
    const agents = sim.state.agents.map(a => ({ a, p: place(a.id, pad + a.x * (w - pad * 2), pad + a.y * (h - pad * 2)) }));
    const live = sim.state.jobs.filter(j => j.phase !== 'done').slice(-6);
    ctx.font = '8.5px "Martian Mono", monospace';
    live.forEach((job, i) => {
      const angle = (job.id * 2.399) % 6.28, hubP = place(`job-${job.id}`, w / 2 + Math.cos(angle) * w * .2, h / 2 + Math.sin(angle) * h * .22);
      for (const bid of job.bids) {
        const target = agents.find(x => x.a.id === bid.agent); if (!target) continue;
        const winner = job.winner === bid.agent;
        if (job.winner && !winner) continue;
        ctx.strokeStyle = winner ? '#27e04a' : 'rgba(241,240,234,.5)'; ctx.lineWidth = winner ? 1.6 : .7;
        ctx.beginPath(); ctx.moveTo(hubP.x, hubP.y); ctx.lineTo(target.p.x, target.p.y); ctx.stroke();
      }
      ctx.fillStyle = '#27e04a'; ctx.beginPath(); ctx.arc(hubP.x, hubP.y, 5, 0, 6.28); ctx.fill();
      ctx.fillStyle = '#f1f0ea'; ctx.fillText(`#${job.id} ${job.phase}`, hubP.x + 9, hubP.y + 3);
    });
    for (const { a, p } of agents) {
      const dry = a.balance < 200, on = hover === a.id;
      ctx.fillStyle = dry ? '#3a3a37' : '#f1f0ea'; ctx.beginPath(); ctx.arc(p.x, p.y, on ? 6 : 3.6, 0, 6.28); ctx.fill();
      ctx.fillStyle = on ? '#27e04a' : 'rgba(241,240,234,.62)';
      ctx.fillText(on ? `${a.name}  ${(a.balance / 10000).toFixed(3)} NEAR  won ${a.won}` : `${(p.x - w / 2).toFixed(2)},${(p.y - h / 2).toFixed(2)}`, p.x + 8, p.y - 7);
    }
    if (!reduced()) requestAnimationFrame(draw);
  }
  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 18; for (const [id, p] of pos) { if (id.startsWith('job')) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = id; } }
    hover = best; canvas.style.cursor = best ? 'crosshair' : 'default';
  });
  canvas.addEventListener('pointerleave', () => { hover = null; });
  requestAnimationFrame(draw);
  return { redraw: () => { if (reduced()) { for (let i = 0; i < 60; i++) draw(); } } };
}
