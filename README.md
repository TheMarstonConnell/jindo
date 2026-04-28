
![jindo logo](jindo.png)
# jindo

Jindo is a decentralized storage system that produces a cryptographically verifiable agreement between a data owner (the *client*) and a storage provider (the *host*). Every change to what a host is holding for a client gets signed by the client and committed on-chain, so neither side can later misrepresent what was stored.

The system has three pieces that all share the same Merkle and EIP-712 primitives:

- A **host server** that accepts signed uploads and deletes, persists the bytes, and posts each state transition to the Jindo smart contract.
- A **CLI** that runs either side of the protocol — `jindo start` runs a host, `jindo upload/delete/list/recover` are the client commands.
- A **library** (`src/lib`) that exposes the same client logic and crypto primitives so other programs can speak the protocol without shelling out.

A Solidity contract (`contract/src/Jindo.sol`) is the source of truth. For every `(host, client)` pair it stores the current outer Merkle root and total byte count, and it verifies the client's EIP-712 signature on every state change. Hosts can be challenged later to prove they still hold the bytes by submitting Merkle proofs against the on-chain root.

## Components

- [`docs/server.md`](docs/server.md) — the host HTTP server: routes, request shapes, locking, and the upload/delete flow.
- [`docs/cli.md`](docs/cli.md) — every `jindo` subcommand, its flags, and the environment variables it expects.
- [`docs/library.md`](docs/library.md) — the programmatic API exported from `src/lib`, with usage examples.

## Quick start

```bash
bun install

# Host (in one shell)
JINDO_PRIVATE_KEY=0x... \
JINDO_RPC_URL=https://... \
JINDO_CONTRACT=0x... \
bun src/cli.ts start

# Client (in another shell)
JINDO_PRIVATE_KEY=0x... \
JINDO_RPC_URL=https://... \
JINDO_CONTRACT=0x... \
bun src/cli.ts upload ./file.bin --host http://localhost:5689
```

## How the pieces fit

```
client CLI / library  ──HTTP──▶  host server  ──viem──▶  Jindo contract
        │                            │                        ▲
        └──── signs EIP-712 intent ──┘                        │
                                     └──── verifies sig and ──┘
                                          submits root update
```

The client signs an `Upload` or `Delete` intent that names the prior root, the new root, and the new total size. The host refuses to act on an intent it cannot verify, and the contract refuses to record a transition whose signature does not recover to the named client. The result is that the host cannot fabricate state and the client cannot disown a change they signed.

The host keeps one SQLite database per client under `JINDO_DATA_DIR`. The client keeps a mirror cache under `JINDO_CACHE_DIR` (default `~/.jindo/cache`) that it can rebuild from the host with `jindo recover`, verifying every reported file against the on-chain root before trusting it.
