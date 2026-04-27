import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync } from "node:fs";
import { getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";
import { ZERO_ROOT, type FileRecord, type PairState } from "../shared/types.ts";

export interface ClientStore {
  client: Address;
  dir: string;
  blobsDir: string;
  db: Database;
}

const cache = new Map<Address, ClientStore>();

export function getStore(dataDir: string, client: Address): ClientStore {
  const key = client.toLowerCase() as Address;
  const existing = cache.get(key);
  if (existing) return existing;

  const dir = `${dataDir}/${key}`;
  const blobsDir = `${dir}/blobs`;
  mkdirSync(blobsDir, { recursive: true });

  const db = new Database(`${dir}/db.sqlite`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      file_root TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      outer_root TEXT NOT NULL,
      total_size TEXT NOT NULL,
      last_tx_hash TEXT
    );
  `);
  db.run(
    `INSERT OR IGNORE INTO state (id, outer_root, total_size) VALUES (1, ?, '0')`,
    [ZERO_ROOT],
  );

  const store: ClientStore = { client: key, dir, blobsDir, db };
  cache.set(key, store);
  return store;
}

export function readState(store: ClientStore): PairState {
  const row = store.db
    .query<{ outer_root: string; total_size: string }, []>(
      "SELECT outer_root, total_size FROM state WHERE id = 1",
    )
    .get();
  if (!row) throw new Error("state row missing");
  return { outerRoot: row.outer_root as Hex, totalSize: BigInt(row.total_size) };
}

export function writeState(store: ClientStore, state: PairState, txHash: Hex): void {
  store.db.run(
    "UPDATE state SET outer_root = ?, total_size = ?, last_tx_hash = ? WHERE id = 1",
    [state.outerRoot, state.totalSize.toString(), txHash],
  );
}

export function listFiles(store: ClientStore): FileRecord[] {
  const rows = store.db
    .query<{ file_root: string; size_bytes: number; uploaded_at: number }, []>(
      "SELECT file_root, size_bytes, uploaded_at FROM files ORDER BY uploaded_at ASC",
    )
    .all();
  return rows.map((r) => ({
    fileRoot: r.file_root as Hex,
    sizeBytes: r.size_bytes,
    uploadedAt: r.uploaded_at,
  }));
}

export function fileRoots(store: ClientStore): Hex[] {
  const rows = store.db
    .query<{ file_root: string }, []>("SELECT file_root FROM files")
    .all();
  return rows.map((r) => r.file_root as Hex);
}

export function hasFile(store: ClientStore, fileRoot: Hex): boolean {
  const row = store.db
    .query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM files WHERE file_root = ?")
    .get(fileRoot);
  return (row?.c ?? 0) > 0;
}

export function insertFile(store: ClientStore, rec: FileRecord): void {
  store.db.run("INSERT INTO files (file_root, size_bytes, uploaded_at) VALUES (?, ?, ?)", [
    rec.fileRoot,
    rec.sizeBytes,
    rec.uploadedAt,
  ]);
}

export function deleteFileRow(store: ClientStore, fileRoot: Hex): void {
  store.db.run("DELETE FROM files WHERE file_root = ?", [fileRoot]);
}

export interface ClientSummary {
  client: Address;
  outerRoot: Hex;
  totalSize: string;
  fileCount: number;
}

export function listClientSummaries(dataDir: string): ClientSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }

  const summaries: ClientSummary[] = [];
  for (const name of entries) {
    if (!isAddress(name, { strict: false })) continue;
    const client = getAddress(name);
    const store = getStore(dataDir, client);
    const state = readState(store);
    const countRow = store.db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM files")
      .get();
    summaries.push({
      client,
      outerRoot: state.outerRoot,
      totalSize: state.totalSize.toString(),
      fileCount: countRow?.c ?? 0,
    });
  }
  return summaries;
}
