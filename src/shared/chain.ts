import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { JINDO_ABI } from "./abi.ts";
import type { PairState } from "./types.ts";

export interface ChainContext {
  chainId: number;
  contract: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
}

export async function buildChainContext(opts: {
  rpcUrl: string;
  privateKey: Hex;
  contract: Address;
}): Promise<ChainContext> {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const walletClient = createWalletClient({ account, transport });
  return {
    chainId,
    contract: opts.contract,
    publicClient,
    walletClient,
    account: account.address,
  };
}

export async function buildChainContextFromWallet(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  contract: Address;
}): Promise<ChainContext> {
  const account = opts.walletClient.account;
  if (!account) throw new Error("walletClient has no account attached");
  const chainId = await opts.publicClient.getChainId();
  return {
    chainId,
    contract: opts.contract,
    publicClient: opts.publicClient,
    walletClient: opts.walletClient,
    account: account.address,
  };
}

export interface OnChainPair {
  host: Address;
  client: Address;
  outerRoot: Hex;
  totalSize: bigint;
  challengeIndex: bigint;
}

export async function readPair(
  ctx: ChainContext,
  host: Address,
  client: Address,
): Promise<OnChainPair> {
  const key = (await ctx.publicClient.readContract({
    address: ctx.contract,
    abi: JINDO_ABI,
    functionName: "key",
    args: [host, client],
  })) as Hex;

  const [h, size, c, challengeIndex, root] = (await ctx.publicClient.readContract({
    address: ctx.contract,
    abi: JINDO_ABI,
    functionName: "contracts",
    args: [key],
  })) as readonly [Address, bigint, Address, bigint, Hex];

  return {
    host: h,
    client: c,
    outerRoot: root,
    totalSize: size,
    challengeIndex,
  };
}

export async function submitCommitUpload(
  ctx: ChainContext,
  client: Address,
  fileRoot: Hex,
  priorRoot: Hex,
  newRoot: Hex,
  newSize: bigint,
  signature: Hex,
): Promise<Hex> {
  const hash = await ctx.walletClient.writeContract({
    account: ctx.walletClient.account!,
    chain: null,
    address: ctx.contract,
    abi: JINDO_ABI,
    functionName: "commitUpload",
    args: [client, fileRoot, priorRoot, newRoot, newSize, signature],
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function submitCommitDelete(
  ctx: ChainContext,
  client: Address,
  fileRoot: Hex,
  priorRoot: Hex,
  newRoot: Hex,
  newSize: bigint,
  signature: Hex,
): Promise<Hex> {
  const hash = await ctx.walletClient.writeContract({
    account: ctx.walletClient.account!,
    chain: null,
    address: ctx.contract,
    abi: JINDO_ABI,
    functionName: "commitDelete",
    args: [client, fileRoot, priorRoot, newRoot, newSize, signature],
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function submitCommitProof(
  ctx: ChainContext,
  client: Address,
  cumulativeBytesBefore: bigint,
  fileSize: bigint,
  fileRoot: Hex,
  chunkInFileIndex: bigint,
  chunkBytes: Hex,
  outerProof: readonly Hex[],
  fileProof: readonly Hex[],
): Promise<Hex> {
  const hash = await ctx.walletClient.writeContract({
    account: ctx.walletClient.account!,
    chain: null,
    address: ctx.contract,
    abi: JINDO_ABI,
    functionName: "commitProof",
    args: [
      client,
      cumulativeBytesBefore,
      fileSize,
      fileRoot,
      chunkInFileIndex,
      chunkBytes,
      outerProof,
      fileProof,
    ],
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
