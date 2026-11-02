/**
 * Tests for registry matching (`match`) and Capture logging (`log`):
 * spec version 2, AC2–AC4, AC6 and AC7.
 *
 * The registry search and Capture are fakes: `behaviour.exec` is stubbed and
 * `runModel` is a recording function, so no test runs swamp or reaches Capture.
 *
 * Run with: make test
 *
 * @module
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { stub } from "jsr:@std/testing@1.0.21/mock";
import { parse as parseYaml } from "jsr:@std/yaml@1";
import {
  type Answer,
  behaviour,
  type ClassifiedTask,
  criteriaFor,
  type Exec,
  type ExecResult,
  GlobalArgsSchema,
  LogArgsSchema,
  logCandidates,
  LoggedSchema,
  type LogSettings,
  match,
  MatchArgsSchema,
  MatchedSchema,
  type MatchItem,
  MAX_LOGS,
  model,
  type ModelCall,
  requestDraft,
  type RunResult,
  searchQuery,
  searchRegistry,
} from "./obsidian_task_scan.ts";

/** A classified task; a candidate unless told otherwise. */
function task(
  id: string,
  text: string,
  extra: Partial<ClassifiedTask> = {},
): ClassifiedTask {
  return {
    path: "Projects/Ops.md",
    line: 7,
    text,
    heading: "Infra",
    id,
    withheld: false,
    classification: "candidate",
    choice: "extension",
    confidence: 0.8,
    ...extra,
  };
}

const ID1 = "0000000000000001";
const ID2 = "0000000000000002";
const ID3 = "0000000000000003";

/** One registry row as `swamp extension search --json` prints it. */
const row = (name: string, description = `${name} does things`) => ({
  name,
  description,
  latestVersion: "2026.1.1.1",
});

/** An exec that answers each search from a table of query → rows. */
function fakeSearch(
  table: Record<string, unknown[] | "fail" | "garbage">,
): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (args) => {
    calls.push(args);
    const answer = table[args[2]] ?? [];
    const res: ExecResult = answer === "fail"
      ? { code: 1, stdout: "", stderr: "network unreachable" }
      : answer === "garbage"
      ? { code: 0, stdout: "not json", stderr: "" }
      : {
        code: 0,
        stdout: JSON.stringify({ query: args[2], extensions: answer }),
        stderr: "",
      };
    return Promise.resolve(res);
  };
  return { exec, calls };
}

/** A Capture `runModel` that logs requests #1, #2… and records each call. */
function fakeCapture(failWith?: string) {
  const calls: ModelCall[] = [];
  let next = 1;
  const keys = new Map<string, number>();
  const runModel = (call: ModelCall): Promise<RunResult> => {
    calls.push(call);
    if (failWith) {
      return Promise.resolve({ ok: false, error: { message: failWith } });
    }
    const key = String(call.arguments?.idempotencyKey);
    const number = keys.get(key) ?? next++;
    keys.set(key, number);
    return Promise.resolve({
      ok: true,
      resources: [{
        name: `req-${number}`,
        specName: "request",
        attributes: { id: `uuid-${number}`, number, title: "t" },
      }],
    });
  };
  return { runModel, calls };
}

const LIVE: LogSettings = {
  logAs: "mark@example.com",
  captureModel: "capture",
  captureUrl: "http://127.0.0.1:3002",
  matchThreshold: 0.5,
};

const pick = (choice: string, confidence = 0.9): Answer => ({
  choice,
  confidence,
});

const searched = (
  id: string,
  found: string[],
  extra: Partial<MatchItem> = {},
): MatchItem => ({
  id,
  query: "post weekly metrics slack",
  found: found.map((name) => ({ name, description: `${name} does things` })),
  searchFailed: false,
  ...extra,
});

// ---------------------------------------------------------------- searching

Deno.test("searchQuery keeps at most four content words", () => {
  assertEquals(
    searchQuery("Post the weekly metrics to Slack every Monday at 9"),
    "post weekly metrics slack",
  );
  assertEquals(searchQuery("Do it"), "");
  assertEquals(
    searchQuery("GitHub: review PRs, review PRs"),
    "github review prs",
  );
});

