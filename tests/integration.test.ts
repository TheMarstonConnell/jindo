import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess } from "bun";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { JINDO_ABI } from "../src/shared/abi.ts";
import bytecodeJson from "../contract/out/Jindo.sol/Jindo.json" with { type: "json" };
import { startHost } from "../src/host/server.ts";
import { JindoClient, fetchList } from "../src/lib/index.ts";
import { sqliteCacheFactory } from "../src/node/sqlite-cache.ts";
import { fileRoot as computeFileRoot, outerRoot as computeOuterRoot } from "../src/shared/merkle.ts";
import { ZERO_ROOT } from "../src/shared/types.ts";
import { prove } from "../src/host/prove.ts";

const ANVIL_PORT = 8546;
const HOST_PORT = 3456;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// anvil deterministic keys
const HOST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const CLIENT_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const HOST_ADDRESS = privateKeyToAccount(HOST_PRIVATE_KEY).address;
const CLIENT_ADDRESS = privateKeyToAccount(CLIENT_PRIVATE_KEY).address;

let anvil: Subprocess;
let contractAddress: Address;
let hostHandle: { stop: () => void; url: string };
let dataDir: string;
let cacheDir: string;
let publicClient: PublicClient;

async function waitForRpc(url: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil did not start on ${url}`);
}

beforeAll(async () => {
  anvil = Bun.spawn(["anvil", "--port", String(ANVIL_PORT), "--silent"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForRpc(RPC_URL);

  const transport = http(RPC_URL);
  publicClient = createPublicClient({ transport }) as PublicClient;
  const deployer = createWalletClient({ account: privateKeyToAccount(HOST_PRIVATE_KEY), transport });
  const bytecode = (bytecodeJson as { bytecode: { object: string } }).bytecode.object as Hex;

  const deployHash = await deployer.deployContract({ abi: JINDO_ABI, bytecode, chain: null });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (!receipt.contractAddress) throw new Error("no contract address");
  contractAddress = receipt.contractAddress;

  dataDir = mkdtempSync(join(tmpdir(), "jindo-host-"));
  cacheDir = mkdtempSync(join(tmpdir(), "jindo-cache-"));

  hostHandle = await startHost({
    privateKey: HOST_PRIVATE_KEY,
    rpcUrl: RPC_URL,
    contract: contractAddress,
    account: HOST_ADDRESS,
    port: HOST_PORT,
    dataDir,
  });
});

afterAll(() => {
  hostHandle?.stop();
  anvil?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

function openClient(hostUrl: string, overrideCacheDir?: string): Promise<JindoClient> {
  return JindoClient.open({
    rpcUrl: RPC_URL,
    privateKey: CLIENT_PRIVATE_KEY,
    contract: contractAddress,
    hostUrl,
    openCache: sqliteCacheFactory(overrideCacheDir ?? cacheDir),
  });
}

async function readPairOnChain() {
  const key = (await publicClient.readContract({
    address: contractAddress,
    abi: JINDO_ABI,
    functionName: "key",
    args: [HOST_ADDRESS, CLIENT_ADDRESS],
  })) as Hex;
  const [host, size, client, challengeIndex, root] = (await publicClient.readContract({
    address: contractAddress,
    abi: JINDO_ABI,
    functionName: "contracts",
    args: [key],
  })) as readonly [Address, bigint, Address, bigint, Hex];
  return { host, size, client, challengeIndex, root };
}

test("upload → list → delete → recover roundtrip", async () => {
  const hostUrl = `http://127.0.0.1:${HOST_PORT}`;
  const jindo = await openClient(hostUrl);

  // ── 1. upload first file ─────────────────────────────────────────
  const bytes1 = new Uint8Array(8192);
  for (let i = 0; i < bytes1.length; i++) bytes1[i] = i % 251;

  const fileRoot1 = await jindo.upload(bytes1);
  expect(fileRoot1).toBe(computeFileRoot(bytes1));

  let onChain = await readPairOnChain();
  expect(onChain.host).toBe(HOST_ADDRESS);
  expect(onChain.client).toBe(CLIENT_ADDRESS);
  const expectedRootAfter1 = computeOuterRoot([
    { fileRoot: fileRoot1, sizeBytes: bytes1.byteLength, uploadedAt: 0 },
  ]);
  expect(onChain.root.toLowerCase()).toBe(expectedRootAfter1.toLowerCase());
  expect(onChain.size).toBe(BigInt(bytes1.byteLength));

  // ── 2. upload second file ────────────────────────────────────────
  const bytes2 = new Uint8Array(1024);
  for (let i = 0; i < bytes2.length; i++) bytes2[i] = (i * 7) % 251;

  const fileRoot2 = await jindo.upload(bytes2);
  expect(fileRoot2).toBe(computeFileRoot(bytes2));
  expect(fileRoot2).not.toBe(fileRoot1);

  onChain = await readPairOnChain();
  expect(onChain.size).toBe(BigInt(bytes1.byteLength + bytes2.byteLength));
  const rootAfterTwo = onChain.root;
  expect(rootAfterTwo.toLowerCase()).not.toBe(ZERO_ROOT);

  // ── 3. /list reflects both files ─────────────────────────────────
  const listed = await fetchList(hostUrl, CLIENT_ADDRESS);
  expect(listed.outerRoot.toLowerCase()).toBe(rootAfterTwo.toLowerCase());
  expect(listed.totalSize).toBe(String(bytes1.byteLength + bytes2.byteLength));
  const roots = listed.files.map((f) => f.fileRoot.toLowerCase()).sort();
  expect(roots).toEqual([fileRoot1.toLowerCase(), fileRoot2.toLowerCase()].sort());

  // ── 4. recover into a fresh cache and verify the result matches ──
  const freshCacheDir = mkdtempSync(join(tmpdir(), "jindo-recover-"));
  try {
    const fresh = await openClient(hostUrl, freshCacheDir);
    const recovered = await fresh.recover();
    expect(recovered.outerRoot.toLowerCase()).toBe(rootAfterTwo.toLowerCase());
    expect(recovered.files.length).toBe(2);
  } finally {
    rmSync(freshCacheDir, { recursive: true, force: true });
  }

  // ── 5. delete one file ───────────────────────────────────────────
  await jindo.delete(fileRoot1);

  onChain = await readPairOnChain();
  expect(onChain.size).toBe(BigInt(bytes2.byteLength));
  const expectedRootAfterDelete = computeOuterRoot([
    { fileRoot: fileRoot2, sizeBytes: bytes2.byteLength, uploadedAt: 0 },
  ]);
  expect(onChain.root.toLowerCase()).toBe(expectedRootAfterDelete.toLowerCase());

  const listedAfter = await fetchList(hostUrl, CLIENT_ADDRESS);
  expect(listedAfter.files.length).toBe(1);
  expect(listedAfter.files[0]!.fileRoot.toLowerCase()).toBe(fileRoot2.toLowerCase());

  // ── 6. download is public ────────────────────────────────────────
  const dl = await fetch(`${hostUrl}/download/${fileRoot2}`);
  expect(dl.status).toBe(200);
  const dlBytes = new Uint8Array(await dl.arrayBuffer());
  expect(dlBytes.byteLength).toBe(bytes2.byteLength);
}, 30000);

