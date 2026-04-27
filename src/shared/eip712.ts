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
    { name: "fileRoot", type: "bytes32" },
    { name: "priorRoot", type: "bytes32" },
    { name: "newRoot", type: "bytes32" },
    { name: "newSize", type: "uint256" },
  ],
  Delete: [
    { name: "host", type: "address" },
    { name: "client", type: "address" },
    { name: "fileRoot", type: "bytes32" },
    { name: "priorRoot", type: "bytes32" },
    { name: "newRoot", type: "bytes32" },
    { name: "newSize", type: "uint256" },
  ],
} as const;

export interface IntentMessage {
  host: Address;
  client: Address;
  fileRoot: Hex;
  priorRoot: Hex;
  newRoot: Hex;
  newSize: bigint;
}

export type IntentKind = "Upload" | "Delete";

export async function recoverIntentSigner(
  chainId: number,
  contract: Address,
  kind: IntentKind,
  message: IntentMessage,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: buildDomain(chainId, contract),
    types: TYPES,
    primaryType: kind,
    message,
    signature,
  });
}
