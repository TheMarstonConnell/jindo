import type { Hex } from "viem";
import type { FileRecord, PairState } from "../shared/types.ts";
import { ZERO_ROOT } from "../shared/types.ts";
import type { CacheFactory, CacheStore } from "./cache.ts";

export const memoryCacheFactory: CacheFactory = () => {
  let state: PairState = { outerRoot: ZERO_ROOT, totalSize: 0n };
  const files = new Map<string, FileRecord>();

  const store: CacheStore = {
    readState: () => state,
    writeState: (s) => {
      state = s;
    },
    listFiles: () => Array.from(files.values()),
    fileRoots: () => Array.from(files.values()).map((f) => f.fileRoot),
    insertFile: (rec) => {
      files.set(rec.fileRoot.toLowerCase(), rec);
    },
    deleteFile: (fileRoot: Hex) => {
      files.delete(fileRoot.toLowerCase());
    },
    replaceAll: (newFiles, newState) => {
      files.clear();
      for (const f of newFiles) files.set(f.fileRoot.toLowerCase(), f);
      state = newState;
    },
  };
  return store;
};
