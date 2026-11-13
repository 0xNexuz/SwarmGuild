// The rules a manifest must pass before the swarm's runner will host it. Plain JavaScript with no imports,
// so the website and the runner (lib/manifest.mjs) check manifests with the same code.
export const ALLOWED_MODELS = ['z-ai/glm-5.3-flash'];
export const TOOLS = ['near_account'];
export const MAX_MANIFEST_BYTES = 20_000;

const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** Returns the list of problems with a manifest. Empty means the runner will host it. */
export function manifestProblems(m) {
  const problems = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['The manifest must be a JSON object.'];
  if (!isText(m.name, 64)) problems.push('name: 1 to 64 characters.');
  if (!ALLOWED_MODELS.includes(m.model)) problems.push(`model: one of ${ALLOWED_MODELS.join(', ')}.`);
  if (!isText(m.prompt, 4000)) problems.push('prompt: 1 to 4000 characters.');
  const list = (key, maxItems, maxLen) => {
    const v = m[key] ?? [];
    if (!Array.isArray(v) || v.length > maxItems || v.some(x => !isText(x, maxLen))) problems.push(`${key}: up to ${maxItems} strings of at most ${maxLen} characters.`);
    return Array.isArray(v) ? v : [];
  };
  list('knowledge', 10, 1000);
  if (!list('skills', 12, 32).length) problems.push('skills: at least one keyword, or the agent never bids.');
  if (list('tools', 4, 32).some(t => !TOOLS.includes(t))) problems.push(`tools: only ${TOOLS.join(', ')}.`);
  if (!/^\d{1,3}(\.\d{1,6})?$/.test(m.pricing?.floorNear ?? '') || Number(m.pricing.floorNear) <= 0) problems.push('pricing.floorNear: a decimal NEAR amount such as "0.08".');
  if (m.pricing?.adaptive !== undefined && typeof m.pricing.adaptive !== 'boolean') problems.push('pricing.adaptive: true or false.');
  if (m.pricing?.adaptive === true && !(/^\d{1,3}(\.\d{1,6})?$/.test(m.pricing.ceilingNear ?? '') && Number(m.pricing.ceilingNear) >= Number(m.pricing.floorNear)))
    problems.push('pricing.ceilingNear: an adaptive agent needs a ceiling, a decimal NEAR amount at or above its floor.');
  if (m.maxTokens !== undefined && !(Number.isInteger(m.maxTokens) && m.maxTokens >= 16 && m.maxTokens <= 1024)) problems.push('maxTokens: an integer from 16 to 1024.');
  return problems;
}
