'use strict';
// Backup encryption: AES-256-GCM, key from the passphrase with scrypt.
// File layout: "PIPAASE1" | salt (16) | iv (12) | ciphertext | tag (16).
// Streams, so a large backup never has to fit in the Pi's memory.
const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('PIPAASE1');
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, KDF);
}

async function encryptFile(src, dest, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
}

async function decryptFile(src, dest, passphrase) {
  const fd = await fs.promises.open(src, 'r');
  let header;
  let tag;
  let size;
  try {
    ({ size } = await fd.stat());
    if (size < MAGIC.length + 28 + 16) throw new Error('Not an encrypted Pi-PaaS backup');
    header = Buffer.alloc(MAGIC.length + 28);
    await fd.read(header, 0, header.length, 0);
    tag = Buffer.alloc(16);
    await fd.read(tag, 0, 16, size - 16);
  } finally {
    await fd.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted Pi-PaaS backup');
  const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = header.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: header.length, end: size - 17 }), decipher, fs.createWriteStream(dest, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw new Error(/auth/i.test(err.message) ? 'Wrong passphrase, or the backup file is damaged' : err.message);
  }
}

function isEncrypted(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, b, 0, b.length, 0);
    return b.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { encryptFile, decryptFile, isEncrypted };
