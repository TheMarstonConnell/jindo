import { createHash, createHmac } from "node:crypto";
import { lookupSecret, type S3Db } from "./db.ts";

/**
 * Verify an AWS Signature Version 4 request against the credentials table.
 *
 * The verifier follows the SigV4 spec[1] using the values claimed in the
 * `Authorization` header (Credential / SignedHeaders / Signature) plus the
 * incoming request's headers, method, path, and query. The signing key is
 * derived from the secret stored under the credential's access key.
 *
 * Body verification is intentionally pass-through: we trust whatever the
 * client put in `x-amz-content-sha256` (whether that's `UNSIGNED-PAYLOAD`,
 * `STREAMING-AWS4-HMAC-SHA256-PAYLOAD`, or an actual hex hash). This matches
 * what S3-compatible servers do — verifying chunked-signed bodies would
 * require parsing the streaming body framing, which is more than this
 * gateway needs.
 *
 * [1] https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */
export interface SigV4Result {
  ok: boolean;
  reason?: string;
  accessKey?: string;
}

const AUTH_PREFIX = "AWS4-HMAC-SHA256 ";

export function verifySigV4(req: Request, hdb: S3Db, rawQuery: string): SigV4Result {
  const auth = req.headers.get("authorization");
  if (!auth) return { ok: false, reason: "missing Authorization" };
  if (!auth.startsWith(AUTH_PREFIX)) return { ok: false, reason: "wrong auth scheme" };

  const params: Record<string, string> = {};
  for (const segment of auth.slice(AUTH_PREFIX.length).split(",")) {
    const piece = segment.trim();
    const eq = piece.indexOf("=");
    if (eq < 0) return { ok: false, reason: "malformed Authorization" };
    params[piece.slice(0, eq)] = piece.slice(eq + 1);
  }
  const credential = params["Credential"];
  const signedHeadersStr = params["SignedHeaders"];
  const givenSignature = params["Signature"];
  if (!credential || !signedHeadersStr || !givenSignature) {
    return { ok: false, reason: "missing Authorization fields" };
  }

  const credParts = credential.split("/");
  if (credParts.length !== 5 || credParts[4] !== "aws4_request") {
    return { ok: false, reason: "bad credential scope" };
  }
  const [accessKey, dateStamp, region, service] = credParts as [
    string,
    string,
    string,
    string,
  ];

  const secretKey = lookupSecret(hdb, accessKey);
  if (!secretKey) return { ok: false, reason: "unknown access key", accessKey };

  const amzDate = req.headers.get("x-amz-date");
  if (!amzDate) return { ok: false, reason: "missing x-amz-date", accessKey };

  const url = new URL(req.url);
  const canonicalUri = url.pathname || "/";
  const canonicalQuery = canonicalizeQueryRaw(rawQuery);
  const signedHeaders = signedHeadersStr.split(";").map((h) => h.toLowerCase());
  const canonicalHeaders = signedHeaders
    .map((h) => `${h}:${(req.headers.get(h) ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const payloadHashHeader = req.headers.get("x-amz-content-sha256") ?? "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHashHeader,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const expected = hmacHex(kSigning, stringToSign);

  if (!constantTimeEquals(expected, givenSignature)) {
    return { ok: false, reason: "signature mismatch", accessKey };
  }
  return { ok: true, accessKey };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Decode-then-encode each (name, value) so whatever encoding the client used
// gets normalized to RFC3986 — the same form the SDK signs with.
function canonicalizeQueryRaw(rawQuery: string): string {
  if (!rawQuery) return "";
  const pairs: [string, string][] = [];
  for (const piece of rawQuery.split("&")) {
    if (!piece) continue;
    const eq = piece.indexOf("=");
    let name: string;
    let value: string;
    if (eq < 0) {
      name = piece;
      value = "";
    } else {
      name = piece.slice(0, eq);
      value = piece.slice(eq + 1);
    }
    name = encodeRfc3986(safeDecode(name));
    value = encodeRfc3986(safeDecode(value));
    pairs.push([name, value]);
  }
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
