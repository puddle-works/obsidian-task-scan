/**
 * Tests for `candidates` and its recipe: spec version 3's answer, and a recipe
 * that matches the one agreed in that spec.
 *
 * Run with: make test
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { parse as parseYaml } from "jsr:@std/yaml@1";
import {
  candidatesAnswer,
  CandidatesSchema,
  type Logged,
  type LoggedItem,
  model,
} from "./obsidian_task_scan.ts";

const SCANNED = "2026-11-02T17:44:41.000Z";
const SCAN_LINE =
  "From the latest scan, 2026-11-02 17:44 UTC. Asking doesn't start a new scan.";

function item(
  text: string,
  extra: Partial<LoggedItem> = {},
): LoggedItem {
  return {
    path: "Projects/Ops.md",
    line: 7,
    text,
    heading: "Infra",
    id: "0000000000000001",
    withheld: false,
    classification: "candidate",
    choice: "extension",
    confidence: 0.8,
    outcome: "failed",
    ...extra,
  };
}

function scan(items: LoggedItem[]): Logged {
  return {
    logAs: "you@example.com",
    captureModel: "capture",
    items,
    counts: { logged: 0, matched: 0, skipped: 0, failed: 0 },
    loggedAt: SCANNED,
  };
}

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

async function agreedRecipe(): Promise<{
  examples: Array<{ phrase: string; answer: string }>;
  whenEmpty: string;
}> {
  const spec = JSON.parse(await read("../../spec/outcome-spec.v3.json"));
  assertEquals(spec.specification.version, 3);
  return spec.specification.recipe;
}

/** Run the `candidates` method with a stored scan; returns what it wrote. */
async function runCandidates(stored: unknown) {
  const writes: Array<{ spec: string; name: string; data: unknown }> = [];
  const asked: string[] = [];
  const result = await model.methods.candidates.execute(
    {},
    {
      globalArgs: { vaultPath: "/vault" },
      logger: { info: () => {} },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      readResource: (name: string) => {
        asked.push(name);
        return Promise.resolve(stored as Record<string, unknown> | null);
      },
    },
  );
  return { result, writes, asked };
}

Deno.test("each candidate shows its path, line, text and what happened to it", () => {
  const { answer, tasks } = candidatesAnswer(scan([
    item("Renew the domain", {
      outcome: "logged",
      request: { id: "r1", number: 63, url: "http://capture/requests/r1" },
    }),
    item("Back up the photos", {
      path: "Home.md",
      line: 12,
      outcome: "matched",
      extension: "@swamp/backup",
    }),
    item("Rotate the keys", {
      outcome: "skipped",
      reason: "Preview: logAs is empty, so nothing is logged.",
      wouldLog: true,
    }),
    item("Sync the calendar", {
      outcome: "failed",
      reason: "Capture could not be reached",
    }),
  ]));
  assertEquals(tasks, 4);
  assertEquals(
    answer,
    [
      "4 open tasks a swamp extension could do (Jev's confidence 0.5 or more):",
      "- Projects/Ops.md:7: Renew the domain (logged in Capture as #63)",
      "- Home.md:12: Back up the photos (matched to @swamp/backup)",
      "- Projects/Ops.md:7: Rotate the keys (not logged: the scan was a preview)",
      "- Projects/Ops.md:7: Sync the calendar (not logged: Capture could not be reached)",
      SCAN_LINE,
    ].join("\n"),
  );
});

Deno.test("one candidate reads as one task", () => {
  const { answer } = candidatesAnswer(scan([item("Renew the domain")]));
  assert(answer.startsWith("1 open task a swamp extension could do "));
});

Deno.test("only candidates are shown: never a withheld or unclassified task", () => {
  const { answer, tasks } = candidatesAnswer(scan([
    item("Keep me", { outcome: "failed", reason: "no answer" }),
    item("Call mum", {
      classification: "not_candidate",
      choice: "person",
      outcome: "skipped",
    }),
    item("password = hunter2hunter2", {
      classification: "withheld",
      withheld: true,
      outcome: "skipped",
    }),
    item("Jev never said", {
      classification: "unclassified",
      outcome: "skipped",
    }),
  ]));
  assertEquals(tasks, 1);
  assert(answer.includes("Keep me"));
  for (const left of ["Call mum", "hunter2", "Jev never said"]) {
    assertEquals(answer.includes(left), false, left);
  }
});

Deno.test("every candidate is listed, past the recipe engine's 20 lines", () => {
  const items = Array.from(
    { length: 23 },
    (_, i) => item(`Task number ${i + 1}`),
  );
  const { answer, tasks } = candidatesAnswer(scan(items));
  assertEquals(tasks, 23);
  assert(answer.includes("Task number 23"));
  assertEquals(answer.includes("… and"), false);
});

Deno.test("with no candidates the answer is the agreed empty text, with the scan's date", async () => {
  const { whenEmpty } = await agreedRecipe();
  const { answer, tasks } = candidatesAnswer(scan([
    item("Call mum", {
      classification: "not_candidate",
      choice: "person",
      outcome: "skipped",
    }),
  ]));
  assertEquals(tasks, 0);
  assertEquals(answer, `${whenEmpty}\n${SCAN_LINE}`);
});

