import type { Address, Hex } from "viem";
import { buildDomain, TYPES } from "../shared/eip712.ts";
import { fileRoot as computeFileRoot, outerRoot as computeOuterRoot } from "../shared/merkle.ts";
import {
  ERC20_ABI,
  buildChainContext,
  readPair,
  submitDepositUsdc,
  type ChainContext,
} from "../shared/chain.ts";
import { JINDO_ABI } from "../shared/abi.ts";
import type { FileRecord, PairState } from "../shared/types.ts";
import type { CacheFactory, CacheStore } from "./cache.ts";
import { fetchHostAddress, fetchList, postDelete, postUpload } from "./host-client.ts";

export interface JindoClientOptions {
  rpcUrl: string;
  privateKey: Hex;
  contract: Address;
  hostUrl: string;
  openCache: CacheFactory;
}

export interface JindoClientFromContextOptions {
  hostUrl: string;
  openCache: CacheFactory;
}

export class JindoClient {
  private constructor(
    private readonly hostUrl: string,
    private readonly ctx: ChainContext,
    public readonly hostAddress: Address,
    private readonly cache: CacheStore,
  ) {}

  static async open(opts: JindoClientOptions): Promise<JindoClient> {
    const ctx = await buildChainContext({
      rpcUrl: opts.rpcUrl,
      privateKey: opts.privateKey,
      contract: opts.contract,
    });
    return JindoClient.fromContext(ctx, { hostUrl: opts.hostUrl, openCache: opts.openCache });
  }

  static async fromContext(
    ctx: ChainContext,
    opts: JindoClientFromContextOptions,
  ): Promise<JindoClient> {
    const hostAddress = await fetchHostAddress(opts.hostUrl);
    const cache = await opts.openCache(hostAddress, ctx.account);
    return new JindoClient(opts.hostUrl, ctx, hostAddress, cache);
  }

  get clientAddress(): Address {
    return this.ctx.account;
  }

  get chainId(): number {
    return this.ctx.chainId;
  }

  list(): { state: PairState; files: FileRecord[] } {
    return { state: this.cache.readState(), files: this.cache.listFiles() };
  }

  private async assertCacheInSync(): Promise<PairState> {
    const local = this.cache.readState();
    const onChain = await readPair(this.ctx, this.hostAddress, this.clientAddress);
    if (local.outerRoot.toLowerCase() !== onChain.outerRoot.toLowerCase()) {
      throw new Error(
        `cache out of sync with chain (local=${local.outerRoot}, chain=${onChain.outerRoot}); call recover()`,
      );
    }
    return local;
  }

  private async signUploadBatch(message: {
    host: Address;
    client: Address;
    fileRoots: Hex[];
    priorRoot: Hex;
    newRoot: Hex;
    newSize: bigint;
  }): Promise<Hex> {
    const account = this.ctx.walletClient.account;
    if (!account) throw new Error("walletClient missing an account");
    return this.ctx.walletClient.signTypedData({
      account,
      domain: buildDomain(this.ctx.chainId, this.ctx.contract),
      types: TYPES,
      primaryType: "Upload",
      message,
    });
  }

  private async signDelete(message: {
    host: Address;
    client: Address;
    fileRoot: Hex;
    priorRoot: Hex;
    newRoot: Hex;
    newSize: bigint;
  }): Promise<Hex> {
    const account = this.ctx.walletClient.account;
    if (!account) throw new Error("walletClient missing an account");
    return this.ctx.walletClient.signTypedData({
      account,
      domain: buildDomain(this.ctx.chainId, this.ctx.contract),
      types: TYPES,
      primaryType: "Delete",
      message,
    });
  }

  /// Upload 1+ files in a single batch. One wallet signature, one chain tx.
  /// Pass `[bytes]` for a single file or `[a, b, c]` for multiple. Returns the
  /// file roots in the same order they were passed.
  async upload(
    files: Array<Uint8Array | { bytes: Uint8Array; filename?: string }>,
  ): Promise<{ fileRoots: Hex[]; outerRoot: Hex }> {
    if (files.length === 0) throw new Error("cannot upload an empty batch");

    // Normalize input: bytes-only entries get a synthetic name.
    const normalized = files.map((f, i) =>
      f instanceof Uint8Array
        ? { bytes: f, filename: `blob-${i}` }
        : { bytes: f.bytes, filename: f.filename ?? `blob-${i}` },
    );
    for (const f of normalized) {
      if (f.bytes.byteLength === 0) throw new Error("cannot upload empty file");
    }

    const local = await this.assertCacheInSync();
    const now = Math.floor(Date.now() / 1000);
    const newFiles: FileRecord[] = normalized.map((f) => ({
      fileRoot: computeFileRoot(f.bytes),
      sizeBytes: f.bytes.byteLength,
      uploadedAt: now,
    }));
    const fileRoots = newFiles.map((f) => f.fileRoot);

    const newRoot = computeOuterRoot([...this.cache.listFiles(), ...newFiles]);
    const newSize =
      local.totalSize +
      normalized.reduce((acc, f) => acc + BigInt(f.bytes.byteLength), 0n);

    const signature = await this.signUploadBatch({
      host: this.hostAddress,
      client: this.clientAddress,
      fileRoots,
      priorRoot: local.outerRoot,
      newRoot,
      newSize,
    });

    const { outerRoot } = await postUpload(
      this.hostUrl,
      normalized,
      {
        client: this.clientAddress,
        fileRoots,
        priorRoot: local.outerRoot,
        newRoot,
        newSize: newSize.toString(),
        signature,
      },
    );

    for (const f of newFiles) this.cache.insertFile(f);
    this.cache.writeState({ outerRoot, totalSize: newSize });

    return { fileRoots, outerRoot };
  }

