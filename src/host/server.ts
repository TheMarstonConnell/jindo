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

function explorerAddrUrl(chainId: number, addr: string): string | null {
  switch (chainId) {
    case 1: return `https://etherscan.io/address/${addr}`;
    case 11155111: return `https://sepolia.etherscan.io/address/${addr}`;
    case 8453: return `https://basescan.org/address/${addr}`;
    case 84532: return `https://sepolia.basescan.org/address/${addr}`;
    case 10: return `https://optimistic.etherscan.io/address/${addr}`;
    case 42161: return `https://arbiscan.io/address/${addr}`;
    default: return null;
  }
}

function fmtRateAsUsdPerGbMonth(rateBytePerDay: bigint): string {
  // atto/byte/day × 1 GiB × 30 / 1e18 = USD per GiB per month.
  const monthlyAttoPerGiB = rateBytePerDay * (1n << 30n) * 30n;
  const monthlyUsdMicro = Number(monthlyAttoPerGiB / 1_000_000_000_000n); // base USDC (6 decimals)
  return `$${(monthlyUsdMicro / 1e6).toFixed(4)}`;
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
  rateBytePerDay: bigint,
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
  const tag = shortAddr(client);

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
    console.log(`[upload] ${tag} signature mismatch — rejected (401)`);
    return jsonError(401, "signature does not match intent.client");
  }

  console.log(
    `[upload] ${tag} requested: fileRoot=${shortHex(intent.fileRoot)} newTotal=${fmtBytes(newSize)}`,
  );

  return withLock(client, async () => {
    const state = await ensurePairState(ctx, hdb, client);

    if (state.outerRoot.toLowerCase() !== intent.priorRoot.toLowerCase()) {
      console.log(`[upload] ${tag} priorRoot mismatch — rejected (409)`);
      return jsonError(409, "priorRoot mismatch", { currentRoot: state.outerRoot });
    }

    if (hasFile(hdb, client, intent.fileRoot)) {
      console.log(`[upload] ${tag} file already exists — rejected (409)`);
      return jsonError(409, "file already in set", { currentRoot: state.outerRoot });
    }

    const bytes = new Uint8Array(await fileField.arrayBuffer());
    const computedFileRoot = computeFileRoot(bytes);
    if (computedFileRoot.toLowerCase() !== intent.fileRoot.toLowerCase()) {
      console.log(`[upload] ${tag} fileRoot mismatch — rejected (400)`);
      return jsonError(400, "fileRoot does not match uploaded bytes");
    }

    const expectedNewRoot = computeOuterRoot([
      ...listFiles(hdb, client),
      { fileRoot: computedFileRoot, sizeBytes: bytes.byteLength, uploadedAt: 0 },
    ]);
    if (expectedNewRoot.toLowerCase() !== intent.newRoot.toLowerCase()) {
      console.log(`[upload] ${tag} newRoot mismatch — rejected (400)`);
      return jsonError(400, "newRoot does not match expected outer root");
    }

    const expectedNewSize = state.totalSize + BigInt(bytes.byteLength);
    if (expectedNewSize !== newSize) {
      console.log(
        `[upload] ${tag} newSize mismatch (got=${newSize} expected=${expectedNewSize}) — rejected (400)`,
      );
      return jsonError(400, "newSize does not match expected size", {
        expected: expectedNewSize.toString(),
      });
    }

    // Refuse the upload unless the client's on-contract balance can cover one
    // month of storage at the new total size. Computed in atto-USDC:
    //   required = newTotalSize × ratePerBytePerDay × 30
    // Note this is a snapshot check. The pool is global per-client across all
    // hosts, so other hosts could drain it later — but at this moment we know
    // the client put up a month's worth of skin in the game for our pair.
    const monthlyCostAtto = newSize * rateBytePerDay * DAYS_PER_MONTH;
    const clientBalanceAtto = await readClientBalance(ctx, client);
    const fileBytes = fmtBytes(bytes.byteLength);
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

    console.log(
      `[upload] ${tag} balance=${balanceFmt} required=${requiredFmt} (30d × ${totalBytes}) ` +
        `— allowed; committing ${fileBytes} (file=${shortHex(intent.fileRoot)})`,
    );

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
      console.error(`[upload] ${tag} chain submission failed:`, e);
      return jsonError(502, "chain submission failed", { detail: String(e) });
    }
    console.log(`[upload] ${tag} chain ok: tx=${txHash}`);

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
      `[upload] ${tag} stored ${fileBytes} (file=${shortHex(intent.fileRoot)}); pair total=${totalBytes}`,
    );
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

