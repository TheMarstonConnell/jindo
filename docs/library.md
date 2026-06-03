# Library reference

`src/lib/index.ts` is the importable surface of jindo. It re-exports a high-level
client class (`JindoClient`) plus the lower-level Merkle, EIP-712, chain, and
folder primitives the client and host both build on. Anything the CLI does on the
client side, you can do from your own TypeScript through this library.

For *what these pieces mean*, read [concepts.md](concepts.md). This page is the
API.

## `JindoClient`

The high-level entry point. One instance corresponds to one `(host, client)`
pair, backed by a local cache.

```ts
import { JindoClient } from "./src/lib";
import { sqliteCacheFactory } from "./src/node/sqlite-cache";

const jindo = await JindoClient.open({
  rpcUrl: process.env.JINDO_RPC_URL!,
  privateKey: process.env.JINDO_PRIVATE_KEY! as `0x${string}`,
  contract: process.env.JINDO_CONTRACT! as `0x${string}`,
  hostUrl: "http://localhost:5689",
  openCache: sqliteCacheFactory("/tmp/jindo-cache"),
});
```

`open` resolves the host's address from `/health`, derives the client's address
from the private key, and opens the cache for that pair. It exposes `hostAddress`,
`clientAddress`, and `chainId` as read-only properties.

