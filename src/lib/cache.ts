import type { Hex } from "viem";
import type { FileRecord, PairState } from "../shared/types.ts";

export interface CacheStore {
  readState(): PairState;
  writeState(state: PairState): void;
  listFiles(): FileRecord[];
  fileRoots(): Hex[];
  insertFile(rec: FileRecord): void;
  deleteFile(fileRoot: Hex): void;
  replaceAll(files: FileRecord[], state: PairState): void;
}

export type CacheFactory = (
  hostAddress: import("viem").Address,
  clientAddress: import("viem").Address,
) => CacheStore | Promise<CacheStore>;
