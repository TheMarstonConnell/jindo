# Feature: Jindo Storage MVP — CLI + Host + On-Chain Contract

## Problem Statement

Decentralized storage agreements need a cryptographically verifiable handshake between a *client* (data owner) and a *host* (storage provider): the host should be unable to silently drop, swap, or fabricate files, and the client should be unable to deny that they authorized the data the host is holding. Today the project has only a sketch contract and no way to actually exchange data. The MVP delivers a working end-to-end loop — client uploads a file, host stores it, both sides agree on a Merkle root committed on-chain — using a single Bun CLI binary that can run as either side.

The cost of not building this: the contract sketch can't be exercised, signature semantics stay theoretical, and there's no testbed for the per-client storage-set design.

## Goals & Non-Goals

### Goals

- One Bun CLI (`jindo`) that runs as a host (`jindo start`) or a client (`jindo upload`, `jindo delete`, `jindo list`, `jindo recover`).
- Clients sign every state transition (upload, delete) with EIP-712. Hosts post the signed transition on-chain via the Jindo contract.
- Each (host, client) pair is one on-chain `Contract` entry. Clients can use multiple hosts; hosts can serve many clients.
- Cumulative byte usage tracked on-chain (`size` field).
- Local recovery: a client whose cache is wiped can rebuild it from a host and verify against the on-chain root.
- Foundry tests for the contract; Bun integration tests for the end-to-end flow against local anvil.

### Non-Goals

- No payment, fees, or staking primitives. Storage is "free" in v1 — fee logic is a future layer.
- No data-availability proofs / challenges / slashing. Trust model assumes cooperative-but-verifiable hosts.
- No public testnet or mainnet support in v1 — anvil only.
- No filename, MIME type, or content metadata beyond timestamp + size. Files are identified solely by file root.
- No host discovery / registry. Clients pass `--host <url>` explicitly.
- No multi-region replication, sharding, or any host-to-host coordination.
- No GUI, web UI, or wallet integration — keys come from env.

## User Stories

- As a **storage provider**, I want to run `jindo start` and accept signed uploads from many clients, so I can offer storage with cryptographic accountability.
- As a **client**, I want to run `jindo upload <file> --host <url>` and have the entire flow (Merkle tree, signature, transmission, chain confirmation) handled for me.
- As a **client**, I want to `jindo delete <file_root>` and have the file removed from the host with my signed authorization recorded on-chain.
- As a **client** who lost their local cache, I want `jindo recover --host <url>` to rebuild local state from the host and verify it against the on-chain root before trusting it.
- As a **third party** with a `file_root`, I want to `GET /download/<file_root>` and fetch the bytes (download is public).

## Technical Design

### Components

```
contract/                    Foundry project (Solidity)
  src/Jindo.sol              (rename from Counter.sol)
  test/Jindo.t.sol
src/                         Bun CLI sources
  cli.ts                     entry point: jindo <command>
  host/                      `jindo start` server
    server.ts                Bun.serve routes
    db.ts                    bun:sqlite per-client schema
    chain.ts                 viem write client (host signer)
  client/                    `jindo upload | delete | list | recover`
    upload.ts                full upload flow
    delete.ts                signed delete intent
    list.ts                  read local cache
    recover.ts               rebuild cache from host
    cache.ts                 bun:sqlite per (host, client) schema
  shared/
    merkle.ts                wrapper over OZ StandardMerkleTree
    eip712.ts                domain + type definitions
    chain.ts                 viem read helpers
    types.ts                 shared TS types
specs/jindo-mvp.md           (this file)
```

### Data Model

#### On-Chain (Solidity)

```solidity
struct Contract {
    address host;
    address client;
    bytes32 root;     // outer Merkle root over all file roots in this set
    uint256 size;     // total bytes stored, cumulative
}

mapping(bytes32 => Contract) public contracts;          // key(host, client) -> Contract
mapping(address => address[]) public clientsOfHost;
mapping(address => address[]) public hostsOfClient;
// + private 1-based index maps for O(1) removal (already in Counter.sol)
```

