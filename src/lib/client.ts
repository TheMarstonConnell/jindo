import type { Address, Hex } from "viem";
import { buildDomain, TYPES } from "../shared/eip712.ts";
import { fileRoot as computeFileRoot, outerRoot as computeOuterRoot } from "../shared/merkle.ts";
import { buildChainContext, readPair, type ChainContext } from "../shared/chain.ts";
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

  private async signIntent(
    primaryType: "Upload" | "Delete",
    message: {
      host: Address;
      client: Address;
      fileRoot: Hex;
      priorRoot: Hex;
      newRoot: Hex;
      newSize: bigint;
    },
  ): Promise<Hex> {
    const account = this.ctx.walletClient.account;
    if (!account) throw new Error("walletClient missing an account");
    return this.ctx.walletClient.signTypedData({
      account,
      domain: buildDomain(this.ctx.chainId, this.ctx.contract),
      types: TYPES,
      primaryType,
      message,
    });
  }

  async upload(bytes: Uint8Array): Promise<Hex> {
    if (bytes.byteLength === 0) throw new Error("cannot upload empty file");
    const local = await this.assertCacheInSync();

    const fileRootHex = computeFileRoot(bytes);
    const newFile: FileRecord = {
      fileRoot: fileRootHex,
      sizeBytes: bytes.byteLength,
      uploadedAt: Math.floor(Date.now() / 1000),
    };
    const newRoot = computeOuterRoot([...this.cache.listFiles(), newFile]);
    const newSize = local.totalSize + BigInt(bytes.byteLength);

    const signature = await this.signIntent("Upload", {
      host: this.hostAddress,
      client: this.clientAddress,
      fileRoot: fileRootHex,
      priorRoot: local.outerRoot,
      newRoot,
      newSize,
    });

    const { outerRoot } = await postUpload(this.hostUrl, bytes, {
      client: this.clientAddress,
      fileRoot: fileRootHex,
      priorRoot: local.outerRoot,
      newRoot,
      newSize: newSize.toString(),
      signature,
    });

    this.cache.insertFile(newFile);
    this.cache.writeState({ outerRoot, totalSize: newSize });

    return fileRootHex;
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

    const signature = await this.signIntent("Delete", {
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
}
