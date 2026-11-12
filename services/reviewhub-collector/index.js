// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { setTimeout: sleep } = require("node:timers/promises");
const { PostgresStore } = require("./database/postgres.js");
const { collect, optionsFromFile } = require("./collector.js");
async function main() {
  if (!process.env.REVIEWHUB_DATABASE_URL || !process.argv[2])
    throw Error(
      "Set REVIEWHUB_DATABASE_URL and supply the collector config path"
    );
  const sourceId = process.env.REVIEWHUB_SOURCE_ID || "ocr-github";
  const { options, config } = optionsFromFile(process.argv[2]);
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  let failures = 0;
  while (!abort.signal.aborted) {
    const store = new PostgresStore(
      process.env.REVIEWHUB_DATABASE_URL,
      sourceId
    );
    try {
      let saved = await store.connect();
      do {
        const result = await collect({ options, config, store, saved });
        saved = result.saved;
        failures = 0;
        console.info(
          JSON.stringify({
            service: "reviewhub-collector",
            sourceId,
            collectedAt: result.batch.collectedAt,
            repositories: result.batch.repositories.length,
            runs: result.batch.runs.length,
            warnings: result.batch.warnings,
            mode: saved.checkpoint.mode,
            changedRows: saved.checkpoint.changedRows
          })
        );
        if (process.argv.includes("--once")) return;
        await sleep(options.intervalSeconds * 1000, undefined, {
          signal: abort.signal
        });
      } while (!abort.signal.aborted);
    } catch {
      if (abort.signal.aborted) break;
      failures++;
      await store.failure("COLLECTION_FAILED").catch(() => {});
      console.error(
        JSON.stringify({
          service: "reviewhub-collector",
          sourceId,
          code: "COLLECTION_FAILED"
        })
      );
      if (process.argv.includes("--once"))
        throw Error(
          "Collection failed; last committed data and cursor preserved"
        );
    } finally {
      await store.close();
    }
    if (!abort.signal.aborted)
      await sleep(
        Math.min(
          options.intervalSeconds *
            1000 *
            Math.pow(2, Math.min(failures - 1, 3)),
          3600000
        ),
        undefined,
        { signal: abort.signal }
      ).catch(() => {});
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
