import { unlinkSync, existsSync } from "node:fs";
import { isAddress, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { recoverIntentSigner } from "../shared/eip712.ts";
import { fileRoot as computeFileRoot, outerRoot as computeOuterRoot } from "../shared/merkle.ts";
import {
  buildChainContext,
  readClientBalance,
  readPair,
  readRateBytePerDay,
  readUsdcAddress,
  submitCommitDelete,
  submitCommitUpload,
  type ChainContext,
} from "../shared/chain.ts";

const DAYS_PER_MONTH = 30n;

// ── log helpers ──────────────────────────────────────────────────────────────

function shortAddr(a: Address): string {
  return `${a.slice(0, 6)}..${a.slice(-4)}`;
}

function shortHex(h: Hex): string {
  return `${h.slice(0, 10)}..${h.slice(-4)}`;
}

function fmtUsdc(atto: bigint): string {
  // atto-USDC → dollars. atto / 10^12 = base USDC; base / 10^6 = USD.
  const base = atto / 1_000_000_000_000n;
  return `$${(Number(base) / 1e6).toFixed(6)}`;
}

function fmtBytes(n: bigint | number): string {
  const v = typeof n === "bigint" ? Number(n) : n;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function chainName(chainId: number): string {
  switch (chainId) {
    case 1: return "Ethereum";
    case 11155111: return "Sepolia";
    case 8453: return "Base";
    case 84532: return "Base Sepolia";
    case 10: return "Optimism";
    case 42161: return "Arbitrum One";
    case 137: return "Polygon";
    default: return `chain ${chainId}`;
  }
}

import {
  blobIsLive,
  deleteFileRow,
  fileRootRefCount,
  hasFile,
  insertFile,
  listClientSummaries,
  listFiles,
  openHostDb,
  readState,
  writeState,
  type HostDb,
} from "./db.ts";
import { proveOnce, ProofCooldownActive } from "./prove.ts";
import type { HostEnv } from "../node/env.ts";

const DEFAULT_PROVE_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const STARTUP_DELAY_MS = 30 * 1000; // wait 30s after startup before the first sweep

interface UploadIntentBody {
  client: Address;
  fileRoots: Hex[];
  priorRoot: Hex;
  newRoot: Hex;
  newSize: string;
  signature: Hex;
}

interface DeleteIntentBody {
  client: Address;
  fileRoot: Hex;
  priorRoot: Hex;
  newRoot: Hex;
  newSize: string;
  signature: Hex;
}

const locks = new Map<Address, Promise<unknown>>();
function withLock<T>(client: Address, fn: () => Promise<T>): Promise<T> {
  const key = client.toLowerCase() as Address;
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next as Promise<T>;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function jsonError(status: number, msg: string, extra: Record<string, unknown> = {}) {
  return withCors(Response.json({ error: msg, ...extra }, { status }));
}

async function ensurePairState(
  ctx: ChainContext,
  hdb: HostDb,
  client: Address,
): Promise<{ outerRoot: Hex; totalSize: bigint }> {
  const local = readState(hdb, client);
  const onChain = await readPair(ctx, ctx.account, client);
  if (local.outerRoot.toLowerCase() !== onChain.outerRoot.toLowerCase()) {
    throw new Error(
      `host db out of sync with chain: local=${local.outerRoot} chain=${onChain.outerRoot}`,
    );
  }
  return { outerRoot: local.outerRoot, totalSize: local.totalSize };
}

async function handleUpload(
  req: Request,
  ctx: ChainContext,
  hdb: HostDb,
  rateBytePerDay: bigint,
): Promise<Response> {
  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "expected multipart/form-data");
  }
  const intentRaw = form.get("intent");
  // Files arrive as File objects (Blob is the runtime type, FormDataEntryValue
  // is the spec'd union). Either way arrayBuffer() works.
  const fileFields = form.getAll("file").filter(
    (f): f is File => f instanceof Blob,
  );
  if (typeof intentRaw !== "string" || fileFields.length === 0) {
    return jsonError(400, "missing intent or file field");
  }

  let intent: UploadIntentBody;
  try {
    intent = JSON.parse(intentRaw) as UploadIntentBody;
  } catch {
    return jsonError(400, "intent is not valid JSON");
  }

  if (!isAddress(intent.client)) return jsonError(400, "intent.client invalid");
  if (!Array.isArray(intent.fileRoots) || intent.fileRoots.length === 0) {
    return jsonError(400, "intent.fileRoots must be a non-empty array");
  }
  if (intent.fileRoots.length !== fileFields.length) {
    return jsonError(400, "intent.fileRoots length does not match uploaded file count", {
      expected: intent.fileRoots.length,
      received: fileFields.length,
    });
  }

  const client = getAddress(intent.client);
  const newSize = BigInt(intent.newSize);
  const tag = shortAddr(client);

  const signer = await recoverIntentSigner(
    ctx.chainId,
    ctx.contract,
    "Upload",
    {
      host: ctx.account,
      client,
      fileRoots: intent.fileRoots,
      priorRoot: intent.priorRoot,
      newRoot: intent.newRoot,
      newSize,
    },
    intent.signature,
  );
  if (signer.toLowerCase() !== client.toLowerCase()) {
    console.log(`[upload] ${tag} signature mismatch — rejected (401)`);
    return jsonError(401, "signature does not match intent.client");
  }

  console.log(
    `[upload] ${tag} requested: ${intent.fileRoots.length} file(s) newTotal=${fmtBytes(newSize)}`,
  );

  return withLock(client, async () => {
    const state = await ensurePairState(ctx, hdb, client);

    if (state.outerRoot.toLowerCase() !== intent.priorRoot.toLowerCase()) {
      console.log(`[upload] ${tag} priorRoot mismatch — rejected (409)`);
      return jsonError(409, "priorRoot mismatch", { currentRoot: state.outerRoot });
    }

    // Read every uploaded blob into memory and validate each against its claimed fileRoot.
    const blobs: Uint8Array[] = [];
    for (let i = 0; i < fileFields.length; i++) {
      const bytes = new Uint8Array(await fileFields[i]!.arrayBuffer());
      const claimed = intent.fileRoots[i]!;
      const computed = computeFileRoot(bytes);
      if (computed.toLowerCase() !== claimed.toLowerCase()) {
        console.log(
          `[upload] ${tag} fileRoot mismatch at index ${i} (got ${shortHex(computed)} expected ${shortHex(claimed)}) — rejected (400)`,
        );
        return jsonError(400, "fileRoot does not match uploaded bytes", { index: i });
      }
      if (hasFile(hdb, client, claimed)) {
        console.log(
          `[upload] ${tag} duplicate fileRoot at index ${i} (${shortHex(claimed)}) — rejected (409)`,
        );
        return jsonError(409, "file already in set", {
          fileRoot: claimed,
          currentRoot: state.outerRoot,
        });
      }
      // also reject duplicates within the batch itself
      for (let j = 0; j < i; j++) {
        if (intent.fileRoots[j]!.toLowerCase() === claimed.toLowerCase()) {
          return jsonError(400, "duplicate fileRoot within batch", { fileRoot: claimed });
        }
      }
      blobs.push(bytes);
    }

    const newRecords = blobs.map((bytes, i) => ({
      fileRoot: intent.fileRoots[i]!,
      sizeBytes: bytes.byteLength,
      uploadedAt: 0,
    }));

    const expectedNewRoot = computeOuterRoot([...listFiles(hdb, client), ...newRecords]);
    if (expectedNewRoot.toLowerCase() !== intent.newRoot.toLowerCase()) {
      console.log(`[upload] ${tag} newRoot mismatch — rejected (400)`);
      return jsonError(400, "newRoot does not match expected outer root");
    }

    const totalNewBytes = blobs.reduce((acc, b) => acc + BigInt(b.byteLength), 0n);
    const expectedNewSize = state.totalSize + totalNewBytes;
    if (expectedNewSize !== newSize) {
      console.log(
        `[upload] ${tag} newSize mismatch (got=${newSize} expected=${expectedNewSize}) — rejected (400)`,
      );
      return jsonError(400, "newSize does not match expected size", {
        expected: expectedNewSize.toString(),
      });
    }

    // Refuse the upload unless the client's on-contract balance can cover one
    // month of storage at the new total size.
    const monthlyCostAtto = newSize * rateBytePerDay * DAYS_PER_MONTH;
    const clientBalanceAtto = await readClientBalance(ctx, client);
    const totalBytes = fmtBytes(newSize);
    const balanceFmt = fmtUsdc(clientBalanceAtto);
    const requiredFmt = fmtUsdc(monthlyCostAtto);

    if (clientBalanceAtto < monthlyCostAtto) {
      const shortAtto = monthlyCostAtto - clientBalanceAtto;
      console.log(
        `[upload] ${tag} balance=${balanceFmt} required=${requiredFmt} (30d × ${totalBytes}) ` +
          `short ${fmtUsdc(shortAtto)} — REJECTED (402)`,
      );
      return jsonError(402, "client balance insufficient for one month of storage", {
        requiredAtto: monthlyCostAtto.toString(),
        availableAtto: clientBalanceAtto.toString(),
        newTotalBytes: newSize.toString(),
      });
    }

    const batchBytes = fmtBytes(totalNewBytes);
    console.log(
      `[upload] ${tag} balance=${balanceFmt} required=${requiredFmt} (30d × ${totalBytes}) ` +
        `— allowed; committing ${blobs.length} file(s) totaling ${batchBytes}`,
    );

    // Track which blobs we actually wrote so we can undo only those if persist fails.
    const blobPaths = intent.fileRoots.map((root) => `${hdb.blobsDir}/${root}`);
    const blobExistedBefore = blobPaths.map((p) => existsSync(p));

    let txHash: Hex;
    try {
      txHash = await submitCommitUpload(
        ctx,
        client,
        intent.fileRoots,
        intent.priorRoot,
        intent.newRoot,
        newSize,
        intent.signature,
      );
    } catch (e) {
      console.error(`[upload] ${tag} chain submission failed:`, e);
      return jsonError(502, "chain submission failed", { detail: String(e) });
    }
    console.log(`[upload] ${tag} chain ok: tx=${txHash}`);

    try {
      // Write every blob first; only commit the DB once all bytes are durable.
      for (let i = 0; i < blobs.length; i++) {
        await Bun.write(blobPaths[i]!, blobs[i]!);
      }
      const now = Math.floor(Date.now() / 1000);
      const tx = hdb.db.transaction(() => {
        for (let i = 0; i < intent.fileRoots.length; i++) {
          insertFile(hdb, client, {
            fileRoot: intent.fileRoots[i]!,
            sizeBytes: blobs[i]!.byteLength,
            uploadedAt: now,
          });
        }
        writeState(hdb, client, { outerRoot: intent.newRoot, totalSize: newSize }, txHash);
      });
      tx();
    } catch (e) {
      // Chain tx is committed but local persistence failed.
      // Only unlink blobs we created in this request — earlier-existing blobs
      // are still referenced by other clients.
      for (let i = 0; i < blobPaths.length; i++) {
        try {
          if (!blobExistedBefore[i] && existsSync(blobPaths[i]!)) unlinkSync(blobPaths[i]!);
        } catch {}
      }
      console.error(
        `[upload] ${tag} local persist FAILED after chain tx ${txHash}:`,
        e,
      );
      return jsonError(500, "chain succeeded but local persistence failed", {
        detail: String(e),
        txHash,
      });
    }

    console.log(
      `[upload] ${tag} stored ${blobs.length} file(s) totaling ${batchBytes}; pair total=${totalBytes}`,
    );
    return withCors(
      Response.json({ txHash, outerRoot: intent.newRoot, fileRoots: intent.fileRoots }),
    );
  });
}

async function handleDelete(
  req: Request,
  ctx: ChainContext,
  hdb: HostDb,
): Promise<Response> {
  let intent: DeleteIntentBody;
  try {
    intent = (await req.json()) as DeleteIntentBody;
  } catch {
    return jsonError(400, "expected JSON body");
  }

  if (!isAddress(intent.client)) return jsonError(400, "intent.client invalid");
  const client = getAddress(intent.client);
  const newSize = BigInt(intent.newSize);

  const signer = await recoverIntentSigner(
    ctx.chainId,
    ctx.contract,
    "Delete",
    {
      host: ctx.account,
      client,
      fileRoot: intent.fileRoot,
      priorRoot: intent.priorRoot,
      newRoot: intent.newRoot,
      newSize,
    },
    intent.signature,
  );
  if (signer.toLowerCase() !== client.toLowerCase()) {
    return jsonError(401, "signature does not match intent.client");
  }

  return withLock(client, async () => {
    const state = await ensurePairState(ctx, hdb, client);

    if (state.outerRoot.toLowerCase() !== intent.priorRoot.toLowerCase()) {
      return jsonError(409, "priorRoot mismatch", { currentRoot: state.outerRoot });
    }
    if (!hasFile(hdb, client, intent.fileRoot)) {
      return jsonError(404, "unknown file_root");
    }

    const remaining = listFiles(hdb, client).filter(
      (f) => f.fileRoot.toLowerCase() !== intent.fileRoot.toLowerCase(),
    );
    const expectedNewRoot = computeOuterRoot(remaining);
    if (expectedNewRoot.toLowerCase() !== intent.newRoot.toLowerCase()) {
      return jsonError(400, "newRoot does not match expected outer root after deletion");
    }

    const blobPath = `${hdb.blobsDir}/${intent.fileRoot}`;
    let removedSize: number;
    try {
      removedSize = Bun.file(blobPath).size;
    } catch {
      return jsonError(500, "blob missing on disk");
    }
    const expectedNewSize = state.totalSize - BigInt(removedSize);
    if (expectedNewSize !== newSize) {
      return jsonError(400, "newSize does not match", { expected: expectedNewSize.toString() });
    }

    let txHash: Hex;
    try {
      txHash = await submitCommitDelete(
        ctx,
        client,
        intent.fileRoot,
        intent.priorRoot,
        intent.newRoot,
        newSize,
        intent.signature,
      );
    } catch (e) {
      return jsonError(502, "chain submission failed", { detail: String(e) });
    }

    try {
      const tx = hdb.db.transaction(() => {
        deleteFileRow(hdb, client, intent.fileRoot);
        writeState(hdb, client, { outerRoot: intent.newRoot, totalSize: newSize }, txHash);
      });
      tx();
      // Refcounted blob removal: only unlink when no other client still references this fileRoot.
      try {
        if (fileRootRefCount(hdb, intent.fileRoot) === 0 && existsSync(blobPath)) {
          unlinkSync(blobPath);
        }
      } catch {}
    } catch (e) {
      return jsonError(500, "chain succeeded but local persistence failed", {
        detail: String(e),
        txHash,
      });
    }

    return withCors(Response.json({ txHash, outerRoot: intent.newRoot }));
  });
}

function handleList(client: Address, hdb: HostDb): Response {
  if (!isAddress(client)) return jsonError(400, "invalid client address");
  const checked = getAddress(client);
  const state = readState(hdb, checked);
  const files = listFiles(hdb, checked);
  return withCors(Response.json({
    outerRoot: state.outerRoot,
    totalSize: state.totalSize.toString(),
    files,
  }));
}

async function handleDownload(fileRoot: Hex, hdb: HostDb): Promise<Response> {
  // Only serve blobs that are currently referenced by some client.
  // A file deleted by every client has its blob removed; this guards against
  // someone hitting a stale fileRoot URL after deletion.
  if (!blobIsLive(hdb, fileRoot)) return jsonError(404, "not found");
  const file = Bun.file(`${hdb.blobsDir}/${fileRoot}`);
  if (!(await file.exists())) return jsonError(404, "not found");
  return withCors(new Response(file));
}

interface RootInfo {
  ctx: ChainContext;
  hdb: HostDb;
  usdcAddress: Address;
  startedAt: number;
}

function handleRoot(info: RootInfo): Response {
  const { ctx, hdb, usdcAddress, startedAt } = info;
  const summaries = listClientSummaries(hdb);
  const totalBytes = summaries.reduce((acc, s) => acc + BigInt(s.totalSize), 0n);
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);

  const body = {
    host: ctx.account,
    chain: { id: ctx.chainId, name: chainName(ctx.chainId) },
    contract: ctx.contract,
    usdc: usdcAddress,
    status: {
      clients: summaries.length,
      totalBytes: totalBytes.toString(),
      totalBytesHuman: fmtBytes(totalBytes),
      uptimeSeconds: uptimeSec,
    },
    endpoints: {
      "GET /health": "JSON status",
      "GET /clients": "all known clients on this host",
      "GET /list/:client": "files for a client",
      "GET /download/:fileRoot": "stream a blob",
      "POST /upload": "multipart: signed intent + bytes",
      "POST /delete": "JSON: signed delete intent",
    },
  };

  return withCors(Response.json(body));
}