Deno.test("searchRegistry passes the query as one argument and keeps the top three", async () => {
  const { exec, calls } = fakeSearch({
    "post weekly metrics slack": [
      row("@a/x"),
      row("@b/y"),
      row("@c/z"),
      row(
        "@d/w",
      ),
    ],
  });
  const r = await searchRegistry("post weekly metrics slack", exec);
  assertEquals(calls, [[
    "extension",
    "search",
    "post weekly metrics slack",
    "--json",
  ]]);
  assertEquals(r.failed, false);
  assertEquals(r.found.map((f) => f.name), ["@a/x", "@b/y", "@c/z"]);
  assertEquals(r.found[0].description, "@a/x does things");
});

Deno.test("searchRegistry reports a failed, garbled or thrown search as failed", async () => {
  for (const answer of ["fail", "garbage"] as const) {
    const { exec } = fakeSearch({ q: answer });
    assertEquals(await searchRegistry("q", exec), { found: [], failed: true });
  }
  const throws: Exec = () => Promise.reject(new Error("no swamp"));
  assertEquals(await searchRegistry("q", throws), { found: [], failed: true });
});

Deno.test("searchRegistry does not search for an empty query", async () => {
  const { exec, calls } = fakeSearch({});
  assertEquals(await searchRegistry("", exec), { found: [], failed: false });
  assertEquals(calls.length, 0);
});

// ----------------------------------------------------------------- matching

Deno.test("match searches only candidates and asks Jev only where something was found", async () => {
  const { exec, calls } = fakeSearch({
    "post weekly metrics slack": [row("@a/slack"), row("@b/metrics")],
    "renew domain certificates": [],
  });
  const tasks = [
    task(ID1, "Post weekly metrics to Slack"),
    task(ID2, "Renew domain certificates"),
    task(ID3, "Call mum", { classification: "not_candidate" }),
    task("0000000000000004", "token=abc", {
      classification: "withheld",
      choice: undefined,
      confidence: undefined,
    }),
  ];
  const m = await match(tasks, exec, 150);
  assertEquals(calls.map((c) => c[2]), [
    "post weekly metrics slack",
    "renew domain certificates",
  ]);
  assertEquals(m.items.map((i) => [i.id, i.found.length, i.searchFailed]), [
    [ID1, 2, false],
    [ID2, 0, false],
  ]);
  assertEquals(m.batches.length, 1);
  assertEquals(Object.keys(m.batches[0]), [ID1]);
  const q = m.batches[0][ID1];
  assertEquals(q.type, "choice");
  assertMatch(q.instructions, /Post weekly metrics to Slack/);
  assertMatch(q.instructions, /Projects\/Ops\.md/);
  assertEquals(q.criteria, criteriaFor(m.items[0].found));
});

Deno.test("criteriaFor offers c1..c3 and none, filling missing slots", () => {
  const c = criteriaFor([{ name: "@a/x", description: "" }]);
  assertEquals(Object.keys(c), ["c1", "c2", "c3", "none"]);
  assertEquals(c.c1, "@a/x: no description");
  assertEquals(c.c2, "No such candidate.");
  assertEquals(c.c3, "No such candidate.");
});

Deno.test("match puts at most batchSize questions in a request", async () => {
  const table: Record<string, unknown[]> = {};
  const tasks = Array.from({ length: 5 }, (_, i) => {
    table[`thing${i} widget`] = [row("@a/x")];
    return task(`000000000000001${i}`, `Thing${i} widget`);
  });
  const m = await match(tasks, fakeSearch(table).exec, 2);
  assertEquals(m.batches.map((b) => Object.keys(b).length), [2, 2, 1]);
});

Deno.test("match keeps a failed search and asks no question for it", async () => {
  const { exec } = fakeSearch({ "post weekly metrics slack": "fail" });
  const m = await match([task(ID1, "Post weekly metrics to Slack")], exec, 150);
  assertEquals(m.items[0].searchFailed, true);
  assertEquals(m.batches, []);
});

