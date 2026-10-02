// A ZIP archive of a few files, stored without compression: a demo's video is compressed already,
// and every system opens such an archive without extra tools.

import { crc32 } from 'node:zlib';

export interface ZipEntry {
  /** The path inside the archive, with `/` between directories. */
  name: string;
  data: Uint8Array;
}

/** The archive as bytes; files up to 4 GiB each (ZIP without its 64-bit extension). */
export function zip(entries: ZipEntry[], at = new Date()): Uint8Array<ArrayBuffer> {
  const time = ((at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1)) & 0xffff;
  const date = (((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()) & 0xffff;
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const crc = crc32(e.data) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 10, true); // version needed: 1.0
    local.setUint16(6, 0x0800, true); // names in UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 0x031e, true); // made by: Unix, 3.0 (so the file mode below counts)
    head.setUint16(6, 10, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(12, time, true);
    head.setUint16(14, date, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, e.data.length, true);
    head.setUint32(24, e.data.length, true);
    head.setUint16(28, name.length, true);
    head.setUint32(38, (0o100644 << 16) >>> 0, true);
    head.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of all) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
