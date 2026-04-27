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
  deleteFileRow,
  getStore,
  hasFile,
  insertFile,
  listClientSummaries,
  listFiles,
  readState,
  writeState,
  type ClientStore,
} from "./db.ts";
import type { HostEnv } from "../node/env.ts";

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

function jsonError(status: number, msg: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error: msg, ...extra }, { status });
}

async function ensurePairState(
  ctx: ChainContext,
  store: ClientStore,
  client: Address,
): Promise<{ outerRoot: Hex; totalSize: bigint }> {
  const local = readState(store);
  const onChain = await readPair(ctx, ctx.account, client);
  if (local.outerRoot.toLowerCase() !== onChain.outerRoot.toLowerCase()) {
    throw new Error(
      `host db out of sync with chain: local=${local.outerRoot} chain=${onChain.outerRoot}`,
    );
  }
  return { outerRoot: local.outerRoot, totalSize: local.totalSize };
}

async function handleUpload(req: Request, ctx: ChainContext, env: HostEnv): Promise<Response> {
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
    const store = getStore(env.dataDir, client);
    const state = await ensurePairState(ctx, store, client);

    if (state.outerRoot.toLowerCase() !== intent.priorRoot.toLowerCase()) {
      return jsonError(409, "priorRoot mismatch", { currentRoot: state.outerRoot });
    }

    if (hasFile(store, intent.fileRoot)) {
      return jsonError(409, "file already in set", { currentRoot: state.outerRoot });
    }

    const bytes = new Uint8Array(await fileField.arrayBuffer());
    const computedFileRoot = computeFileRoot(bytes);
    if (computedFileRoot.toLowerCase() !== intent.fileRoot.toLowerCase()) {
      return jsonError(400, "fileRoot does not match uploaded bytes");
    }

    const expectedNewRoot = computeOuterRoot([
      ...listFiles(store),
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

    const blobPath = `${store.blobsDir}/${intent.fileRoot}`;

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
      const tx = store.db.transaction(() => {
        insertFile(store, {
          fileRoot: intent.fileRoot,
          sizeBytes: bytes.byteLength,
          uploadedAt: Math.floor(Date.now() / 1000),
        });
        writeState(store, { outerRoot: intent.newRoot, totalSize: newSize }, txHash);
      });
      tx();
    } catch (e) {
      // Tx is on-chain but local persistence failed — try to roll back db then surface.
      try {
        if (existsSync(blobPath)) unlinkSync(blobPath);
      } catch {}
      return jsonError(500, "chain succeeded but local persistence failed", {
        detail: String(e),
        txHash,
      });
    }

    return Response.json({ txHash, outerRoot: intent.newRoot });
  });
}

async function handleDelete(req: Request, ctx: ChainContext, env: HostEnv): Promise<Response> {
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
    const store = getStore(env.dataDir, client);
    const state = await ensurePairState(ctx, store, client);

    if (state.outerRoot.toLowerCase() !== intent.priorRoot.toLowerCase()) {
      return jsonError(409, "priorRoot mismatch", { currentRoot: state.outerRoot });
    }
    if (!hasFile(store, intent.fileRoot)) {
      return jsonError(404, "unknown file_root");
    }

    const remaining = listFiles(store).filter(
      (f) => f.fileRoot.toLowerCase() !== intent.fileRoot.toLowerCase(),
    );
    const expectedNewRoot = computeOuterRoot(remaining);
    if (expectedNewRoot.toLowerCase() !== intent.newRoot.toLowerCase()) {
      return jsonError(400, "newRoot does not match expected outer root after deletion");
    }

    const blobPath = `${store.blobsDir}/${intent.fileRoot}`;
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
      const tx = store.db.transaction(() => {
        deleteFileRow(store, intent.fileRoot);
        writeState(store, { outerRoot: intent.newRoot, totalSize: newSize }, txHash);
      });
      tx();
      try {
        if (existsSync(blobPath)) unlinkSync(blobPath);
      } catch {}
    } catch (e) {
      return jsonError(500, "chain succeeded but local persistence failed", {
        detail: String(e),
        txHash,
      });
    }

    return Response.json({ txHash, outerRoot: intent.newRoot });
  });
}

function handleList(client: Address, env: HostEnv): Response {
  if (!isAddress(client)) return jsonError(400, "invalid client address");
  const checked = getAddress(client);
  const store = getStore(env.dataDir, checked);
  const state = readState(store);
  const files = listFiles(store);
  return Response.json({
    outerRoot: state.outerRoot,
    totalSize: state.totalSize.toString(),
    files,
  });
}

async function handleDownload(client: Address, fileRoot: Hex, env: HostEnv): Promise<Response> {
  if (!isAddress(client)) return jsonError(400, "invalid client address");
  const checked = getAddress(client);
  const store = getStore(env.dataDir, checked);
  if (!hasFile(store, fileRoot)) return jsonError(404, "not found");
  const file = Bun.file(`${store.blobsDir}/${fileRoot}`);
  if (!(await file.exists())) return jsonError(404, "not found");
  return new Response(file);
}

export async function startHost(env: HostEnv): Promise<{ stop: () => void; url: string }> {
  const ctx = await buildChainContext({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    contract: env.contract,
  });

  const server = Bun.serve({
    port: env.port,
    hostname: "0.0.0.0",
    routes: {
      "/health": () =>
        Response.json({ address: ctx.account, chainId: ctx.chainId, contract: ctx.contract }),
      "/upload": { POST: (req) => handleUpload(req, ctx, env) },
      "/delete": { POST: (req) => handleDelete(req, ctx, env) },
      "/clients": () =>
        Response.json({ host: ctx.account, clients: listClientSummaries(env.dataDir) }),
      "/list/:client": (req) => handleList(req.params.client as Address, env),
      "/download/:client/:fileRoot": (req) =>
        handleDownload(req.params.client as Address, req.params.fileRoot as Hex, env),
    },
    fetch: () => new Response("not found", { status: 404 }),
  });

  console.log(
    `jindo host listening on ${server.url} as ${ctx.account} (chain ${ctx.chainId}, contract ${ctx.contract})`,
  );

  return {
    stop: () => server.stop(true),
    url: server.url.toString(),
  };
}
