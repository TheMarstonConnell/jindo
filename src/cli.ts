#!/usr/bin/env bun
import { Command } from "commander";
import type { Address, Hex } from "viem";
import { JindoClient } from "./lib/index.ts";
import { JINDO_ABI } from "./shared/abi.ts";
import { buildChainContext, submitApproveUsdc } from "./shared/chain.ts";
import { startHost } from "./host/server.ts";
import { startS3 } from "./s3/index.ts";
import { prove } from "./host/prove.ts";
import { withdrawAll } from "./host/withdraw.ts";
import { loadClient, loadHost, loadS3Gateway } from "./node/env.ts";
import { sqliteCacheFactory } from "./node/sqlite-cache.ts";

/// Parse a USDC string (e.g. "1.5", "100", "0.000001") into 6-decimal base units.
/// Throws on bad input or excess precision.
function parseUsdc(input: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(input)) {
    throw new Error(`invalid USDC amount: ${input}`);
  }
  const [whole, frac = ""] = input.split(".");
  if (frac.length > 6) {
    throw new Error(`USDC supports at most 6 decimal places (got ${frac.length})`);
  }
  const padded = (frac + "000000").slice(0, 6);
  return BigInt(whole!) * 1_000_000n + BigInt(padded || "0");
}

async function openClient(hostUrl: string): Promise<JindoClient> {
  const env = loadClient();
  return JindoClient.open({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    contract: env.contract,
    hostUrl,
    openCache: sqliteCacheFactory(env.cacheDir),
  });
}

const program = new Command();
program.name("jindo").description("Jindo storage CLI");

program
  .command("start")
  .description("run a storage host (Bun.serve)")
  .action(async () => {
    await startHost(loadHost());
  });

program
  .command("s3")
  .description("run an S3-compatible gateway backed by a jindo host")
  .action(async () => {
    await startS3(loadS3Gateway());
  });

program
  .command("upload")
  .description("upload one or more files to a host in a single batch")
  .argument("<files...>", "paths to one or more files")
  .requiredOption("--host <url>", "host URL")
  .action(async (paths: string[], opts: { host: string }) => {
    const files = await Promise.all(
      paths.map(async (p) => ({
        bytes: new Uint8Array(await Bun.file(p).arrayBuffer()),
        filename: p.split("/").pop() ?? p,
      })),
    );
    const jindo = await openClient(opts.host);
    const { fileRoots } = await jindo.upload(files);
    console.log(`uploaded ${fileRoots.length} file(s):`);
    for (let i = 0; i < fileRoots.length; i++) {
      console.log(`  ${paths[i]}  →  ${fileRoots[i]}`);
    }
  });

program
  .command("delete")
  .description("delete a file from a host")
  .argument("<fileRoot>", "0x-prefixed bytes32 file root")
  .requiredOption("--host <url>", "host URL")
  .action(async (fileRoot: string, opts: { host: string }) => {
    const jindo = await openClient(opts.host);
    const txHash = await jindo.delete(fileRoot as Hex);
    console.log(`deleted\n  txHash: ${txHash}`);
  });

program
  .command("list")
  .description("list locally cached files for a host")
  .requiredOption("--host <url>", "host URL")
  .action(async (opts: { host: string }) => {
    const jindo = await openClient(opts.host);
    const out = jindo.list();
    console.log(`host:   ${jindo.hostAddress}`);
    console.log(`client: ${jindo.clientAddress}`);
    console.log(`outer:  ${out.state.outerRoot}`);
    console.log(`size:   ${out.state.totalSize} bytes`);
    if (out.files.length === 0) {
      console.log("(no files)");
    } else {
      for (const f of out.files) {
        console.log(`  ${f.fileRoot}  ${f.sizeBytes}B  @${f.uploadedAt}`);
      }
    }
  });

program
  .command("recover")
  .description("rebuild local cache from a host (verified against on-chain root)")
  .requiredOption("--host <url>", "host URL")
  .action(async (opts: { host: string }) => {
    const jindo = await openClient(opts.host);
    const out = await jindo.recover();
    console.log(`recovered ${out.files.length} files\n  outer: ${out.outerRoot}`);
  });

program
  .command("deposit")
  .description("deposit USDC into the Jindo contract (auto-approves if needed)")
  .argument("<amount>", "USDC amount with up to 6 decimals (e.g. 1.5)")
  .action(async (amount: string) => {
    const baseAmount = parseUsdc(amount);
    const env = loadClient();
    const ctx = await buildChainContext({
      rpcUrl: env.rpcUrl,
      privateKey: env.privateKey,
      contract: env.contract,
    });

    console.log(`→ approving ${amount} USDC for ${ctx.contract}…`);
    const { approveHash, skipped } = await submitApproveUsdc(ctx, baseAmount);
    if (skipped) {
      console.log("  (allowance already sufficient, skipped)");
    } else {
      console.log(`  approve tx: ${approveHash}`);
      console.log("  approval mined");
    }

    console.log(`→ depositing ${amount} USDC…`);
    const depositHash = await ctx.walletClient.writeContract({
      account: ctx.walletClient.account!,
      chain: null,
      address: ctx.contract,
      abi: JINDO_ABI,
      functionName: "deposit",
      args: [baseAmount],
    });
    console.log(`  deposit tx: ${depositHash}`);
    await ctx.publicClient.waitForTransactionReceipt({ hash: depositHash });
    console.log(`  deposit mined — ${amount} USDC credited`);
  });

program
  .command("withdraw")
  .description("(host) claim earnings from every client we store data for")
  .action(async () => {
    const results = await withdrawAll(loadHost());
    const errors = results.filter((r) => r.status === "error");
    if (errors.length > 0) process.exitCode = 1;
  });

program
  .command("prove")
  .description("(host) respond to the current on-chain challenge for a client")
  .argument("<client>", "client address")
  .action(async (clientArg: string) => {
    const env = loadHost();
    const result = await prove(env, clientArg as Address);
    console.log(
      `proof committed\n  challengeIndex: ${result.challengeIndex}\n  fileRoot:       ${result.fileRoot}\n  chunkInFile:    ${result.chunkInFileIndex}\n  txHash:         ${result.txHash}`,
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
