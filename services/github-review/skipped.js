// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { jobOutcome } = require("./outcome.js");
module.exports = { normalSkip: (job) => jobOutcome(job)?.reason === "no_reviewable_items" };
