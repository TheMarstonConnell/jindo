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
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { JINDO_ABI } from "../src/shared/abi.ts";
import bytecodeJson from "../contract/out/Jindo.sol/Jindo.json" with { type: "json" };
import mockUsdcJson from "../contract/out/Jindo.t.sol/MockUSDC.json" with { type: "json" };
import { startHost } from "../src/host/server.ts";
import { startS3 } from "../src/s3/index.ts";

const MOCK_USDC_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const ANVIL_PORT = 8547;
const HOST_PORT = 3457;
const S3_PORT = 3458;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// anvil deterministic keys
const HOST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const S3_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const HOST_ADDRESS = privateKeyToAccount(HOST_PRIVATE_KEY).address;
const S3_ADDRESS = privateKeyToAccount(S3_PRIVATE_KEY).address;

let anvil: Subprocess;
let contractAddress: Address;
let hostHandle: { stop: () => void; url: string };
let s3Handle: Awaited<ReturnType<typeof startS3>>;
let dataDir: string;
let s3DataDir: string;
let s3CacheDir: string;
let s3: S3Client;

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
  const publicClient = createPublicClient({ transport }) as PublicClient;
  const deployer = createWalletClient({
    account: privateKeyToAccount(HOST_PRIVATE_KEY),
    transport,
  });

  // Deploy MockUSDC, then Jindo with the USDC address as constructor arg.
  const usdcBytecode = (mockUsdcJson as { bytecode: { object: string } }).bytecode.object as Hex;
  const usdcDeployHash = await deployer.deployContract({
    abi: MOCK_USDC_ABI,
    bytecode: usdcBytecode,
    chain: null,
  });
  const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcDeployHash });
  const usdcAddress = usdcReceipt.contractAddress!;

  const jindoBytecode = (bytecodeJson as { bytecode: { object: string } }).bytecode.object as Hex;
  // JINDO_ABI omits the constructor; supply it inline so deployContract can encode args.
  const jindoDeployAbi = [
    ...JINDO_ABI,
    {
      type: "constructor",
      stateMutability: "nonpayable",
      inputs: [{ name: "usdc", type: "address" }],
    },
  ] as const;
  const jindoDeployHash = await deployer.deployContract({
    abi: jindoDeployAbi,
    bytecode: jindoBytecode,
    args: [usdcAddress],
    chain: null,
  });
  const jindoReceipt = await publicClient.waitForTransactionReceipt({ hash: jindoDeployHash });
  if (!jindoReceipt.contractAddress) throw new Error("no contract address");
  contractAddress = jindoReceipt.contractAddress;

  // Fund the S3 gateway's chain identity so it can pay for uploads.
  // Mint $1000 USDC, approve Jindo, deposit into the contract.
  const s3Wallet = createWalletClient({
    account: privateKeyToAccount(S3_PRIVATE_KEY),
    transport,
  });
  const oneThousandUsdc = 1000n * 10n ** 6n;
  const mintHash = await deployer.writeContract({
    address: usdcAddress,
    abi: MOCK_USDC_ABI,
    functionName: "mint",
    args: [S3_ADDRESS, oneThousandUsdc],
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
  const approveHash = await s3Wallet.writeContract({
    address: usdcAddress,
    abi: MOCK_USDC_ABI,
    functionName: "approve",
    args: [contractAddress, oneThousandUsdc],
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  const depositHash = await s3Wallet.writeContract({
    address: contractAddress,
    abi: JINDO_ABI,
    functionName: "deposit",
    args: [oneThousandUsdc],
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });

  dataDir = mkdtempSync(join(tmpdir(), "jindo-s3-host-"));
  s3DataDir = mkdtempSync(join(tmpdir(), "jindo-s3-store-"));
  s3CacheDir = mkdtempSync(join(tmpdir(), "jindo-s3-cache-"));

  hostHandle = await startHost({
    privateKey: HOST_PRIVATE_KEY,
    rpcUrl: RPC_URL,
    contract: contractAddress,
    account: HOST_ADDRESS,
    port: HOST_PORT,
    dataDir,
  });

  s3Handle = await startS3({
    port: S3_PORT,
    dataDir: s3DataDir,
    cacheDir: s3CacheDir,
    jindoHostUrl: `http://127.0.0.1:${HOST_PORT}`,
    rpcUrl: RPC_URL,
    privateKey: S3_PRIVATE_KEY,
    contract: contractAddress,
  });

  if (!s3Handle.defaultCredential) throw new Error("expected seeded credential");

  s3 = new S3Client({
    endpoint: `http://127.0.0.1:${S3_PORT}`,
    region: "us-east-1",
    credentials: {
      accessKeyId: s3Handle.defaultCredential.accessKey,
      secretAccessKey: s3Handle.defaultCredential.secretKey,
    },
    forcePathStyle: true,
  });
});

afterAll(() => {
  s3?.destroy();
  s3Handle?.stop();
  hostHandle?.stop();
  anvil?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (s3DataDir) rmSync(s3DataDir, { recursive: true, force: true });
  if (s3CacheDir) rmSync(s3CacheDir, { recursive: true, force: true });
});

async function streamToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) throw new Error("no body");
  if (body instanceof Uint8Array) return body;
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    return await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  // ReadableStream fallback
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

test("CreateBucket → ListBuckets → HeadBucket", async () => {
  await s3.send(new CreateBucketCommand({ Bucket: "alpha" }));
  await s3.send(new CreateBucketCommand({ Bucket: "beta" }));

  const list = await s3.send(new ListBucketsCommand({}));
  const names = (list.Buckets ?? []).map((b) => b.Name).sort();
  expect(names).toEqual(["alpha", "beta"]);

  const head = await s3.send(new HeadBucketCommand({ Bucket: "alpha" }));
  expect(head.$metadata.httpStatusCode).toBe(200);

  await expect(s3.send(new HeadBucketCommand({ Bucket: "ghost" }))).rejects.toBeDefined();
}, 30000);

test("PutObject → GetObject roundtrip is byte-exact", async () => {
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 11) & 0xff;

  await s3.send(
    new PutObjectCommand({
      Bucket: "alpha",
      Key: "nested/path/file.bin",
      Body: bytes,
      ContentType: "application/octet-stream",
    }),
  );

  const head = await s3.send(new HeadObjectCommand({ Bucket: "alpha", Key: "nested/path/file.bin" }));
  expect(head.ContentLength).toBe(bytes.byteLength);
  expect(head.ContentType).toBe("application/octet-stream");

  const got = await s3.send(new GetObjectCommand({ Bucket: "alpha", Key: "nested/path/file.bin" }));
  const downloaded = await streamToBytes(got.Body);
  expect(downloaded.byteLength).toBe(bytes.byteLength);
  expect(downloaded).toEqual(bytes);
}, 30000);

