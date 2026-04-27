import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

export class JindoClient {
  private constructor(
    private readonly opts: JindoClientOptions,
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
    const hostAddress = await fetchHostAddress(opts.hostUrl);
    const cache = await opts.openCache(hostAddress, ctx.account);
    return new JindoClient(opts, ctx, hostAddress, cache);
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

  async upload(bytes: Uint8Array): Promise<Hex> {
    if (bytes.byteLength === 0) throw new Error("cannot upload empty file");
    const account = privateKeyToAccount(this.opts.privateKey);
    const local = await this.assertCacheInSync();

    const fileRootHex = computeFileRoot(bytes);
    const newFile: FileRecord = {
      fileRoot: fileRootHex,
      sizeBytes: bytes.byteLength,
      uploadedAt: Math.floor(Date.now() / 1000),
    };
    const newRoot = computeOuterRoot([...this.cache.listFiles(), newFile]);
    const newSize = local.totalSize + BigInt(bytes.byteLength);

    const message = {
      host: this.hostAddress,
      client: this.clientAddress,
      fileRoot: fileRootHex,
      priorRoot: local.outerRoot,
      newRoot,
      newSize,
    };

    const signature = await account.signTypedData({
      domain: buildDomain(this.ctx.chainId, this.opts.contract),
      types: TYPES,
      primaryType: "Upload",
      message,
    });

    const { outerRoot } = await postUpload(this.opts.hostUrl, bytes, {
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
    const account = privateKeyToAccount(this.opts.privateKey);
    const local = await this.assertCacheInSync();

    const all = this.cache.listFiles();
    const found = all.find((f) => f.fileRoot.toLowerCase() === target);
    if (!found) throw new Error(`file_root not in local cache: ${target}`);

    const remaining = all.filter((f) => f.fileRoot.toLowerCase() !== target);
    const newRoot = computeOuterRoot(remaining);
    const newSize = local.totalSize - BigInt(found.sizeBytes);

    const message = {
      host: this.hostAddress,
      client: this.clientAddress,
      fileRoot: target,
      priorRoot: local.outerRoot,
      newRoot,
      newSize,
    };

    const signature = await account.signTypedData({
      domain: buildDomain(this.ctx.chainId, this.opts.contract),
      types: TYPES,
      primaryType: "Delete",
      message,
    });

    const { txHash, outerRoot } = await postDelete(this.opts.hostUrl, {
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
    const remote = await fetchList(this.opts.hostUrl, this.clientAddress);

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
