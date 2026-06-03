import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Hex } from "viem";
import { fileRoot as computeFileRoot } from "../shared/merkle.ts";
import {
  buildFolder,
  serializeFolder,
  type JindoFolderChild,
} from "../lib/folder.ts";
import type { JindoClient } from "../lib/client.ts";

/// Recursively upload a directory as a Jindo folder. Walks `localPath`
/// leaf-first, computing each file's root and synthesizing folder JSON
/// blobs for every directory. All blobs (regular files plus the folder
/// JSONs) are uploaded in a single signed batch. Files whose root is
/// already in the client's local cache are skipped; duplicate files
/// within the tree are deduplicated.
///
/// Returns the top-level folder's id (its file root). Use that id with
/// `/serve/:id` on the host to browse the folder.
///
/// Lives in `src/node/` because it depends on `node:fs` — keeping it out
/// of the browser-importable `src/lib/` keeps the web bundle clean.
export async function uploadFolderFromDir(
  client: JindoClient,
  localPath: string,
): Promise<{ folderRoot: Hex; uploadedRoots: Hex[]; outerRoot: Hex }> {
  const tree = await readFolderTree(localPath);

  // Collect every blob we'd need to upload — files plus folder JSONs —
  // keyed by fileRoot so duplicate content (same file in two places, or
  // already-cached files) only appears once.
  const blobs = new Map<string, { bytes: Uint8Array; filename: string }>();
  const seenRoots = new Set(
    client.list().files.map((f) => f.fileRoot.toLowerCase()),
  );

  const queue = (root: Hex, bytes: Uint8Array, filename: string) => {
    const key = root.toLowerCase();
    if (seenRoots.has(key)) return;
    if (blobs.has(key)) return;
    blobs.set(key, { bytes, filename });
  };

  const { root: folderRoot } = serializeTree(tree, queue);

  // Nothing new to upload (folder + every file already in cache).
  if (blobs.size === 0) {
    const local = client.list().state;
    return { folderRoot, uploadedRoots: [], outerRoot: local.outerRoot };
  }

  const filesToUpload = [...blobs.values()];
  const { fileRoots, outerRoot } = await client.upload(filesToUpload);
  return { folderRoot, uploadedRoots: fileRoots, outerRoot };
}

type DirNode = { type: "dir"; name: string; children: TreeNode[] };
type FileNode = { type: "file"; name: string; bytes: Uint8Array };
type TreeNode = DirNode | FileNode;

async function readFolderTree(localPath: string): Promise<DirNode> {
  const trimmed = localPath.replace(/\/+$/, "");
  const name = basename(trimmed) || trimmed;
  const root: DirNode = { type: "dir", name, children: [] };
  await readDirInto(trimmed, root);
  return root;
}

async function readDirInto(absPath: string, into: DirNode): Promise<void> {
  const entries = await readdir(absPath, { withFileTypes: true });
  // Sort for deterministic folder JSON output.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const childPath = join(absPath, entry.name);
    if (entry.isDirectory()) {
      const sub: DirNode = { type: "dir", name: entry.name, children: [] };
      await readDirInto(childPath, sub);
      into.children.push(sub);
    } else if (entry.isFile()) {
      const bytes = new Uint8Array(await Bun.file(childPath).arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error(`cannot upload empty file: ${childPath}`);
      }
      into.children.push({ type: "file", name: entry.name, bytes });
    }
    // Symlinks, sockets, etc. are skipped silently.
  }
}

/// Walk a tree leaf-first, queuing every blob that needs uploading. Returns
/// the top-level folder's id (file root) and its rolled-up size in bytes.
function serializeTree(
  node: DirNode,
  queue: (root: Hex, bytes: Uint8Array, filename: string) => void,
): { root: Hex; size: number } {
  const children: JindoFolderChild[] = [];
  for (const child of node.children) {
    if (child.type === "file") {
      const root = computeFileRoot(child.bytes);
      queue(root, child.bytes, child.name);
      children.push({ name: child.name, size: child.bytes.byteLength, id: root });
    } else {
      const sub = serializeTree(child, queue);
      children.push({ name: child.name, size: sub.size, id: sub.root });
    }
  }
  const folder = buildFolder(node.name, children);
  const bytes = serializeFolder(folder);
  const root = computeFileRoot(bytes);
  queue(root, bytes, `${node.name}.jindo-folder.json`);
  return { root, size: folder.size };
}
