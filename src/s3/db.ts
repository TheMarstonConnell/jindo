import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * S3 gateway store. One sqlite file holds all bucket / object / multipart
 * state plus the credentials used to authenticate AWS-SDK callers. Object
 * bytes themselves live on the jindo host; the `file_root` column is what
 * we hand to /download/:fileRoot to fetch them back.
 */
export interface S3Db {
  db: Database;
  dataDir: string;
}

export interface DefaultCredential {
  accessKey: string;
  secretKey: string;
}

export interface OpenS3DbResult {
  hdb: S3Db;
  defaultCredential?: DefaultCredential;
}

export function openS3Db(dataDir: string): OpenS3DbResult {
  mkdirSync(dataDir, { recursive: true });

  const db = new Database(`${dataDir}/s3.sqlite`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE IF NOT EXISTS credentials (
      access_key TEXT PRIMARY KEY,
      secret_key TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS buckets (
      name TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS objects (
      bucket TEXT NOT NULL,
      key TEXT NOT NULL,
      size INTEGER NOT NULL,
      etag TEXT NOT NULL,
      content_type TEXT,
      file_root TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (bucket, key)
    );
    CREATE INDEX IF NOT EXISTS idx_objects_bucket_key ON objects(bucket, key);
    CREATE TABLE IF NOT EXISTS multipart_uploads (
      upload_id TEXT PRIMARY KEY,
      bucket TEXT NOT NULL,
      key TEXT NOT NULL,
      content_type TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS multipart_parts (
      upload_id TEXT NOT NULL,
      part_number INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      etag TEXT NOT NULL,
      PRIMARY KEY (upload_id, part_number)
    );
  `);

  const hdb: S3Db = { db, dataDir };
  let defaultCredential: DefaultCredential | undefined;
  const count = db
    .query<{ c: number }, []>("SELECT COUNT(*) as c FROM credentials")
    .get();
  if ((count?.c ?? 0) === 0) {
    const accessKey = `AKIA${randomBytes(8).toString("hex").toUpperCase()}`;
    const secretKey = randomBytes(30).toString("base64");
    db.run(
      "INSERT INTO credentials (access_key, secret_key, label, created_at) VALUES (?, ?, ?, ?)",
      [accessKey, secretKey, "default", Math.floor(Date.now() / 1000)],
    );
    defaultCredential = { accessKey, secretKey };
  }

  return { hdb, defaultCredential };
}

export function lookupSecret(hdb: S3Db, accessKey: string): string | null {
  const row = hdb.db
    .query<{ secret_key: string }, [string]>(
      "SELECT secret_key FROM credentials WHERE access_key = ?",
    )
    .get(accessKey);
  return row?.secret_key ?? null;
}

// ── bucket ops ─────────────────────────────────────────────────────────────

export function bucketExists(hdb: S3Db, name: string): boolean {
  const row = hdb.db
    .query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM buckets WHERE name = ?")
    .get(name);
  return (row?.c ?? 0) > 0;
}

export function createBucket(hdb: S3Db, name: string): boolean {
  const result = hdb.db.run(
    "INSERT OR IGNORE INTO buckets (name, created_at) VALUES (?, ?)",
    [name, Math.floor(Date.now() / 1000)],
  );
  return result.changes > 0;
}

export type DeleteBucketResult = "ok" | "not-found" | "not-empty";

export function deleteBucket(hdb: S3Db, name: string): DeleteBucketResult {
  if (!bucketExists(hdb, name)) return "not-found";
  const objCount = hdb.db
    .query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM objects WHERE bucket = ?")
    .get(name);
  if ((objCount?.c ?? 0) > 0) return "not-empty";
  hdb.db.run("DELETE FROM buckets WHERE name = ?", [name]);
  return "ok";
}

export interface BucketRow {
  name: string;
  createdAt: number;
}

export function listBuckets(hdb: S3Db): BucketRow[] {
  return hdb.db
    .query<{ name: string; created_at: number }, []>(
      "SELECT name, created_at FROM buckets ORDER BY name ASC",
    )
    .all()
    .map((r) => ({ name: r.name, createdAt: r.created_at }));
}

// ── object ops ─────────────────────────────────────────────────────────────

export interface ObjectRow {
  bucket: string;
  key: string;
  size: number;
  etag: string;
  contentType: string | null;
  fileRoot: string | null;
  createdAt: number;
}

export function putObject(hdb: S3Db, row: ObjectRow): void {
  hdb.db.run(
    `INSERT OR REPLACE INTO objects (bucket, key, size, etag, content_type, file_root, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.bucket, row.key, row.size, row.etag, row.contentType, row.fileRoot, row.createdAt],
  );
}

export function getObject(hdb: S3Db, bucket: string, key: string): ObjectRow | null {
  const r = hdb.db
    .query<
      {
        size: number;
        etag: string;
        content_type: string | null;
        file_root: string | null;
        created_at: number;
      },
      [string, string]
    >(
      "SELECT size, etag, content_type, file_root, created_at FROM objects WHERE bucket = ? AND key = ?",
    )
    .get(bucket, key);
  if (!r) return null;
  return {
    bucket,
    key,
    size: r.size,
    etag: r.etag,
    contentType: r.content_type,
    fileRoot: r.file_root,
    createdAt: r.created_at,
  };
}

export function deleteObject(hdb: S3Db, bucket: string, key: string): boolean {
  const r = hdb.db.run("DELETE FROM objects WHERE bucket = ? AND key = ?", [bucket, key]);
  return r.changes > 0;
}

export interface ListObjectsOpts {
  prefix?: string;
  maxKeys?: number;
  startAfter?: string;
}

export function listObjects(hdb: S3Db, bucket: string, opts: ListObjectsOpts = {}): ObjectRow[] {
  let sql =
    "SELECT bucket, key, size, etag, content_type, file_root, created_at FROM objects WHERE bucket = ?";
  const params: Array<string | number> = [bucket];
  if (opts.prefix) {
    // Escape SQL LIKE metacharacters; we want a literal-prefix match.
    const escaped = opts.prefix.replace(/[\\%_]/g, "\\$&");
    sql += " AND key LIKE ? ESCAPE '\\'";
    params.push(`${escaped}%`);
  }
  if (opts.startAfter) {
    sql += " AND key > ?";
    params.push(opts.startAfter);
  }
  sql += " ORDER BY key ASC";
  if (opts.maxKeys && opts.maxKeys > 0) {
    sql += " LIMIT ?";
    params.push(opts.maxKeys);
  }
  return hdb.db
    .query<
      {
        bucket: string;
        key: string;
        size: number;
        etag: string;
        content_type: string | null;
        file_root: string | null;
        created_at: number;
      },
      Array<string | number>
    >(sql)
    .all(...params)
    .map((r) => ({
      bucket: r.bucket,
      key: r.key,
      size: r.size,
      etag: r.etag,
      contentType: r.content_type,
      fileRoot: r.file_root,
      createdAt: r.created_at,
    }));
}

// ── multipart ops ──────────────────────────────────────────────────────────

export interface MultipartHeader {
  uploadId: string;
  bucket: string;
  key: string;
  contentType: string | null;
  createdAt: number;
}

export function createMultipartUpload(
  hdb: S3Db,
  args: { uploadId: string; bucket: string; key: string; contentType: string | null },
): void {
  hdb.db.run(
    "INSERT INTO multipart_uploads (upload_id, bucket, key, content_type, created_at) VALUES (?, ?, ?, ?, ?)",
    [args.uploadId, args.bucket, args.key, args.contentType, Math.floor(Date.now() / 1000)],
  );
}

export function getMultipart(hdb: S3Db, uploadId: string): MultipartHeader | null {
  const r = hdb.db
    .query<
      {
        upload_id: string;
        bucket: string;
        key: string;
        content_type: string | null;
        created_at: number;
      },
      [string]
    >(
      "SELECT upload_id, bucket, key, content_type, created_at FROM multipart_uploads WHERE upload_id = ?",
    )
    .get(uploadId);
  if (!r) return null;
  return {
    uploadId: r.upload_id,
    bucket: r.bucket,
    key: r.key,
    contentType: r.content_type,
    createdAt: r.created_at,
  };
}

export function listMultiparts(hdb: S3Db, bucket: string): MultipartHeader[] {
  return hdb.db
    .query<
      {
        upload_id: string;
        bucket: string;
        key: string;
        content_type: string | null;
        created_at: number;
      },
      [string]
    >(
      "SELECT upload_id, bucket, key, content_type, created_at FROM multipart_uploads WHERE bucket = ? ORDER BY created_at ASC",
    )
    .all(bucket)
    .map((r) => ({
      uploadId: r.upload_id,
      bucket: r.bucket,
      key: r.key,
      contentType: r.content_type,
      createdAt: r.created_at,
    }));
}

export function deleteMultipart(hdb: S3Db, uploadId: string): void {
  hdb.db.run("DELETE FROM multipart_parts WHERE upload_id = ?", [uploadId]);
  hdb.db.run("DELETE FROM multipart_uploads WHERE upload_id = ?", [uploadId]);
}

export function putPart(
  hdb: S3Db,
  args: { uploadId: string; partNumber: number; bytes: Uint8Array; etag: string },
): void {
  hdb.db.run(
    "INSERT OR REPLACE INTO multipart_parts (upload_id, part_number, bytes, etag) VALUES (?, ?, ?, ?)",
    [args.uploadId, args.partNumber, args.bytes, args.etag],
  );
}

export interface PartRow {
  partNumber: number;
  bytes: Uint8Array;
  etag: string;
}

export function getParts(hdb: S3Db, uploadId: string): PartRow[] {
  return hdb.db
    .query<{ part_number: number; bytes: Uint8Array; etag: string }, [string]>(
      "SELECT part_number, bytes, etag FROM multipart_parts WHERE upload_id = ? ORDER BY part_number ASC",
    )
    .all(uploadId)
    .map((r) => ({ partNumber: r.part_number, bytes: r.bytes, etag: r.etag }));
}
