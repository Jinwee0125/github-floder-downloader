/* Minimal STORE-only ZIP writer (no compression).
 *
 * We only need STORE (method 0) because the user opted out of DEFLATE, and
 * avoiding a third-party dependency (JSZip) keeps the extension tiny and
 * dependency-free. Produces a Blob that browsers can download directly.
 *
 * Exposed as globalThis.GHDLZip = { createZip, crc32 }.
 */
(function (global) {
  'use strict';

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time =
      ((d.getHours() & 0x1f) << 11) |
      ((d.getMinutes() & 0x3f) << 5) |
      ((Math.floor(d.getSeconds() / 2)) & 0x1f);
    const date =
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      (((d.getMonth() + 1) & 0x0f) << 5) |
      (d.getDate() & 0x1f);
    return { time: time & 0xffff, date: date & 0xffff };
  }

  /**
   * @param {Array<{name: string, data: Uint8Array}>} files
   * @returns {Blob}
   */
  function createZip(files) {
    if (files.length > 0xffff) {
      // Classic ZIP stores the entry count in a 16-bit field (no ZIP64 support).
      throw new Error('Too many files for a single ZIP (max 65535).');
    }

    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(new Date());

    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.data;
      const crc = crc32(data);
      const size = data.length;

      // --- Local file header ---
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); // local file header signature
      lv.setUint16(4, 20, true); // version needed to extract
      lv.setUint16(6, 0x0800, true); // general purpose flag: UTF-8 names
      lv.setUint16(8, 0, true); // compression method: STORE
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true); // compressed size
      lv.setUint32(22, size, true); // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true); // extra field length
      local.set(nameBytes, 30);

      localParts.push(local, data);

      // --- Central directory header ---
      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); // central file header signature
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true); // method
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); // extra
      cv.setUint16(32, 0, true); // comment
      cv.setUint16(34, 0, true); // disk number start
      cv.setUint16(36, 0, true); // internal attributes
      cv.setUint32(38, 0, true); // external attributes
      cv.setUint32(42, offset, true); // relative offset of local header
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    }

    let centralSize = 0;
    for (const c of centralParts) centralSize += c.length;

    // --- End of central directory ---
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true); // disk number
    ev.setUint16(6, 0, true); // disk with central dir
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true); // comment length

    return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
  }

  global.GHDLZip = { createZip, crc32 };
})(globalThis);