test("ListObjectsV2 returns the keys we put", async () => {
  await s3.send(new PutObjectCommand({ Bucket: "alpha", Key: "list/a.txt", Body: new Uint8Array([1]) }));
  await s3.send(new PutObjectCommand({ Bucket: "alpha", Key: "list/b.txt", Body: new Uint8Array([2]) }));
  const list = await s3.send(new ListObjectsV2Command({ Bucket: "alpha", Prefix: "list/" }));
  const keys = (list.Contents ?? []).map((c) => c.Key).sort();
  expect(keys).toEqual(["list/a.txt", "list/b.txt"]);
}, 30000);

test("Multipart upload: 3 parts → CompleteMultipartUpload → byte-exact GetObject", async () => {
  // Build three distinct parts. S3 requires parts >= 5 MiB except the last,
  // but our gateway doesn't enforce that — keep it small for test speed.
  const partSizes = [4096, 4096, 1024];
  const parts = partSizes.map((n, idx) => {
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = (i * (idx + 1) + 7) & 0xff;
    return u;
  });
  const expected = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    expected.set(p, off);
    off += p.byteLength;
  }

  const created = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: "alpha",
      Key: "multipart/big.bin",
      ContentType: "application/octet-stream",
    }),
  );
  const UploadId = created.UploadId!;
  expect(UploadId).toBeTruthy();

  const uploadedParts: { ETag: string; PartNumber: number }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const r = await s3.send(
      new UploadPartCommand({
        Bucket: "alpha",
        Key: "multipart/big.bin",
        UploadId,
        PartNumber: i + 1,
        Body: parts[i]!,
      }),
    );
    expect(r.ETag).toBeTruthy();
    uploadedParts.push({ ETag: r.ETag!, PartNumber: i + 1 });
  }

  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: "alpha",
      Key: "multipart/big.bin",
      UploadId,
      MultipartUpload: { Parts: uploadedParts },
    }),
  );

  const got = await s3.send(new GetObjectCommand({ Bucket: "alpha", Key: "multipart/big.bin" }));
  const downloaded = await streamToBytes(got.Body);
  expect(downloaded.byteLength).toBe(expected.byteLength);
  expect(downloaded).toEqual(expected);
}, 60000);

test("DeleteObject removes the key", async () => {
  await s3.send(
    new PutObjectCommand({ Bucket: "alpha", Key: "tmp/del.bin", Body: new Uint8Array([9, 9, 9]) }),
  );
  await s3.send(new DeleteObjectCommand({ Bucket: "alpha", Key: "tmp/del.bin" }));
  await expect(
    s3.send(new HeadObjectCommand({ Bucket: "alpha", Key: "tmp/del.bin" })),
  ).rejects.toBeDefined();
}, 30000);

test("Wrong secret key is rejected", async () => {
  const bad = new S3Client({
    endpoint: `http://127.0.0.1:${S3_PORT}`,
    region: "us-east-1",
    credentials: {
      accessKeyId: s3Handle.defaultCredential!.accessKey,
      secretAccessKey: "WRONG_SECRET_KEY_VALUE",
    },
    forcePathStyle: true,
  });
  await expect(bad.send(new ListBucketsCommand({}))).rejects.toBeDefined();
  bad.destroy();
}, 30000);
