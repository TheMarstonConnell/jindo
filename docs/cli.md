# CLI

The `jindo` CLI lives in `src/cli.ts` and is built on Commander. The same binary runs both sides of the protocol: `jindo start` is the host, every other command is a client. Run it directly with Bun:

```bash
bun src/cli.ts <command> [args]
```

## Environment

All commands read configuration from the environment rather than flags. Missing variables fail fast at startup.

**Host (`start`, `prove`):**

- `JINDO_PRIVATE_KEY` — host signing key.
- `JINDO_RPC_URL` — chain RPC.
- `JINDO_CONTRACT` — Jindo contract address.
- `JINDO_PORT` (optional, default `5689`).
- `JINDO_DATA_DIR` (optional, default `./data`).

**Client (`upload`, `delete`, `list`, `recover`):**

- `JINDO_PRIVATE_KEY` — client signing key.
- `JINDO_RPC_URL` — chain RPC.
- `JINDO_CONTRACT` — contract address.
- `JINDO_CACHE_DIR` (optional, default `~/.jindo/cache`).

## Commands

### `jindo start`

Run a host server. Reads the host environment, opens a Bun HTTP server on `JINDO_PORT`, and serves the routes documented in [`server.md`](server.md). Prints the listening URL on startup.

```bash
jindo start
```

### `jindo upload <file> --host <url>`

Read `<file>` from disk, sign an `Upload` intent for it, and POST it to the host. On success, prints the file's Merkle root.

```bash
jindo upload ./report.pdf --host http://localhost:5689
```

The client's local cache is updated only after the host confirms the on-chain commitment. If the cache is out of sync with the chain, the command refuses to upload — run `jindo recover` first.

### `jindo delete <fileRoot> --host <url>`

Sign a `Delete` intent for the named file root and submit it. Prints the on-chain transaction hash.

```bash
jindo delete 0xabc123... --host http://localhost:5689
```

The file root must already be present in the local cache; otherwise the client cannot compute the new outer root that the host and contract will check.

### `jindo list --host <url>`

Print the client's local view of files stored with that host. This is a pure cache read — no network call to the host, no on-chain read. Use `recover` if you suspect the cache is stale.

```
host:   0xHOST...
client: 0xCLIENT...
outer:  0x...
size:   4096 bytes
  0x...  1024B  @1735689600
  0x...  3072B  @1735689601
```

### `jindo recover --host <url>`

Rebuild the local cache from the host. The command:

1. Reads the on-chain `(host, client)` state.
2. Pulls `/list/:client` from the host.
3. Recomputes the outer root over the host's reported files and refuses to trust it if it does not match the on-chain root, or if the sizes do not sum correctly.
4. Wipes the local cache and writes the verified file list.

```bash
jindo recover --host http://localhost:5689
```

This is the right command after losing a machine, suspecting a host of misbehaving, or hitting a `cache out of sync` error from `upload`/`delete`.

### `jindo prove <client>`

Host-only. Reads the current on-chain challenge for the given client, locates the corresponding chunk in the host's stored files, builds the outer and file Merkle proofs, and submits `commitProof` to the contract. Prints the challenge index, the proven file and chunk, and the transaction hash.

```bash
jindo prove 0xCLIENT...
```

The challenge mechanism is the foundation for slashing dishonest hosts; the v1 contract records proofs but does not yet auto-rotate challenges or apply penalties.

## Exit codes

`0` on success, `1` on any error. Errors print the message to stderr — whether from a bad signature, a stale cache, an HTTP failure from the host, or a reverted transaction.
