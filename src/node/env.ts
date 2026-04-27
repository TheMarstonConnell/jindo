import type { Address, Hex } from "viem";
import { getAddress, isAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function asPrivateKey(v: string): Hex {
  const k = v.startsWith("0x") ? v : `0x${v}`;
  if (!isHex(k) || k.length !== 66) throw new Error("private key must be 32-byte hex");
  return k as Hex;
}

function asAddress(v: string): Address {
  if (!isAddress(v, { strict: false })) throw new Error(`invalid address: ${v}`);
  return getAddress(v);
}

export interface CommonEnv {
  privateKey: Hex;
  rpcUrl: string;
  contract: Address;
  account: Address;
}

export function loadCommon(): CommonEnv {
  const privateKey = asPrivateKey(required("JINDO_PRIVATE_KEY"));
  const account = privateKeyToAccount(privateKey).address;
  return {
    privateKey,
    rpcUrl: required("JINDO_RPC_URL"),
    contract: asAddress(required("JINDO_CONTRACT")),
    account,
  };
}

export interface HostEnv extends CommonEnv {
  port: number;
  dataDir: string;
}

export function loadHost(): HostEnv {
  return {
    ...loadCommon(),
    port: Number(process.env.JINDO_PORT ?? 5689),
    dataDir: process.env.JINDO_DATA_DIR ?? "./data",
  };
}

export interface ClientEnv extends CommonEnv {
  cacheDir: string;
}

export function loadClient(): ClientEnv {
  const home = process.env.HOME ?? ".";
  return {
    ...loadCommon(),
    cacheDir: process.env.JINDO_CACHE_DIR ?? `${home}/.jindo/cache`,
  };
}
