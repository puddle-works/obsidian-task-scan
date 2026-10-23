/**
 * Tests for @puddleworks/obsidian-task-scan.
 *
 * Run with the "Test it" command in puddles/obsidian-task-scan/README.md.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { assertSpyCallArgs, stub } from "jsr:@std/testing@1/mock";
import {
  behaviour,
  type GlobalArgs,
  GlobalArgsSchema,
  model,
  ResultSchema,
  run,
  RunArgsSchema,
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
  const items = await run(DEFAULTS, vault);
  assertEquals(
    ResultSchema.safeParse({
      args: DEFAULTS,
      items,
      ranAt: new Date().toISOString(),
    }).success,
    true,
  );
  for (
    const item of [{ path: "a.md", text: "task" }, {
      path: "a.md",
      line: 0,
      text: "task",
    }]
  ) {
    assertEquals(ResultSchema.shape.items.safeParse([item]).success, false);
  }
});
