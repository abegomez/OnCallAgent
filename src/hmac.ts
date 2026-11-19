import { createHmac, timingSafeEqual } from "node:crypto";

export function signBody(secret: string, raw: Buffer): string {
  const hex = createHmac("sha256", secret).update(raw).digest("hex");
  return `sha256=${hex}`;
}

export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = signBody(secret, raw);
  const provided = Buffer.from(header);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length) return false;
  return timingSafeEqual(provided, computed);
}

export function tokensMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
