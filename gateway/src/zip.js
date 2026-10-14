'use strict';
// Minimal ZIP reader and writer for DOCX parts (stored and deflated entries, no ZIP64).
const zlib = require('zlib');
const {GatewayError} = require('./errors');

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

function invalid(message) {
  return new GatewayError(422, 'GW-422-NOT-DOCX', message);
}

function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid('File is not a DOCX (ZIP) archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw invalid('ZIP64 archives are not supported');

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid('Corrupted ZIP central directory');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, {
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      size: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42)
    });
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }

  function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw invalid(`Corrupted ZIP entry ${name}`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + entry.compressedSize);
    if (entry.size > MAX_ENTRY_BYTES) throw invalid(`ZIP entry ${name} is too large`);
    if (entry.method === 0) return data;
    if (entry.method === 8) {
      try {
        return zlib.inflateRawSync(data, {maxOutputLength: MAX_ENTRY_BYTES});
      } catch (err) {
        throw invalid(`Cannot decompress ${name}: ${err.message}`);
      }
    }
    throw invalid(`Unsupported ZIP compression method ${entry.method} in ${name}`);
  }

  function readText(name) {
    const data = read(name);
    return data ? data.toString('utf8') : null;
  }

  return {names: () => [...entries.keys()], read, readText};
}

// Writes entries ([name, Buffer] in archive order) deflated, as Word and the editor do.
function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const packed = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  if (files.length >= 0xffff || offset >= 0xffffffff) throw invalid('Document is too large to write without ZIP64');
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

module.exports = {readZip, writeZip};
