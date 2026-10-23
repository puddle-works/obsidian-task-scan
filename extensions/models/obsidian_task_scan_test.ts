/**
 * Tests for @puddleworks/obsidian-task-scan.
 *
 * Run with the "Test it" command in puddles/obsidian-task-scan/README.md.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { assertSpyCallArgs, stub } from "jsr:@std/testing@1.0.21/mock";
import {
  behaviour,
  ClassifiedSchema,
  classify,
  ClassifyArgsSchema,
  type GlobalArgs,
  GlobalArgsSchema,
  looksSecret,
  model,
  prepare,
  ResultSchema,
  run,
  RunArgsSchema,
  taskId,
} from "./obsidian_task_scan.ts";

/** Values for the required inputs. */
const REQUIRED = {};

/**
 * Placeholders that only need to pass the schema: these tests stub `run`.
 * Tests of the real behaviour call `run` with working settings of their own.
 */
const SETTINGS: GlobalArgs = { vaultPath: "example" };

Deno.test("model type matches the app spec", () => {
  assertEquals(model.type, "@puddleworks/obsidian-task-scan");
});

Deno.test("run arguments are exactly the specification inputs", () => {
  assertEquals(Object.keys(RunArgsSchema.shape).sort(), ["folder"]);
});

Deno.test("run arguments apply the specification defaults", () => {
  assertEquals(RunArgsSchema.parse(REQUIRED), { folder: "" });
});

Deno.test("run arguments reject values of the wrong type", () => {
  const wrong: Array<[string, unknown]> = [
    ["folder", 1],
  ];
  for (const [name, value] of wrong) {
    assertEquals(
      RunArgsSchema.safeParse({ ...REQUIRED, [name]: value }).success,
      false,
      name,
    );
  }
});

Deno.test("every setting must be set", () => {
  assertEquals(GlobalArgsSchema.safeParse({}).success, false);
  assertEquals(GlobalArgsSchema.safeParse(SETTINGS).success, true);
});

Deno.test("run writes one result resource with the arguments it ran with", async () => {
  using runStub = stub(behaviour, "run", () => Promise.resolve([]));
  const args = RunArgsSchema.parse(REQUIRED);
  const writes: Array<{ specName: string; data: Record<string, unknown> }> = [];
  const out = await model.methods.run.execute(args, {
    globalArgs: SETTINGS,
    writeResource: (specName, name, data) => {
      writes.push({ specName, data });
      return Promise.resolve({ name });
    },
  });
  assertEquals(out.dataHandles.length, 1);
  assertSpyCallArgs(runStub, 0, [args, SETTINGS]);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "result");
  assertEquals(writes[0].data.args, args);
  assertEquals(ResultSchema.safeParse(writes[0].data).success, true);
});

// Behaviour

