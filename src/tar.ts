/**
 * Minimal tar reader, enough for a GitHub tarball.
 *
 * GitHub serves repositories from codeload as a single gzipped tar, which is
 * one request instead of a walk over the contents API and it brings bundled
 * Skill files along for free. Workers has DecompressionStream('gzip'), so the
 * only missing piece is the tar format itself -- 512-byte headers, 512-byte
 * aligned payloads, two zero blocks at the end.
 */

export interface TarEntry {
  path: string;
  content: string;
  size: number;
}

/** Files larger than this are skipped: a Skill is markdown, not a binary. */
const MAX_ENTRY_BYTES = 512 * 1024;

export async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function readTar(buf: Uint8Array): TarEntry[] {
  const decoder = new TextDecoder();
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    // Two consecutive zero blocks mark the end; one is enough to stop on.
    if (header.every((b) => b === 0)) break;

    const name = cstr(decoder, header.subarray(0, 100));
    const size = parseOctal(decoder, header.subarray(124, 12 + 124));
    const typeflag = String.fromCharCode(header[156]);
    // Long paths are split across a prefix field in ustar archives.
    const prefix = cstr(decoder, header.subarray(345, 345 + 155));
    const path = prefix ? `${prefix}/${name}` : name;

    offset += 512;

    // '0' and '\0' are regular files. Directories, symlinks and PAX headers
    // are skipped -- a Skill needs none of them.
    if ((typeflag === "0" || typeflag === "\0") && size > 0 && size <= MAX_ENTRY_BYTES) {
      entries.push({ path, size, content: decoder.decode(buf.subarray(offset, offset + size)) });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

function cstr(decoder: TextDecoder, bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
}

function parseOctal(decoder: TextDecoder, bytes: Uint8Array): number {
  const text = cstr(decoder, bytes).replace(/[^0-7]/g, "");
  return text ? parseInt(text, 8) : 0;
}
