'use strict';
// ZIP extraction in JavaScript, entry by entry, so a crafted archive cannot
// write outside the target folder ("zip slip"), plant symlinks or inflate
// into a disk-filling bomb. No system unzip binary is needed.
const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const yauzl = require('yauzl');

const DEFAULTS = { maxFiles: 20000, maxBytes: 1024 * 1024 * 1024 };

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function openEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

function isSymlink(entry) {
  // Upper 16 bits of externalFileAttributes carry the Unix mode when made on Unix.
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

async function extractZip(file, dest, limits = {}) {
  const { maxFiles, maxBytes } = { ...DEFAULTS, ...limits };
  const root = path.resolve(dest);
  await fs.ensureDir(root);
  const zip = await openZip(file);
  let files = 0;
  let bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          const name = entry.fileName.replace(/\\/g, '/');
          // macOS archive noise is never part of the app.
          if (name.startsWith('__MACOSX/') || path.basename(name) === '.DS_Store') return zip.readEntry();
          if (name.includes('\0') || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) throw new Error(`Unsafe path in archive: ${name}`);
          const target = path.resolve(root, name);
          if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Unsafe path in archive: ${name}`);
          if (isSymlink(entry)) throw new Error(`Symbolic links are not allowed in archives: ${name}`);
          if (name.endsWith('/')) {
            await fs.ensureDir(target);
            return zip.readEntry();
          }
          files += 1;
          if (files > maxFiles) throw new Error(`Archive has more than ${maxFiles} files`);
          await fs.ensureDir(path.dirname(target));
          const stream = await openEntry(zip, entry);
          const counter = new Transform({
            transform(chunk, _enc, cb) {
              bytes += chunk.length;
              if (bytes > maxBytes) return cb(new Error(`Archive expands beyond ${Math.round(maxBytes / 1048576)} MB`));
              cb(null, chunk);
            },
          });
          const mode = (entry.externalFileAttributes >>> 16) & 0o777;
          await pipeline(stream, counter, fs.createWriteStream(target, { mode: mode & 0o100 ? 0o755 : 0o644 }));
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  await flattenSingleRoot(root);
  return { files, bytes };
}

/** If the archive held one top-level folder (my-app/...), lift its content up. */
async function flattenSingleRoot(dir) {
  const entries = await fs.readdir(dir);
  if (entries.length !== 1) return;
  const only = path.join(dir, entries[0]);
  if (!(await fs.lstat(only)).isDirectory()) return;
  const tmp = path.join(dir, `.flatten-${Date.now()}`);
  await fs.move(only, tmp);
  for (const e of await fs.readdir(tmp)) await fs.move(path.join(tmp, e), path.join(dir, e));
  await fs.remove(tmp);
}

module.exports = { extractZip, flattenSingleRoot };
