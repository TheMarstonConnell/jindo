import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import type { Hex } from "viem";
import { CHUNK_SIZE, ZERO_ROOT, type FileRecord } from "./types.ts";

// File-tree leaf binds chunk index to chunk content:
//   leaf = keccak256(abi.encode(uint256 chunkIndex, bytes chunk))
// Outer-tree leaf binds (cumulativeOffset, size, fileRoot):
//   leaf = keccak256(abi.encode(uint256 cumulativeBytesBefore, uint256 fileSize, bytes32 fileRoot))
// Both trees use OZ's default sort-pair commutative node hash; position binding
// happens inside the leaf encoding, so we can use a single tree implementation.

const FILE_LEAF_PARAMS = [{ type: "uint256" }, { type: "bytes" }] as const;
const OUTER_LEAF_PARAMS = [
  { type: "uint256" },
  { type: "uint256" },
  { type: "bytes32" },
] as const;

export function fileLeaf(chunkIndex: number | bigint, chunk: Uint8Array): Hex {
  return keccak256(encodeAbiParameters(FILE_LEAF_PARAMS, [BigInt(chunkIndex), toHex(chunk)]));
}

export function outerLeaf(cumulativeBytesBefore: bigint, fileSize: bigint, fileRoot: Hex): Hex {
  return keccak256(
    encodeAbiParameters(OUTER_LEAF_PARAMS, [cumulativeBytesBefore, fileSize, fileRoot]),
  );
}

function chunkCount(byteLen: number, size: number = CHUNK_SIZE): number {
  return Math.ceil(byteLen / size);
}

function chunksOf(bytes: Uint8Array, size: number = CHUNK_SIZE): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return out;
}

export function fileRoot(bytes: Uint8Array, size: number = CHUNK_SIZE): Hex {
  if (bytes.length === 0) throw new Error("empty file not supported");
  const leaves = chunksOf(bytes, size).map((c, i) => fileLeaf(i, c));
  if (leaves.length === 1) return leaves[0]!;
  return SimpleMerkleTree.of(leaves).root as Hex;
}

// Sort files by fileRoot ascending and return them with computed cumulative offsets.
export function canonicalLayout(
  files: FileRecord[],
): { record: FileRecord; cumulativeBytesBefore: bigint }[] {
  const sorted = [...files].sort((a, b) => (a.fileRoot < b.fileRoot ? -1 : a.fileRoot > b.fileRoot ? 1 : 0));
  let acc = 0n;
  const out: { record: FileRecord; cumulativeBytesBefore: bigint }[] = [];
  for (const f of sorted) {
    out.push({ record: f, cumulativeBytesBefore: acc });
    acc += BigInt(f.sizeBytes);
  }
  return out;
}

export function outerRoot(files: FileRecord[]): Hex {
  if (files.length === 0) return ZERO_ROOT;
  const layout = canonicalLayout(files);
  const leaves = layout.map((l) =>
    outerLeaf(l.cumulativeBytesBefore, BigInt(l.record.sizeBytes), l.record.fileRoot),
  );
  if (leaves.length === 1) return leaves[0]!;
  return SimpleMerkleTree.of(leaves).root as Hex;
}

export interface FileChunkProof {
  chunkIndex: number;
  chunk: Uint8Array;
  leaf: Hex;
  proof: Hex[];
}

export function fileMerkleProof(bytes: Uint8Array, chunkIndex: number): FileChunkProof {
  const chunks = chunksOf(bytes);
  if (chunkIndex < 0 || chunkIndex >= chunks.length) {
    throw new Error(`chunk index ${chunkIndex} out of range (0..${chunks.length - 1})`);
  }
  const chunk = chunks[chunkIndex]!;
  const leaves = chunks.map((c, i) => fileLeaf(i, c));
  const leaf = leaves[chunkIndex]!;
  if (leaves.length === 1) {
    return { chunkIndex, chunk, leaf, proof: [] };
  }
  const tree = SimpleMerkleTree.of(leaves);
  const proof = tree.getProof(leaf) as Hex[];
  return { chunkIndex, chunk, leaf, proof };
}

export interface OuterFileProof {
  fileRoot: Hex;
  fileSize: bigint;
  cumulativeBytesBefore: bigint;
  leaf: Hex;
  proof: Hex[];
}

export function outerMerkleProof(files: FileRecord[], targetFileRoot: Hex): OuterFileProof {
  const layout = canonicalLayout(files);
  const idx = layout.findIndex(
    (l) => l.record.fileRoot.toLowerCase() === targetFileRoot.toLowerCase(),
  );
  if (idx < 0) throw new Error(`fileRoot not in set: ${targetFileRoot}`);
  const target = layout[idx]!;
  const leaves = layout.map((l) =>
    outerLeaf(l.cumulativeBytesBefore, BigInt(l.record.sizeBytes), l.record.fileRoot),
  );
  const leaf = leaves[idx]!;
  if (leaves.length === 1) {
    return {
      fileRoot: target.record.fileRoot,
      fileSize: BigInt(target.record.sizeBytes),
      cumulativeBytesBefore: target.cumulativeBytesBefore,
      leaf,
      proof: [],
    };
  }
  const tree = SimpleMerkleTree.of(leaves);
  const proof = tree.getProof(leaf) as Hex[];
  return {
    fileRoot: target.record.fileRoot,
    fileSize: BigInt(target.record.sizeBytes),
    cumulativeBytesBefore: target.cumulativeBytesBefore,
    leaf,
    proof,
  };
}

// Find which file in the canonical layout owns a given byte offset.
export function locateOffset(
  files: FileRecord[],
  byteOffset: bigint,
): { record: FileRecord; cumulativeBytesBefore: bigint; chunkIndex: number } | null {
  const layout = canonicalLayout(files);
  for (const l of layout) {
    const start = l.cumulativeBytesBefore;
    const end = start + BigInt(l.record.sizeBytes);
    if (byteOffset >= start && byteOffset < end) {
      const chunkIndex = Number((byteOffset - start) / BigInt(CHUNK_SIZE));
      return { record: l.record, cumulativeBytesBefore: start, chunkIndex };
    }
  }
  return null;
}
