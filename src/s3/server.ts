import { createHash, randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { JindoClient } from "../lib/index.ts";
import { fetchDownload } from "../lib/host-client.ts";
import { sqliteCacheFactory } from "../node/sqlite-cache.ts";
import {
  bucketExists,
  createBucket,
  createMultipartUpload,
  deleteBucket,
  deleteMultipart,
  deleteObject,
  getMultipart,
  getObject,
  getParts,
  listBuckets,
  listMultiparts,
  listObjects,
  openS3Db,
  putObject,
  putPart,
  type S3Db,
} from "./db.ts";
import { verifySigV4 } from "./auth.ts";
import {
  parseCompleteMultipart,
  xmlCompleteMultipart,
  xmlError,
  xmlInitiateMultipart,
  xmlListAllMyBuckets,
  xmlListBucketResult,
  xmlListMultipartUploads,
} from "./xml.ts";

export interface S3Env {
  port: number;
  dataDir: string;
  cacheDir: string;
  jindoHostUrl: string;
  rpcUrl: string;
  privateKey: Hex;
  contract: Address;
  region?: string;
}

export interface S3Handle {
  stop: () => void;
  url: string;
  defaultCredential?: { accessKey: string; secretKey: string };
}

const VALID_BUCKET = /^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/;
const MAX_KEYS_DEFAULT = 1000;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function shortKey(s: string | undefined): string {
  if (!s) return "?";
  return s.length <= 12 ? s : `${s.slice(0, 8)}..`;
}

function shortRoot(s: string | null): string {
  if (!s) return "—";
  return `${s.slice(0, 10)}..${s.slice(-4)}`;
}

export async function startS3(env: S3Env): Promise<S3Handle> {
  const { hdb, defaultCredential } = openS3Db(env.dataDir);

  const jindo = await JindoClient.open({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    contract: env.contract,
    hostUrl: env.jindoHostUrl,
    openCache: sqliteCacheFactory(env.cacheDir),
  });

  const region = env.region ?? "us-east-1";

  const md5Hex = (b: Uint8Array): string => createHash("md5").update(b).digest("hex");

  const xmlResponse = (
    status: number,
    body: string,
    extraHeaders: Record<string, string> = {},
  ) =>
    new Response(body, {
      status,
      headers: { "content-type": "application/xml", ...extraHeaders },
    });

  const errorResponse = (
    status: number,
    code: string,
    message: string,
    resource?: string,
  ) => xmlResponse(status, xmlError(code, message, resource));

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : "";

    const auth = verifySigV4(req, hdb, rawQuery);
    if (!auth.ok) {
      console.log(`[s3] 403 ${req.method} ${url.pathname} (${auth.reason ?? "auth failed"})`);
      return errorResponse(403, "SignatureDoesNotMatch", auth.reason ?? "auth failed");
    }

    const method = req.method.toUpperCase();
    const segs = url.pathname === "/" ? [] : url.pathname.slice(1).split("/");
    const bucket = segs[0] ? decodeURIComponent(segs[0]) : undefined;
    const key = segs.length > 1 ? segs.slice(1).map(decodeURIComponent).join("/") : undefined;
    const tag = `[${shortKey(auth.accessKey)}]`;

    // ── service-level (no bucket) ────────────────────────────────────────
    if (!bucket) {
      if (method === "GET") {
        const all = listBuckets(hdb);
        console.log(`[s3] ${tag} list-buckets → ${all.length}`);
        return xmlResponse(200, xmlListAllMyBuckets(all, jindo.clientAddress));
      }
      return errorResponse(405, "MethodNotAllowed", `${method} /`);
    }

    // ── bucket-level (no key) ────────────────────────────────────────────
    if (!key) {
      if (method === "PUT") {
        if (!VALID_BUCKET.test(bucket)) {
          return errorResponse(400, "InvalidBucketName", "invalid bucket name");
        }
        const created = createBucket(hdb, bucket);
        if (!created) {
          console.log(`[s3] ${tag} create-bucket ${bucket} (already exists, 409)`);
          return errorResponse(409, "BucketAlreadyOwnedByYou", "bucket exists");
        }
        console.log(`[s3] ${tag} create-bucket ${bucket}`);
        return new Response(null, { status: 200, headers: { Location: `/${bucket}` } });
      }
      if (method === "HEAD") {
        const exists = bucketExists(hdb, bucket);
        console.log(`[s3] ${tag} head-bucket ${bucket} → ${exists ? "200" : "404"}`);
        return exists
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 404 });
      }
      if (method === "DELETE") {
        const r = deleteBucket(hdb, bucket);
        if (r === "not-found") {
          console.log(`[s3] ${tag} delete-bucket ${bucket} → 404`);
          return errorResponse(404, "NoSuchBucket", "bucket not found");
        }
        if (r === "not-empty") {
          console.log(`[s3] ${tag} delete-bucket ${bucket} → 409 not-empty`);
          return errorResponse(409, "BucketNotEmpty", "bucket has objects");
        }
        console.log(`[s3] ${tag} delete-bucket ${bucket}`);
        return new Response(null, { status: 204 });
      }
      if (method === "GET") {
        if (url.searchParams.has("uploads")) {
          if (!bucketExists(hdb, bucket))
            return errorResponse(404, "NoSuchBucket", "bucket not found");
          const ups = listMultiparts(hdb, bucket);
          console.log(`[s3] ${tag} list-multiparts ${bucket} → ${ups.length}`);
          return xmlResponse(200, xmlListMultipartUploads(bucket, ups));
        }
        if (!bucketExists(hdb, bucket))
          return errorResponse(404, "NoSuchBucket", "bucket not found");

        const prefix = url.searchParams.get("prefix") ?? "";
        const startAfter = url.searchParams.get("start-after") ?? undefined;
        const maxKeysRaw = url.searchParams.get("max-keys");
        const maxKeys = maxKeysRaw
          ? Math.min(Math.max(parseInt(maxKeysRaw, 10) || MAX_KEYS_DEFAULT, 1), MAX_KEYS_DEFAULT)
          : MAX_KEYS_DEFAULT;
        const continuationToken = url.searchParams.get("continuation-token") ?? undefined;
        const after = continuationToken
          ? Buffer.from(continuationToken, "base64url").toString("utf-8")
          : startAfter;

        // Fetch maxKeys+1 to detect truncation in one query.
        const rows = listObjects(hdb, bucket, {
          prefix: prefix || undefined,
          maxKeys: maxKeys + 1,
          startAfter: after,
        });
        const isTruncated = rows.length > maxKeys;
        const slice = isTruncated ? rows.slice(0, maxKeys) : rows;
        const nextToken = isTruncated
          ? Buffer.from(slice[slice.length - 1]!.key).toString("base64url")
          : undefined;

        console.log(
          `[s3] ${tag} list ${bucket}${prefix ? ` prefix="${prefix}"` : ""} → ${slice.length}${
            isTruncated ? " (truncated)" : ""
          }`,
        );
        return xmlResponse(
          200,
          xmlListBucketResult({
            bucket,
            prefix,
            maxKeys,
            isTruncated,
            continuationToken,
            nextContinuationToken: nextToken,
            startAfter,
            contents: slice.map((r) => ({
              key: r.key,
              size: r.size,
              etag: r.etag,
              lastModified: new Date(r.createdAt * 1000).toISOString(),
            })),
          }),
        );
      }
      return errorResponse(405, "MethodNotAllowed", `${method} /${bucket}`);
    }

    // ── object-level ─────────────────────────────────────────────────────
    if (!bucketExists(hdb, bucket)) {
      return errorResponse(404, "NoSuchBucket", "bucket not found");
    }

    // Multipart entry points come before plain PUT/POST since the dispatch
    // is keyed off query parameters, not method alone.
    if (method === "POST" && url.searchParams.has("uploads")) {
      const uploadId = randomUploadId();
      const contentType = req.headers.get("content-type") ?? null;
      createMultipartUpload(hdb, { uploadId, bucket, key, contentType });
      console.log(`[s3] ${tag} mpu init ${bucket}/${key} uploadId=${shortKey(uploadId)}`);
      return xmlResponse(200, xmlInitiateMultipart(bucket, key, uploadId));
    }

    if (method === "POST" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId")!;
      const header = getMultipart(hdb, uploadId);
      if (!header || header.bucket !== bucket || header.key !== key) {
        return errorResponse(404, "NoSuchUpload", "upload not found");
      }
      const xmlBody = await req.text();
      const requested = parseCompleteMultipart(xmlBody);
      if (requested.length === 0) {
        return errorResponse(400, "InvalidRequest", "empty parts list");
      }
      // Part numbers must be strictly ascending.
      for (let i = 1; i < requested.length; i++) {
        if (requested[i]!.partNumber <= requested[i - 1]!.partNumber) {
          return errorResponse(400, "InvalidPartOrder", "parts must be strictly ascending");
        }
      }

      const stored = getParts(hdb, uploadId);
      const byNumber = new Map(stored.map((p) => [p.partNumber, p]));
      const ordered: typeof stored = [];
      for (const r of requested) {
        const have = byNumber.get(r.partNumber);
        if (!have) return errorResponse(400, "InvalidPart", `missing part ${r.partNumber}`);
        if (have.etag !== r.etag) {
          return errorResponse(400, "InvalidPart", `etag mismatch on part ${r.partNumber}`);
        }
        ordered.push(have);
      }

      const totalSize = ordered.reduce((a, p) => a + p.bytes.byteLength, 0);
      const merged = new Uint8Array(totalSize);
      let off = 0;
      for (const p of ordered) {
        merged.set(p.bytes, off);
        off += p.bytes.byteLength;
      }
      const etag = md5Hex(merged);
      let fileRoot: string | null = null;
      if (totalSize > 0) {
        const r = await jindo.upload([{ bytes: merged, filename: key }]);
        fileRoot = r.fileRoots[0]!;
      }

      putObject(hdb, {
        bucket,
        key,
        size: totalSize,
        etag,
        contentType: header.contentType,
        fileRoot,
        createdAt: Math.floor(Date.now() / 1000),
      });
      deleteMultipart(hdb, uploadId);

      console.log(
        `[s3] ${tag} mpu complete ${bucket}/${key} parts=${ordered.length} size=${fmtBytes(
          totalSize,
        )} fileRoot=${shortRoot(fileRoot)}`,
      );

      const location = `${url.origin}/${encodeURIComponent(bucket)}/${key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      return xmlResponse(200, xmlCompleteMultipart(bucket, key, etag, location));
    }

    if (
      method === "PUT" &&
      url.searchParams.has("uploadId") &&
      url.searchParams.has("partNumber")
    ) {
      const uploadId = url.searchParams.get("uploadId")!;
      const partNumber = parseInt(url.searchParams.get("partNumber")!, 10);
      if (!Number.isFinite(partNumber) || partNumber < 1 || partNumber > 10000) {
        return errorResponse(400, "InvalidArgument", "bad partNumber");
      }
      const header = getMultipart(hdb, uploadId);
      if (!header || header.bucket !== bucket || header.key !== key) {
        return errorResponse(404, "NoSuchUpload", "upload not found");
      }
      const bytes = new Uint8Array(await req.arrayBuffer());
      const etag = md5Hex(bytes);
      putPart(hdb, { uploadId, partNumber, bytes, etag });
      console.log(
        `[s3] ${tag} mpu part ${bucket}/${key} #${partNumber} size=${fmtBytes(bytes.byteLength)} uploadId=${shortKey(uploadId)}`,
      );
      return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
    }

    if (method === "DELETE" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId")!;
      const header = getMultipart(hdb, uploadId);
      if (header && header.bucket === bucket && header.key === key) {
        deleteMultipart(hdb, uploadId);
      }
      console.log(`[s3] ${tag} mpu abort ${bucket}/${key} uploadId=${shortKey(uploadId)}`);
      return new Response(null, { status: 204 });
    }

    if (method === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const etag = md5Hex(bytes);
      let fileRoot: string | null = null;
      if (bytes.byteLength > 0) {
        const r = await jindo.upload([{ bytes, filename: key }]);
        fileRoot = r.fileRoots[0]!;
      }
      putObject(hdb, {
        bucket,
        key,
        size: bytes.byteLength,
        etag,
        contentType: req.headers.get("content-type") ?? null,
        fileRoot,
        createdAt: Math.floor(Date.now() / 1000),
      });
      console.log(
        `[s3] ${tag} put ${bucket}/${key} size=${fmtBytes(bytes.byteLength)} fileRoot=${shortRoot(fileRoot)}`,
      );
      return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
    }

    if (method === "GET" || method === "HEAD") {
      const obj = getObject(hdb, bucket, key);
      if (!obj) {
        console.log(`[s3] ${tag} ${method.toLowerCase()} ${bucket}/${key} → 404`);
        return errorResponse(404, "NoSuchKey", "key not found");
      }
      const headers: Record<string, string> = {
        ETag: `"${obj.etag}"`,
        "content-length": String(obj.size),
        "last-modified": new Date(obj.createdAt * 1000).toUTCString(),
        "accept-ranges": "bytes",
      };
      if (obj.contentType) headers["content-type"] = obj.contentType;
      if (method === "HEAD") {
        console.log(`[s3] ${tag} head ${bucket}/${key} size=${fmtBytes(obj.size)}`);
        return new Response(null, { status: 200, headers });
      }
      if (obj.size === 0 || !obj.fileRoot) {
        console.log(`[s3] ${tag} get ${bucket}/${key} size=0 (empty)`);
        return new Response(new Uint8Array(0), { status: 200, headers });
      }
      const bytes = await fetchDownload(env.jindoHostUrl, obj.fileRoot as Hex);
      console.log(
        `[s3] ${tag} get ${bucket}/${key} size=${fmtBytes(obj.size)} fileRoot=${shortRoot(obj.fileRoot)}`,
      );
      return new Response(bytes as BodyInit, { status: 200, headers });
    }

    if (method === "DELETE") {
      // S3 DELETE is idempotent — 204 whether or not the key existed.
      const removed = deleteObject(hdb, bucket, key);
      console.log(`[s3] ${tag} delete ${bucket}/${key}${removed ? "" : " (noop)"}`);
      return new Response(null, { status: 204 });
    }

    return errorResponse(405, "MethodNotAllowed", `${method} /${bucket}/${key}`);
  };

  const server = Bun.serve({
    port: env.port,
    hostname: "0.0.0.0",
    fetch: handle,
  });

  if (defaultCredential) {
    console.log(
      `[s3] seeded default credential\n  AccessKeyId:     ${defaultCredential.accessKey}\n  SecretAccessKey: ${defaultCredential.secretKey}`,
    );
  }
  console.log(
    `jindo s3 listening on ${server.url} (region=${region}) backing host ${env.jindoHostUrl}`,
  );

  return {
    stop: () => server.stop(true),
    url: server.url.toString(),
    defaultCredential,
  };
}

function randomUploadId(): string {
  return randomBytes(24).toString("base64url");
}

export type { S3Db };
