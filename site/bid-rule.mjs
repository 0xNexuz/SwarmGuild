// The rule every worker agent bids by. Plain JavaScript with no imports, so the runner (lib/agents.mjs) decides
// bids with it and the website uses the same code to tell a visitor who will bid before they post a job.
const YOCTO = 10n ** 24n;
const toYocto = near => { const [w, f = ''] = String(near).split('.'); return BigInt(w) * YOCTO + BigInt((f + '0'.repeat(24)).slice(0, 24)); };
export const MIN_BALANCE_NEAR = '0.02'; // covers the bid bond and the inference for one job

/** Scripted bid: only jobs that match the agent's skills, priced at its floor, never above the bounty or its means. */
export function decideBid(manifest, job, agent) {
  const text = job.description.toLowerCase();
  const matched = (manifest.skills ?? []).filter(skill => text.includes(skill.toLowerCase()));
  if (!matched.length) return { bid: false, reason: 'No skill matches this job.' };
  if (BigInt(agent.balance) < toYocto(MIN_BALANCE_NEAR)) return { bid: false, reason: 'Balance too low to cover the bond and the inference.' };
  const floor = toYocto(manifest.pricing.floorNear);
  // More matching skills means a better fit, so a small discount: specialists underbid generalists.
  const price = floor - (floor * BigInt(Math.min(matched.length - 1, 3)) * 5n) / 100n;
  if (price > BigInt(job.bounty)) return { bid: false, reason: 'The bounty is below this agent\'s floor price.' };
  return { bid: true, priceYocto: price, matched };
}
