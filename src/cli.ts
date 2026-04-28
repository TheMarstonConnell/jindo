#!/usr/bin/env bun
import { Command } from "commander";
import type { Address, Hex } from "viem";
import { JindoClient } from "./lib/index.ts";
import { startHost } from "./host/server.ts";
import { prove } from "./host/prove.ts";
import { withdrawAll } from "./host/withdraw.ts";
import { loadClient, loadHost } from "./node/env.ts";
import { sqliteCacheFactory } from "./node/sqlite-cache.ts";

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
  .command("upload")
  .description("upload a file to a host")
  .argument("<file>", "path to file")
  .requiredOption("--host <url>", "host URL")
  .action(async (file: string, opts: { host: string }) => {
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const jindo = await openClient(opts.host);
    const fileRoot = await jindo.upload(bytes);
    console.log(`uploaded\n  fileRoot: ${fileRoot}`);
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
