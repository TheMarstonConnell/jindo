import { unlinkSync, existsSync } from "node:fs";
import { isAddress, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { recoverIntentSigner } from "../shared/eip712.ts";
import { fileRoot as computeFileRoot, outerRoot as computeOuterRoot } from "../shared/merkle.ts";
import {
  buildChainContext,
  readPair,
  submitCommitDelete,
  submitCommitUpload,
  type ChainContext,
} from "../shared/chain.ts";
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
import { proveOnce } from "./prove.ts";
import type { HostEnv } from "../node/env.ts";

const DEFAULT_PROVE_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const STARTUP_DELAY_MS = 30 * 1000; // wait 30s after startup before the first sweep

interface IntentBody {
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
): Promise<Response> {
  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "expected multipart/form-data");
  }
  const intentRaw = form.get("intent");
  const fileField = form.get("file");
  if (typeof intentRaw !== "string" || !(fileField instanceof Blob)) {
    return jsonError(400, "missing intent or file field");
  }

  let intent: IntentBody;
  try {
    intent = JSON.parse(intentRaw) as IntentBody;
  } catch {
    return jsonError(400, "intent is not valid JSON");
  }

  if (!isAddress(intent.client)) return jsonError(400, "intent.client invalid");
  const client = getAddress(intent.client);
  const newSize = BigInt(intent.newSize);

  const signer = await recoverIntentSigner(
    ctx.chainId,
    ctx.contract,
    "Upload",
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

    if (hasFile(hdb, client, intent.fileRoot)) {
      return jsonError(409, "file already in set", { currentRoot: state.outerRoot });
    }

    const bytes = new Uint8Array(await fileField.arrayBuffer());
    const computedFileRoot = computeFileRoot(bytes);
    if (computedFileRoot.toLowerCase() !== intent.fileRoot.toLowerCase()) {
      return jsonError(400, "fileRoot does not match uploaded bytes");
    }

    const expectedNewRoot = computeOuterRoot([
      ...listFiles(hdb, client),
      { fileRoot: computedFileRoot, sizeBytes: bytes.byteLength, uploadedAt: 0 },
    ]);
    if (expectedNewRoot.toLowerCase() !== intent.newRoot.toLowerCase()) {
      return jsonError(400, "newRoot does not match expected outer root");
    }

    const expectedNewSize = state.totalSize + BigInt(bytes.byteLength);
    if (expectedNewSize !== newSize) {
      return jsonError(400, "newSize does not match expected size", {
        expected: expectedNewSize.toString(),
      });
    }

    const blobPath = `${hdb.blobsDir}/${intent.fileRoot}`;
    const blobExistedBefore = existsSync(blobPath);

    let txHash: Hex;
    try {
      txHash = await submitCommitUpload(
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
      await Bun.write(blobPath, bytes);
      const tx = hdb.db.transaction(() => {
        insertFile(hdb, client, {
          fileRoot: intent.fileRoot,
          sizeBytes: bytes.byteLength,
          uploadedAt: Math.floor(Date.now() / 1000),
        });
        writeState(hdb, client, { outerRoot: intent.newRoot, totalSize: newSize }, txHash);
      });
      tx();
    } catch (e) {
      // Chain tx is committed but local persistence failed.
      // Only unlink the blob if we created it on this request — otherwise another
      // client still references it and we'd corrupt their state.
      try {
        if (!blobExistedBefore && existsSync(blobPath)) unlinkSync(blobPath);
      } catch {}
      return jsonError(500, "chain succeeded but local persistence failed", {
        detail: String(e),
        txHash,
      });
    }

    return withCors(Response.json({ txHash, outerRoot: intent.newRoot }));
  });
}

async function handleDelete(
  req: Request,
  ctx: ChainContext,
  hdb: HostDb,
): Promise<Response> {
  let intent: IntentBody;
  try {
    intent = (await req.json()) as IntentBody;
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
      console.error(
        `[prove-all] ${s.client}: failed —`,
        e instanceof Error ? e.message : String(e),
      );
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

  const corsPreflight = () => withCors(new Response(null, { status: 204 }));

  const server = Bun.serve({
    port: env.port,
    hostname: "0.0.0.0",
    routes: {
      "/health": {
        GET: () =>
          withCors(
            Response.json({ address: ctx.account, chainId: ctx.chainId, contract: ctx.contract }),
          ),
        OPTIONS: corsPreflight,
      },
      "/upload": { POST: (req) => handleUpload(req, ctx, hdb), OPTIONS: corsPreflight },
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
