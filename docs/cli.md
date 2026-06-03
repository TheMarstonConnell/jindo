# CLI reference

The `jindo` CLI lives in `src/cli.ts` and is built on Commander. The same binary
runs every role: `jindo start` is the host server, `jindo s3` is the S3 gateway,
and the rest are client or host operator commands. Run it with Bun:

```bash
bun src/cli.ts <command> [args]
```

New to jindo? Follow [getting-started.md](getting-started.md) first — it shows
these commands in the order you actually use them. This page is the flat
reference.

## Environment

All commands read configuration from the environment (Bun auto-loads `.env`).
Missing required variables fail fast at startup. The easiest two-identity setup is
to keep the host identity in `.env` and override `JINDO_PRIVATE_KEY` inline for
client commands — see the getting-started guide.

**Host commands (`start`, `prove`, `withdraw`):**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JINDO_PRIVATE_KEY` | yes | — | Host signing key (pays gas, identifies the host on-chain). |
| `JINDO_RPC_URL` | yes | — | Chain RPC endpoint. |
| `JINDO_CONTRACT` | yes | — | Deployed Jindo contract address. |
| `JINDO_PORT` | no | `5689` | Port for `start`. |
| `JINDO_DATA_DIR` | no | `./data` | Database + blob storage. |
| `JINDO_PROVE_INTERVAL_MS` | no | `43200000` | Auto proof-sweep interval for `start`; `0` disables it. |

**Client commands (`upload`, `upload-folder`, `delete`, `list`, `recover`, `deposit`):**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JINDO_PRIVATE_KEY` | yes | — | Client signing key (signs EIP-712 intents). |
| `JINDO_RPC_URL` | yes | — | Chain RPC endpoint. |
| `JINDO_CONTRACT` | yes | — | Contract address. |
| `JINDO_CACHE_DIR` | no | `~/.jindo/cache` | Local per-pair cache. |

**S3 gateway (`s3`):** see [`../src/s3/README.md`](../src/s3/README.md) for its
extra `JINDO_S3_*` and `JINDO_HOST_URL` variables.

---

## Host commands

### `jindo start`

Run a storage host. Opens an HTTP server on `JINDO_PORT`, serves the routes in
[server.md](server.md), and runs an automatic proof sweep on a timer. Prints the
listening URL. Stop with `Ctrl-C`. See [host-operations.md](host-operations.md)
for running one for real.

```bash
jindo start
```

### `jindo prove <client>`

Answer the current on-chain challenge for one client immediately, instead of
waiting for the automatic sweep. Reads the challenge, locates the corresponding
chunk in the stored blobs, builds the Merkle proofs, and submits `commitProof`.
Prints the challenge index, the proven file/chunk, and the transaction hash. A
successful proof moves one day of fees into the host's earnings (at most once per
UTC day per client).

```bash
jindo prove 0xCLIENT...
```

### `jindo withdraw`

**Host earnings claim.** Sweeps every client the host stores for and claims each
pair's accrued USDC into the host wallet (whole units; sub-cent dust is left for
next time). Prints a per-client summary and exits non-zero if any claim errored.

```bash
jindo withdraw
```

> This is *not* a client deposit-withdrawal. It claims what the host *earned*. A
> client pulling back unspent deposit calls the contract's `withdraw()` directly.

---

## Client commands

### `jindo deposit <amount>`

Pre-pay for storage. Pulls `<amount>` USDC (up to 6 decimal places, e.g. `1.5`)
from the client wallet into the client's on-chain pool, auto-approving the token
allowance first if needed. The host requires a funded pool before it will accept
uploads.

```bash
jindo deposit 1
jindo deposit 0.5
```

### `jindo upload <files...> --host <url>`

Upload one or more files as a single signed batch. Computes each file's Merkle
root, signs one `Upload` intent over the whole batch, posts it to the host, and
updates the local cache after the host confirms the on-chain commitment. Prints
each file's root.

```bash
jindo upload ./report.pdf --host http://localhost:5689
jindo upload ./a.txt ./b.png ./c.bin --host http://localhost:5689
```

If the local cache is out of sync with the chain, the command refuses — run
`jindo recover` first.

### `jindo upload-folder <dir> --host <url>`

Recursively upload a directory tree as a browsable **folder**. Walks `<dir>`,
uploads every file plus a small JSON manifest per directory, all in one signed
batch. Files whose contents are already stored are skipped (de-duplicated). Prints
the top-level folder root and a `/serve/<root>` URL you can open in a browser to
navigate the tree.

```bash
jindo upload-folder ./my-site --host http://localhost:5689
# folder root: 0x...
# browse:      http://localhost:5689/serve/0x...
```

### `jindo delete <fileRoot> --host <url>`

Sign a `Delete` intent for a file already in the set and submit it. Prints the
on-chain transaction hash. The file root must be in the local cache so the client
can compute the new outer root.

```bash
jindo delete 0xabc123... --host http://localhost:5689
```

### `jindo list --host <url>`

Print the client's **local** view of files stored with that host. Pure cache read
— no network or chain call. Use `recover` if you suspect the cache is stale.

```
host:   0xHOST...
client: 0xCLIENT...
outer:  0x...
size:   4096 bytes
  0x...  1024B  @1735689600
  0x...  3072B  @1735689601
```

### `jindo recover --host <url>`

Rebuild the local cache from the host, verified against the chain. The command:

1. Reads the on-chain `(host, client)` state.
2. Pulls `/list/:client` from the host.
3. Recomputes the outer root over the host's reported files and **refuses to
   trust it** unless it matches the on-chain root and the sizes add up.
4. Wipes and rewrites the local cache from the verified list.

```bash
jindo recover --host http://localhost:5689
```

Use it after losing a machine, suspecting a host, or hitting a `cache out of sync`
/ `409 priorRoot mismatch` error.

---

## Gateway command

### `jindo s3`

Run an S3-compatible gateway in front of a jindo host, so existing S3 tools and
SDKs can read and write jindo-backed storage. Full documentation, including its
own configuration and supported operations, is in
[`../src/s3/README.md`](../src/s3/README.md).

```bash
jindo s3
```

---

## Exit codes

`0` on success, `1` on any error (`withdraw` also exits `1` if any per-client
claim failed). Errors print to stderr — whether from a bad signature, a stale
cache, an HTTP failure from the host, an insufficient balance, or a reverted
transaction.
