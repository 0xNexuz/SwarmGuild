// Loads the public site in a real browser and checks that its Testnet page shows what the chain holds.
// Needs Playwright (not a dependency of this repository): npm install --no-save playwright && npx playwright install chromium
//   node scripts/check-site.mjs [https://swarmguild.vercel.app]
import { chromium } from 'playwright';
import { main, readPlan, testnet } from './common.mjs';

main(async () => {
  const base = (process.argv[2] ?? 'https://swarmguild.vercel.app').replace(/\/$/, '');
  const plan = readPlan(); const chain = await testnet({}, { signing: false });
  const config = await chain.view(plan.guild, 'get_config');
  const agents = await chain.view(plan.guild, 'get_agents', { from: 0, limit: 100 });
  const jobs = await Promise.all(Array.from({ length: config.job_count }, (_, id) => chain.view(plan.guild, 'get_job', { job_id: id })));

  // SITE_CHECK_CHANNEL=chrome uses a browser already on the machine, so a CI run downloads nothing.
  const browser = await chromium.launch(process.env.SITE_CHECK_CHANNEL ? { channel: process.env.SITE_CHECK_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  // A push to main redeploys the site; wait for the version that has the Testnet page.
  let ready = false;
  for (let attempt = 0; attempt < 18 && !ready; attempt++) {
    await page.goto(`${base}/?t=${Date.now()}#live`, { waitUntil: 'load' });
    ready = await page.locator('#live-jobs tr.row').first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    ready = ready && await page.locator('#post-form [data-connect]').count() === 1; // the version with the wallet connector
  }
  const results = []; const check = (name, ok, detail = '') => results.push({ check: name, ok: Boolean(ok), detail: String(detail) });
  check('The Testnet page loads and lists jobs', ready);
  if (ready) {
    const rows = await page.locator('#live-jobs tr.row').count();
    check('It lists every job on chain', rows === jobs.length, `${rows} rows, ${jobs.length} jobs`);
    for (const job of jobs) {
      const text = await page.locator(`#live-jobs tr.row[data-job="${job.id}"] .status`).innerText().catch(() => '');
      if (['Paid', 'Rejected', 'Expired', 'Cancelled'].includes(job.status)) check(`Job ${job.id} is shown as ${job.status}`, text.toLowerCase() === job.status.toLowerCase(), text);
    }
    check('It lists every agent on chain', await page.locator('#live-agents > li').count() === agents.length);
    check('The header says the page is live', /live/i.test(await page.locator('#truth').innerText()));
    check('It shows the guild account and that it has no keys', (await page.locator('#live-facts').innerText()).includes(plan.guild) && /\b0\b/.test(await page.locator('#live-facts').innerText()));
    const paid = jobs.find(j => j.status === 'Paid');
    if (paid) {
      await page.locator(`#live-jobs tr.row[data-job="${paid.id}"]`).click();
      await page.locator('#live-jobs .detail-grid').waitFor({ timeout: 30000 });
      const detail = await page.locator('#live-jobs tr.detail').innerText();
      const good = (detail.match(/✓ matches chain/g) ?? []).length;
      check(`Job ${paid.id}: the browser rehashed the result and both reviewer reports, and they match the chain`, good >= 3 && !detail.includes('✗'), `${good} matches`);
      check(`Job ${paid.id}: the agent's result is shown`, (await page.locator('#live-jobs .result pre').innerText()).length > 20);
    }
    // Real use: the visitor's own wallet signs. The picker must offer wallets that work on Testnet, and the form must turn a job into a post_job call.
    await page.locator('#post-form [data-connect]').click();
    const picker = page.locator('.hot-connector-popup');
    const offered = await picker.waitFor({ state: 'attached', timeout: 30000 }).then(() => picker.innerText(), () => '');
    check('Connect wallet: the picker offers Meteor Wallet for Testnet', /Meteor Wallet/.test(offered), offered.replace(/\s+/g, ' ').slice(0, 200) || 'no picker');
    await page.keyboard.press('Escape'); await page.mouse.click(5, 5);
    await picker.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await page.locator('#post-form [name=account]').fill(plan.owner); await page.locator('#post-form [name=account]').blur();
    await page.locator('#post-form [name=description]').fill('Summarize this text: a site check.');
    await page.locator('#post-form button[type=submit]').click();
    const prepared = await page.locator('#post-out [data-sign]').waitFor({ timeout: 30000 }).then(() => true, () => false);
    check('Post a job: it prepares a post_job call for the visitor\'s wallet to sign', prepared && /0\.20 NEAR/.test(await page.locator('#post-out').innerText()), prepared ? '' : await page.locator('#post-out').innerText().catch(() => 'no output'));
    check('Post a job: it names the agent that will bid, by the runner\'s own rule', prepared && /Summarizer<\/b>.*will bid/.test(await page.locator('#post-out').innerHTML()), prepared ? (await page.locator('#post-out p').first().innerText()).slice(0, 200) : '');
    check('Post a job: it prints the same call as a near-cli command', prepared && (await page.locator('#post-out pre').innerText()).includes(`call-function as-transaction ${plan.guild} post_job`));
    await page.goto(`${base}/?t=${Date.now()}#swarm`, { waitUntil: 'load' });
    const landed = await page.locator('#real-flight .phase-name').first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    check('The landing page lists the latest real jobs', landed && await page.locator('#real-flight li').count() === Math.min(5, jobs.length));
    const newestPaid = jobs.filter(j => j.status === 'Paid').at(-1);
    if (newestPaid && await page.locator('#replay').count() === 1) { // the front page replays one real job, step by step
      const replayed = await page.locator('#replay li[data-s=done], #replay li[data-s=now]').first().waitFor({ timeout: 30000 }).then(() => true, () => false);
      check(`The front page replays job ${newestPaid.id}, the newest paid job, with its real prices`, replayed && (await page.locator('#replay-title').innerText()).includes(`#${newestPaid.id}`)
        && (await page.locator('#replay').innerText()).includes('NEAR escrowed'), replayed ? await page.locator('#replay-title').innerText() : 'no replay');
    }
    if (await page.locator('#demo-video').count() === 1) { // the demo video is served from the site itself
      const video = await fetch(`${base}/media/demo.mp4`, { method: 'HEAD', signal: AbortSignal.timeout(20000) }).then(r => ({ ok: r.ok, type: r.headers.get('content-type') ?? '' }), e => ({ ok: false, type: e.message }));
      check('The front page has the demo video, and its file is served', video.ok && video.type.startsWith('video/'), video.type);
    }
    await page.goto(`${base}/?t=${Date.now()}#simulation`, { waitUntil: 'load' });
    check('The simulation page says it is a simulation', /simulation/i.test(await page.locator('#truth').innerText()));
    check('No script error on the page', errors.length === 0, errors.join(' | '));
  }
  await browser.close();
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} [site] ${r.check}${r.ok ? '' : ` (${r.detail})`}`);
  console.log(JSON.stringify({ site: base, checks: results.length, failed: results.filter(r => !r.ok).length }));
  if (results.some(r => !r.ok)) process.exitCode = 1;
});
