/// Tiny S3-XML serializer / parser. We emit only the fields the AWS SDK and
/// most clients actually look for; ACL, ownership, and storage-class fields
/// are stubbed to fixed values.

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const NS = "http://s3.amazonaws.com/doc/2006-03-01/";

export function xmlError(code: string, message: string, resource?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message>${
    resource ? `<Resource>${escapeXml(resource)}</Resource>` : ""
  }</Error>`;
}

export function xmlListAllMyBuckets(
  buckets: { name: string; createdAt: number }[],
  ownerId: string,
): string {
  const owner = ownerId.toLowerCase();
  const items = buckets
    .map(
      (b) =>
        `<Bucket><Name>${escapeXml(b.name)}</Name><CreationDate>${new Date(
          b.createdAt * 1000,
        ).toISOString()}</CreationDate></Bucket>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="${NS}"><Owner><ID>${escapeXml(owner)}</ID><DisplayName>${escapeXml(
    owner,
  )}</DisplayName></Owner><Buckets>${items}</Buckets></ListAllMyBucketsResult>`;
}

export interface ListBucketResultArgs {
  bucket: string;
  prefix: string;
  maxKeys: number;
  isTruncated: boolean;
  continuationToken?: string;
  nextContinuationToken?: string;
  startAfter?: string;
  contents: { key: string; size: number; etag: string; lastModified: string }[];
}

export function xmlListBucketResult(args: ListBucketResultArgs): string {
  const items = args.contents
    .map(
      (c) =>
        `<Contents><Key>${escapeXml(c.key)}</Key><LastModified>${
          c.lastModified
        }</LastModified><ETag>&quot;${escapeXml(c.etag)}&quot;</ETag><Size>${
          c.size
        }</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="${NS}"><Name>${escapeXml(args.bucket)}</Name><Prefix>${escapeXml(
    args.prefix,
  )}</Prefix><KeyCount>${args.contents.length}</KeyCount><MaxKeys>${
    args.maxKeys
  }</MaxKeys><IsTruncated>${args.isTruncated}</IsTruncated>${
    args.continuationToken
      ? `<ContinuationToken>${escapeXml(args.continuationToken)}</ContinuationToken>`
      : ""
  }${
    args.nextContinuationToken
      ? `<NextContinuationToken>${escapeXml(args.nextContinuationToken)}</NextContinuationToken>`
      : ""
  }${args.startAfter ? `<StartAfter>${escapeXml(args.startAfter)}</StartAfter>` : ""}${items}</ListBucketResult>`;
}

export function xmlInitiateMultipart(bucket: string, key: string, uploadId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="${NS}"><Bucket>${escapeXml(
    bucket,
  )}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${escapeXml(
    uploadId,
  )}</UploadId></InitiateMultipartUploadResult>`;
}

export function xmlCompleteMultipart(
  bucket: string,
  key: string,
  etag: string,
  location: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="${NS}"><Location>${escapeXml(
    location,
  )}</Location><Bucket>${escapeXml(bucket)}</Bucket><Key>${escapeXml(
    key,
  )}</Key><ETag>&quot;${escapeXml(etag)}&quot;</ETag></CompleteMultipartUploadResult>`;
}

export function xmlListMultipartUploads(
  bucket: string,
  ups: { uploadId: string; key: string }[],
): string {
  const items = ups
    .map(
      (u) =>
        `<Upload><Key>${escapeXml(u.key)}</Key><UploadId>${escapeXml(
          u.uploadId,
        )}</UploadId></Upload>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="${NS}"><Bucket>${escapeXml(
    bucket,
  )}</Bucket><KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker><NextKeyMarker></NextKeyMarker><NextUploadIdMarker></NextUploadIdMarker><MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>${items}</ListMultipartUploadsResult>`;
}

/// Parse the XML body of a CompleteMultipartUpload request.
/// Permissive regex parser — the body is small and the structure is fixed.
export function parseCompleteMultipart(body: string): { partNumber: number; etag: string }[] {
  const out: { partNumber: number; etag: string }[] = [];
  const partRe = /<Part\b[^>]*>([\s\S]*?)<\/Part>/g;
  let m: RegExpExecArray | null;
  while ((m = partRe.exec(body))) {
    const inner = m[1] ?? "";
    const pn = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(inner);
    const et = /<ETag>([\s\S]*?)<\/ETag>/.exec(inner);
    if (!pn || !et) continue;
    const rawEtag = et[1] ?? "";
    const cleaned = rawEtag
      .trim()
      .replace(/&quot;/g, "")
      .replace(/^"|"$/g, "");
    out.push({ partNumber: parseInt(pn[1] ?? "0", 10), etag: cleaned });
  }
  return out;
}
