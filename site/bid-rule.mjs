// The rule every worker agent bids by. Plain JavaScript with no imports, so the runner (lib/agents.mjs) decides
// bids with it and the website uses the same code to tell a visitor who will bid before they post a job.
const YOCTO = 10n ** 24n;
const toYocto = near => { const [w, f = ''] = String(near).split('.'); return BigInt(w) * YOCTO + BigInt((f + '0'.repeat(24)).slice(0, 24)); };
export const MIN_BALANCE_NEAR = '0.02'; // covers the bid bond and the inference for one job
export const ADAPT_STEP_PERCENT = 10n; // an adaptive agent moves its price by this share of its base price per auction
export const ADAPT_MEMORY = 20; // how many of its past auctions an adaptive agent looks back over

/**
 * How an agent's past auctions went, oldest first: true where it won. `jobs` are jobs as the contract returns
 * them; only auctions before `beforeJobId` that it bid in and that had a winner count.
 */
export function auctionHistory(jobs, agentId, beforeJobId) {
  return jobs.filter(j => j && j.id < beforeJobId && j.winner && j.bidders.includes(agentId)).sort((a, b) => a.id - b.id).slice(-ADAPT_MEMORY).map(j => j.winner === agentId);
}

/** How many steps above its base price an adaptive agent bids: one up after each win, one down after each loss, never below zero. */
export const adaptiveSteps = history => history.reduce((steps, won) => (won ? steps + 1 : Math.max(0, steps - 1)), 0);

/**
 * Scripted bid: only jobs that match the agent's skills, never above the bounty or its means.
 * The base price is the manifest's floor, less a small discount for a closer fit. An agent whose manifest sets
 * `pricing.adaptive` then looks for the price the market will bear: it asks more after each auction it wins and
 * less after each it loses, between its base price and `pricing.ceilingNear`. `history` is auctionHistory() for it.
 */
export function decideBid(manifest, job, agent, history = []) {
  const text = job.description.toLowerCase();
  const matched = (manifest.skills ?? []).filter(skill => text.includes(skill.toLowerCase()));
  if (!matched.length) return { bid: false, reason: 'No skill matches this job.' };
  if (BigInt(agent.balance) < toYocto(MIN_BALANCE_NEAR)) return { bid: false, reason: 'Balance too low to cover the bond and the inference.' };
  const floor = toYocto(manifest.pricing.floorNear);
  // More matching skills means a better fit, so a small discount: specialists underbid generalists.
  const base = floor - (floor * BigInt(Math.min(matched.length - 1, 3)) * 5n) / 100n;
  let price = base, steps = 0;
  if (manifest.pricing.adaptive === true) {
    steps = adaptiveSteps(history);
    const ceiling = toYocto(manifest.pricing.ceilingNear), asked = base + (base * ADAPT_STEP_PERCENT * BigInt(steps)) / 100n;
    price = asked > ceiling ? ceiling : asked;
    if (price > BigInt(job.bounty)) price = BigInt(job.bounty) >= base ? BigInt(job.bounty) : price; // a small bounty is still worth taking at any price above base
  }
  if (price > BigInt(job.bounty)) return { bid: false, reason: 'The bounty is below this agent\'s floor price.' };
  return { bid: true, priceYocto: price, matched, ...(manifest.pricing.adaptive === true ? { adaptive: { steps, baseYocto: base } } : {}) };
}
