# Library

`src/lib/index.ts` is the importable surface of jindo. It re-exports a single high-level class (`JindoClient`) plus the lower-level Merkle, EIP-712, and chain primitives the client and host both build on. Everything the CLI does on the client side, you can do from your own code through this library.

## `JindoClient`

The high-level entry point. One instance corresponds to one `(host, client)` pair, backed by a local cache.

```ts
import { JindoClient } from "./src/lib";
import { sqliteCacheFactory } from "./src/lib/sqlite-cache";

const jindo = await JindoClient.open({
  rpcUrl: process.env.JINDO_RPC_URL!,
  privateKey: process.env.JINDO_PRIVATE_KEY! as `0x${string}`,
  contract: process.env.JINDO_CONTRACT! as `0x${string}`,
  hostUrl: "http://localhost:5689",
  openCache: sqliteCacheFactory("/tmp/jindo-cache"),
});
```

`open` resolves the host's address from `/health`, derives the client's address from the private key, and opens the cache for that pair. It exposes `hostAddress`, `clientAddress`, and `chainId` as read-only properties.

### `upload(bytes: Uint8Array): Promise<Hex>`

Computes the file's Merkle root, signs an `Upload` intent that names the prior and new outer roots, posts to the host, and updates the cache. Returns the file root.

```ts
const bytes = new Uint8Array(await Bun.file("./photo.jpg").arrayBuffer());
const fileRoot = await jindo.upload(bytes);
```

### `delete(fileRoot: Hex): Promise<Hex>`

Signs a `Delete` intent for a file the cache already knows about, posts to the host, and removes the entry from the cache on success. Returns the on-chain transaction hash.

```ts
const txHash = await jindo.delete(fileRoot);
```

### `list(): { state, files }`

Synchronous read of the local cache. Returns the cached `outerRoot` and `totalSize` along with every `FileRecord` (`fileRoot`, `sizeBytes`, `uploadedAt`).

```ts
const { state, files } = jindo.list();
console.log(state.outerRoot, files.length);
```

### `recover(): Promise<{ files, outerRoot }>`

Rebuilds the cache from the host, but only after verifying the host's reported list against on-chain state. Throws if the host's outer root, total size, or per-file accounting does not match.

```ts
const { files, outerRoot } = await jindo.recover();
```

## Cache abstraction

`JindoClient.open` takes an `openCache: CacheFactory`, so you can plug in any backend that implements the `CacheStore` interface (read state, list files, insert, delete, replace-all). The CLI uses a SQLite-backed factory; tests and embedded uses can pass a memory implementation. The factory is called with `(hostAddress, clientAddress)` so it can isolate caches per pair.

## Merkle primitives

These are the same functions the contract verifies against, exposed for tools that need to build or check proofs.

- `fileRoot(bytes, chunkSize?)` — root of a file's chunk tree. `chunkSize` defaults to `CHUNK_SIZE` (1024).
- `outerRoot(files)` — root of a sorted set of `FileRecord`s. Empty input returns `ZERO_ROOT`.
- `fileLeaf(chunkIndex, chunk)` / `outerLeaf(cumulativeBytesBefore, fileSize, fileRoot)` — single-leaf hashes.
- `fileMerkleProof(bytes, chunkIndex)` — proof for chunk `i` against `fileRoot(bytes)`.
- `outerMerkleProof(files, fileRoot)` — proof that `fileRoot` belongs to the set.
- `canonicalLayout(files)` — sorts files and computes cumulative byte offsets.
- `locateOffset(files, byteOffset)` — given a byte position in the set, finds the file and chunk that cover it. This is what `jindo prove` uses to answer a challenge.

```ts
import { fileRoot, fileMerkleProof } from "./src/lib";

const bytes = new Uint8Array([/* ... */]);
const root = fileRoot(bytes);
const proof = fileMerkleProof(bytes, 0);
// proof.leaf, proof.proof, proof.chunk
```

## EIP-712

- `buildDomain(chainId, contract)` — returns the `{ name: "Jindo", version: "1", chainId, verifyingContract }` domain.
- `TYPES` — the `Upload` and `Delete` typed-data structs (both have `host`, `client`, `fileRoot`, `priorRoot`, `newRoot`, `newSize`).
- `recoverIntentSigner(chainId, contract, kind, message, signature)` — recovers the address that signed an intent. The host uses this on every request.

```ts
import { recoverIntentSigner } from "./src/lib";

const signer = await recoverIntentSigner(chainId, contract, "Upload", {
  host, client, fileRoot, priorRoot, newRoot, newSize,
}, signature);
```

## Chain access

Wrappers around viem that match what `JindoClient` and the host server use internally.

- `buildChainContext({ rpcUrl, privateKey, contract })` — returns `{ chainId, contract, publicClient, walletClient, account }`.
- `readPair(ctx, host, client)` — reads on-chain `outerRoot`, `totalSize`, and challenge state for a pair.
- `submitCommitUpload(ctx, client, fileRoot, priorRoot, newRoot, newSize, signature)` — sends the upload commitment.
- `submitCommitDelete(...)` — same shape, for deletes.
- `submitCommitProof(ctx, client, cumulativeBytesBefore, fileSize, fileRoot, chunkInFileIndex, chunkBytes, outerProof, fileProof)` — answers a challenge.

```ts
import { buildChainContext, readPair } from "./src/lib";

const ctx = await buildChainContext({ rpcUrl, privateKey, contract });
const onChain = await readPair(ctx, hostAddress, clientAddress);
```

## HTTP host helpers

Thin fetchers used by `JindoClient` that you can call directly if you want to talk to a host without managing a cache or signing key.

- `fetchHostAddress(hostUrl)` — `GET /health`.
- `fetchList(hostUrl, client)` — `GET /list/:client`.
- `postUpload(hostUrl, bytes, intent)` — `POST /upload` with multipart body.
- `postDelete(hostUrl, body)` — `POST /delete`.

## Constants and types

- `ZERO_ROOT` — the canonical empty-set root (`0x` followed by 64 zeros).
- `CHUNK_SIZE` — chunk size used by the file Merkle tree (`1024`); must match the contract.
- `JINDO_ABI` — full TypeScript ABI for the contract, ready to hand to viem.
- Types: `Address`, `Hex`, `FileRecord`, `PairState`, `UploadIntent`, `DeleteIntent`, `ListResponse`, `ChainContext`, `OnChainPair`, `FileChunkProof`, `OuterFileProof`, `IntentKind`, `IntentMessage`, `CacheStore`, `CacheFactory`, `JindoClientOptions`.