Deno.test("match method writes one matched resource and logs counts, never task text", async () => {
  using _ = stub(
    behaviour,
    "exec",
    fakeSearch({ "post weekly metrics slack": [row("@a/x")] }).exec,
  );
  const writes: Array<{ spec: string; data: Record<string, unknown> }> = [];
  const lines: Array<Record<string, unknown> | undefined> = [];
  const messages: string[] = [];
  await model.methods.match.execute(
    MatchArgsSchema.parse({
      tasks: [task(ID1, "Post weekly metrics to Slack")],
    }),
    {
      globalArgs: { vaultPath: "/v" },
      logger: {
        info: (m: string, p?: Record<string, unknown>) => {
          messages.push(m);
          lines.push(p);
        },
      },
      writeResource: (spec, name, data) => {
        writes.push({ spec, data });
        return Promise.resolve({ name });
      },
    },
  );
  assertEquals(writes.map((w) => w.spec), ["matched"]);
  const matched = MatchedSchema.parse(writes[0].data);
  assertEquals(matched.items.length, 1);
  assert(matched.guidance.length > 0);
  const logged = JSON.stringify([messages, lines]);
  for (const text of ["Post weekly", "Ops.md", "@a/x"]) {
    assertEquals(logged.includes(text), false, text);
  }
});

// ------------------------------------------------------------------ logging

