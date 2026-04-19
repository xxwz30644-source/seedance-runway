/**
 * Minimal ZIP utilities (Store mode, no compression)
 * For Chrome Extension MV3 — no external dependencies
 */

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeU16(view, offset, val) { view.setUint16(offset, val, true); }
function writeU32(view, offset, val) { view.setUint32(offset, val, true); }

/**
 * Create a ZIP file (Store mode — no compression)
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Blob}
 */
export function createZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map(f => ({
    name: encoder.encode(f.name),
    data: f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data),
  }));

  // Calculate total size
  let localSize = 0;
  for (const e of entries) {
    localSize += 30 + e.name.length + e.data.length;
  }
  let centralSize = 0;
  for (const e of entries) {
    centralSize += 46 + e.name.length;
  }
  const eocdSize = 22;
  const totalSize = localSize + centralSize + eocdSize;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  let localOffset = 0;
  const offsets = [];

  // Write local file headers + data
  for (const e of entries) {
    offsets.push(localOffset);
    const crc = crc32(e.data);
    const o = localOffset;

    writeU32(view, o, 0x04034b50);       // local file header signature
    writeU16(view, o + 4, 20);            // version needed
    writeU16(view, o + 6, 0);             // flags
    writeU16(view, o + 8, 0);             // compression: store
    writeU16(view, o + 10, 0);            // mod time
    writeU16(view, o + 12, 0);            // mod date
    writeU32(view, o + 14, crc);          // crc-32
    writeU32(view, o + 18, e.data.length); // compressed size
    writeU32(view, o + 22, e.data.length); // uncompressed size
    writeU16(view, o + 26, e.name.length); // filename length
    writeU16(view, o + 28, 0);            // extra field length

    u8.set(e.name, o + 30);
    u8.set(e.data, o + 30 + e.name.length);

    localOffset = o + 30 + e.name.length + e.data.length;
  }

  // Write central directory
  const centralStart = localOffset;
  let cdOffset = centralStart;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const crc = crc32(e.data);
    const o = cdOffset;

    writeU32(view, o, 0x02014b50);        // central dir signature
    writeU16(view, o + 4, 20);             // version made by
    writeU16(view, o + 6, 20);             // version needed
    writeU16(view, o + 8, 0);              // flags
    writeU16(view, o + 10, 0);             // compression: store
    writeU16(view, o + 12, 0);             // mod time
    writeU16(view, o + 14, 0);             // mod date
    writeU32(view, o + 16, crc);           // crc-32
    writeU32(view, o + 20, e.data.length); // compressed size
    writeU32(view, o + 24, e.data.length); // uncompressed size
    writeU16(view, o + 28, e.name.length); // filename length
    writeU16(view, o + 30, 0);             // extra field length
    writeU16(view, o + 32, 0);             // file comment length
    writeU16(view, o + 34, 0);             // disk number start
    writeU16(view, o + 36, 0);             // internal file attributes
    writeU32(view, o + 38, 0);             // external file attributes
    writeU32(view, o + 42, offsets[i]);    // local header offset

    u8.set(e.name, o + 46);
    cdOffset = o + 46 + e.name.length;
  }

  // Write EOCD
  const o = cdOffset;
  writeU32(view, o, 0x06054b50);                  // EOCD signature
  writeU16(view, o + 4, 0);                        // disk number
  writeU16(view, o + 6, 0);                        // central dir disk
  writeU16(view, o + 8, entries.length);            // entries on this disk
  writeU16(view, o + 10, entries.length);           // total entries
  writeU32(view, o + 12, cdOffset - centralStart);  // central dir size
  writeU32(view, o + 16, centralStart);             // central dir offset
  writeU16(view, o + 20, 0);                        // comment length

  return new Blob([buf], { type: 'application/zip' });
}

/**
 * Parse a ZIP file (Store mode)
 * @param {ArrayBuffer} buffer
 * @returns {Array<{name: string, data: Uint8Array}>}
 */
export function parseZip(buffer) {
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const files = [];

  let offset = 0;
  while (offset + 4 <= u8.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // not a local file header

    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const compSize = view.getUint32(offset + 18, true);
    const name = decoder.decode(u8.subarray(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = u8.slice(dataStart, dataStart + compSize);

    files.push({ name, data });
    offset = dataStart + compSize;
  }

  return files;
}
