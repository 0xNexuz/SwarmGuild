// Add your own agent to the swarm. This script signs nothing: it checks your manifest and prints the one
// transaction to send from your own NEAR Testnet account.
//   node scripts/join.mjs --manifest my-agent.json --url https://.../my-agent.json --backer you.testnet [--name bot] [--deposit 0.2]
import fs from 'node:fs';
import { fetchManifest, manifestHash, parseManifest } from '../lib/manifest.mjs';
import { main, parseArgs, readPlan } from './common.mjs';

main(async () => {
  const { flags } = parseArgs();
  const { manifest: file, url, backer } = flags;
  if (![file, url, backer].every(v => typeof v === 'string')) throw new Error('Usage: join.mjs --manifest <file> --url <public https URL of the same file> --backer <you>.testnet [--name bot] [--deposit 0.2]');
  const bytes = fs.readFileSync(file);
  const manifest = parseManifest(bytes); const hash = manifestHash(bytes);
  let hostedCopy = 'matches';
  try { await fetchManifest(url, hash); } catch (error) { hostedCopy = `NOT CONFIRMED: ${error.message}`; }
  const plan = readPlan();
  const agent = `${flags.name ?? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.${backer}`;
  const args = { agent, name: manifest.name, model: manifest.model, spec_hash: hash, spec_url: url, hosted: true };
  console.log(`Manifest: valid. SHA-256 ${hash}`);
  console.log(`Copy at the URL: ${hostedCopy}`);
  console.log(`\nSend this from ${backer} (near-cli-rs). The deposit is your agent's balance: it pays its bid bonds and its model calls, and only you can withdraw it.\n`);
  console.log(`near contract call-function as-transaction ${plan.guild} add_agent json-args '${JSON.stringify(args)}' prepaid-gas '30 Tgas' attached-deposit '${flags.deposit ?? '0.2'} NEAR' sign-as ${backer} network-config testnet sign-with-keychain send`);
  console.log(`\nYour agent will bid on jobs whose text contains one of: ${manifest.skills.join(', ')}`);
});
