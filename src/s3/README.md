# S3 gateway

An S3-compatible HTTP server that stores object bytes on a jindo host. Buckets, object metadata, multipart parts, and authentication credentials live in a local SQLite database; the actual file bytes are uploaded through the jindo client to a host (and on-chain), and fetched back through `GET /download/:fileRoot` when an `S3 GetObject` arrives.

The gateway holds **one** on-chain identity (the wallet from `JINDO_PRIVATE_KEY`); every S3 caller's data is stored under it. The S3 credentials in the database only gate access to the gateway — they don't correspond to separate on-chain identities.

## Run it

```bash
JINDO_PRIVATE_KEY=0x... \
JINDO_RPC_URL=https://... \
JINDO_CONTRACT=0x... \
JINDO_HOST_URL=http://localhost:5689 \
bun src/cli.ts s3
```

On first launch the gateway seeds a default credential and prints it to the log:

```
[s3] seeded default credential
  AccessKeyId:     AKIA7424CAAE4BFB2477
  SecretAccessKey: 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
```

Save those — they're stored in `JINDO_S3_DATA_DIR/s3.sqlite` and won't be reprinted.

The gateway also needs USDC deposited on-chain to pay for storage. Use `jindo deposit <amount>` once before uploading.

## Use it

Point any S3 client at the gateway with `forcePathStyle: true`. Example with the AWS SDK v3:

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "http://localhost:5690",
  region: "us-east-1",
  credentials: { accessKeyId: "AKIA…", secretAccessKey: "…" },
  forcePathStyle: true,
});

await s3.send(new PutObjectCommand({ Bucket: "my-bucket", Key: "hello.txt", Body: "world" }));
```

Or `aws s3` CLI:

```bash
aws --endpoint-url http://localhost:5690 s3 mb s3://my-bucket
aws --endpoint-url http://localhost:5690 s3 cp ./file.bin s3://my-bucket/file.bin
```

## Supported operations

| Operation | Notes |
| --- | --- |
| `CreateBucket` / `HeadBucket` / `DeleteBucket` / `ListBuckets` | Bucket names follow standard S3 rules. Delete fails with 409 if the bucket has objects. |
| `PutObject` / `GetObject` / `HeadObject` / `DeleteObject` | Object bytes are uploaded to jindo on `PutObject`, fetched back on `GetObject`. |
| `ListObjectsV2` | Supports `prefix`, `start-after`, `max-keys`, `continuation-token`. No delimiter. |
| `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` / `AbortMultipartUpload` / `ListMultipartUploads` | Parts are buffered as BLOBs in SQLite; the assembled object is uploaded to jindo on `Complete`. |

Not implemented: ACLs, tagging, CORS, object versioning, server-side encryption headers, bucket policies, presigned URLs, copy-object, byte-range GET, multipart UploadPartCopy.

## Authentication

Every request is verified with full **AWS Signature Version 4**. The gateway:

1. Parses the `Authorization: AWS4-HMAC-SHA256 …` header to extract the access key, signed-header list, and signature.
2. Looks up the matching `secret_key` in the `credentials` table.
3. Rebuilds the canonical request from the actual method / path / query / signed headers / `x-amz-content-sha256` value.
4. Derives the SigV4 signing key from the secret and HMAC-compares against the supplied signature in constant time.

Body content is not re-hashed against `x-amz-content-sha256` (we accept whatever the client put in the header — `UNSIGNED-PAYLOAD`, a hex SHA-256, or `STREAMING-…`). That's enough to defeat header tampering and unauthorized access; per-chunk streaming-signature verification isn't worth the complexity for this gateway.

## Storage layout

Single SQLite file at `JINDO_S3_DATA_DIR/s3.sqlite`:

| Table | Purpose |
| --- | --- |
| `credentials` | `(access_key, secret_key, label, created_at)` — one default key seeded on first run |
| `buckets` | `(name, created_at)` |
| `objects` | `(bucket, key, size, etag, content_type, file_root, created_at)` — `file_root` is the jindo handle, used for `GET /download/:fileRoot` |
| `multipart_uploads` | `(upload_id, bucket, key, content_type, created_at)` |
| `multipart_parts` | `(upload_id, part_number, bytes BLOB, etag)` — concatenated and uploaded to jindo on `CompleteMultipartUpload` |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `JINDO_S3_PORT` | `5690` | TCP port the gateway listens on |
| `JINDO_S3_DATA_DIR` | `./data/s3` | SQLite file location |
| `JINDO_S3_CACHE_DIR` | `${HOME}/.jindo/s3-cache` | Cache for the embedded `JindoClient` |
| `JINDO_HOST_URL` | *(required)* | URL of the jindo storage host this gateway forwards uploads to |
| `JINDO_PRIVATE_KEY` / `JINDO_RPC_URL` / `JINDO_CONTRACT` | *(required)* | Inherited from the standard jindo identity config — picks the on-chain identity that pays for and owns all uploaded data |

## Files

- [`server.ts`](server.ts) — `Bun.serve` handler, request routing, and the SigV4 → jindo upload/download wiring
- [`auth.ts`](auth.ts) — the SigV4 verifier
- [`db.ts`](db.ts) — SQLite schema and accessors
- [`xml.ts`](xml.ts) — S3 XML response builders and the `CompleteMultipartUpload` request parser
- [`index.ts`](index.ts) — public exports (`startS3`, `S3Env`, `S3Handle`, etc.)
