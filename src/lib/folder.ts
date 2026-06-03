import type { Hex } from "viem";

export const FOLDER_KIND = "jindo-folder";
export const FOLDER_VERSION = 1;

export interface JindoFolderChild {
  name: string;
  /// Recursive content size: file bytes for a file, rolled-up byte total
  /// of every descendant for a child folder.
  size: number;
  id: Hex;
}

export interface JindoFolder {
  kind: typeof FOLDER_KIND;
  version: typeof FOLDER_VERSION;
  name: string;
  /// Recursive content size — the sum of every descendant's bytes.
  size: number;
  children: JindoFolderChild[];
}

export function buildFolder(
  name: string,
  children: JindoFolderChild[],
): JindoFolder {
  const seen = new Set<string>();
  for (const c of children) {
    if (seen.has(c.name)) {
      throw new Error(`duplicate child name in folder "${name}": ${c.name}`);
    }
    seen.add(c.name);
  }
  const size = children.reduce((acc, c) => acc + c.size, 0);
  return { kind: FOLDER_KIND, version: FOLDER_VERSION, name, size, children };
}

export function serializeFolder(folder: JindoFolder): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(folder));
}

export function tryParseFolder(bytes: Uint8Array): JindoFolder | null {
  // Cheap pre-check: a folder JSON always begins with `{` after at most a
  // BOM. Skip JSON.parse on anything that obviously isn't an object.
  if (bytes.byteLength === 0) return null;
  const first = bytes[0];
  if (first !== 0x7b /* { */ && first !== 0xef /* BOM */) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== FOLDER_KIND) return null;
  if (obj.version !== FOLDER_VERSION) return null;
  if (typeof obj.name !== "string") return null;
  if (typeof obj.size !== "number") return null;
  if (!Array.isArray(obj.children)) return null;
  const children: JindoFolderChild[] = [];
  for (const raw of obj.children) {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== "string") return null;
    if (typeof c.size !== "number") return null;
    if (typeof c.id !== "string" || !c.id.startsWith("0x")) return null;
    children.push({ name: c.name, size: c.size, id: c.id as Hex });
  }
  return {
    kind: FOLDER_KIND,
    version: FOLDER_VERSION,
    name: obj.name,
    size: obj.size,
    children,
  };
}