> **Cache backends.** `sqliteCacheFactory` lives in `src/node` because it uses the
> filesystem — import it from `./src/node/sqlite-cache`, not from `src/lib`. For
> tests or in-memory embedding, `src/lib` exports `memoryCacheFactory`. Any object
> implementing the `CacheStore` interface works (see [Cache abstraction](#cache-abstraction)).

> **Funding.** Uploads still require the client's on-chain USDC pool to cover 30
> days of storage — fund it first with `submitDepositUsdc` (below) or the
> `jindo deposit` CLI, or the host will reject the upload with `402`.

### `upload(files): Promise<{ fileRoots, outerRoot }>`

Upload one or more files as a single signed batch. Each entry is a raw
`Uint8Array` or `{ bytes, filename? }`. Computes each file's Merkle root, signs
one `Upload` intent over the whole batch, posts to the host, and updates the cache
once the host confirms the on-chain commitment.

```ts
const a = new Uint8Array(await Bun.file("./photo.jpg").arrayBuffer());
const b = new Uint8Array(await Bun.file("./notes.txt").arrayBuffer());
const { fileRoots, outerRoot } = await jindo.upload([a, { bytes: b, filename: "notes.txt" }]);
```

### `delete(fileRoot): Promise<Hex>`

Signs a `Delete` intent for a file the cache already knows about, posts to the
host, and removes the entry from the cache on success. Returns the on-chain
transaction hash.

```ts
const txHash = await jindo.delete(fileRoots[0]);
```

### `list(): { state, files }`

Synchronous read of the local cache. Returns the cached `outerRoot` and
`totalSize` along with every `FileRecord` (`fileRoot`, `sizeBytes`, `uploadedAt`).

```ts
const { state, files } = jindo.list();
console.log(state.outerRoot, files.length);
```

### `recover(): Promise<{ files, outerRoot }>`

Rebuilds the cache from the host, but only after verifying the host's reported
list against on-chain state. Throws if the host's outer root, total size, or
per-file accounting doesn't match.

```ts
const { files, outerRoot } = await jindo.recover();
```

## Folders

Helpers to build and parse the JSON manifests that back `jindo upload-folder` and
the host's `/serve` browser. A manifest lists named children, each pointing at a
file root (or another folder manifest's root) plus a rolled-up size.

- `buildFolder(name, children)` / `serializeFolder(folder)` — construct and encode
  a manifest. `tryParseFolder(bytes)` returns a `JindoFolder` or `null`.
- `FOLDER_KIND`, `FOLDER_VERSION` — the manifest's discriminator constants.

The recursive directory walk that turns a local folder into a batch of uploads
lives in `src/node/folder-upload.ts` (`uploadFolderFromDir`), kept out of
`src/lib` because it touches the filesystem.

## Cache abstraction

`JindoClient.open` takes `openCache: CacheFactory`, so you can plug in any backend
implementing the `CacheStore` interface (read state, list files, insert, delete,
replace-all). The factory is called with `(hostAddress, clientAddress)` so it can
isolate caches per pair. The CLI uses the SQLite factory; `memoryCacheFactory` is
provided for tests and embedded use.

## Merkle primitives

The same functions the contract verifies against, for tools that build or check
proofs.

- `fileRoot(bytes, chunkSize?)` — root of a file's chunk tree. `chunkSize`
  defaults to `CHUNK_SIZE` (`1024`).
- `outerRoot(files)` — root of a sorted set of `FileRecord`s. Empty input returns
  `ZERO_ROOT`.
- `fileLeaf(chunkIndex, chunk)` / `outerLeaf(cumulativeBytesBefore, fileSize, fileRoot)`
  — single-leaf hashes.
- `fileMerkleProof(bytes, chunkIndex)` — proof for chunk `i` against
  `fileRoot(bytes)`.
- `outerMerkleProof(files, fileRoot)` — proof that `fileRoot` belongs to the set.
- `canonicalLayout(files)` — sorts files and computes cumulative byte offsets.
- `locateOffset(files, byteOffset)` — given a byte position in the set, finds the
  file and chunk that cover it. This is what proving a challenge uses.

```ts
import { fileRoot, fileMerkleProof } from "./src/lib";

const bytes = new Uint8Array([/* ... */]);
const root = fileRoot(bytes);
const proof = fileMerkleProof(bytes, 0); // proof.leaf, proof.proof, proof.chunk
```

## EIP-712

- `buildDomain(chainId, contract)` — the
  `{ name: "Jindo", version: "1", chainId, verifyingContract }` domain.
- `TYPES` — the `Upload` and `Delete` typed-data structs.
- `recoverIntentSigner(chainId, contract, kind, message, signature)` — recovers
  the signing address. The host calls this on every request.

```ts
import { recoverIntentSigner } from "./src/lib";

const signer = await recoverIntentSigner(chainId, contract, "Upload", {
  host, client, fileRoots, priorRoot, newRoot, newSize,
}, signature);
```

## Chain access

Wrappers around viem matching what `JindoClient` and the host use internally.

- `buildChainContext({ rpcUrl, privateKey, contract })` — returns
  `{ chainId, contract, publicClient, walletClient, account }`.
- `buildChainContextFromWallet({ publicClient, walletClient, contract })` — same,
  from an existing wallet (e.g. a browser-injected one).
- `readPair(ctx, host, client)` — on-chain pair state: `outerRoot`, `totalSize`,
  `challengeIndex`, `lastProof`, `accrued`.
- `readClientBalance(ctx, client)` / `readWithdrawableBalance(ctx, client)` — the
  client's USDC pool, and the portion withdrawable after the 30-day reserve (both
  in atto-USDC).
- `readRateBytePerDay(ctx)` — the contract's storage rate.
- `submitDepositUsdc(ctx, baseAmount, opts?)` — approve (if needed) + deposit USDC
  into the client's pool.
- `submitCommitUpload(ctx, client, fileRoots, priorRoot, newRoot, newSize, signature)`
  — sends an upload commitment (note `fileRoots` is an array).
- `submitCommitDelete(...)` — same shape, single `fileRoot`, for deletes.
- `submitCommitProof(ctx, client, cumulativeBytesBefore, fileSize, fileRoot, chunkInFileIndex, chunkBytes, outerProof, fileProof)`
  — answers a challenge.

```ts
import { buildChainContext, readPair, readClientBalance } from "./src/lib";

const ctx = await buildChainContext({ rpcUrl, privateKey, contract });
const onChain = await readPair(ctx, hostAddress, clientAddress);
const poolAtto = await readClientBalance(ctx, clientAddress);
```

## HTTP host helpers

Thin fetchers used by `JindoClient`, callable directly if you want to talk to a
host without managing a cache or signing key.

- `fetchHostAddress(hostUrl)` — `GET /health`.
- `fetchList(hostUrl, client)` — `GET /list/:client`.
- `fetchDownload(hostUrl, fileRoot)` — `GET /download/:fileRoot`.
- `postUpload(hostUrl, files, intent)` — `POST /upload` (multipart batch).
- `postDelete(hostUrl, body)` — `POST /delete`.

## Constants and types

- `ZERO_ROOT` — the canonical empty-set root (`0x` + 64 zeros).
- `CHUNK_SIZE` — file-tree chunk size (`1024`); must match the contract.
- `JINDO_ABI` — the contract ABI, ready for viem.
- Types: `Address`, `Hex`, `FileRecord`, `PairState`, `UploadIntent`,
  `DeleteIntent`, `ListResponse`, `ChainContext`, `OnChainPair`, `FileChunkProof`,
  `OuterFileProof`, `IntentKind`, `IntentMessage`, `CacheStore`, `CacheFactory`,
  `JindoClientOptions`, `JindoFolder`, `JindoFolderChild`.