/** Writes vault-relative files into a fresh temporary vault. */
async function makeVault(files: Record<string, string>): Promise<GlobalArgs> {
  const vaultPath = await Deno.makeTempDir();
  for (const [path, content] of Object.entries(files)) {
    const full = `${vaultPath}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
  return { vaultPath };
}

const DEFAULTS = RunArgsSchema.parse({});

Deno.test("lists trimmed tasks in path then line order, including nested and numbered markers", async () => {
  const vault = await makeVault({
    "z.md": "before\n  - [ ]  last task  \n",
    "a/b.md": "* [ ] star\n+ [ ] plus\n1. [ ] period\n  12) [ ] parenthesis\n",
    "a/a.md": "- [ ] first\nplain\n- [ ] third\n",
  });
  assertEquals(await run(DEFAULTS, vault), [
    { path: "a/a.md", line: 1, text: "first" },
    { path: "a/a.md", line: 3, text: "third" },
    { path: "a/b.md", line: 1, text: "star" },
    { path: "a/b.md", line: 2, text: "plus" },
    { path: "a/b.md", line: 3, text: "period" },
    { path: "a/b.md", line: 4, text: "parenthesis" },
    { path: "z.md", line: 2, text: "last task" },
  ]);
});

Deno.test("excludes other checkbox states, plain text and empty tasks", async () => {
  const vault = await makeVault({
    "a.md":
      "- [x] done\n- [X] done\n- [-] cancelled\n- [/] active\n- [>] deferred\ntext [ ] mention\n- [ ]\n- [ ]   \n- [ ] kept\n",
  });
  assertEquals(await run(DEFAULTS, vault), [{
    path: "a.md",
    line: 9,
    text: "kept",
  }]);
});

Deno.test("handles CRLF and skips both kinds of fenced code blocks", async () => {
  const vault = await makeVault({
    "a.md":
      "- [ ] before\r\n```md\r\n- [ ] code\r\n```\r\n- [ ] middle\r\n~~~\r\n- [ ] more code\r\n~~~\r\n- [ ] after\r\n",
  });
  assertEquals(await run(DEFAULTS, vault), [
    { path: "a.md", line: 1, text: "before" },
    { path: "a.md", line: 5, text: "middle" },
    { path: "a.md", line: 9, text: "after" },
  ]);
});

Deno.test("reads only visible markdown files and does not follow symlinks", async () => {
  const vault = await makeVault({
    "kept.md": "- [ ] kept",
    "notes.txt": "- [ ] text",
    "board.canvas": "- [ ] canvas",
    ".obsidian/workspace.md": "- [ ] hidden",
    ".trash/old.md": "- [ ] trashed",
  });
  const outside = await makeVault({ "escape.md": "- [ ] outside" });
  await Deno.symlink(outside.vaultPath, `${vault.vaultPath}/linked`);
  await Deno.symlink(
    `${outside.vaultPath}/escape.md`,
    `${vault.vaultPath}/linked.md`,
  );
  assertEquals(await run(DEFAULTS, vault), [{
    path: "kept.md",
    line: 1,
    text: "kept",
  }]);
});

Deno.test("folder limits the scan and keeps vault-relative paths", async () => {
  const vault = await makeVault({
    "Other/a.md": "- [ ] other",
    "Work/b.md": "- [ ] work",
    "Work/Sub/c.md": "- [ ] nested",
  });
  assertEquals(await run({ folder: "Work/" }, vault), [
    { path: "Work/Sub/c.md", line: 1, text: "nested" },
    { path: "Work/b.md", line: 1, text: "work" },
  ]);
});

Deno.test("rejects folders outside the vault and names missing directories", async () => {
  const vault = await makeVault({});
  for (const folder of ["../x", "a/../../x", "/etc"]) {
    await assertRejects(
      () => run({ folder }, vault),
      Error,
      "inside the vault",
    );
  }
  await assertRejects(
    () => run({ folder: "Missing" }, vault),
    Error,
    'No folder "Missing" in the vault.',
  );
  await assertRejects(
    () => run(DEFAULTS, { vaultPath: `${vault.vaultPath}/absent` }),
    Error,
    "No vault at",
  );
});

Deno.test("rejects a folder that leads through a symlink out of the vault", async () => {
  const vault = await makeVault({ "Work/a.md": "- [ ] work" });
  const outside = await makeVault({ "Deep/escape.md": "- [ ] outside" });
  await Deno.symlink(outside.vaultPath, `${vault.vaultPath}/linked`);
  await Deno.symlink(outside.vaultPath, `${vault.vaultPath}/Work/linked`);
  for (const folder of ["linked", "linked/Deep", "Work/linked"]) {
    await assertRejects(
      () => run({ folder }, vault),
      Error,
      "inside the vault",
    );
  }
});

Deno.test("empty vault returns no tasks and scanning never changes vault files", async () => {
  const empty = await makeVault({});
  assertEquals(await run(DEFAULTS, empty), []);
  const vault = await makeVault({
    "a.md": "- [ ] task\n",
    "nested/b.txt": "untouched\n",
  });
  const paths = ["a.md", "nested/b.txt"];
  const before = await Promise.all(paths.map(async (path) => {
    const full = `${vault.vaultPath}/${path}`;
    return {
      content: await Deno.readTextFile(full),
      mtime: (await Deno.stat(full)).mtime?.getTime(),
    };
  }));
  await run(DEFAULTS, vault);
  const after = await Promise.all(paths.map(async (path) => {
    const full = `${vault.vaultPath}/${path}`;
    return {
      content: await Deno.readTextFile(full),
      mtime: (await Deno.stat(full)).mtime?.getTime(),
    };
  }));
  assertEquals(after, before);
});

Deno.test("result schema requires a positive line number and task text", async () => {
  const vault = await makeVault({ "a.md": "- [ ] task" });
  const { items, questions } = await prepare(await run(DEFAULTS, vault));
  assertEquals(
    ResultSchema.safeParse({
      args: DEFAULTS,
      items,
      questions,
      ranAt: new Date().toISOString(),
    }).success,
    true,
  );
  for (
    const item of [{ ...items[0], line: undefined }, { ...items[0], line: 0 }]
  ) {
    assertEquals(ResultSchema.shape.items.safeParse([item]).success, false);
  }
});

// Leaving out templates and daily notes

Deno.test("leaves out the Templates folder and daily notes by default", async () => {
  const vault = await makeVault({
    "Templates/Daily Note.md": "- [ ] Supplements",
    "2026-10-23.md": "- [ ] Supplements",
    "Journal/2026-01-01.md": "- [ ] Tidy table",
    "2026 plan.md": "- [ ] kept, not a daily note",
    "TemplatesOld/a.md": "- [ ] kept, a different folder",
    "tasks/Tech.md": "- [ ] kept",
  });
  assertEquals((await run(DEFAULTS, vault)).map((t) => t.path), [
    "2026 plan.md",
    "TemplatesOld/a.md",
    "tasks/Tech.md",
  ]);
});

Deno.test("excludeFolders replaces the default list of folders to leave out", async () => {
  const vault = await makeVault({
    "Templates/a.md": "- [ ] template",
    "Archive/Old/b.md": "- [ ] archived",
    "c.md": "- [ ] kept",
  });
  const items = await run(DEFAULTS, { ...vault, excludeFolders: ["Archive/"] });
  assertEquals(items.map((t) => t.path), ["Templates/a.md", "c.md"]);
  const all = await run(DEFAULTS, { ...vault, excludeFolders: [] });
  assertEquals(all.length, 3);
});

// Preparing the classifier questions

Deno.test("taskId depends on the file and the text, not the line", async () => {
  const a = await taskId({ path: "a.md", line: 1, text: "Back up photos" });
  assertEquals(
    a,
    await taskId({ path: "a.md", line: 9, text: "Back up photos" }),
  );
  assertEquals(a.length, 16);
  assertEquals(/^[0-9a-f]+$/.test(a), true);
  for (
    const other of [
      { path: "b.md", line: 1, text: "Back up photos" },
      { path: "a.md", line: 1, text: "Back up the photos" },
    ]
  ) {
    assertEquals(a === await taskId(other), false);
  }
});

Deno.test("looksSecret catches tokens, keys, passwords and emails but not ordinary tasks", () => {
  for (
    const text of [
      "rotate ghp_abcdefghijklmnopqrstuvwx1234",
      "AKIAABCDEFGHIJKLMNOP is the old key",
      "set password: hunter2",
      "email someone@example.com about it",
      "-----BEGIN RSA PRIVATE KEY-----",
    ]
  ) assertEquals(looksSecret(text), true, text);
  for (
    const text of [
      "Rotate the AWS access keys monthly",
      "Reset my password on the router",
      "List open pull requests every Monday",
    ]
  ) assertEquals(looksSecret(text), false, text);
});

Deno.test("prepare asks one choice question per task and withholds secret-looking tasks", async () => {
  const tasks = [
    {
      path: "tasks/Tech.md",
      line: 3,
      text: "Check CI on every repo each morning",
    },
    {
      path: "tasks/Tech.md",
      line: 4,
      text: "store token=abc123 somewhere safe",
    },
  ];
  const { items, questions } = await prepare(tasks);
  assertEquals(items.map((i) => i.withheld), [false, true]);
  assertEquals(items[0].id, await taskId(tasks[0]));
  assertEquals(Object.keys(questions), [items[0].id]);
  const question = questions[items[0].id];
  assertEquals(question.type, "choice");
  assertEquals(Object.keys(question.criteria).sort(), ["extension", "person"]);
  assertEquals(
    question.instructions.includes("Check CI on every repo each morning"),
    true,
  );
  assertEquals(question.instructions.includes("tasks/Tech.md"), true);
});

Deno.test("run writes the prepared items and questions into the result", async () => {
  const tasks = [{
    path: "a.md",
    line: 1,
    text: "Post weekly metrics to Slack",
  }];
  using _ = stub(behaviour, "run", () => Promise.resolve(tasks));
  const writes: Array<Record<string, unknown>> = [];
  await model.methods.run.execute(RunArgsSchema.parse({}), {
    globalArgs: SETTINGS,
    writeResource: (_spec, name, data) => {
      writes.push(data);
      return Promise.resolve({ name });
    },
  });
  const result = ResultSchema.parse(writes[0]);
  assertEquals(result.items, (await prepare(tasks)).items);
  assertEquals(Object.keys(result.questions), [result.items[0].id]);
});

// Classifying with Jev's answers

const answer = (choice: string, confidence: number) => ({
  type: "choice" as const,
  choice,
  confidence,
  probabilities: { [choice]: confidence },
});

Deno.test("classify marks extension answers at or above the threshold as candidates", async () => {
  const { items } = await prepare([
    { path: "a.md", line: 1, text: "Check CI every morning" },
    { path: "a.md", line: 2, text: "Renew the car insurance" },
    { path: "a.md", line: 3, text: "Fix the garage door" },
    { path: "a.md", line: 4, text: "Book the dentist" },
    { path: "a.md", line: 5, text: "token=abc123 for the NAS" },
  ]);
  const [ci, insurance, garage, dentist, secret] = items;
  const out = classify(items, {
    [ci.id]: answer("extension", 1),
    [insurance.id]: answer("extension", 0.48),
    [garage.id]: answer("person", 1),
  }, 0.7);
  assertEquals(
    out.items.map((i) => [i.text, i.classification, i.confidence]),
    [
      [ci.text, "candidate", 1],
      [insurance.text, "not_candidate", 0.48],
      [garage.text, "not_candidate", 1],
      [dentist.text, "unclassified", undefined],
      [secret.text, "withheld", undefined],
    ],
  );
  assertEquals(out.counts, {
    candidate: 1,
    not_candidate: 2,
    unclassified: 1,
    withheld: 1,
  });
});

Deno.test("classify method writes one classified resource", async () => {
  const { items } = await prepare([{
    path: "a.md",
    line: 1,
    text: "Check CI every morning",
  }]);
  const args = ClassifyArgsSchema.parse({
    tasks: items,
    answers: { [items[0].id]: answer("extension", 0.9) },
  });
  assertEquals(args.threshold, 0.7);
  const writes: Array<{ specName: string; data: Record<string, unknown> }> = [];
  const out = await model.methods.classify.execute(args, {
    globalArgs: SETTINGS,
    writeResource: (specName, name, data) => {
      writes.push({ specName, data });
      return Promise.resolve({ name });
    },
  });
  assertEquals(out.dataHandles.length, 1);
  assertEquals(writes[0].specName, "classified");
  const classified = ClassifiedSchema.parse(writes[0].data);
  assertEquals(classified.items[0].classification, "candidate");
  assertEquals(classified.threshold, 0.7);
});

Deno.test("classify arguments default to no answers", () => {
  assertEquals(ClassifyArgsSchema.parse({ tasks: [] }).answers, {});
});