interface RootInfo {
  ctx: ChainContext;
  hdb: HostDb;
  rateBytePerDay: bigint;
  usdcAddress: Address;
  startedAt: number;
}

function handleRoot(info: RootInfo): Response {
  const { ctx, hdb, rateBytePerDay, usdcAddress, startedAt } = info;
  const summaries = listClientSummaries(hdb);
  const totalBytes = summaries.reduce((acc, s) => acc + BigInt(s.totalSize), 0n);
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);

  const explorerHost = explorerAddrUrl(ctx.chainId, ctx.account);
  const explorerContract = explorerAddrUrl(ctx.chainId, ctx.contract);
  const explorerUsdc = explorerAddrUrl(ctx.chainId, usdcAddress);
  const link = (url: string | null, text: string) =>
    url ? `<a href="${url}" target="_blank" rel="noreferrer">${text}</a>` : text;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>jindo host · ${chainName(ctx.chainId)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fef9c3; --panel: #fff; --ink: #000; --muted: #4a4a4a;
      font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); padding: 40px 24px;
      background-image: radial-gradient(rgba(0,0,0,0.07) 1px, transparent 1px);
      background-size: 18px 18px; }
    main { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
    h1 { margin: 0 0 4px; font-size: 56px; line-height: 0.95; letter-spacing: -0.03em;
      font-weight: 800; text-transform: lowercase; }
    p { margin: 0; }
    .panel { background: var(--panel); border: 3px solid var(--ink); border-radius: 6px;
      padding: 20px; box-shadow: 6px 6px 0 var(--ink); display: flex;
      flex-direction: column; gap: 12px; }
    .panel strong { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
    .kv { display: grid; grid-template-columns: max-content 1fr; column-gap: 16px;
      row-gap: 8px; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px; }
    .kv > .k { font-weight: 800; text-transform: uppercase; font-size: 11px;
      letter-spacing: 0.08em; align-self: center; }
    .kv > .v { word-break: break-all; }
    .muted { color: var(--muted); }
    a { color: inherit; }
    code { font-family: "JetBrains Mono", ui-monospace, monospace; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>jindo host</h1>
      <p class="muted">A node on the Jindo storage network. Drop a wallet at the demo
      and you can store files against this host.</p>
    </header>

    <section class="panel">
      <strong>Identity</strong>
      <div class="kv">
        <div class="k">host</div><div class="v">${link(explorerHost, `<code>${ctx.account}</code>`)}</div>
        <div class="k">chain</div><div class="v">${chainName(ctx.chainId)} <span class="muted">(${ctx.chainId})</span></div>
        <div class="k">contract</div><div class="v">${link(explorerContract, `<code>${ctx.contract}</code>`)}</div>
        <div class="k">USDC</div><div class="v">${link(explorerUsdc, `<code>${usdcAddress}</code>`)}</div>
      </div>
    </section>

    <section class="panel">
      <strong>Pricing</strong>
      <div class="kv">
        <div class="k">rate</div><div class="v">${fmtRateAsUsdPerGbMonth(rateBytePerDay)} / GB / month
          <span class="muted">(${rateBytePerDay} atto/byte/day)</span></div>
        <div class="k">cooldown</div><div class="v">1 paid proof per UTC day</div>
        <div class="k">reserve required</div><div class="v">balance ≥ size × rate × 30 to upload</div>
      </div>
    </section>

    <section class="panel">
      <strong>Status</strong>
      <div class="kv">
        <div class="k">clients</div><div class="v">${summaries.length}</div>
        <div class="k">total stored</div><div class="v">${fmtBytes(totalBytes)}
          <span class="muted">(${String(totalBytes)} B)</span></div>
        <div class="k">uptime</div><div class="v">${fmtUptime(uptimeSec)}</div>
      </div>
    </section>

    <section class="panel">
      <strong>Endpoints</strong>
      <div class="kv">
        <div class="k">GET /health</div><div class="v">JSON status</div>
        <div class="k">GET /clients</div><div class="v">all known clients on this host</div>
        <div class="k">GET /list/:client</div><div class="v">files for a client</div>
        <div class="k">GET /download/:fileRoot</div><div class="v">stream a blob</div>
        <div class="k">POST /upload</div><div class="v">multipart: signed intent + bytes</div>
        <div class="k">POST /delete</div><div class="v">JSON: signed delete intent</div>
      </div>
    </section>
  </main>
</body>
</html>`;

  return withCors(
    new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  );
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return `${d}d ${h}h`;
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
        GET: () => handleRoot({ ctx, hdb, rateBytePerDay, usdcAddress, startedAt }),
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
