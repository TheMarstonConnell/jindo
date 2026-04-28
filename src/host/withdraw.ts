import type { Address, Hex } from "viem";
import {
  buildChainContext,
  readPair,
  submitClaimEarnings,
  type ChainContext,
} from "../shared/chain.ts";
import { listClientSummaries, openHostDb, type HostDb } from "./db.ts";
import type { HostEnv } from "../node/env.ts";

const ATTO_PER_BASE = 1_000_000_000_000n;

function shortAddr(a: Address): string {
  return `${a.slice(0, 6)}..${a.slice(-4)}`;
}

function fmtUsdc(atto: bigint): string {
  // atto-USDC → USD. atto / 1e12 = base USDC; base / 1e6 = USD.
  const base = atto / ATTO_PER_BASE;
  return `$${(Number(base) / 1e6).toFixed(6)}`;
}

export interface WithdrawResult {
  client: Address;
  status: "claimed" | "skipped" | "error";
  /// Atto-USDC pending on the pair before the call.
  accruedBeforeAtto: bigint;
  /// Atto-USDC pending on the pair after the call (sub-base dust on success).
  accruedAfterAtto: bigint;
  /// Base-USDC actually transferred to the host on success.
  claimedBaseAtto: bigint;
  txHash?: Hex;
  error?: string;
}

async function withdrawOne(
  ctx: ChainContext,
  client: Address,
): Promise<WithdrawResult> {
  const before = await readPair(ctx, ctx.account, client);
  const claimable = before.accrued / ATTO_PER_BASE;

  if (claimable === 0n) {
    return {
      client,
      status: "skipped",
      accruedBeforeAtto: before.accrued,
      accruedAfterAtto: before.accrued,
      claimedBaseAtto: 0n,
    };
  }

  const claimedAtto = claimable * ATTO_PER_BASE;
  const txHash = await submitClaimEarnings(ctx, client);
  const after = await readPair(ctx, ctx.account, client);
  return {
    client,
    status: "claimed",
    accruedBeforeAtto: before.accrued,
    accruedAfterAtto: after.accrued,
    claimedBaseAtto: claimedAtto,
    txHash,
  };
}

export async function withdrawAll(env: HostEnv): Promise<WithdrawResult[]> {
  const ctx = await buildChainContext({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    contract: env.contract,
  });
  const hdb: HostDb = openHostDb(env.dataDir);
  const summaries = listClientSummaries(hdb);

  console.log(
    `[withdraw] sweep starting for ${summaries.length} client(s) as host ${ctx.account}`,
  );

  const results: WithdrawResult[] = [];
  let totalClaimedAtto = 0n;
  let claimedCount = 0;
  let errorCount = 0;

  for (const s of summaries) {
    const tag = shortAddr(s.client);
    try {
      const r = await withdrawOne(ctx, s.client);
      results.push(r);
      if (r.status === "skipped") {
        console.log(
          `[withdraw] ${tag}: nothing to claim (accrued=${fmtUsdc(r.accruedBeforeAtto)} < 1 base unit) — skipping`,
        );
      } else {
        totalClaimedAtto += r.claimedBaseAtto;
        claimedCount += 1;
        console.log(
          `[withdraw] ${tag}: claimed ${fmtUsdc(r.claimedBaseAtto)} ` +
            `(accrued ${fmtUsdc(r.accruedBeforeAtto)} → ${fmtUsdc(r.accruedAfterAtto)}) tx=${r.txHash}`,
        );
      }
    } catch (e) {
      errorCount += 1;
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        client: s.client,
        status: "error",
        accruedBeforeAtto: 0n,
        accruedAfterAtto: 0n,
        claimedBaseAtto: 0n,
        error: msg,
      });
      console.error(`[withdraw] ${tag}: failed — ${msg}`);
    }
  }

  console.log(
    `[withdraw] sweep done: claimed ${fmtUsdc(totalClaimedAtto)} from ${claimedCount}/${summaries.length} client(s)` +
      (errorCount > 0 ? `, ${errorCount} error(s)` : ""),
  );

  return results;
}
