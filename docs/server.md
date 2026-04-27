# Host server

The host server lives in `src/host/server.ts` and runs on `Bun.serve`. It is started by `jindo start`, which calls `startHost(env)` with configuration loaded from environment variables.

A host serves one address (its own) but many clients. For every client that has ever uploaded to it, the host keeps an isolated SQLite database under `JINDO_DATA_DIR/{clientAddress}/db.sqlite` plus a `blobs/` directory that holds the file content. The on-chain Jindo contract is the source of truth for the outer Merkle root and total size of each `(host, client)` pair; the host's database is a cache of that state plus the actual bytes.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JINDO_PRIVATE_KEY` | yes | — | Host signing key, used to submit on-chain transactions. |
| `JINDO_RPC_URL` | yes | — | RPC endpoint for the chain the contract is deployed on. |
| `JINDO_CONTRACT` | yes | — | Address of the deployed Jindo contract. |
| `JINDO_PORT` | no | `5689` | Port to bind. |
| `JINDO_DATA_DIR` | no | `./data` | Where per-client SQLite databases and blob files live. |

On startup the server resolves the chain ID via viem, builds a public and wallet client, and prints a line like:

```
jindo host listening on http://0.0.0.0:5689 as 0xHOST... (chain 84532, contract 0xCONTRACT...)
```

## Concurrency

State for a single client is serialized through a `withLock(client, fn)` helper that maps a client address to a promise chain. Two uploads for different clients can run in parallel; two uploads for the same client are forced to run one after the other. This is what keeps the local cache, the on-chain root, and the file blobs consistent under load.

## Routes

### `POST /upload`

The core write path. The body is `multipart/form-data` with two parts:

- `intent` — JSON string with `client`, `fileRoot`, `priorRoot`, `newRoot`, `newSize`, `signature`.
- `file` — the raw bytes.

The handler runs, in order:

1. Recover the EIP-712 signer from `signature` and confirm it equals `intent.client`.
2. Acquire the per-client lock.
3. Read on-chain state for `(host, client)` and confirm the host's local cache matches it. If they have drifted, the request is refused.
4. Confirm `intent.priorRoot` equals the current outer root. A mismatch returns `409` with the current root.
5. Recompute the file root from the uploaded bytes and confirm it matches `intent.fileRoot`.
6. Add the file to the in-memory file list, recompute the outer root and total size, and confirm both match `intent.newRoot` / `intent.newSize`.
7. Submit `commitUpload` to the contract via viem and wait for the receipt.
8. In a single SQLite transaction, write the blob to disk, insert the file row, and update the state row with the new outer root and tx hash.

A `200` response carries `{ txHash, outerRoot }`. Failures use `400` (malformed or invalid intent), `401` (signature does not match `client`), `409` (stale `priorRoot`), `502` (chain submission failed), or `500` (chain confirmed but local persistence failed — the host flags this as an inconsistency to investigate).

### `POST /delete`

Same shape as upload but no file part — only the JSON body. The handler verifies the signature, confirms the file exists in the current set, recomputes the outer root and size after removal, calls `commitDelete` on the contract, then atomically deletes the database row and the blob. The response is `{ txHash, outerRoot }`.

### `GET /list/:client`

Returns the host's view of what it is storing for a given client:

```json
{
  "outerRoot": "0x...",
  "totalSize": "4096",
  "files": [
    { "fileRoot": "0x...", "sizeBytes": 1024, "uploadedAt": 1735689600 }
  ]
}
```

`totalSize` is a string because JSON cannot represent a `bigint` natively. This route is the basis for `jindo recover` — the client pulls this list and verifies every field of it against the on-chain root before trusting it.

### `GET /download/:client/:fileRoot`

Returns the raw bytes of a stored file, or `404` if the file is not present. There is no authentication on this route: anyone holding a `fileRoot` can fetch the bytes, so do not use a host as a confidential store. If you want privacy, encrypt before uploading.

### `GET /clients`

Enumerates every client directory the host has data for and returns a summary:

```json
{
  "host": "0x...",
  "clients": [
    { "client": "0x...", "outerRoot": "0x...", "totalSize": "4096", "fileCount": 2 }
  ]
}
```

Useful for operators inspecting a host.

### `GET /health`

Returns `{ address, chainId, contract }`. Clients call this on first contact to learn the host's address (which they need before they can sign an EIP-712 intent that names the host).

## Error model

Every error response is JSON of the shape `{ error: "...", ...extra }`, returned by the internal `jsonError(status, message, extra)` helper. The most useful `extra` field is the current `outerRoot` returned with a `409`, which lets a client re-sync without an extra round trip.

## Shutdown

`startHost` returns `{ stop, url }`. Calling `stop()` closes the Bun server. The CLI does not currently wire this to a signal handler — `Ctrl-C` is the supported way to stop a long-running host.