test("host rejects upload when signature client does not match recovered signer", async () => {
  // Forge a request: claim to be CLIENT_ADDRESS but sign with a different key.
  const otherKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
  const otherAccount = privateKeyToAccount(otherKey);

  // Build a minimal valid-looking intent and sign with the wrong key
  const { buildDomain, TYPES } = await import("../src/shared/eip712.ts");
  const payload = new Uint8Array([1, 2, 3]);
  const fileRoot = computeFileRoot(payload);
  const newRoot = computeOuterRoot([{ fileRoot, sizeBytes: payload.byteLength, uploadedAt: 0 }]);
  const message = {
    host: HOST_ADDRESS,
    client: CLIENT_ADDRESS, // claim to be the legitimate client
    fileRoot,
    priorRoot: ZERO_ROOT,
    newRoot,
    newSize: 3n,
  };
  const chainId = await publicClient.getChainId();
  const signature = await otherAccount.signTypedData({
    domain: buildDomain(chainId, contractAddress),
    types: TYPES,
    primaryType: "Upload",
    message,
  });

  const form = new FormData();
  form.append(
    "intent",
    JSON.stringify({
      client: CLIENT_ADDRESS,
      fileRoot,
      priorRoot: ZERO_ROOT,
      newRoot,
      newSize: "3",
      signature,
    }),
  );
  form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "x");

  const res = await fetch(`http://127.0.0.1:${HOST_PORT}/upload`, { method: "POST", body: form });
  expect(res.status).toBe(401);
}, 15000);

test("host can answer the on-chain challenge with a valid proof", async () => {
  const hostUrl = `http://127.0.0.1:${HOST_PORT}`;

  // Use a fresh client identity so we start from an empty pair on this host.
  const proofClientPk = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
  const proofClient = privateKeyToAccount(proofClientPk).address;
  const proofCacheDir = mkdtempSync(join(tmpdir(), "jindo-proof-"));

  const fresh = await JindoClient.open({
    rpcUrl: RPC_URL,
    privateKey: proofClientPk,
    contract: contractAddress,
    hostUrl,
    openCache: sqliteCacheFactory(proofCacheDir),
  });

  // Two files: a 4 KiB and a 2 KiB blob → 6 chunks total. Plenty of selection space.
  const a = new Uint8Array(4096);
  for (let i = 0; i < a.length; i++) a[i] = (i * 13) & 0xff;
  const b = new Uint8Array(2048);
  for (let i = 0; i < b.length; i++) b[i] = (i * 29 + 7) & 0xff;

  await fresh.upload(a);
  await fresh.upload(b);

  // Read the on-chain pair and confirm a challenge has been set.
  const pairKey = (await publicClient.readContract({
    address: contractAddress,
    abi: JINDO_ABI,
    functionName: "key",
    args: [HOST_ADDRESS, proofClient],
  })) as Hex;
  const [, sizeBefore, , challengeBefore] = (await publicClient.readContract({
    address: contractAddress,
    abi: JINDO_ABI,
    functionName: "contracts",
    args: [pairKey],
  })) as readonly [Address, bigint, Address, bigint, Hex];
  const blockBeforeProof = await publicClient.getBlockNumber();
  expect(sizeBefore).toBe(BigInt(a.byteLength + b.byteLength));
  // 6 chunks → challengeIndex in [0, 6)
  expect(challengeBefore < 6n).toBe(true);

  // Now have the host respond.
  const result = await prove(
    {
      privateKey: HOST_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      contract: contractAddress,
      account: HOST_ADDRESS,
      port: HOST_PORT,
      dataDir,
    },
    proofClient,
  );
  expect(result.challengeIndex).toBe(challengeBefore);

  // Challenge rotated: a new block was mined for the proof tx.
  const blockAfterProof = await publicClient.getBlockNumber();
  expect(blockAfterProof > blockBeforeProof).toBe(true);

  rmSync(proofCacheDir, { recursive: true, force: true });
}, 30000);
