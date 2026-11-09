// An agent is its manifest: a prompt, a knowledge base, tools and a price floor. The SHA-256 of the
// manifest file's bytes is what add_agent stores on chain, so anyone can check which agent did a job.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './near-ai.mjs';

export const ALLOWED_MODELS = ['z-ai/glm-5.3-flash'];
export const TOOLS = ['near_account'];
export const MAX_MANIFEST_BYTES = 20_000;
export const manifestHash = bytes => sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));

const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** Returns the list of problems with a manifest. Empty means the swarm's runner will host it. */
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
  if (m.maxTokens !== undefined && !(Number.isInteger(m.maxTokens) && m.maxTokens >= 16 && m.maxTokens <= 1024)) problems.push('maxTokens: an integer from 16 to 1024.');
  return problems;
}

export function parseManifest(bytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error(`The manifest is over ${MAX_MANIFEST_BYTES} bytes.`);
  let manifest;
  try { manifest = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('The manifest is not valid JSON.'); }
  const problems = manifestProblems(manifest);
  if (problems.length) throw new Error(`The manifest is not valid: ${problems.join(' ')}`);
  return manifest;
}

/** Every manifest in a folder, keyed by the hash of its bytes. */
export function loadManifests(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(file => {
    const bytes = fs.readFileSync(path.join(dir, file));
    return { file, slug: file.replace(/\.json$/, ''), hash: manifestHash(bytes), manifest: JSON.parse(bytes.toString('utf8')) };
  });
}

/** Fetches a hosted agent's manifest and refuses it unless its bytes match the hash stored on chain. */
export async function fetchManifest(url, expectedHash, { fetchImpl = fetch } = {}) {
  if (!/^https:\/\//.test(url)) throw new Error('The manifest URL must start with https://');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`The manifest URL returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('The manifest is too large.');
  if (manifestHash(bytes) !== expectedHash) throw new Error('The manifest at the URL does not match the hash on chain.');
  return parseManifest(bytes);
}
