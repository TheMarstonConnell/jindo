import type { Address, Hex } from "viem";
import { getAddress, toHex } from "viem";
import {
  buildChainContext,
  readPair,
  submitCommitProof,
  type ChainContext,
} from "../shared/chain.ts";
import { fileMerkleProof, locateOffset, outerMerkleProof } from "../shared/merkle.ts";
import { CHUNK_SIZE } from "../shared/types.ts";
import type { HostEnv } from "../node/env.ts";
import { listFiles, openHostDb, type HostDb } from "./db.ts";

export interface ProveResult {
  txHash: Hex;
  challengeIndex: bigint;
  fileRoot: Hex;
  chunkInFileIndex: number;
}

export async function proveOnce(
  ctx: ChainContext,
  hdb: HostDb,
  _env: HostEnv,
  client: Address,
): Promise<ProveResult> {
  const checked = getAddress(client);
  const onChain = await readPair(ctx, ctx.account, checked);
  if (onChain.totalSize === 0n) throw new Error("nothing to prove for this client");

  const challengeByte = onChain.challengeIndex * BigInt(CHUNK_SIZE);
  const files = listFiles(hdb, checked);
  const local = files.reduce((acc, f) => acc + BigInt(f.sizeBytes), 0n);
  if (local !== onChain.totalSize) {
    throw new Error(
      `host db total (${local}) out of sync with chain total (${onChain.totalSize})`,
    );
  }

  const located = locateOffset(files, challengeByte);
  if (!located) throw new Error(`could not locate file for challenge byte ${challengeByte}`);

  const blob = Bun.file(`${hdb.blobsDir}/${located.record.fileRoot}`);
  if (!(await blob.exists())) throw new Error(`blob missing: ${located.record.fileRoot}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== located.record.sizeBytes) {
    throw new Error(
      `blob size mismatch on disk for ${located.record.fileRoot}: ${bytes.byteLength} vs ${located.record.sizeBytes}`,
    );
  }

  const fileProofGen = fileMerkleProof(bytes, located.chunkIndex);
  const outerProofGen = outerMerkleProof(files, located.record.fileRoot);

  const txHash = await submitCommitProof(
    ctx,
    checked,
    outerProofGen.cumulativeBytesBefore,
    outerProofGen.fileSize,
    outerProofGen.fileRoot,
    BigInt(fileProofGen.chunkIndex),
    toHex(fileProofGen.chunk),
    outerProofGen.proof,
    fileProofGen.proof,
  );

  return {
    txHash,
    challengeIndex: onChain.challengeIndex,
    fileRoot: located.record.fileRoot,
    chunkInFileIndex: located.chunkIndex,
  };
}

export async function prove(env: HostEnv, client: Address): Promise<ProveResult> {
  const ctx = await buildChainContext({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    contract: env.contract,
  });
  const hdb = openHostDb(env.dataDir);
  return proveOnce(ctx, hdb, env, client);
}
