# Deployment files

- `swarmguild.wasm` is the contract built by CI from `contracts/swarm` with Rust 1.96.0 (`cargo build --locked --target wasm32-unknown-unknown --release`, with the flag in `.cargo/config.toml`). SHA-256: `cd073a39f844b69fec4d8c10baf17dd6f05e99bcfb3b6d2288c005cc0aa932a7`. Every CI run rebuilds it and fails if the bytes differ, then runs it on NEAR Sandbox.
- `testnet.json` appears once the Testnet deployment is planned. It holds only public data: account names, public keys, amounts, manifest hashes and transaction hashes.
