import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { Address, Hex } from "viem";
import type { CacheFactory, CacheStore } from "../lib/cache.ts";
import { ZERO_ROOT, type FileRecord, type PairState } from "../shared/types.ts";

function pairKey(host: Address, client: Address): string {
  return `${host.toLowerCase()}-${client.toLowerCase()}`;
}

export class SqliteCacheStore implements CacheStore {
  private constructor(private readonly db: Database) {}

  static open(cacheDir: string, host: Address, client: Address): SqliteCacheStore {
    mkdirSync(cacheDir, { recursive: true });
    const path = `${cacheDir}/${pairKey(host, client)}.sqlite`;
    const db = new Database(path);
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
        total_size TEXT NOT NULL
      );
    `);
    db.run("INSERT OR IGNORE INTO state (id, outer_root, total_size) VALUES (1, ?, '0')", [
      ZERO_ROOT,
    ]);
    return new SqliteCacheStore(db);
  }

  readState(): PairState {
    const row = this.db
      .query<{ outer_root: string; total_size: string }, []>(
        "SELECT outer_root, total_size FROM state WHERE id = 1",
      )
      .get();
    if (!row) throw new Error("client cache state missing");
    return { outerRoot: row.outer_root as Hex, totalSize: BigInt(row.total_size) };
  }

  writeState(state: PairState): void {
    this.db.run("UPDATE state SET outer_root = ?, total_size = ? WHERE id = 1", [
      state.outerRoot,
      state.totalSize.toString(),
    ]);
  }

  listFiles(): FileRecord[] {
    return this.db
      .query<{ file_root: string; size_bytes: number; uploaded_at: number }, []>(
        "SELECT file_root, size_bytes, uploaded_at FROM files ORDER BY uploaded_at ASC",
      )
      .all()
      .map((r) => ({
        fileRoot: r.file_root as Hex,
        sizeBytes: r.size_bytes,
        uploadedAt: r.uploaded_at,
      }));
  }

  fileRoots(): Hex[] {
    return this.db
      .query<{ file_root: string }, []>("SELECT file_root FROM files")
      .all()
      .map((r) => r.file_root as Hex);
  }

  insertFile(rec: FileRecord): void {
    this.db.run("INSERT INTO files (file_root, size_bytes, uploaded_at) VALUES (?, ?, ?)", [
      rec.fileRoot,
      rec.sizeBytes,
      rec.uploadedAt,
    ]);
  }

  deleteFile(fileRoot: Hex): void {
    this.db.run("DELETE FROM files WHERE file_root = ?", [fileRoot]);
  }

  replaceAll(files: FileRecord[], state: PairState): void {
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM files");
      for (const f of files) this.insertFile(f);
      this.writeState(state);
    });
    tx();
  }
}

export function sqliteCacheFactory(cacheDir: string): CacheFactory {
  return (host, client) => SqliteCacheStore.open(cacheDir, host, client);
}
