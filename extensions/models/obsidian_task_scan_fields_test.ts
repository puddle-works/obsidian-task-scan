/**
 * Tests for how @puddleworks/obsidian-task-scan reads Obsidian Tasks fields:
 * dates, recurrence, priority and ids are not part of what a task is, so they
 * stay out of its id, Jev's questions, the registry search and the request.
 *
 * Run with: make test
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  type ClassifiedTask,
  type GlobalArgs,
  match,
  type MatchItem,
  prepare,
  requestDraft,
  run,
  RunArgsSchema,
  searchQuery,
  splitTasksFields,
  TaskSchema,
} from "./obsidian_task_scan.ts";

Deno.test("splitTasksFields leaves a task without fields exactly as it is", () => {
  for (const text of ["Back up photos", "Two  spaces kept", "Ship it 🚀"]) {
    assertEquals(splitTasksFields(text), { text });
  }
});

Deno.test("splitTasksFields drops dates, priority, ids and on-completion, and keeps the recurrence rule", () => {
  assertEquals(
    splitTasksFields("Timesheets 🔁 every week on Friday 📅 2026-10-23"),
    { text: "Timesheets", recurrence: "every week on Friday" },
  );
  assertEquals(
    splitTasksFields(
      "Pay rent ⏫ ➕ 2026-01-02 🛫 2026-01-03 ⏳ 2026-01-04 📅 2026-01-05 🆔 rent1 ⛔ abc,def 🏁 delete",
    ),
    { text: "Pay rent" },
  );
  // The rule ends at the next field, wherever it is; emoji may carry U+FE0F.
  assertEquals(
    splitTasksFields("Invoice 🔁️ every month on the last 🔼 📅️ 2026-10-31"),
    { text: "Invoice", recurrence: "every month on the last" },
  );
  assertEquals(
    splitTasksFields("Update FreeAgent ✅ 2026-10-01 ❌ 2026-10-02"),
    { text: "Update FreeAgent" },
  );
});

Deno.test("splitTasksFields reads the Dataview field format too", () => {
  assertEquals(
    splitTasksFields(
      "Monthly YNAB review [repeat:: every month on the 1st] [due:: 2026-11-01] [priority:: high]",
    ),
    { text: "Monthly YNAB review", recurrence: "every month on the 1st" },
  );
  assertEquals(
    splitTasksFields("Backup Mac (scheduled:: 2026-11-03)"),
    { text: "Backup Mac" },
  );
});

Deno.test("splitTasksFields keeps the text when the task is nothing but fields", () => {
  assertEquals(splitTasksFields("📅 2026-10-23"), { text: "📅 2026-10-23" });
});

/** Writes vault-relative files into a fresh temporary vault. */
async function makeVault(files: Record<string, string>): Promise<GlobalArgs> {
  const vaultPath = await Deno.makeTempDir();
  for (const [path, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${vaultPath}/${path}`, content);
  }
  return { vaultPath };
}

Deno.test("a recurring task keeps its id when Obsidian Tasks rolls its date on", async () => {
  const before = await makeVault({
    "Recurring.md": "- [ ] Timesheets 🔁 every week on Friday 📅 2026-10-23\n",
  });
  const after = await makeVault({
    "Recurring.md":
      "- [x] Timesheets 🔁 every week on Friday 📅 2026-10-23 ✅ 2026-10-23\n" +
      "- [ ] Timesheets 🔁 every week on Friday 📅 2026-10-30\n",
  });
  const args = RunArgsSchema.parse({});
  const [a] = await run(args, before);
  const [b] = await run(args, after);
  assertEquals(a, {
    path: "Recurring.md",
    line: 1,
    text: "Timesheets",
    recurrence: "every week on Friday",
  });
  assertEquals(TaskSchema.safeParse(a).success, true);
  assertEquals(b.line, 2);
  const [pa, pb] = [
    (await prepare([a], 10)).items[0],
    (await prepare([b], 10)).items[0],
  ];
  assertEquals(pa.id, pb.id);
});

Deno.test("Jev's questions say how a task recurs, without its dates", async () => {
  const t = {
    path: "Recurring.md",
    line: 1,
    text: "Timesheets",
    recurrence: "every week on Friday",
  };
  const { items, batches } = await prepare([t], 10);
  assertEquals(
    batches[0][items[0].id].instructions,
    '"Timesheets" (note Recurring.md, recurs every week on Friday)',
  );
  const classified: ClassifiedTask = {
    ...items[0],
    classification: "candidate",
    choice: "extension",
    confidence: 0.9,
  };
  const exec = () =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ extensions: [{ name: "@a/b", description: "" }] }),
      stderr: "",
    });
  const m = await match([classified], exec, 10);
  assertEquals(
    m.batches[0][items[0].id].instructions,
    '"Timesheets" (note Recurring.md, recurs every week on Friday)',
  );
});

Deno.test("a recurring task's request has a clean title and says how it recurs", () => {
  const t: ClassifiedTask = {
    path: "Recurring.md",
    line: 3,
    text: "Timesheets",
    recurrence: "every week on Friday",
    id: "0000000000000001",
    withheld: false,
    classification: "candidate",
    choice: "extension",
    confidence: 0.9,
  };
  const searched: MatchItem = {
    id: t.id,
    query: "timesheets",
    found: [],
    searchFailed: false,
  };
  const d = requestDraft(t, searched, undefined);
  assertEquals(d.title, "Timesheets");
  assert(d.description.includes("It recurs every week on Friday."));
  assertEquals(/\d{4}-\d{2}-\d{2}/.test(d.description), false);
});

Deno.test("searchQuery leaves out words that say nothing about the task", () => {
  assertEquals(
    searchQuery("Use Space Bunny again where rapid repo analysis is useful"),
    "space bunny rapid repo",
  );
  assertEquals(
    searchQuery("Keep Strands off the critical path, rather than later"),
    "strands critical path",
  );
});
