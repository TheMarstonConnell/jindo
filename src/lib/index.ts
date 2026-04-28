export { JindoClient } from "./client.ts";
export type { JindoClientOptions, JindoClientFromContextOptions } from "./client.ts";
export type { CacheStore, CacheFactory } from "./cache.ts";
export { memoryCacheFactory } from "./memory-cache.ts";
export {
  fetchHostAddress,
  fetchList,
  postDelete,
  postUpload,
} from "./host-client.ts";

export {
  fileRoot,
  outerRoot,
  fileLeaf,
  outerLeaf,
  fileMerkleProof,
  outerMerkleProof,
  canonicalLayout,
  locateOffset,
} from "../shared/merkle.ts";
export type { FileChunkProof, OuterFileProof } from "../shared/merkle.ts";
export { buildDomain, TYPES, recoverIntentSigner } from "../shared/eip712.ts";
export type { IntentKind, IntentMessage } from "../shared/eip712.ts";
export { JINDO_ABI } from "../shared/abi.ts";
export {
  buildChainContext,
  buildChainContextFromWallet,
  readPair,
  readClientBalance,
  readRateBytePerDay,
  readWithdrawableBalance,
  submitCommitUpload,
  submitCommitDelete,
  submitCommitProof,
} from "../shared/chain.ts";
export type { ChainContext, OnChainPair } from "../shared/chain.ts";
export {
  ZERO_ROOT,
  CHUNK_SIZE,
} from "../shared/types.ts";
export type {
  Address,
  Hex,
  FileRecord,
  PairState,
  UploadIntent,
  DeleteIntent,
  ListResponse,
} from "../shared/types.ts";
