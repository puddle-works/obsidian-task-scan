import type { Contracts } from "https://raw.githubusercontent.com/puddle-works/puddle-tooling/v0.2.1/contracts/check.ts";

// Maps each model instance a workflow reads with data.latest(...) to its type
// and the data names it writes. The workflow passes data between steps as
// step outputs and reads nothing with data.latest, so this is empty.
export const CONTRACTS: Contracts = {};