  async delete(fileRoot: Hex): Promise<Hex> {
    const target = fileRoot.toLowerCase() as Hex;
    const local = await this.assertCacheInSync();

    const all = this.cache.listFiles();
    const found = all.find((f) => f.fileRoot.toLowerCase() === target);
    if (!found) throw new Error(`file_root not in local cache: ${target}`);

    const remaining = all.filter((f) => f.fileRoot.toLowerCase() !== target);
    const newRoot = computeOuterRoot(remaining);
    const newSize = local.totalSize - BigInt(found.sizeBytes);

    const signature = await this.signDelete({
      host: this.hostAddress,
      client: this.clientAddress,
      fileRoot: target,
      priorRoot: local.outerRoot,
      newRoot,
      newSize,
    });

    const { txHash, outerRoot } = await postDelete(this.hostUrl, {
      client: this.clientAddress,
      fileRoot: target,
      priorRoot: local.outerRoot,
      newRoot,
      newSize: newSize.toString(),
      signature,
    });

    this.cache.deleteFile(target);
    this.cache.writeState({ outerRoot, totalSize: newSize });

    return txHash;
  }

  async recover(): Promise<{ files: FileRecord[]; outerRoot: Hex }> {
    const onChain = await readPair(this.ctx, this.hostAddress, this.clientAddress);
    const remote = await fetchList(this.hostUrl, this.clientAddress);

    if (remote.outerRoot.toLowerCase() !== onChain.outerRoot.toLowerCase()) {
      throw new Error(
        `host's reported outerRoot (${remote.outerRoot}) does not match chain (${onChain.outerRoot})`,
      );
    }
    const totalFromList = remote.files.reduce((acc, f) => acc + BigInt(f.sizeBytes), 0n);
    if (totalFromList !== onChain.totalSize) {
      throw new Error(
        `host file size sum (${totalFromList}) does not match chain totalSize (${onChain.totalSize})`,
      );
    }
    const reconstructed = computeOuterRoot(remote.files);
    if (reconstructed.toLowerCase() !== onChain.outerRoot.toLowerCase()) {
      throw new Error(
        `reconstructed outer root (${reconstructed}) does not match chain (${onChain.outerRoot})`,
      );
    }

    this.cache.replaceAll(remote.files, {
      outerRoot: onChain.outerRoot,
      totalSize: onChain.totalSize,
    });

    return { files: remote.files, outerRoot: onChain.outerRoot };
  }

  // ── USDC payment helpers ───────────────────────────────────────────────────

  private cachedUsdc: Address | null = null;

  /// Read the USDC token address the Jindo contract is configured for. Cached.
  async usdcAddress(): Promise<Address> {
    if (this.cachedUsdc) return this.cachedUsdc;
    const addr = (await this.ctx.publicClient.readContract({
      address: this.ctx.contract,
      abi: JINDO_ABI,
      functionName: "USDC",
    })) as Address;
    this.cachedUsdc = addr;
    return addr;
  }

  /// USDC the connected wallet holds (base units, 6 decimals).
  async walletUsdcBalance(): Promise<bigint> {
    const usdc = await this.usdcAddress();
    return (await this.ctx.publicClient.readContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.clientAddress],
    })) as bigint;
  }

  /// The client's deposited balance held by the Jindo contract (atto-USDC).
  async contractUsdcBalance(): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.ctx.contract,
      abi: JINDO_ABI,
      functionName: "balance",
      args: [this.clientAddress],
    })) as bigint;
  }

  /// Atto-USDC the connected wallet could withdraw right now. Equals
  /// contractUsdcBalance() minus the 30-day storage reserve the contract
  /// holds back across all of this client's live pairs.
  async withdrawableUsdc(): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.ctx.contract,
      abi: JINDO_ABI,
      functionName: "getWithdrawableBalance",
      args: [this.clientAddress],
    })) as bigint;
  }

  /// Read the current ERC-20 allowance the wallet has granted to the Jindo contract.
  async usdcAllowance(): Promise<bigint> {
    const usdc = await this.usdcAddress();
    return (await this.ctx.publicClient.readContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.clientAddress, this.ctx.contract],
    })) as bigint;
  }

  /// Deposit USDC. If the wallet has already granted enough allowance to the
  /// Jindo contract, the approve step is skipped — so most subsequent deposits
  /// only prompt MetaMask once. The approveHash is `null` when skipped.
  depositUsdc(
    baseAmount: bigint,
    opts?: { onStage?: (stage: "approve" | "deposit") => void },
  ): Promise<{ approveHash: Hex | null; depositHash: Hex }> {
    return submitDepositUsdc(this.ctx, baseAmount, opts);
  }

  /// Pull `baseAmount` USDC out of the contract pool back to the connected wallet.
  async withdrawUsdc(baseAmount: bigint): Promise<Hex> {
    const account = this.ctx.walletClient.account;
    if (!account) throw new Error("walletClient missing account");
    const hash = await this.ctx.walletClient.writeContract({
      account,
      chain: null,
      address: this.ctx.contract,
      abi: JINDO_ABI,
      functionName: "withdraw",
      args: [baseAmount],
    });
    await this.ctx.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }
}