Deno.test("requestDraft titles the request from the task and describes where it came from", () => {
  const t = task(ID1, "Post weekly   metrics\tto Slack");
  const d = requestDraft(t, searched(ID1, ["@a/slack"]), pick("none", 0.7));
  assertEquals(d.title, "Post weekly metrics to Slack");
  assertEquals(d.idempotencyKey, `obsidian-task-scan:${ID1}`);
  assertEquals(d.candidateExtensions, ["@a/slack"]);
  for (
    const part of [
      "Post weekly   metrics\tto Slack",
      "Projects/Ops.md",
      "line 7",
      '"Infra"',
      "0.80",
      "post weekly metrics slack",
      "@a/slack",
      ID1,
    ]
  ) {
    assert(d.description.includes(part), part);
  }
  // Capture shows the description as plain text.
  assertEquals(/[*_`#]/.test(d.description.replace(ID1, "")), false);
});

Deno.test("requestDraft keeps titles within Capture's limit and leaves out a secret-looking heading", () => {
  const long = task(ID1, "x".repeat(300), { heading: "token=abc123" });
  const d = requestDraft(long, searched(ID1, []), undefined);
  assert(d.title.length <= 120);
  assertEquals(d.description.includes("abc123"), false);
});

Deno.test("logCandidates logs a candidate the search found nothing for (AC3)", async () => {
  const cap = fakeCapture();
  const r = await logCandidates(
    [task(ID1, "Renew domain certificates")],
    [searched(ID1, [])],
    [],
    LIVE,
    cap.runModel,
  );
  assertEquals(cap.calls.length, 1);
  const call = cap.calls[0];
  assertEquals(call.definition, "capture");
  assertEquals(call.method, "create_request");
  assertEquals(call.arguments?.as, "mark@example.com");
  assertEquals(call.arguments?.title, "Renew domain certificates");
  assertEquals(call.arguments?.candidateExtensions, []);
  assertEquals(call.arguments?.idempotencyKey, `obsidian-task-scan:${ID1}`);
  assertEquals(r.items[0].outcome, "logged");
  assertEquals(r.items[0].request, {
    id: "uuid-1",
    number: 1,
    url: "http://127.0.0.1:3002/requests/uuid-1",
  });
  assertEquals(r.counts.logged, 1);
});

Deno.test("logCandidates reports a sure match by name and does not log it (AC2)", async () => {
  const cap = fakeCapture();
  const r = await logCandidates(
    [task(ID1, "Post weekly metrics to Slack")],
    [searched(ID1, ["@a/slack", "@b/metrics"])],
    [{ [ID1]: pick("c2", 0.5) }],
    LIVE,
    cap.runModel,
  );
  assertEquals(cap.calls.length, 0);
  assertEquals(r.items[0].outcome, "matched");
  assertEquals(r.items[0].extension, "@b/metrics");
});

Deno.test("logCandidates logs when Jev says none or is not sure of its pick", async () => {
  const cap = fakeCapture();
  const r = await logCandidates(
    [task(ID1, "Post weekly metrics"), task(ID2, "Rotate backups")],
    [searched(ID1, ["@a/slack"]), searched(ID2, ["@b/backup"])],
    [{ [ID1]: pick("none", 0.9) }, { [ID2]: pick("c1", 0.49) }],
    LIVE,
    cap.runModel,
  );
  assertEquals(r.items.map((i) => i.outcome), ["logged", "logged"]);
  assertEquals(cap.calls.map((c) => c.arguments?.candidateExtensions), [
    ["@a/slack"],
    ["@b/backup"],
  ]);
});

Deno.test("logCandidates logs nothing it is unsure of (AC7)", async () => {
  const cap = fakeCapture();
  const r = await logCandidates(
    [
      task(ID1, "Search failed"),
      task(ID2, "Jev did not answer the pick"),
      task(ID3, "Jev picked an empty slot"),
      task("0000000000000004", "Never searched"),
    ],
    [
      searched(ID1, [], { searchFailed: true }),
      searched(ID2, ["@a/x"]),
      searched(ID3, ["@a/x"]),
    ],
    [{ [ID3]: pick("c3", 0.9) }],
    LIVE,
    cap.runModel,
  );
  assertEquals(cap.calls.length, 0);
  assertEquals(r.items.map((i) => i.outcome), [
    "failed",
    "failed",
    "failed",
    "failed",
  ]);
  for (const item of r.items) assert(item.reason, item.id);
  assertEquals(r.counts.failed, 4);
});

Deno.test("logCandidates marks a request Capture turned away as failed (AC7)", async () => {
  const cap = fakeCapture("Capture is not reachable");
  const r = await logCandidates(
    [task(ID1, "Renew domain certificates")],
    [searched(ID1, [])],
    [],
    LIVE,
    cap.runModel,
  );
  assertEquals(r.items[0].outcome, "failed");
  assertMatch(r.items[0].reason!, /Capture is not reachable/);
  assertEquals(r.items[0].request, undefined);
});

Deno.test("logCandidates fails every would-be log when runModel is missing", async () => {
  const r = await logCandidates(
    [task(ID1, "Renew domain certificates")],
    [searched(ID1, [])],
    [],
    LIVE,
    undefined,
  );
  assertEquals(r.items[0].outcome, "failed");
  assertMatch(r.items[0].reason!, /runModel/);
});

Deno.test("logCandidates with logAs empty is a preview: nothing reaches Capture", async () => {
  const cap = fakeCapture();
  const r = await logCandidates(
    [task(ID1, "Renew domain certificates"), task(ID2, "Post to Slack")],
    [searched(ID1, []), searched(ID2, ["@a/slack"])],
    [{ [ID2]: pick("c1", 0.9) }],
    { ...LIVE, logAs: "" },
    cap.runModel,
  );
  assertEquals(cap.calls.length, 0);
  assertEquals(r.items.map((i) => i.outcome), ["skipped", "matched"]);
  assertEquals(r.items[0].wouldLog, true);
  assertMatch(r.items[0].reason!, /preview/i);
});

Deno.test("logCandidates skips tasks that are not candidates, with the reason", async () => {
  const cap = fakeCapture();
  const r = await logCandidates(
    [
      task(ID1, "Call mum", { classification: "not_candidate" }),
      task(ID2, "x", { classification: "unclassified" }),
      task(ID3, "token=abc", { classification: "withheld" }),
    ],
    [],
    [],
    LIVE,
    cap.runModel,
  );
  assertEquals(cap.calls.length, 0);
  assertEquals(r.items.map((i) => i.outcome), [
    "skipped",
    "skipped",
    "skipped",
  ]);
  for (const item of r.items) assert(item.reason);
  assertEquals(r.items[1].wouldLog, undefined);
});

Deno.test("a rerun gives the same requests: the idempotency key depends only on the task (AC4)", async () => {
  const cap = fakeCapture();
  const tasks = [task(ID1, "Renew domain certificates")];
  const first = await logCandidates(
    tasks,
    [searched(ID1, [])],
    [],
    LIVE,
    cap.runModel,
  );
  // The task moved down the note: same path and text, so the same id.
  const moved = [{ ...tasks[0], line: 12 }];
  const second = await logCandidates(
    moved,
    [searched(ID1, [])],
    [],
    LIVE,
    cap.runModel,
  );
  assertEquals(second.items[0].request, first.items[0].request);
  assertEquals(
    cap.calls.map((c) => c.arguments?.idempotencyKey),
    [`obsidian-task-scan:${ID1}`, `obsidian-task-scan:${ID1}`],
  );
});

Deno.test("logCandidates reuses requests the last run logged and calls Capture at most MAX_LOGS times", async () => {
  const cap = fakeCapture();
  const tasks = Array.from(
    { length: MAX_LOGS + 3 },
    (_, i) => task(i.toString(16).padStart(16, "0"), `Thing ${i}`),
  );
  const matched = tasks.map((t) => searched(t.id, []));
  const first = await logCandidates(tasks, matched, [], LIVE, cap.runModel);
  assertEquals(cap.calls.length, MAX_LOGS);
  assertEquals(first.counts.logged, MAX_LOGS);
  assertEquals(first.counts.failed, 3);
  const previous = LoggedSchema.parse({
    ...first,
    logAs: LIVE.logAs,
    captureModel: LIVE.captureModel,
    loggedAt: new Date().toISOString(),
  });

  const second = await logCandidates(
    tasks,
    matched,
    [],
    LIVE,
    cap.runModel,
    previous,
  );
  // Only the three left over reach Capture.
  assertEquals(cap.calls.length, MAX_LOGS + 3);
  assertEquals(second.counts.logged, MAX_LOGS + 3);
  assertEquals(second.items[0].request, first.items[0].request);

  // Logged for someone else: not reused.
  const other = await logCandidates(
    tasks.slice(0, 1),
    matched.slice(0, 1),
    [],
    { ...LIVE, logAs: "other@example.com" },
    cap.runModel,
    previous,
  );
  assertEquals(other.items[0].outcome, "logged");
  assertEquals(cap.calls.length, MAX_LOGS + 4);
});

Deno.test("log method writes one logged resource and warns about failures without task text (AC6, AC7)", async () => {
  const cap = fakeCapture("connection refused");
  const writes: Array<{ spec: string; data: Record<string, unknown> }> = [];
  const info: unknown[] = [];
  const warnings: unknown[] = [];
  await model.methods.log.execute(
    LogArgsSchema.parse({
      tasks: [
        task(ID1, "Renew domain certificates"),
        task(ID2, "Call mum", { classification: "not_candidate" }),
      ],
      matched: [searched(ID1, [])],
      answers: [],
    }),
    {
      globalArgs: { vaultPath: "/v", logAs: "mark@example.com" },
      logger: {
        info: (m: string, p?: Record<string, unknown>) => info.push([m, p]),
        warning: (m: string, p?: Record<string, unknown>) =>
          warnings.push([m, p]),
      },
      writeResource: (spec, name, data) => {
        writes.push({ spec, data });
        return Promise.resolve({ name });
      },
      readResource: () => Promise.resolve(null),
      runModel: cap.runModel,
    },
  );
  assertEquals(writes.map((w) => w.spec), ["logged"]);
  const logged = LoggedSchema.parse(writes[0].data);
  assertEquals(logged.items.map((i) => i.outcome), ["failed", "skipped"]);
  assertEquals(logged.counts, { logged: 0, matched: 0, skipped: 1, failed: 1 });
  assertEquals(logged.logAs, "mark@example.com");
  assertEquals(warnings.length, 1);
  const said = JSON.stringify([info, warnings]);
  for (const text of ["Renew domain", "Ops.md", "Call mum"]) {
    assertEquals(said.includes(text), false, text);
  }
});

Deno.test("log method reuses the last logged resource as its previous run", async () => {
  const cap = fakeCapture();
  const previous = {
    logAs: "mark@example.com",
    captureModel: "capture",
    items: [{
      ...task(ID1, "Renew domain certificates"),
      outcome: "logged",
      request: { id: "uuid-9", number: 9, url: "http://x/requests/uuid-9" },
    }],
    counts: { logged: 1, matched: 0, skipped: 0, failed: 0 },
    loggedAt: new Date().toISOString(),
  };
  const writes: Array<Record<string, unknown>> = [];
  const read: string[] = [];
  await model.methods.log.execute(
    LogArgsSchema.parse({
      tasks: [task(ID1, "Renew domain certificates")],
      matched: [searched(ID1, [])],
    }),
    {
      globalArgs: { vaultPath: "/v", logAs: "mark@example.com" },
      logger: { info: () => {} },
      writeResource: (_spec, name, data) => {
        writes.push(data);
        return Promise.resolve({ name });
      },
      readResource: (name: string) => {
        read.push(name);
        return Promise.resolve(previous);
      },
      runModel: cap.runModel,
    },
  );
  assertEquals(read, ["logged"]);
  assertEquals(cap.calls.length, 0);
  const logged = LoggedSchema.parse(writes[0]);
  assertEquals(logged.items[0].request?.number, 9);
});

// ----------------------------------------------------------------- settings

Deno.test("the logging settings default to a preview against the capture behavior", () => {
  const s = GlobalArgsSchema.parse({ vaultPath: "/v" });
  assertEquals(s.logAs, "");
  assertEquals(s.captureModel, "capture");
  assertEquals(s.captureUrl, "http://127.0.0.1:3002");
  assertEquals(s.matchThreshold, 0.5);
  assertEquals(
    GlobalArgsSchema.safeParse({ vaultPath: "/v", logAs: "not-an-email" })
      .success,
    false,
  );
  assertEquals(
    GlobalArgsSchema.safeParse({ vaultPath: "/v", matchThreshold: 2 }).success,
    false,
  );
});

// ----------------------------------------------------------------- workflow

interface Step {
  name: string;
  forEach?: { item: string; in: string };
  task: {
    modelIdOrName: string;
    methodName: string;
    inputs: Record<string, string>;
  };
  allowFailure?: boolean;
}
interface Job {
  name: string;
  dependsOn: Array<{ job: string; condition: { type: string } }>;
  steps: Step[];
}

Deno.test("the workflow matches, picks and logs after classifying", () => {
  const wf = parseYaml(
    Deno.readTextFileSync(
      new URL(
        "../../workflows/workflow-obsidian-task-scan.yaml",
        import.meta.url,
      ),
    ),
  ) as { jobs: Job[] };
  const jobs = Object.fromEntries(wf.jobs.map((j) => [j.name, j]));
  assertEquals(wf.jobs.map((j) => j.name), [
    "scan",
    "ask",
    "classify",
    "match",
    "pick",
    "log",
  ]);

  const matchStep = jobs.match.steps[0];
  assertEquals(matchStep.task.methodName, "match");
  assertEquals(
    matchStep.task.inputs.tasks,
    "${{ steps.classify.outputs.items }}",
  );

  const pickStep = jobs.pick.steps[0];
  assertEquals(pickStep.task.modelIdOrName, "jev");
  assertEquals(pickStep.task.methodName, "ask");
  assertEquals(pickStep.allowFailure, true);
  assertMatch(pickStep.name, /^pick-/);
  assertMatch(
    pickStep.forEach!.in,
    /data\.latest\("obsidian-task-scan-model", "matched"\)/,
  );

  const logStep = jobs.log.steps[0];
  assertEquals(logStep.task.methodName, "log");
  assertEquals(
    logStep.task.inputs.tasks,
    "${{ steps.classify.outputs.items }}",
  );
  assertEquals(logStep.task.inputs.matched, "${{ steps.match.outputs.items }}");
  assertMatch(logStep.task.inputs.answers, /k\.startsWith\("pick-"\)/);
  assertEquals(
    jobs.log.dependsOn.map((d) => [d.job, d.condition.type]),
    [["match", "succeeded"], ["pick", "always"]],
  );
});
