// The sealed-bid commitment, exactly as contracts/swarm/src/lib.rs computes it.
import { createHash, randomBytes } from 'node:crypto';

export const YOCTO = 10n ** 24n;
export const BID_BOND = 10n ** 22n;
export const REVIEW_FEE_BPS = 1000n;
export const nearToYocto = near => { const [w, f = ''] = String(near).split('.'); return BigInt(w) * YOCTO + BigInt((f + '0'.repeat(24)).slice(0, 24)); };
export const yoctoToNear = yocto => { const s = BigInt(yocto).toString().padStart(25, '0'); return `${s.slice(0, -24)}.${s.slice(-24)}`.replace(/\.?0+$/, '') || '0'; };
export const commitment = (jobId, agent, priceYocto, salt) =>
  createHash('sha256').update(`${jobId}:${agent}:${BigInt(priceYocto)}:${salt}`).digest('hex');
export const newSalt = () => randomBytes(16).toString('hex');