Functions:

| Function | Caller | Purpose |
|----------|--------|---------|
| `create(host, client, root, size)` | host (msg.sender == host) | First upload from a new client |
| `update(host, client, newRoot, newSize)` | host (msg.sender == host) | Subsequent upload or delete |
| `remove(host, client)` | host (msg.sender == host) | Tear down the entire pair (e.g. last file deleted) |

Authorization: every state-changing function requires `msg.sender == host`. The client's EIP-712 signature is **not** stored on-chain in v1 — it's verified off-chain by the host. (Open question below.)

Events (emit but don't store the signature itself, to keep gas low):

```solidity
event ContractCreated(address indexed host, address indexed client, bytes32 root, uint256 size);
event ContractUpdated(address indexed host, address indexed client, bytes32 oldRoot, bytes32 newRoot, uint256 newSize);
event ContractRemoved(address indexed host, address indexed client);
```

#### Host SQLite (one db per client: `data/<client_address>.sqlite`)

```sql
CREATE TABLE files (
    file_root      TEXT PRIMARY KEY,    -- 0x-prefixed hex of bytes32
    size_bytes     INTEGER NOT NULL,
    uploaded_at    INTEGER NOT NULL     -- unix seconds
);

CREATE TABLE state (
    -- single-row table tracking the latest confirmed outer root
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    outer_root     TEXT NOT NULL,
    total_size     INTEGER NOT NULL,
    last_tx_hash   TEXT
);
```

Blobs stored at `data/<client_address>/<file_root>` (content-addressed within the client's namespace).

#### Client SQLite (one db per pair: `~/.jindo/cache/<host_address>-<client_address>.sqlite`)

```sql
CREATE TABLE files (
    file_root      TEXT PRIMARY KEY,
    size_bytes     INTEGER NOT NULL,
    uploaded_at    INTEGER NOT NULL
);

CREATE TABLE state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    outer_root     TEXT NOT NULL,
    total_size     INTEGER NOT NULL
);
```

Mirror of the host's view, plus the client knows the original file paths it uploaded (kept ephemerally — not part of the protocol).

### Merkle Trees

Use OpenZeppelin `StandardMerkleTree` (sorted-pair, hash-sorted). Both inner (file-content) and outer (set-of-roots) trees use the same library.

- **File tree**: leaves = sequential 4 KiB chunks of the file (configurable via const, default `CHUNK_SIZE = 4096`). `file_root` = root of this tree.
- **Outer tree**: leaves = the list of `file_root`s in the client's set. Because OZ `StandardMerkleTree` sorts internally, the same set always produces the same root — order-independent. **Empty set: outer_root = bytes32(0)** (sentinel; contract initial state).

### EIP-712 Domain & Types

```ts
const domain = {
  name: "Jindo",
  version: "1",
  chainId: 31337,                // anvil default in v1
  verifyingContract: process.env.JINDO_CONTRACT,
};

const types = {
  Upload: [
    { name: "host",          type: "address" },
    { name: "client",        type: "address" },
    { name: "fileRoot",      type: "bytes32" },
    { name: "priorRoot",     type: "bytes32" },  // expected current outer root
    { name: "newRoot",       type: "bytes32" },  // post-upload outer root
    { name: "newSize",       type: "uint256" },
  ],
  Delete: [
    { name: "host",          type: "address" },
    { name: "client",        type: "address" },
    { name: "fileRoot",      type: "bytes32" },
    { name: "priorRoot",     type: "bytes32" },
    { name: "newRoot",       type: "bytes32" },
    { name: "newSize",       type: "uint256" },
  ],
};
```

Note: `priorRoot` is the optimistic-concurrency check.

### API Design (Host HTTP)

Bun.serve routes:

| Method | Route | Body / Params | Response |
|--------|-------|---------------|----------|
| `POST` | `/upload` | multipart: `file` (blob) + `intent` (JSON: `{client, fileRoot, priorRoot, newRoot, newSize, signature}`) | `200 {txHash, outerRoot}` / `409 {currentRoot}` (root mismatch) / `400` (bad sig or root) / `500` |
| `POST` | `/delete` | JSON: `{client, fileRoot, priorRoot, newRoot, newSize, signature}` | `200 {txHash, outerRoot}` / `404` / `409` / `400` |
| `GET`  | `/list/:client` | — | `200 {outerRoot, totalSize, files: [{fileRoot, sizeBytes, uploadedAt}]}` |
| `GET`  | `/download/:fileRoot` | — | `200` blob (no auth) / `404` |
| `GET`  | `/health` | — | `200 {address, chainId}` |

`/upload` is the choke point. Server flow:

1. Recover signer from `signature` over EIP-712 `Upload` typed data → must equal `client` field.
2. Check `priorRoot` matches the host's latest confirmed `outer_root` for this client (read from `state` table). Mismatch → `409` with the current root so the client can rebuild and retry.
3. Stream `file` to a temp path, compute file Merkle root → must equal `intent.fileRoot`.
4. Append `fileRoot` to the in-memory list of leaves, recompute outer root → must equal `intent.newRoot`. Verify `total_size + size_bytes == intent.newSize`.
5. Submit the on-chain `update` (or `create` if this is the first file). Wait for confirmation.
6. On confirmation: move temp blob into place, insert `files` row, update `state` row, return `200`.
7. On any failure (sig bad, root mismatch, tx revert, tx timeout): delete temp blob, do not write rows, return error. Host state always matches chain.

`/delete` mirrors this: verify sig, verify `priorRoot`, verify the new outer root after removal, submit chain update, then delete the row + blob atomically.

### CLI Surface

```
jindo start
    Run the host server. Reads:
        JINDO_PRIVATE_KEY     host signing key
        JINDO_RPC_URL         anvil rpc
        JINDO_CONTRACT        deployed Jindo address
        JINDO_PORT            default 3000
        JINDO_DATA_DIR        default ./data

jindo upload <file> --host <url>
jindo delete <file_root> --host <url>
jindo list --host <url>
jindo recover --host <url>
    Reads:
        JINDO_PRIVATE_KEY     client signing key
        JINDO_RPC_URL         anvil rpc
        JINDO_CONTRACT        deployed Jindo address
        JINDO_CACHE_DIR       default ~/.jindo/cache
```

### Upload Flow (Client Side)

```
1. Resolve host_address  ← GET /health on the host URL
2. Open cache db for (host_address, client_address)
3. fileRoot               ← merkle(file)
4. priorRoot, totalSize   ← read state from cache (or from chain if cache empty — see recover)
5. newLeaves              ← cache.allFileRoots() ∪ {fileRoot}
6. newRoot                ← merkle(newLeaves)
7. newSize                ← totalSize + len(file)
8. signature              ← sign EIP-712 Upload(host, client, fileRoot, priorRoot, newRoot, newSize)
9. POST /upload {file, intent: {fileRoot, priorRoot, newRoot, newSize, signature}}
10. On 200: insert into cache.files, update cache.state
11. On 409: refresh state from chain via recover(); return error suggesting retry
12. On other error: leave cache untouched; surface error
```

### Delete Flow (Client Side)

Same shape: derive `priorRoot` and `newRoot` from cache, sign `Delete`, POST `/delete`, sync cache on success.

### Recover Flow (Client Side)

```
1. onChainRoot, onChainSize ← read contracts[key(host, client)] from chain
2. {outerRoot, totalSize, files} ← GET /list/:client
3. assert outerRoot == onChainRoot       (host can't lie about the set)
4. assert sum(files.sizeBytes) == onChainSize == totalSize
5. assert merkle(files.fileRoot[]) == onChainRoot
6. Wipe and rebuild local cache from `files`
```

This is the only legitimate way to populate an empty cache. Steps 3–5 fail-closed — if any check fails, the host is byzantine relative to the chain and the recovery aborts.

### State Machine

Per-pair states (host's view; client mirrors):

```
NONEXISTENT --upload--> ACTIVE
ACTIVE --upload/delete--> ACTIVE   (root + size change)
ACTIVE --delete-last-file--> ACTIVE with empty set (outerRoot = 0, size = 0)
                                    [contract entry NOT removed; remains for stats]
```

`remove(host, client)` is exposed on-chain but the v1 host does not call it automatically — entries persist in the empty state. (Cleanup is a v2 concern.)

### Security Model

| Trust boundary | Mechanism |
|---|---|
| Client → Host (data integrity) | Client computes file Merkle root locally; signs `(fileRoot, newRoot, newSize)`. Host can't substitute file content without breaking the root. |
| Host → Chain (authorized roots) | Host can only write its own (host, client) pair (`msg.sender == host`). Client sig verified off-chain. **Trust gap**: nothing on-chain proves the client signed the root the host posted; an evil host could post arbitrary roots for an existing pair and the client would notice only on next read. Documented as open question. |
| Public download | Intentional. Anyone with a file root can fetch bytes. Don't upload secrets. |
| Replay | Each `(priorRoot, newRoot)` pair is unique to a single state transition because outer roots change every time. Same signature can never apply to two different states. |
| Concurrency | Optimistic: client supplies `priorRoot` it expects; host rejects with 409 if its current root differs. No locks. |

## Edge Cases & Error Handling

| Scenario | Expected Behavior |
|---|---|
| First upload from a new client | Host calls `create(host, client, newRoot, newSize)` (not `update`). `priorRoot` in the signed intent is `bytes32(0)`. |
| Two parallel `jindo upload` invocations from same client | Second one's `priorRoot` will mismatch as soon as the first lands. Host returns 409; the second client recovers and retries. CLI may also take a local lockfile to avoid the round-trip. |
| Host accepts file but on-chain tx reverts / never confirms | Roll back: delete temp blob, no db writes, return 5xx to client. Host state == chain state. |
| Client signs and POSTs, then crashes before getting response | Host has already written the row + landed the tx. Client cache is stale. `jindo list --host` followed by `jindo recover` detects and reconciles. |
| Client cache corrupted or wiped | Re-run `jindo recover`. Verifies host's reported set against on-chain root before trusting. |
| Host returns a `/list` set that doesn't match on-chain root during recover | `recover` aborts with an error. Manual investigation needed (host is byzantine, or chain RPC is stale). |
| Same file uploaded twice (same `fileRoot`) | `files` table primary-key collision → host returns 409 with current state. (Append-only semantics: same root is the same leaf.) |
| Delete of a file the host doesn't have | 404 `unknown file_root`. |
| Empty set after deleting the last file | `outerRoot = bytes32(0)`, `size = 0`. Contract entry stays. |
| Client uses wrong RPC / chainId | EIP-712 domain mismatch → host rejects sig. |
| File too large for chunking | No size limit in v1 — chunked into 4 KiB leaves. (May want a soft cap of e.g. 100 MiB later.) |

## Performance Considerations

- v1 targets a single anvil node and one or two clients. No optimization for scale.
- Outer-tree recomputation is O(N log N) per upload/delete (N = number of files). Fine for N < 10⁴; revisit if N grows.
- File chunking is streamed; large files are not loaded fully into memory.
- One sqlite db per client on the host; per-pair on the client. SQLite single-writer semantics naturally serialize per pair.
- HTTP: Bun.serve handles concurrent connections, but per-client serialization is enforced by the optimistic `priorRoot` check, not by locking.

## Rollout Plan

v1 is anvil-only and self-contained. There is no "production" to roll out; rollout = "make it work on a fresh checkout":

1. **Contract**: rename `Counter.sol` → `Jindo.sol`, add `update`, add `msg.sender == host` checks, add events. Update or delete `script/Counter.s.sol` and `test/Counter.t.sol`.
2. **Foundry tests**: `forge test` covers create / update / remove paths and authorization rejections.
3. **Deploy script**: `forge script` that deploys `Jindo` to anvil and writes the address into `.env`.
4. **CLI**: implement `host start`, then `client upload`, then `client list`, then `client delete`, then `client recover`.
5. **Bun integration tests**: spin up anvil + host (in-process), run upload/list/delete/recover via the CLI, assert on-chain reads with viem.
6. **Demo README**: anvil up → deploy → start host → upload → list → delete → recover.

Rollback: this is a fresh-build feature. There's no migration. If something is wrong, fix it; nothing depends on it yet.

## Open Questions

1. **On-chain proof of client authorization.** Today the host can post any root for an existing (host, client) pair without on-chain proof the client signed it. A future version could (a) emit the signature in the event for off-chain auditing, (b) verify the EIP-712 signature on-chain inside `update()`, or (c) require the client to call `update()` themselves with a host signature. Worth resolving before any value is at stake.
2. **Per-pair on-chain nonce.** Currently relying on outer-root uniqueness for replay protection. If we ever allow root regression (e.g. roll back to a prior state), we need an explicit nonce.
3. **Should `remove(host, client)` be auto-called when the set becomes empty?** Saves a slot but loses historical stats and complicates `jindo recover` if the entry is gone.
4. **Maximum file size / chunk size policy.** No limit in v1 — fine for testing, but we'll want a configurable cap before any real use.
5. **Host fee / reward mechanic.** Out of scope for v1, but the `Contract` struct doesn't currently have a place for it. Adding `pricePerByte` later is a non-breaking storage extension.
6. **Garbage collection of the empty-set entries.** Same as (3).
7. **Recovery from a host that is offline.** If the only host with the data is down, the client has the on-chain root but no leaves. Multi-host replication is the long-term answer; out of scope.

## Appendix: Interview Notes

Decisions captured during the interview, with the user's reasoning where given:

- **Local cache + recover-from-host fallback** chosen over chain-anchored recovery to keep the upload hot path fast, but with an explicit recovery command that does the on-chain verification when needed.
- **Hash-sorted outer tree** (OZ `StandardMerkleTree`) chosen over upload-index ordering — order-independent reconstruction makes recovery and concurrent reasoning cleaner.
- **Append + delete** chosen over append-only — replace was rejected as ambiguous.
- **Host creates on first upload** chosen — host pays init gas, no separate `register` step.
- **Optimistic concurrency** with `priorRoot` chosen over per-client locking — surfaces conflicts to the user instead of hiding latency.
- **On-chain root verification for cache recovery** chosen over blob-redownload — strong enough for v1, doesn't require redownloading every blob to bootstrap.
- **Public download** chosen — keeps protocol scope tight; users must not upload secrets.
- **Roll back fully on tx failure** chosen — host state always matches chain. Simpler than a pending-retry queue.
- **ENV identity + `--host` flag** chosen — supports one client talking to multiple hosts without env juggling.
- **Metadata = uploaded_at + size_bytes only** — files identified by file root; intentionally no filename or MIME (keeps protocol minimal; users can keep their own filename mapping outside the protocol).
- **Contract additions: `update()` + `msg.sender == host` authorization.** No on-chain signature storage and no nonce in v1; both flagged in Open Questions.
- **`size` = total bytes stored, cumulative.** Sets up future fee logic.
- **One sqlite db per (host, client)** on the client side, mirroring the per-client db on the host side — 1:1 with on-chain entries.
- **EIP-712 typed data** chosen over personal_sign — wallet-friendly and trivially upgradeable to on-chain verification.
- **Delete = atomic blob removal** with rollback on chain failure — simplest disk story, no GC.
- **Anvil-only for v1.** Foundry tests + Bun integration tests as verification harness; no testnet/mainnet plumbing yet.
