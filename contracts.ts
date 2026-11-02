import type { Contracts } from "https://raw.githubusercontent.com/puddle-works/puddle-tooling/v0.2.1/contracts/check.ts";
import { model as obsidianTaskScan } from "./extensions/models/obsidian_task_scan.ts";

// Maps each model instance a workflow reads with data.latest(...) to its type
// and the data names it writes. The ask and pick jobs read the batches of
// run and match with data.latest, so they need this entry.
export const CONTRACTS: Contracts = {
  "obsidian-task-scan-model": {
    model: obsidianTaskScan,
    data: {
      result: "result",
      classified: "classified",
      matched: "matched",
      logged: "logged",
    },
  },
};
