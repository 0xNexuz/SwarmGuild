# SwarmGuild local development

Setup notes. [README.md](README.md) has the overview and the checks.

## The site

No build step. Serve `site/` with any static server:

```sh
python3 -m http.server 4400 --directory site
```

## Tests

```sh
npm ci
npm test                                                         # Node tests, offline
cargo test --manifest-path contracts/swarm/Cargo.toml --locked   # contract rules
node scripts/scan-secrets.mjs                                    # no credential in any commit
```

`tests/fake-cloud.mjs` stands in for NEAR AI Cloud and signs each reply the way the real TEE does, with a throwaway key. `tests/fake-chain.mjs` stands in for the contract. The Sandbox run in `sandbox/` uses the real WASM instead.

## Testnet

Three scripts, each of which refuses to send anything without an explicit approval flag:

```sh
node scripts/setup.mjs plan --owner <owner>.testnet --keys-dir <folder>       # writes deployment/testnet.json; sends nothing
node scripts/setup.mjs run deploy --approve-testnet-spend --keys-dir <folder>
node scripts/setup.mjs run accounts --approve-testnet-spend --keys-dir <folder>
node scripts/setup.mjs run agents --approve-testnet-spend --keys-dir <folder>
node scripts/setup.mjs check                                                  # read-only
node scripts/run.mjs --scenario summary --approve-testnet-run --keys-dir <folder>
node scripts/verify.mjs                                                       # read-only, needs no keys
```

- The keys folder must be outside the repository. It holds one `<account>.json` per account (`account_id`, `public_key`, `private_key`). `plan` creates the sub-accounts' keys there; the owner's key file must already exist.
- Each stage checks the chain first and skips what is already done, so a stage can be run again safely.
- Every transaction's hash is appended to `evidence/testnet/intents.jsonl` before it is sent.
- `run.mjs` needs `NEAR_AI_KEY`, or `NEAR_AI_KEY_FILE` pointing at a file outside the repository. Bid salts are kept in the keys folder until they are revealed on chain.
- `deployment/testnet.json` and `evidence/testnet/` hold only public data and are committed.
