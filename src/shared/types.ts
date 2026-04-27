import type { Address, Hex } from "viem";

export type { Address, Hex };

export const ZERO_ROOT: Hex = `0x${"0".repeat(64)}`;

// 1 KiB. The contract's challenge granularity and the file-tree leaf granularity
// are the same constant, so chunk indices line up across both layers.
export const CHUNK_SIZE = 1024;

export interface FileRecord {
  fileRoot: Hex;
  sizeBytes: number;
  uploadedAt: number;
}

export interface PairState {
  outerRoot: Hex;
  totalSize: bigint;
}

export interface UploadIntent {
  host: Address;
  client: Address;
  fileRoot: Hex;
  priorRoot: Hex;
  newRoot: Hex;
  newSize: bigint;
  signature: Hex;
}

export interface DeleteIntent {
  host: Address;
  client: Address;
  fileRoot: Hex;
  priorRoot: Hex;
  newRoot: Hex;
  newSize: bigint;
  signature: Hex;
}

export interface ListResponse {
  outerRoot: Hex;
  totalSize: string;
  files: { fileRoot: Hex; sizeBytes: number; uploadedAt: number }[];
}
