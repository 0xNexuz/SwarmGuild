// NEAR AI Cloud client: one chat call, the TEE signature for it, and the check that the signing key is
// in a fresh, nonce-bound attestation report. Every reply an agent uses goes through verifyReply.
import { createHash, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export const CLOUD = 'https://cloud-api.near.ai';
export const sha256 = data => createHash('sha256').update(data).digest('hex');
// USD per token for z-ai/glm-5.3-flash, as NEAR AI reported them with its attestation on 2026-11-04.
export const USD_PER_TOKEN = { input: 80e-9, output: 500e-9 };
// Test NEAR has no price, so the operator bills inference at this fixed rate. It is a demo constant.
export const YOCTO_PER_USD = 10n ** 24n; // 1 test NEAR per US dollar
export const MIN_CHARGE_YOCTO = 10n ** 20n; // 0.0001 NEAR, so every call leaves a visible charge

export function costYocto(usage, price = USD_PER_TOKEN) {
  const usd = (usage?.prompt_tokens ?? 0) * price.input + (usage?.completion_tokens ?? 0) * price.output;
  const yocto = BigInt(Math.round(usd * 1e9)) * (YOCTO_PER_USD / 10n ** 9n);
  return yocto > MIN_CHARGE_YOCTO ? yocto : MIN_CHARGE_YOCTO;
}

// EIP-191 personal_sign recovery: the address that signed `message`.
export function eip191Recover(message, signatureHex) {
  const msg = Buffer.from(message, 'utf8');
  const digest = keccak_256(Buffer.concat([Buffer.from(`\u0019Ethereum Signed Message:\n${msg.length}`, 'utf8'), msg]));
  const sig = Buffer.from(String(signatureHex).replace(/^0x/, ''), 'hex');
  if (sig.length !== 65) throw new Error('Signature must be 65 bytes');
  const recovery = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const publicKey = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(false);
  return `0x${Buffer.from(keccak_256(publicKey.subarray(1)).subarray(12)).toString('hex')}`;
}

const attestations = new Map();
const ATTESTATION_REUSE_MS = 30 * 60 * 1000;
export function forgetAttestations() { attestations.clear(); }
// Which signing keys NEAR AI attests for `model` right now. The report must echo our random nonce.
export async function attestedKeys(model, { apiKey, fetchImpl = fetch, now = Date.now } = {}) {
  const cached = attestations.get(model);
  if (cached && now() - cached.fetchedAtMs < ATTESTATION_REUSE_MS) return cached;
  const nonce = randomBytes(32).toString('hex');
  const params = new URLSearchParams({ model, provider: 'near', signing_algo: 'ecdsa', include_tls_fingerprint: 'false', nonce });
  const response = await fetchImpl(`${CLOUD}/v1/attestation/report?${params}`, {
    headers: { authorization: `Bearer ${apiKey}`, 'x-no-aliasing': 'true' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Object.assign(new Error(`Attestation report returned HTTP ${response.status}`), { status: response.status });
  const report = await response.json();
  const models = report.model_attestations ?? [];
  if (!models.length || report.gateway_attestation?.request_nonce !== nonce || models.some(m => m.request_nonce !== nonce)) {
    throw new Error('Attestation report does not echo our nonce');
  }
  const entry = { keys: new Set(models.map(m => m.signing_address.toLowerCase())), nonce, fetchedAtMs: now() };
  attestations.set(model, entry);
  return entry;
}

async function fetchSignature(chatId, { apiKey, fetchImpl, delay }) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetchImpl(`${CLOUD}/v1/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`,
      { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (response.status === 404 && attempt < 4) { await delay(400 * attempt); continue; }
    if (!response.ok) throw Object.assign(new Error(`Signature lookup returned HTTP ${response.status}`), { status: response.status });
    return response.json();
  }
  throw new Error('Signature lookup did not finish');
}

/**
 * One model call. Returns the reply text, token usage, and a `proof` that anyone can recheck:
 * the signed text is `model:sha256(request body):sha256(response body)`.
 */
export async function chat({ model, system, user, maxTokens = 1024 }, { apiKey, fetchImpl = fetch, delay = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!apiKey) throw Object.assign(new Error('NEAR_AI_KEY is not set'), { code: 'NOT_CONFIGURED' });
  const requestBody = JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  const response = await fetchImpl(`${CLOUD}/v1/chat/completions`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'identity', authorization: `Bearer ${apiKey}` },
    body: requestBody, signal: AbortSignal.timeout(90000) });
  const responseBytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw Object.assign(new Error(`NEAR AI returned HTTP ${response.status}`), { status: response.status });
  const payload = JSON.parse(responseBytes.toString('utf8'));
  const text = payload.choices?.[0]?.message?.content ?? '';
  const expectedText = `${model}:${sha256(Buffer.from(requestBody, 'utf8'))}:${sha256(responseBytes)}`;
  const [signature, attestation] = await Promise.all([
    fetchSignature(payload.id, { apiKey, fetchImpl, delay }), attestedKeys(model, { apiKey, fetchImpl })]);
  const proof = { chatId: payload.id, model, signedText: signature?.text ?? null, signature: signature?.signature ?? null,
    signingAddress: String(signature?.signing_address ?? '').toLowerCase() || null, signatureKind: signature?.signature_kind ?? null,
    expectedText };
  // The exact bytes that were signed, so anyone can recompute both hashes without trusting the caller.
  const transcript = { request: requestBody, response: responseBytes.toString('base64') };
  return { text, usage: payload.usage ?? null, costYocto: costYocto(payload.usage), proof, transcript,
    attestedKeys: [...attestation.keys], verification: verifyProof(proof, attestation.keys) };
}

/** Rechecks a proof without calling the model: right text, valid signature, and (if given) an attested key. */
export function verifyProof(proof, attested = null) {
  let recovered = null;
  try { recovered = eip191Recover(proof.signedText ?? '', proof.signature ?? ''); } catch { /* stays null */ }
  const checks = {
    signedByModelTee: proof.signatureKind === 'provider_tee',
    coversThisRequestAndReply: Boolean(proof.expectedText) && proof.signedText === proof.expectedText,
    signatureValid: recovered !== null && recovered === proof.signingAddress,
    keyInFreshAttestation: attested ? new Set(attested).has(proof.signingAddress) : null,
  };
  return { ...checks, verified: checks.signedByModelTee && checks.coversThisRequestAndReply && checks.signatureValid && checks.keyInFreshAttestation !== false };
}

/** Recomputes what the TEE must have signed from the published request and reply bytes. Null if they do not parse. */
export function readTranscript(model, transcript) {
  try {
    const responseBytes = Buffer.from(transcript.response, 'base64');
    const request = JSON.parse(transcript.request);
    const payload = JSON.parse(responseBytes.toString('utf8'));
    return { request, replyText: payload.choices?.[0]?.message?.content ?? '', usage: payload.usage ?? null, chatId: payload.id ?? null,
      expectedText: `${model}:${sha256(Buffer.from(transcript.request, 'utf8'))}:${sha256(responseBytes)}` };
  } catch { return null; }
}
