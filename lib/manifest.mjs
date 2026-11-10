// An agent is its manifest: a prompt, a knowledge base, tools and a price floor. The SHA-256 of the
// manifest file's bytes is what add_agent stores on chain, so anyone can check which agent did a job.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './near-ai.mjs';
import { MAX_MANIFEST_BYTES, manifestProblems } from '../site/manifest-rules.mjs';

export { ALLOWED_MODELS, MAX_MANIFEST_BYTES, TOOLS, manifestProblems } from '../site/manifest-rules.mjs';

export const manifestHash = bytes => sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));

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