async function proveAllClients(ctx: ChainContext, hdb: HostDb, env: HostEnv): Promise<void> {
  const summaries = listClientSummaries(hdb);
  console.log(`[prove-all] sweep starting for ${summaries.length} client(s)`);
  for (const s of summaries) {
    if (s.totalSize === "0") {
      console.log(`[prove-all] ${s.client}: empty, skipping`);
      continue;
    }
    try {
      const result = await withLock(s.client, () => proveOnce(ctx, hdb, env, s.client));
      console.log(
        `[prove-all] ${s.client}: ok challengeIndex=${result.challengeIndex} fileRoot=${result.fileRoot} tx=${result.txHash}`,
      );
    } catch (e) {
      if (e instanceof ProofCooldownActive) {
        console.log(`[prove-all] ${s.client}: cooldown — already proved this UTC day, skipping`);
      } else {
        console.error(
          `[prove-all] ${s.client}: failed —`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }
  console.log(`[prove-all] sweep done`);
}

export async function startHost(env: HostEnv): Promise<{ stop: () => void; url: string }> {
  const ctx = await buildChainContext({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    contract: env.contract,
  });

  const hdb = openHostDb(env.dataDir);

  // Cache the contract's RATE_BYTE_DAY constant and USDC address. Both are
  // immutable for the lifetime of a deployment so reading once at startup
  // saves an RPC call per uploaded file / `/` request.
  const rateBytePerDay = await readRateBytePerDay(ctx);
  const usdcAddress = await readUsdcAddress(ctx);
  const startedAt = Date.now();

  const corsPreflight = () => withCors(new Response(null, { status: 204 }));

  const server = Bun.serve({
    port: env.port,
    hostname: "0.0.0.0",
    routes: {
      "/": {
        GET: () => handleRoot({ ctx, hdb, usdcAddress, startedAt }),
        OPTIONS: corsPreflight,
      },
      "/health": {
        GET: () =>
          withCors(
            Response.json({ address: ctx.account, chainId: ctx.chainId, contract: ctx.contract }),
          ),
        OPTIONS: corsPreflight,
      },
      "/upload": {
        POST: (req) => handleUpload(req, ctx, hdb, rateBytePerDay),
        OPTIONS: corsPreflight,
      },
      "/delete": { POST: (req) => handleDelete(req, ctx, hdb), OPTIONS: corsPreflight },
      "/clients": {
        GET: () =>
          withCors(
            Response.json({ host: ctx.account, clients: listClientSummaries(hdb) }),
          ),
        OPTIONS: corsPreflight,
      },
      "/list/:client": {
        GET: (req) => handleList(req.params.client as Address, hdb),
        OPTIONS: corsPreflight,
      },
      "/download/:fileRoot": {
        GET: (req) => handleDownload(req.params.fileRoot as Hex, hdb),
        OPTIONS: corsPreflight,
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });

  console.log(
    `jindo host listening on ${server.url} as ${ctx.account} (chain ${ctx.chainId}, contract ${ctx.contract})`,
  );

  const intervalMs = Number(process.env.JINDO_PROVE_INTERVAL_MS ?? DEFAULT_PROVE_INTERVAL_MS);
  let proveTimer: Timer | null = null;
  let proveInflight = false;
  const runProveAll = async () => {
    if (proveInflight) {
      console.log("[prove-all] previous sweep still running, skipping this tick");
      return;
    }
    proveInflight = true;
    try {
      await proveAllClients(ctx, hdb, env);
    } catch (e) {
      console.error("[prove-all] sweep crashed:", e);
    } finally {
      proveInflight = false;
    }
  };

  if (intervalMs > 0) {
    console.log(
      `[prove-all] scheduled every ${intervalMs}ms (first sweep in ${STARTUP_DELAY_MS}ms)`,
    );
    setTimeout(() => {
      void runProveAll();
      proveTimer = setInterval(() => void runProveAll(), intervalMs);
    }, STARTUP_DELAY_MS);
  } else {
    console.log("[prove-all] disabled (JINDO_PROVE_INTERVAL_MS=0)");
  }

  return {
    stop: () => {
      if (proveTimer) clearInterval(proveTimer);
      server.stop(true);
    },
    url: server.url.toString(),
  };
}
