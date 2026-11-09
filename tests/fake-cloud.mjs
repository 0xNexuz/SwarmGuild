// A stand-in for NEAR AI Cloud that signs each reply the way the real TEE does, with a throwaway key.
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function fakeCloud(answer, { tamper = false, attested = true } = {}) {
  const key = secp256k1.utils.randomPrivateKey();
  const address = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12)).toString('hex')}`;
  const sign = message => {
    const msg = Buffer.from(message, 'utf8');
    const sig = secp256k1.sign(keccak_256(Buffer.concat([Buffer.from(`\u0019Ethereum Signed Message:\n${msg.length}`), msg])), key);
    return `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(27 + sig.recovery).toString(16)}`;
  };
  const calls = []; const signatures = new Map(); let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/v1/attestation/report') {
      const nonce = u.searchParams.get('nonce');
      return Response.json({ gateway_attestation: { request_nonce: nonce },
        model_attestations: [{ signing_address: attested ? address : '0x' + '11'.repeat(20), request_nonce: nonce }] });
    }
    if (u.pathname === '/v1/chat/completions') {
      const request = JSON.parse(init.body); calls.push(request);
      const id = `chat-${++n}`;
      const content = typeof answer === 'function' ? answer(request) : answer;
      const body = JSON.stringify({ id, model: request.model, usage: { prompt_tokens: 400, completion_tokens: 300 }, choices: [{ message: { content } }] });
      const text = `${request.model}:${sha256(Buffer.from(init.body))}:${sha256(Buffer.from(body))}`;
      signatures.set(id, { text, signature: sign(tamper ? `${text}x` : text), signing_address: address, signature_kind: 'provider_tee' });
      return new Response(body, { status: 200 });
    }
    if (u.pathname.startsWith('/v1/signature/')) return Response.json(signatures.get(decodeURIComponent(u.pathname.split('/').pop())));
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls, address };
}
