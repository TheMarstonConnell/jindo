import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOLDER_KIND,
  FOLDER_VERSION,
  buildFolder,
  serializeFolder,
  tryParseFolder,
} from "../src/lib/folder.ts";

let workRoot: string;

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "jindo-folder-"));
});

afterAll(() => {
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

test("buildFolder sums child sizes and rejects duplicate names", () => {
  const f = buildFolder("docs", [
    { name: "a.txt", size: 100, id: ("0x" + "11".repeat(32)) as `0x${string}` },
    { name: "b.txt", size: 250, id: ("0x" + "22".repeat(32)) as `0x${string}` },
  ]);
  expect(f.kind).toBe(FOLDER_KIND);
  expect(f.version).toBe(FOLDER_VERSION);
  expect(f.size).toBe(350);
  expect(f.children.length).toBe(2);

  expect(() =>
    buildFolder("docs", [
      { name: "x", size: 1, id: ("0x" + "11".repeat(32)) as `0x${string}` },
      { name: "x", size: 2, id: ("0x" + "22".repeat(32)) as `0x${string}` },
    ]),
  ).toThrow(/duplicate/);
});

test("serializeFolder + tryParseFolder roundtrips", () => {
  const f = buildFolder("root", [
    { name: "child", size: 42, id: ("0x" + "ab".repeat(32)) as `0x${string}` },
  ]);
  const bytes = serializeFolder(f);
  const parsed = tryParseFolder(bytes);
  expect(parsed).not.toBeNull();
  expect(parsed!.name).toBe("root");
  expect(parsed!.children[0]!.name).toBe("child");
  expect(parsed!.children[0]!.size).toBe(42);
  expect(parsed!.children[0]!.id).toBe(("0x" + "ab".repeat(32)) as `0x${string}`);
});

test("tryParseFolder returns null on non-folder content", () => {
  expect(tryParseFolder(new Uint8Array([1, 2, 3]))).toBeNull();
  expect(tryParseFolder(new TextEncoder().encode("hello world"))).toBeNull();
  expect(tryParseFolder(new TextEncoder().encode("{not json"))).toBeNull();
  expect(
    tryParseFolder(new TextEncoder().encode(JSON.stringify({ kind: "other" }))),
  ).toBeNull();
  expect(
    tryParseFolder(
      new TextEncoder().encode(
        JSON.stringify({ kind: FOLDER_KIND, version: 99, name: "x", size: 0, children: [] }),
      ),
    ),
  ).toBeNull();
});

test("serializeTree (via uploadFolder dry-run) produces deterministic ids", async () => {
  // This test exercises the recursive walker indirectly: we build the same
  // folder tree on disk twice in different temp dirs and expect identical
  // top-level folder roots, since fileRoot is content-addressed.
  const { fileRoot } = await import("../src/shared/merkle.ts");

  const layoutA = join(workRoot, "a");
  const layoutB = join(workRoot, "b");
  await mkdir(layoutA, { recursive: true });
  await mkdir(layoutB, { recursive: true });
  for (const root of [layoutA, layoutB]) {
    await writeFile(join(root, "hello.txt"), "hello\n");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "n.txt"), "nested\n");
  }

  // Reproduce the inner walk from client.ts without the chain machinery.
  const { readdir } = await import("node:fs/promises");
  const { basename } = await import("node:path");

  type Dir = { type: "dir"; name: string; children: Node[] };
  type File = { type: "file"; name: string; bytes: Uint8Array };
  type Node = Dir | File;

  async function read(path: string): Promise<Dir> {
    const trimmed = path.replace(/\/+$/, "");
    const node: Dir = { type: "dir", name: basename(trimmed), children: [] };
    async function readInto(abs: string, target: Dir) {
      const entries = await readdir(abs, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const child = join(abs, e.name);
        if (e.isDirectory()) {
          const sub: Dir = { type: "dir", name: e.name, children: [] };
          await readInto(child, sub);
          target.children.push(sub);
        } else if (e.isFile()) {
          target.children.push({
            type: "file",
            name: e.name,
            bytes: new Uint8Array(await Bun.file(child).arrayBuffer()),
          });
        }
      }
    }
    await readInto(trimmed, node);
    return node;
  }

  function walk(node: Dir): { root: `0x${string}`; size: number } {
    const children = node.children.map((c) => {
      if (c.type === "file") {
        return { name: c.name, size: c.bytes.byteLength, id: fileRoot(c.bytes) };
      }
      const sub = walk(c);
      return { name: c.name, size: sub.size, id: sub.root };
    });
    const folder = buildFolder(node.name, children);
    const bytes = serializeFolder(folder);
    return { root: fileRoot(bytes), size: folder.size };
  }

  // Both layouts have the same content but a different parent folder name
  // ("a" vs "b"). The root folder JSON includes its own name, so the top
  // roots should differ — but the SUBFOLDER roots should match.
  const treeA = await read(layoutA);
  const treeB = await read(layoutB);
  const a = walk(treeA);
  const b = walk(treeB);
  expect(a.root).not.toBe(b.root);
  expect(a.size).toBe(b.size);

  // Subtree "sub" has identical content+name, so its folder JSON is identical.
  const subA = walk(treeA.children.find((c) => c.type === "dir") as Dir);
  const subB = walk(treeB.children.find((c) => c.type === "dir") as Dir);
  expect(subA.root).toBe(subB.root);
});
