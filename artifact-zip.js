'use strict';

const zlib = require('node:zlib');

/**
 * Compute CRC32 checksum for a buffer
 */
function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ~crc >>> 0;
}

/**
 * Sanitize relative file path to prevent zip directory traversal attacks
 */
function sanitizeZipPath(rawPath) {
  if (!rawPath) return 'file.txt';
  const normalized = String(rawPath)
    .replace(/\\/g, '/')
    .replace(/\.\.+/g, '')
    .replace(/^\/+/, '')
    .trim();
  return normalized || 'file.txt';
}

/**
 * Generate a standard PKZIP buffer from an array of files
 * @param {Array<{path: string, content: string|Buffer}>} files
 * @returns {Buffer} Standard ZIP file buffer
 */
function createZipBuffer(files = []) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  const validFiles = Array.isArray(files) ? files : [];

  for (const f of validFiles) {
    const cleanPath = sanitizeZipPath(f.path || f.name);
    const nameBuf = Buffer.from(cleanPath, 'utf8');
    const dataBuf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ''), 'utf8');

    // Attempt DEFLATE compression
    let compressed;
    try {
      compressed = zlib.deflateRawSync(dataBuf);
    } catch {
      compressed = dataBuf;
    }

    const useCompressed = compressed.length < dataBuf.length;
    const method = useCompressed ? 8 : 0; // 8 = DEFLATE, 0 = STORE
    const body = useCompressed ? compressed : dataBuf;
    const checksum = crc32(dataBuf);

    // Current DOS date/time (default to constant for deterministic builds)
    const now = new Date();
    const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
    const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);

    // Local file header (30 bytes + name length)
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);       // Local file header signature
    local.writeUInt16LE(20, 4);               // Version needed to extract (2.0)
    local.writeUInt16LE(0, 6);                // General purpose bit flag
    local.writeUInt16LE(method, 8);           // Compression method
    local.writeUInt16LE(dosTime, 10);         // Last mod file time
    local.writeUInt16LE(dosDate, 12);         // Last mod file date
    local.writeUInt32LE(checksum, 14);        // CRC-32
    local.writeUInt32LE(body.length, 18);     // Compressed size
    local.writeUInt32LE(dataBuf.length, 22);  // Uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);  // File name length
    local.writeUInt16LE(0, 28);               // Extra field length
    nameBuf.copy(local, 30);

    // Central directory header (46 bytes + name length)
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);     // Central directory header signature
    central.writeUInt16LE(20, 4);             // Version made by
    central.writeUInt16LE(20, 6);             // Version needed to extract (2.0)
    central.writeUInt16LE(0, 8);              // General purpose bit flag
    central.writeUInt16LE(method, 10);        // Compression method
    central.writeUInt16LE(dosTime, 12);       // Last mod file time
    central.writeUInt16LE(dosDate, 14);       // Last mod file date
    central.writeUInt32LE(checksum, 16);      // CRC-32
    central.writeUInt32LE(body.length, 20);   // Compressed size
    central.writeUInt32LE(dataBuf.length, 24);// Uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);// File name length
    central.writeUInt16LE(0, 30);             // Extra field length
    central.writeUInt16LE(0, 32);             // File comment length
    central.writeUInt16LE(0, 34);             // Disk number start
    central.writeUInt16LE(0, 36);             // Internal file attributes
    central.writeUInt32LE(0, 38);             // External file attributes
    central.writeUInt32LE(offset, 42);        // Relative offset of local header
    nameBuf.copy(central, 46);

    localHeaders.push(local, body);
    centralHeaders.push(central);
    offset += local.length + body.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((acc, b) => acc + b.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // EOCD signature
  eocd.writeUInt16LE(0, 4);                   // Number of this disk
  eocd.writeUInt16LE(0, 6);                   // Disk where central directory starts
  eocd.writeUInt16LE(validFiles.length, 8);   // Number of central directory records on this disk
  eocd.writeUInt16LE(validFiles.length, 10);  // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);     // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);   // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                  // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

module.exports = {
  crc32,
  sanitizeZipPath,
  createZipBuffer,
};
