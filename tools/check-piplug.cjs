// Verify a .piplug is a store-only (uncompressed) zip with manifest.json at the root.
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);

function findEocd(buffer) {
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('no end-of-central-directory record: not a zip');
}

const eocd = findEocd(buf);
const count = buf.readUInt16LE(eocd + 10);
let offset = buf.readUInt32LE(eocd + 16);
console.log(`entries: ${count}`);

let deflated = 0;
const names = [];
for (let i = 0; i < count; i += 1) {
  if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`bad central header at ${offset}`);
  const method = buf.readUInt16LE(offset + 10);
  const size = buf.readUInt32LE(offset + 20);
  const nameLen = buf.readUInt16LE(offset + 28);
  const extraLen = buf.readUInt16LE(offset + 30);
  const commentLen = buf.readUInt16LE(offset + 32);
  const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
  if (method !== 0) deflated += 1;
  names.push(`${name} (${size}B, method=${method})`);
  offset += 46 + nameLen + extraLen + commentLen;
}
console.log(names.join('\n'));
console.log(`\nstore-only (no deflate): ${deflated === 0 ? 'YES' : `NO — ${deflated} deflated entries`}`);
console.log(`manifest.json at root: ${names.some((n) => n.startsWith('manifest.json ')) ? 'YES' : 'NO'}`);
