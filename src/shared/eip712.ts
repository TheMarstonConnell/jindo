import type { Address, Hex } from "viem";
import { recoverTypedDataAddress } from "viem";

export function buildDomain(chainId: number, verifyingContract: Address) {
  return {
    name: "Jindo",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

export const TYPES = {
  Upload: [
    { name: "host", type: "address" },
    { name: "client", type: "address" },
    { name: "fileRoots", type: "bytes32[]" },
    { name: "priorRoot", type: "bytes32" },
    { name: "newRoot", type: "bytes32" },
    { name: "newSize", type: "uint64" },
  ],
  Delete: [
    { name: "host", type: "address" },
    { name: "client", type: "address" },
    { name: "fileRoot", type: "bytes32" },
    { name: "priorRoot", type: "bytes32" },
    { name: "newRoot", type: "bytes32" },
    { name: "newSize", type: "uint64" },
  ],
} as const;

export interface UploadMessage {
  host: Address;
  client: Address;
  fileRoots: Hex[];
  priorRoot: Hex;
  newRoot: Hex;
  newSize: bigint;
}

export interface DeleteMessage {
  host: Address;
  client: Address;
  fileRoot: Hex;
  priorRoot: Hex;
  newRoot: Hex;
  newSize: bigint;
}

export type IntentKind = "Upload" | "Delete";
export type IntentMessage = UploadMessage | DeleteMessage;
export type MessageOf<K extends IntentKind> = K extends "Upload"
  ? UploadMessage
  : DeleteMessage;

export async function recoverIntentSigner<K extends IntentKind>(
  chainId: number,
  contract: Address,
  kind: K,
  message: MessageOf<K>,
  signature: Hex,
): Promise<Address> {
  const domain = buildDomain(chainId, contract);
  // viem's generics demand a literal primaryType; switch on the narrowed kind.
  if (kind === "Upload") {
    return recoverTypedDataAddress({
      domain,
      types: TYPES,
      primaryType: "Upload",
      message: message as UploadMessage,
      signature,
    });
  }
  return recoverTypedDataAddress({
    domain,
    types: TYPES,
    primaryType: "Delete",
    message: message as DeleteMessage,
    signature,
  });
}
