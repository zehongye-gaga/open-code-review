// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const path = require("node:path");
const { SQLiteState } = require("./state-sqlite.js");
function writeState(directory, value) {
  const state = new SQLiteState(path.join(directory, "state.db"));
  try { state.save(value); } finally { state.close(); }
}
module.exports = { writeState };
