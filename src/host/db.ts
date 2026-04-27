import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import { ZERO_ROOT, type FileRecord, type PairState } from "../shared/types.ts";

/**
 * Single-database host store.
 *
 *   clients(id, address, outer_root, total_size, last_tx_hash, created_at)
 *   files(id, client_id → clients.id, file_root, size_bytes, uploaded_at, UNIQUE(client_id, file_root))
 *
 * Blobs are stored content-addressed at `${dataDir}/blobs/${file_root}` and shared
 * across clients that happen to upload the same content. Removal is refcounted:
 * we only unlink the blob when the last `files` row referencing it is gone.
 */
export interface HostDb {
  db: Database;
  dataDir: string;
  blobsDir: string;
}

export function openHostDb(dataDir: string): HostDb {
  const blobsDir = `${dataDir}/blobs`;
  mkdirSync(blobsDir, { recursive: true });

  const db = new Database(`${dataDir}/host.sqlite`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT UNIQUE NOT NULL,
      outer_root TEXT NOT NULL,
      total_size TEXT NOT NULL,
      last_tx_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      file_root TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL,
      UNIQUE(client_id, file_root)
    );
    CREATE INDEX IF NOT EXISTS idx_files_root ON files(file_root);
    CREATE INDEX IF NOT EXISTS idx_files_client ON files(client_id);
  `);

  return { db, dataDir, blobsDir };
}

/** Resolve (or create) a client row and return its id. Idempotent. */
export function ensureClient(hdb: HostDb, client: Address): number {
  const checked = getAddress(client);
  const existing = hdb.db
    .query<{ id: number }, [string]>("SELECT id FROM clients WHERE address = ?")
    .get(checked);
  if (existing) return existing.id;
  const result = hdb.db.run(
    "INSERT INTO clients (address, outer_root, total_size, created_at) VALUES (?, ?, '0', ?)",
    [checked, ZERO_ROOT, Math.floor(Date.now() / 1000)],
  );
  return Number(result.lastInsertRowid);
}

function clientId(hdb: HostDb, client: Address): number {
  return ensureClient(hdb, client);
}

export function readState(hdb: HostDb, client: Address): PairState {
  const id = clientId(hdb, client);
  const row = hdb.db
    .query<{ outer_root: string; total_size: string }, [number]>(
      "SELECT outer_root, total_size FROM clients WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error("client row missing after ensure");
  return { outerRoot: row.outer_root as Hex, totalSize: BigInt(row.total_size) };
}

export function writeState(
  hdb: HostDb,
  client: Address,
  state: PairState,
  txHash: Hex,
): void {
  const id = clientId(hdb, client);
  hdb.db.run(
    "UPDATE clients SET outer_root = ?, total_size = ?, last_tx_hash = ? WHERE id = ?",
    [state.outerRoot, state.totalSize.toString(), txHash, id],
  );
}

export function listFiles(hdb: HostDb, client: Address): FileRecord[] {
  const id = clientId(hdb, client);
  const rows = hdb.db
    .query<
      { file_root: string; size_bytes: number; uploaded_at: number },
      [number]
    >(
      "SELECT file_root, size_bytes, uploaded_at FROM files WHERE client_id = ? ORDER BY uploaded_at ASC",
    )
    .all(id);
  return rows.map((r) => ({
    fileRoot: r.file_root as Hex,
    sizeBytes: r.size_bytes,
    uploadedAt: r.uploaded_at,
  }));
}

export function fileRoots(hdb: HostDb, client: Address): Hex[] {
  const id = clientId(hdb, client);
  const rows = hdb.db
    .query<{ file_root: string }, [number]>(
      "SELECT file_root FROM files WHERE client_id = ?",
    )
    .all(id);
  return rows.map((r) => r.file_root as Hex);
}

export function hasFile(hdb: HostDb, client: Address, fileRoot: Hex): boolean {
  const id = clientId(hdb, client);
  const row = hdb.db
    .query<{ c: number }, [number, string]>(
      "SELECT COUNT(*) as c FROM files WHERE client_id = ? AND file_root = ?",
    )
    .get(id, fileRoot);
  return (row?.c ?? 0) > 0;
}

export function insertFile(hdb: HostDb, client: Address, rec: FileRecord): void {
  const id = clientId(hdb, client);
  hdb.db.run(
    "INSERT INTO files (client_id, file_root, size_bytes, uploaded_at) VALUES (?, ?, ?, ?)",
    [id, rec.fileRoot, rec.sizeBytes, rec.uploadedAt],
  );
}

export function deleteFileRow(
  hdb: HostDb,
  client: Address,
  fileRoot: Hex,
): void {
  const id = clientId(hdb, client);
  hdb.db.run("DELETE FROM files WHERE client_id = ? AND file_root = ?", [id, fileRoot]);
}

/** How many distinct (client, file_root) rows still reference this blob. */
export function fileRootRefCount(hdb: HostDb, fileRoot: Hex): number {
  const row = hdb.db
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) as c FROM files WHERE file_root = ?",
    )
    .get(fileRoot);
  return row?.c ?? 0;
}

/** True when at least one client still references this blob — used to authorize downloads. */
export function blobIsLive(hdb: HostDb, fileRoot: Hex): boolean {
  return fileRootRefCount(hdb, fileRoot) > 0;
}

export interface ClientSummary {
  client: Address;
  outerRoot: Hex;
  totalSize: string;
  fileCount: number;
}

export function listClientSummaries(hdb: HostDb): ClientSummary[] {
  const rows = hdb.db
    .query<
      {
        address: string;
        outer_root: string;
        total_size: string;
        file_count: number;
      },
      []
    >(
      `SELECT c.address as address,
              c.outer_root as outer_root,
              c.total_size as total_size,
              (SELECT COUNT(*) FROM files f WHERE f.client_id = c.id) as file_count
       FROM clients c
       ORDER BY c.id ASC`,
    )
    .all();
  return rows.map((r) => ({
    client: r.address as Address,
    outerRoot: r.outer_root as Hex,
    totalSize: r.total_size,
    fileCount: r.file_count,
  }));
}
