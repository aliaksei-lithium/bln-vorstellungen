/** sha256 hex of whitespace-normalized content, for RawItem.contentHash. Uses WebCrypto (off the JS CPU budget). */
export async function contentHash(content: string): Promise<string> {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
