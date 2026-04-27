import { test, expect } from "bun:test";
import {
  fileRoot,
  outerRoot,
  fileMerkleProof,
  outerMerkleProof,
  fileLeaf,
  outerLeaf,
  locateOffset,
} from "../src/shared/merkle.ts";
import { CHUNK_SIZE, ZERO_ROOT, type FileRecord } from "../src/shared/types.ts";

function rec(fileRootHex: `0x${string}`, sizeBytes: number): FileRecord {
  return { fileRoot: fileRootHex, sizeBytes, uploadedAt: 0 };
}

test("fileRoot is deterministic and content-bound", () => {
  const a = new TextEncoder().encode("hello world");
  expect(fileRoot(a)).toBe(fileRoot(a));
  expect(fileRoot(a)).not.toBe(fileRoot(new TextEncoder().encode("hella world")));
});

test("fileRoot of a single chunk equals its positional leaf", () => {
  const a = new TextEncoder().encode("hello");
  expect(fileRoot(a)).toBe(fileLeaf(0, a));
});

test("fileRoot is order-dependent across chunks (positional leaf)", () => {
  const c1 = new Uint8Array(CHUNK_SIZE).fill(0x01);
  const c2 = new Uint8Array(CHUNK_SIZE).fill(0x02);
  const ab = new Uint8Array(CHUNK_SIZE * 2);
  ab.set(c1, 0);
  ab.set(c2, CHUNK_SIZE);
  const ba = new Uint8Array(CHUNK_SIZE * 2);
  ba.set(c2, 0);
  ba.set(c1, CHUNK_SIZE);
  expect(fileRoot(ab)).not.toBe(fileRoot(ba));
});

test("fileRoot throws on empty input", () => {
  expect(() => fileRoot(new Uint8Array())).toThrow();
});

test("outerRoot is order-independent over the same set of files", () => {
  const a: FileRecord = rec("0x" + "11".repeat(32) as `0x${string}`, 1024);
  const b: FileRecord = rec("0x" + "22".repeat(32) as `0x${string}`, 2048);
  const c: FileRecord = rec("0x" + "33".repeat(32) as `0x${string}`, 512);
  expect(outerRoot([a, b, c])).toBe(outerRoot([c, a, b]));
  expect(outerRoot([a, b, c])).toBe(outerRoot([b, c, a]));
});

test("outerRoot of empty set is ZERO_ROOT", () => {
  expect(outerRoot([])).toBe(ZERO_ROOT);
});

test("outerRoot of a single file equals its positional leaf at offset 0", () => {
  const fr = ("0x" + "ab".repeat(32)) as `0x${string}`;
  const f = rec(fr, 5000);
  expect(outerRoot([f])).toBe(outerLeaf(0n, 5000n, fr));
});

test("file merkle proof verifies against fileRoot", async () => {
  const { SimpleMerkleTree } = await import("@openzeppelin/merkle-tree");
  const bytes = new Uint8Array(CHUNK_SIZE * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  const root = fileRoot(bytes);
  const { proof, leaf } = fileMerkleProof(bytes, 2);
  expect(SimpleMerkleTree.verify(root, leaf, proof)).toBe(true);
});

test("outer merkle proof verifies against outerRoot", async () => {
  const { SimpleMerkleTree } = await import("@openzeppelin/merkle-tree");
  const files: FileRecord[] = [
    rec("0x" + "11".repeat(32) as `0x${string}`, 1024),
    rec("0x" + "22".repeat(32) as `0x${string}`, 2048),
    rec("0x" + "33".repeat(32) as `0x${string}`, 512),
  ];
  const root = outerRoot(files);
  const target = files[1]!;
  const { proof, leaf } = outerMerkleProof(files, target.fileRoot);
  expect(SimpleMerkleTree.verify(root, leaf, proof)).toBe(true);
});

test("locateOffset finds the right file in canonical layout", () => {
  // Three files of size 1000, 2000, 500 → cumulative offsets 0, 1000, 3000
  // (after sorting by fileRoot). Use distinct hex prefixes so order is predictable.
  const files: FileRecord[] = [
    rec("0x" + "11".repeat(32) as `0x${string}`, 1000),
    rec("0x" + "22".repeat(32) as `0x${string}`, 2000),
    rec("0x" + "33".repeat(32) as `0x${string}`, 500),
  ];
  const a = locateOffset(files, 500n);
  expect(a?.record.fileRoot).toBe(files[0]!.fileRoot);
  expect(a?.cumulativeBytesBefore).toBe(0n);

  const b = locateOffset(files, 1500n);
  expect(b?.record.fileRoot).toBe(files[1]!.fileRoot);
  expect(b?.cumulativeBytesBefore).toBe(1000n);

  const c = locateOffset(files, 3200n);
  expect(c?.record.fileRoot).toBe(files[2]!.fileRoot);
  expect(c?.cumulativeBytesBefore).toBe(3000n);
});
