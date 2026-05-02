import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import type { ListResponse } from "../shared/types.ts";

const stripTrail = (u: string) => u.replace(/\/$/, "");

export async function fetchHostAddress(hostUrl: string): Promise<Address> {
  const res = await fetch(`${stripTrail(hostUrl)}/health`);
  if (!res.ok) throw new Error(`host health check failed: ${res.status}`);
  const body = (await res.json()) as { address: string };
  return getAddress(body.address);
}

export async function fetchList(hostUrl: string, client: Address): Promise<ListResponse> {
  const res = await fetch(`${stripTrail(hostUrl)}/list/${client}`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return (await res.json()) as ListResponse;
}

export interface UploadFile {
  bytes: Uint8Array;
  filename?: string;
}

/// Upload one or more files in a single multipart POST. The intent JSON
/// references each file's hash via `fileRoots[i]` matching `files[i]` order;
/// the server iterates form.getAll("file") in arrival order to align them.
export async function postUpload(
  hostUrl: string,
  files: UploadFile[],
  intent: unknown,
): Promise<{ txHash: Hex; outerRoot: Hex }> {
  if (files.length === 0) throw new Error("postUpload: at least one file required");
  const form = new FormData();
  form.append("intent", JSON.stringify(intent));
  for (const [i, f] of files.entries()) {
    // Cast: viem-style Uint8Array<ArrayBufferLike> isn't assignable to BlobPart's
    // expected ArrayBufferView<ArrayBuffer>, but at runtime it's a perfectly valid Blob source.
    form.append("file", new Blob([f.bytes as BlobPart]), f.filename ?? `blob-${i}`);
  }
  const res = await fetch(`${stripTrail(hostUrl)}/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { txHash: Hex; outerRoot: Hex };
}

export async function fetchDownload(hostUrl: string, fileRoot: Hex): Promise<Uint8Array> {
  const res = await fetch(`${stripTrail(hostUrl)}/download/${fileRoot}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function postDelete(
  hostUrl: string,
  body: unknown,
): Promise<{ txHash: Hex; outerRoot: Hex }> {
  const res = await fetch(`${stripTrail(hostUrl)}/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`delete failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { txHash: Hex; outerRoot: Hex };
}
