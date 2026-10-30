// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");
async function backupMonitor(database, directory, now = new Date()) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `audit-${now.toISOString().slice(0, 10)}.db`, target = path.join(directory, name);
  const valid = (file) => {
    let check;
    try {
      check = new DatabaseSync(file, { readOnly: true });
      return check.prepare("PRAGMA integrity_check").get().integrity_check === "ok" &&
        check.prepare("SELECT 1 FROM meta WHERE key='dashboard'").get() !== undefined;
    } catch { return false; } finally { check?.close(); }
  };
  if (fs.existsSync(target) && valid(target)) return target;
  const temporary = target + "." + require("node:crypto").randomUUID() + ".tmp";
  fs.closeSync(fs.openSync(temporary, "wx", 0o600));
  try {
    const source = new DatabaseSync(database, { readOnly: true });
    try { await backup(source, temporary); } finally { source.close(); }
    if (!valid(temporary)) throw Error("Backup integrity check failed");
    const fd = fs.openSync(temporary, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    const dir = fs.openSync(directory, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    for (const file of fs.readdirSync(directory).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7)) {
      try { fs.unlinkSync(path.join(directory, file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(temporary + suffix, { force: true });
  }
  return target;
}
if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  backupMonitor(config.sqlite.database, config.sqlite.backupDirectory || path.join(path.dirname(config.sqlite.database), "backups"))
    .then(() => console.log("SQLite backup verified")).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { backupMonitor };