Deno.test("with no scan yet the answer says so, and does not claim the vault is clear", async () => {
  const { whenEmpty } = await agreedRecipe();
  const { answer, tasks, scannedAt } = candidatesAnswer(null);
  assertEquals(tasks, 0);
  assertEquals(scannedAt, null);
  assertEquals(answer.includes(whenEmpty), false);
  assert(answer.includes("No scan has run yet"));
  assert(answer.includes("@puddleworks/obsidian-task-scan"));
});

Deno.test("candidates reads the latest logged data and stores only its answer", async () => {
  const { result, writes, asked } = await runCandidates(
    scan([item("Renew the domain", {
      outcome: "matched",
      extension: "@swamp/dns",
    })]),
  );
  assertEquals(asked, ["logged"]);
  assertEquals(writes.map((w) => [w.spec, w.name]), [[
    "candidates",
    "candidates",
  ]]);
  const stored = CandidatesSchema.parse(writes[0].data);
  assertEquals(stored.tasks, 1);
  assertEquals(stored.scannedAt, SCANNED);
  assert(stored.answer.includes("Renew the domain"));
  assertEquals(result.dataHandles, [{ name: "candidates" }]);
});

Deno.test("candidates with no stored scan still answers", async () => {
  const { writes } = await runCandidates(null);
  const stored = CandidatesSchema.parse(writes[0].data);
  assertEquals(stored.scannedAt, null);
  assert(stored.answer.includes("No scan has run yet"));
});

Deno.test("candidates fails on a stored scan it can't read, rather than saying none ran", async () => {
  await assertRejects(() => runCandidates({ items: "not a list" }));
});

Deno.test("the recipe's pattern matches the phrase agreed in the spec, as the engine compiles it", async () => {
  const recipe = await recipeTag();
  const { examples } = await agreedRecipe();
  assertEquals(examples.length, 1);
  const engine = new RegExp(`^(?:${recipe.pattern})$`, "i");
  assert(engine.test(examples[0].phrase), examples[0].phrase);
  assert(engine.test(`${examples[0].phrase}?`));
  assert(engine.test(examples[0].phrase.toUpperCase()));
  assertEquals(engine.test(`${examples[0].phrase} and fix the bug`), false);
  assertEquals(engine.test("which tasks could a swamp extension do"), false);
  assertEquals(engine.test(`fix ${examples[0].phrase}`), false);
});

Deno.test("the recipe calls candidates and shows its whole answer", async () => {
  const wf = await recipeWorkflow();
  const recipe = JSON.parse(wf.tags.puddlerouterRecipe);
  assertEquals(recipe.id, "obsidian-task-scan-candidates");
  assertEquals(recipe.extension, model.type);
  assertEquals(recipe.dataName, "candidates");
  assertEquals(recipe.template, "{answer}");
  assertEquals(recipe.each, undefined);
  assert(recipe.dataName in model.resources);
  // A pack recipe has exactly one model_method step, which gives the method.
  const steps = wf.jobs.flatMap((j) => j.steps);
  assertEquals(steps.length, 1);
  assertEquals(steps[0].task.type, "model_method");
  assertEquals(steps[0].task.modelIdOrName, "obsidian-task-scan-model");
  assertEquals(steps[0].task.methodName, "candidates");
  assertEquals(steps[0].task.inputs ?? {}, {});
});

Deno.test("the manifest ships the recipe as a pack, and doesn't claim the extension only reads", async () => {
  const manifest = parseYaml(await read("../../manifest.yaml")) as {
    workflows: string[];
    labels: string[];
  };
  assert(
    manifest.workflows.includes("workflow-obsidian-task-scan-candidates.yaml"),
  );
  assert(manifest.labels.includes("puddlerouter-recipe"));
  // `log` writes to Capture, so the recipe's method is vouched for under reads:.
  assertEquals(manifest.labels.includes("effects-read"), false);
});

Deno.test("the manifest, the model and its last upgrade name the same version", async () => {
  const manifest = parseYaml(await read("../../manifest.yaml")) as {
    version: string;
  };
  assertEquals(model.version, manifest.version);
  assertEquals(model.upgrades.at(-1)?.toVersion, manifest.version);
});

interface RecipeWorkflow {
  tags: { puddlerouterRecipe: string };
  jobs: Array<{
    steps: Array<{
      task: {
        type: string;
        modelIdOrName: string;
        methodName: string;
        inputs?: Record<string, unknown>;
      };
    }>;
  }>;
}

async function recipeWorkflow(): Promise<RecipeWorkflow> {
  return parseYaml(
    await read("../../workflows/workflow-obsidian-task-scan-candidates.yaml"),
  ) as RecipeWorkflow;
}

async function recipeTag(): Promise<{ pattern: string }> {
  return JSON.parse((await recipeWorkflow()).tags.puddlerouterRecipe);
}
