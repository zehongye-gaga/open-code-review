// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { SQLiteState, inflate } = require("./state-sqlite.js");
function exportState(database, destination) {
  if (path.resolve(database) === path.resolve(destination)) throw Error("Export must not overwrite its database");
  const source = new SQLiteState(database, { readOnly: true });
  let data;
  try {
    source.db.exec("BEGIN");
    if (!source.db.prepare("SELECT 1 FROM state_head WHERE id=1").get()) throw Error("Source state not initialized");
    data = inflate(source.readRows());
  } finally { source.close(); }
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    const dir = fs.openSync(path.dirname(destination), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(temporary, { force: true }); }
}
if (require.main === module) {
  if (process.argv.length !== 4) throw Error("Usage: state-export.js state.db state.json (stop backend writers before rollback)");
  exportState(process.argv[2], process.argv[3]);
}
module.exports = { exportState };
