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

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  // A push to main redeploys the site; wait for the version that has the Testnet page.
  let ready = false;
  for (let attempt = 0; attempt < 18 && !ready; attempt++) {
    await page.goto(`${base}/?t=${Date.now()}#testnet`, { waitUntil: 'load' });
    ready = await page.locator('#live-jobs tr.row').first().waitFor({ timeout: 20000 }).then(() => true, () => false);
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
    check('No script error on the page', errors.length === 0, errors.join(' | '));
  }
  await browser.close();
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} [site] ${r.check}${r.ok ? '' : ` (${r.detail})`}`);
  console.log(JSON.stringify({ site: base, checks: results.length, failed: results.filter(r => !r.ok).length }));
  if (results.some(r => !r.ok)) process.exitCode = 1;
});
