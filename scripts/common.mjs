// Shared by the command-line scripts: where things are, and how to reach Testnet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpcChain } from '../lib/chain.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const at = (...parts) => path.join(root, ...parts);
export const PLAN_FILE = at('deployment', 'testnet.json');
export const WASM_FILE = at('deployment', 'swarmguild.wasm');
export const EVIDENCE_DIR = at('evidence', 'testnet');
export const RAW_BASE = 'https://raw.githubusercontent.com/0xNexuz/SwarmGuild/main';
export const RPC_URL = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org';
export const ARCHIVAL_URLS = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {}; const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { words.push(argv[i]); continue; }
    const name = argv[i].slice(2);
    flags[name] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return { flags, words };
}
export const readPlan = () => {
  if (!fs.existsSync(PLAN_FILE)) throw new Error('deployment/testnet.json does not exist yet. Run: node scripts/setup.mjs plan --owner <account>');
  return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
};
export const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
export function keysDir(flags, { required = true } = {}) {
  const dir = flags['keys-dir'] ?? process.env.SWARMGUILD_KEYS_DIR;
  if (!dir && required) throw new Error('Name the keys folder with --keys-dir or SWARMGUILD_KEYS_DIR. It must be outside this repository.');
  if (dir && !path.relative(root, path.resolve(dir)).startsWith('..')) throw new Error('The keys folder must be outside this repository.');
  return dir ? path.resolve(dir) : null;
}
/** A Testnet connection. Every transaction is written to evidence/testnet/intents.jsonl before it is sent. */
export function testnet(flags, { signing = true } = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS certificate checks must stay on.');
  const intents = path.join(EVIDENCE_DIR, 'intents.jsonl');
  return rpcChain({ networkId: 'testnet', nodeUrl: RPC_URL, txUrls: ARCHIVAL_URLS, keysDir: signing ? keysDir(flags) : null,
    onSigned(intent) { fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.appendFileSync(intents, JSON.stringify({ at: new Date().toISOString(), ...intent }) + '\n'); } });
}
export function nearAiKey() {
  const key = process.env.NEAR_AI_KEY ?? (process.env.NEAR_AI_KEY_FILE ? fs.readFileSync(process.env.NEAR_AI_KEY_FILE, 'utf8').trim() : '');
  if (!key) throw new Error('Set NEAR_AI_KEY, or NEAR_AI_KEY_FILE to a file outside this repository.');
  return key;
}
export const main = fn => fn().catch(error => { console.error(`Stopped: ${error.message}`); process.exitCode = 1; });
