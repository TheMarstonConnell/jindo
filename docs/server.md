# Host HTTP API

The host server lives in `src/host/server.ts` and runs on `Bun.serve`. It's
started by `jindo start`, which calls `startHost(env)` with configuration from
the environment. This page documents the wire API; for *operating* a host see
[host-operations.md](host-operations.md), and for the concepts behind the flow
see [concepts.md](concepts.md).

A host serves one address (its own) and many clients. The on-chain Jindo contract
is the source of truth for each pair's outer Merkle root and total size; the
host's local database is a cache of that state plus the actual bytes. State is
stored under `JINDO_DATA_DIR`: a single `host.sqlite` and a content-addressed,
de-duplicated `blobs/` directory shared across all clients.

All responses include permissive CORS headers (`Access-Control-Allow-Origin: *`),
so a browser app can talk to a host directly. Errors are JSON of the shape
`{ "error": "...", ...extra }`.

## Concurrency

Writes for a single client are serialized through a `withLock(client, fn)` helper
that chains promises per client address. Uploads/deletes for *different* clients
run in parallel; for the *same* client they run one at a time. That, plus the
optimistic `priorRoot` check, keeps the local cache, the on-chain root, and the
blobs consistent under load — no global lock needed.

## Routes

### `GET /`

Rich operator status — identity, chain, USDC token, live stats, and a map of the
other endpoints:

```json
{
  "host": "0xHOST...",
  "chain": { "id": 84532, "name": "Base Sepolia" },
  "contract": "0xCONTRACT...",
  "usdc": "0xUSDC...",
  "status": { "clients": 3, "totalBytes": "12345", "totalBytesHuman": "12.1 KB", "uptimeSeconds": 3600 },
  "endpoints": { "GET /health": "JSON status", "...": "..." }
}
```

### `GET /health`

Liveness plus the host's identity. Clients call this on first contact to learn the
host's address — they need it before they can sign an `Upload`/`Delete` intent
that names the host.

```json
{ "address": "0xHOST...", "chainId": 84532, "contract": "0xCONTRACT..." }
```

### `POST /upload`

The core write path. Body is `multipart/form-data` with:

- `intent` — a JSON string: `{ client, fileRoots, priorRoot, newRoot, newSize, signature }`.
- `file` — one or more file parts (repeat the field for a batch). The order must
  match `intent.fileRoots`.

The handler runs, in order:

1. Recover the EIP-712 signer from `signature` and confirm it equals
   `intent.client`. (Mismatch → `401`.)
2. Acquire the per-client lock; confirm the local cache matches on-chain state.
3. Confirm `intent.priorRoot` equals the current outer root. (Mismatch → `409`
   with `currentRoot`.)
4. Recompute each file root from the uploaded bytes and confirm it matches
   `intent.fileRoots[i]`; reject duplicates (already stored, or repeated in the
   batch).
5. Recompute the post-upload outer root and total size; confirm both match
   `intent.newRoot` / `intent.newSize`.
6. **Check the client's on-chain USDC balance covers at least 30 days** of
   storage at the new total size. (Short → `402`.)
7. Submit `commitUpload` to the contract and wait for the receipt.
8. Only then: write every blob to disk and, in one SQLite transaction, insert the
   file rows and update the pair's state with the new root and tx hash.

Success → `200 { txHash, outerRoot, fileRoots }`. Errors: `400` (malformed or
invalid intent / root / size mismatch), `401` (bad signature), `402` (client
balance too low), `409` (stale `priorRoot` or duplicate file), `502` (chain
submission failed), `500` (chain confirmed but local persistence failed — flagged
as an inconsistency to investigate).

### `POST /delete`

Same idea, JSON body only (no file part):
`{ client, fileRoot, priorRoot, newRoot, newSize, signature }`. Verifies the
signature, confirms the file exists and the post-deletion root/size match, calls
`commitDelete`, then deletes the row and — only if no other client still
references the bytes — the blob. Success → `200 { txHash, outerRoot }`.

### `GET /list/:client`

The host's view of what it stores for a client. This is the basis for
`jindo recover`: the client re-verifies every field against the on-chain root
before trusting it.

```json
{
  "outerRoot": "0x...",
  "totalSize": "4096",
  "files": [ { "fileRoot": "0x...", "sizeBytes": 1024, "uploadedAt": 1735689600 } ]
}
```

`totalSize` is a string because JSON can't represent a `bigint` natively.

### `GET /download/:fileRoot`

Returns the raw bytes of a stored blob, or `404`. **No authentication** — anyone
with a `fileRoot` can fetch the bytes. Don't use a host as a confidential store;
encrypt before uploading if you need privacy. (A blob deleted by every client is
removed, so stale roots `404`.)

### `GET /serve/:id[/path...]`

Browse a blob in a web browser. If the blob is a **folder manifest** (produced by
`jindo upload-folder`), it renders as a clickable HTML directory listing; path
segments after the id walk into subfolders by name. If the blob is a regular file,
it's served inline with a best-effort `Content-Type` guessed from the path's
extension.

```
http://localhost:5689/serve/0xFOLDERROOT.../docs/readme.md
```

### `GET /clients`

Every client the host has data for, with a per-client summary — useful for
operators inspecting a host.

```json
{
  "host": "0x...",
  "clients": [ { "client": "0x...", "outerRoot": "0x...", "totalSize": "4096", "fileCount": 2 } ]
}
```

## Automatic proof sweeps

Beyond serving requests, `startHost` runs a background timer that proves each
client's data to the contract (so the host gets paid). It's controlled by
`JINDO_PROVE_INTERVAL_MS` (default 12h; `0` disables). See
[host-operations.md](host-operations.md#earning-proofs-and-claims).

## Shutdown

`startHost` returns `{ stop, url }`. `stop()` cancels the proof timer and closes
the server. The CLI relies on `Ctrl-C` to stop a long-running host.
