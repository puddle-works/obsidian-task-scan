/**
 * @puddleworks/obsidian-task-scan — Find tasks in an Obsidian vault that a swamp extension could do
 *
 * `run` lists the open task lines ("- [ ]") in an Obsidian vault, leaving out
 * templates and daily notes, and prepares one Jev choice question per task.
 * The workflow asks Jev (`@swamp/typesafe-ai`) those questions, then `classify`
 * marks each task a candidate, not a candidate, withheld or unclassified.
 *
 * `match` searches the swamp extension registry for each candidate and asks
 * Jev which extension found, if any, already does it. `log` then creates one
 * draft request in Capture (`@puddleworks/capture`, through `runModel`) for
 * each candidate no extension covers. With `logAs` empty nothing is logged:
 * the run is a preview.
 *
 * Output: every task with its file, line, classification, confidence and
 * outcome: logged (with the Capture link), matched, skipped or failed.
 *
 * Out of scope (spec revision 2):
 * - Editing the vault
 * - Proposing, agreeing or building the requests
 * - Merging similar tasks
 * - Done or in-progress tasks
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Settings fixed once per model instance by the builder, not the person running it. */
export const GlobalArgsSchema = z.object({
  vaultPath: z.string().min(1).describe(
    "Absolute path to the Obsidian vault folder.",
  ),
  excludeFolders: z.array(z.string().min(1)).default(["Templates"]).describe(
    "Vault folders to leave out, relative to the vault root. Daily notes (YYYY-MM-DD.md) are always left out.",
  ),
  batchSize: z.number().int().min(1).default(150).describe(
    "Most questions to send Jev in one request. Jev's free tier turns away requests of about 800 questions.",
  ),
  logAs: z.union([z.literal(""), z.email()]).default("").describe(
    "Who the Capture requests are logged for; they must be in Capture's people list. Empty logs nothing: the run is a preview.",
  ),
  captureModel: z.string().min(1).default("capture").describe(
    "Name of the @puddleworks/capture/requests behavior to log requests with.",
  ),
  captureUrl: z.url().default("http://127.0.0.1:3002").describe(
    "Where Capture's request pages are served, with no trailing slash; the result links to <captureUrl>/requests/<id>.",
  ),
  matchThreshold: z.number().min(0).max(1).default(0.5).describe(
    "Least confidence in Jev's pick of an extension for the candidate to count as covered, and not be logged.",
  ),
});
/** The settings as given, before defaults apply. */
export type GlobalArgs = z.input<typeof GlobalArgsSchema>;

/** Arguments for `run` — one per specification input. */
export const RunArgsSchema = z.object({
  folder: z.string().default("").describe(
    "Subfolder of the vault to scan, relative to the vault root. Empty scans the whole vault.",
  ),
});
/** Arguments for `run`, after defaults apply. */
export type RunArgs = z.infer<typeof RunArgsSchema>;

/**
 * One run's result. A list of open tasks, each with the task text, the vault-relative file path and the line number.
 */
export const TaskSchema = z.object({
  /** Path of the note, relative to the vault root, with "/" separators. */
  path: z.string(),
  /** 1-based line number of the task in the note. */
  line: z.number().int().min(1),
  /** The task text after the checkbox, trimmed. */
  text: z.string().min(1),
  /** The nearest heading above the task, if there is one. */
  heading: z.string().min(1).optional(),
});
/** One open task line. */
export type Task = z.infer<typeof TaskSchema>;

/** A task ready for the classifier. */
export const PreparedTaskSchema = TaskSchema.extend({
  /** Stable across runs: depends on the path and text, not the line. */
  id: z.string().regex(/^[0-9a-f]{16}$/),
  /** The text looks like it holds a secret, so it is never sent to the model. */
  withheld: z.boolean(),
});
/** A task with its id and withheld flag. */
export type PreparedTask = z.infer<typeof PreparedTaskSchema>;

/** A Jev `choice` question, as `@swamp/typesafe-ai` `ask` takes it. */
export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()),
});
/** One question for Jev. */
export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;

/** What `run` stores: the prepared tasks and one question per task Jev may see. */
export const ResultSchema = z.object({
  args: RunArgsSchema,
  items: z.array(PreparedTaskSchema),
  /** What Jev needs to know for every question: the `state` for `ask`. */
  guidance: z.string(),
  /** One question per task that is not withheld, keyed by task id, in requests of at most `batchSize`. */
  batches: z.array(z.record(z.string(), ChoiceQuestionSchema)),
  ranAt: z.iso.datetime(),
});
/** The `result` resource. */
export type Result = z.infer<typeof ResultSchema>;

/**
 * List the open task lines ("- [ ]") in an Obsidian vault, with the file each came from, as candidates for puddle requests.
 *
 * Reads visible Markdown notes in path order without changing the vault.
 */
export async function run(
  args: RunArgs,
  settings: GlobalArgs,
): Promise<Task[]> {
  const folder = args.folder.replace(/\/+$/, "");
  if (folder.startsWith("/") || folder.split("/").includes("..")) {
    throw new Error(
      `The folder must be inside the vault, not "${args.folder}".`,
    );
  }
  const { excludeFolders } = GlobalArgsSchema.parse(settings);
  const excluded = excludeFolders.map((f) => f.replace(/^\/+|\/+$/g, ""));
  const root = settings.vaultPath.replace(/\/+$/, "");
  const start = folder ? `${root}/${folder}` : root;
  try {
    if (!(await Deno.stat(start)).isDirectory) throw new Deno.errors.NotFound();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        folder
          ? `No folder "${folder}" in the vault.`
          : `No vault at "${root}".`,
      );
    }
    throw e;
  }

  // A chosen subfolder must not lead through a symlink either.
  let partPath = root;
  for (const part of folder.split("/").filter(Boolean)) {
    partPath += `/${part}`;
    if ((await Deno.lstat(partPath)).isSymlink) {
      throw new Error(
        `The folder must be inside the vault, not "${args.folder}".`,
      );
    }
  }

  const notes = (await listNotes(start, folder)).filter((path) =>
    !DAILY_NOTE.test(path.split("/").pop()!) &&
    !excluded.some((f) => path === f || path.startsWith(`${f}/`))
  ).sort();
  const tasks: Task[] = [];
  const taskLine = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.*\S)\s*$/;
  for (const path of notes) {
    const lines = (await Deno.readTextFile(`${root}/${path}`)).split("\n");
    let fence: "```" | "~~~" | undefined;
    let heading: string | undefined;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].replace(/\r$/, "");
      const marker = /^\s*(```|~~~)/.exec(line)?.[1] as
        | "```"
        | "~~~"
        | undefined;
      if (marker && (!fence || marker === fence)) {
        fence = fence ? undefined : marker;
        continue;
      }
      if (fence) continue;
      const title = HEADING.exec(line)?.[1].trim();
      if (title) {
        heading = title;
        continue;
      }
      const match = taskLine.exec(line);
      if (match) {
        const task: Task = { path, line: index + 1, text: match[1].trim() };
        tasks.push(heading ? { ...task, heading } : task);
      }
    }
  }
  return tasks;
}

/** A Markdown heading line; "#tag" is not one. */
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;

/** A daily note's file name. */
const DAILY_NOTE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** Vault-relative paths of visible Markdown notes under a directory. */
async function listNotes(dir: string, relDir: string): Promise<string[]> {
  const notes: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".") || entry.isSymlink) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      notes.push(...await listNotes(`${dir}/${entry.name}`, rel));
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      notes.push(rel);
    }
  }
  return notes;
}

/** A task's id: the first 16 hex digits of the SHA-256 of its path and text. */
export async function taskId(task: Task): Promise<string> {
  const bytes = new TextEncoder().encode(`${task.path}\n${task.text}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Text that looks like a token, key, password or email address. From puddlerouter. */
const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*\s*[:=]\s*\S+/i,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /\b[0-9a-f]{32,}\b/i,
];

/** Whether a task's text must not be sent to the model. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** Said once per request rather than in every question, to keep requests small. */
export const GUIDANCE =
  "Each question is a task from one person's to-do list, with the note it is in and the nearest heading above it. " +
  "Decide whether it is worth building a reusable swamp extension (a program calling APIs or CLIs, run on demand or on a schedule) " +
  "to do the task, or a recurring version of it, for them.";

const CRITERIA = {
  extension:
    "A reusable extension: software can do it, and it recurs or helps others.",
  one_off:
    "Software can do it, but it is a one-off setup, install or clean-up.",
  person:
    "It needs a person: physical, a conversation, learning, a decision or creative work.",
};

/**
 * Give each task its id and withheld flag, and ask one question per task that
 * is not withheld, at most `batchSize` questions to a request.
 */
export async function prepare(
  tasks: Task[],
  batchSize: number,
): Promise<
  { items: PreparedTask[]; batches: Record<string, ChoiceQuestion>[] }
> {
  const items: PreparedTask[] = [];
  const batches: Record<string, ChoiceQuestion>[] = [];
  for (const task of tasks) {
    const item = {
      ...task,
      id: await taskId(task),
      withheld: looksSecret(task.text),
    };
    items.push(item);
    if (item.withheld) continue;
    let batch = batches.at(-1);
    if (!batch || Object.keys(batch).length >= batchSize) {
      batch = {};
      batches.push(batch);
    }
    // A heading that looks like a secret stays out of the question.
    const heading = task.heading && !looksSecret(task.heading)
      ? `, under the heading "${task.heading}"`
      : "";
    batch[item.id] = {
      type: "choice",
      instructions: `"${task.text}" (note ${task.path}${heading})`,
      criteria: CRITERIA,
    };
  }
  return { items, batches };
}

/** One answer from Jev's `ask`: the choice it made and how sure it is. */
export const AnswerSchema = z.looseObject({
  choice: z.string(),
  confidence: z.number().min(0).max(1),
});
/** One parsed answer from Jev. */
export type Answer = z.infer<typeof AnswerSchema>;

/** Arguments for `classify`: the tasks from `run` and Jev's answers. */
export const ClassifyArgsSchema = z.object({
  tasks: z.array(PreparedTaskSchema).describe("The items from `run`."),
  answers: z.array(z.record(z.string(), AnswerSchema)).default([]).describe(
    "Jev's answers for each request that succeeded, keyed by task id. Tasks in a request that failed stay unclassified.",
  ),
  threshold: z.number().min(0).max(1).default(0.5).describe(
    'Least confidence in an "extension" answer for the task to be a candidate. Jev\'s confidence is its own measure, lower than the probability it gives its answer.',
  ),
});
/** Arguments for `classify`, after defaults apply. */
export type ClassifyArgs = z.infer<typeof ClassifyArgsSchema>;

/** The classifications a task can get. */
export const CLASSIFICATIONS = [
  "candidate",
  "not_candidate",
  "unclassified",
  "withheld",
] as const;

/** A task with its classification, and Jev's choice and confidence when it answered. */
export const ClassifiedTaskSchema = PreparedTaskSchema.extend({
  classification: z.enum(CLASSIFICATIONS),
  choice: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
/** One classified task. */
export type ClassifiedTask = z.infer<typeof ClassifiedTaskSchema>;

/** What `classify` stores: every task classified, with a count of each classification. */
export const ClassifiedSchema = z.object({
  threshold: z.number(),
  items: z.array(ClassifiedTaskSchema),
  counts: z.record(z.enum(CLASSIFICATIONS), z.number().int().min(0)),
  classifiedAt: z.iso.datetime(),
});
/** The `classified` resource. */
export type Classified = z.infer<typeof ClassifiedSchema>;

/** Turn Jev's answers into a classification for every task. */
export function classify(
  tasks: PreparedTask[],
  batches: Record<string, Answer>[],
  threshold: number,
): Pick<Classified, "items" | "counts"> {
  const answers: Record<string, Answer> = Object.assign({}, ...batches);
  const counts = {
    candidate: 0,
    not_candidate: 0,
    unclassified: 0,
    withheld: 0,
  };
  const items = tasks.map((task): ClassifiedTask => {
    const answer = task.withheld ? undefined : answers[task.id];
    const classification = task.withheld
      ? "withheld"
      : !answer
      ? "unclassified"
      : answer.choice === "extension" && answer.confidence >= threshold
      ? "candidate"
      : "not_candidate";
    counts[classification]++;
    return answer
      ? {
        ...task,
        classification,
        choice: answer.choice,
        confidence: answer.confidence,
      }
      : { ...task, classification };
  });
  return { items, counts };
}

/** What `swamp <args>` gave back. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `swamp <args>`; the real one is `swampExec`, tests use a fake. */
export type Exec = (args: string[]) => Promise<ExecResult>;

/**
 * Runs the `swamp` on the path. Arguments are never joined into a shell line:
 * a search passes at most four words of `[a-z0-9_-]` (see `searchQuery`).
 */
export const swampExec: Exec = async (args) => {
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command("swamp", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
};

/** Words that say nothing about what a task needs. From puddlerouter. */
const STOPWORDS = new Set(
  `all and any about are can could did does for from get give had has have how
  its list many much show tell that the their there these this those was what
  whats with would you your please our not but which when where who why will
  into out off than then them they been being also just some such only own
  same too very more most other another each every both few`
    .split(/\s+/),
);

/** The content words of a task, for searching the registry; at most four. */
export function searchQuery(text: string): string {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    seen.add(w);
  }
  return [...seen].slice(0, 4).join(" ");
}

/** Extensions a search keeps, and so Jev picks from. */
const MAX_FOUND = 3;
/** Registry searches run at once. */
const SEARCH_CONCURRENCY = 4;

/** One extension the registry search found. */
export const FoundSchema = z.object({
  name: z.string(),
  description: z.string(),
});
/** One extension found. */
export type Found = z.infer<typeof FoundSchema>;

/**
 * The top extensions the registry finds for a query. A search that fails,
 * prints something that is not JSON or throws is `failed`; an empty query is
 * not searched.
 */
export async function searchRegistry(
  query: string,
  exec: Exec,
): Promise<{ found: Found[]; failed: boolean }> {
  if (!query) return { found: [], failed: false };
  try {
    const res = await exec(["extension", "search", query, "--json"]);
    if (res.code !== 0) return { found: [], failed: true };
    const rows = (JSON.parse(res.stdout) as { extensions?: unknown })
      ?.extensions;
    if (!Array.isArray(rows)) return { found: [], failed: true };
    const found: Found[] = [];
    for (const r of rows) {
      if (typeof r?.name !== "string") continue;
      found.push({
        name: r.name,
        description: typeof r.description === "string" ? r.description : "",
      });
      if (found.length === MAX_FOUND) break;
    }
    return { found, failed: false };
  } catch {
    return { found: [], failed: true };
  }
}

const NO_CANDIDATE = "No such candidate.";

/** Criteria for Jev's pick: c1..c3, one per extension found, and none. */
export function criteriaFor(found: Found[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (let i = 0; i < MAX_FOUND; i++) {
    const f = found[i];
    criteria[`c${i + 1}`] = f
      ? `${f.name}: ${f.description || "no description"}`
      : NO_CANDIDATE;
  }
  criteria.none =
    "None of these already does the task; a new extension would be needed.";
  return criteria;
}

/** Said once per pick request rather than in every question. */
export const MATCH_GUIDANCE =
  "Each question is a task from one person's to-do list that a reusable swamp extension could do, " +
  "with the note it is in, and up to three extensions a search of the swamp extension registry found for it. " +
  "Choose the extension that already does the task, or none if none of them does.";

/** What the registry search gave for one candidate. */
export const MatchItemSchema = z.object({
  id: z.string(),
  /** The words searched for; empty when the task has no content words. */
  query: z.string(),
  found: z.array(FoundSchema),
  /** The search failed, so whether an extension covers it is not known. */
  searchFailed: z.boolean(),
});
/** One candidate's search. */
export type MatchItem = z.infer<typeof MatchItemSchema>;

/** What `match` stores. */
export const MatchedSchema = z.object({
  items: z.array(MatchItemSchema),
  /** The `state` for Jev's pick requests. */
  guidance: z.string(),
  /** One pick question per candidate the search found something for, keyed by task id. */
  batches: z.array(z.record(z.string(), ChoiceQuestionSchema)),
  matchedAt: z.iso.datetime(),
});
/** The `matched` resource. */
export type Matched = z.infer<typeof MatchedSchema>;

/** Arguments for `match`. */
export const MatchArgsSchema = z.object({
  tasks: z.array(ClassifiedTaskSchema).describe("The items from `classify`."),
});
/** Arguments for `match`, after defaults apply. */
export type MatchArgs = z.infer<typeof MatchArgsSchema>;

/** How a question names a task: its text, note and a heading that looks safe. */
function describeTask(task: Task): string {
  const heading = task.heading && !looksSecret(task.heading)
    ? `, under the heading "${task.heading}"`
    : "";
  return `"${task.text}" (note ${task.path}${heading})`;
}

/**
 * Search the registry for each candidate, and ask one pick question for each
 * that the search found something for, at most `batchSize` to a request.
 */
export async function match(
  tasks: ClassifiedTask[],
  exec: Exec,
  batchSize: number,
): Promise<Pick<Matched, "items" | "batches">> {
  const candidates = tasks.filter((t) => t.classification === "candidate");
  const items: MatchItem[] = new Array(candidates.length);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      const query = searchQuery(candidates[i].text);
      const { found, failed } = await searchRegistry(query, exec);
      items[i] = { id: candidates[i].id, query, found, searchFailed: failed };
    }
  };
  await Promise.all(
    Array.from({ length: SEARCH_CONCURRENCY }, worker),
  );
  const batches: Record<string, ChoiceQuestion>[] = [];
  candidates.forEach((task, i) => {
    if (!items[i].found.length) return;
    let batch = batches.at(-1);
    if (!batch || Object.keys(batch).length >= batchSize) {
      batch = {};
      batches.push(batch);
    }
    batch[task.id] = {
      type: "choice",
      instructions: describeTask(task),
      criteria: criteriaFor(items[i].found),
    };
  });
  return { items, batches };
}

/** One call to another behavior's method; `runModel` in a method context. */
export interface ModelCall {
  definition?: string;
  modelType?: string;
  name?: string;
  method: string;
  arguments?: Record<string, unknown>;
}
/** What `runModel` gives back: the data written, or why it failed. */
export type RunResult =
  | {
    ok: true;
    resources: {
      name: string;
      specName?: string;
      attributes?: Record<string, unknown>;
    }[];
  }
  | { ok: false; error: { message: string } };
/** Runs another behavior's method in process. */
export type RunModel = (call: ModelCall) => Promise<RunResult>;

/**
 * Most `create_request` calls in one run. swamp allows 100 `runModel` calls
 * per execution; the rest wait for the next run, which reuses what this one
 * logged.
 */
export const MAX_LOGS = 90;

/** What can happen to a task. */
export const OUTCOMES = ["logged", "matched", "skipped", "failed"] as const;

/** A task with what happened to it. */
export const LoggedItemSchema = ClassifiedTaskSchema.extend({
  outcome: z.enum(OUTCOMES),
  /** Why it was skipped or failed. */
  reason: z.string().optional(),
  /** Skipped only because the run is a preview: a live run would log it. */
  wouldLog: z.boolean().optional(),
  /** The extension that covers it, when matched. */
  extension: z.string().optional(),
  /** The Capture request, when logged. */
  request: z.object({
    id: z.string(),
    number: z.number().int(),
    url: z.string(),
  }).optional(),
});
/** One task's outcome. */
export type LoggedItem = z.infer<typeof LoggedItemSchema>;

/** What `log` stores: every task with its outcome, and a count of each. */
export const LoggedSchema = z.object({
  /** Who the requests were logged for; empty for a preview. */
  logAs: z.string(),
  captureModel: z.string(),
  items: z.array(LoggedItemSchema),
  counts: z.record(z.enum(OUTCOMES), z.number().int().min(0)),
  loggedAt: z.iso.datetime(),
});
/** The `logged` resource. */
export type Logged = z.infer<typeof LoggedSchema>;

/** Arguments for `log`. */
export const LogArgsSchema = z.object({
  tasks: z.array(ClassifiedTaskSchema).describe("The items from `classify`."),
  matched: z.array(MatchItemSchema).default([]).describe(
    "The items from `match`.",
  ),
  answers: z.array(z.record(z.string(), AnswerSchema)).default([]).describe(
    "Jev's pick answers for each request that succeeded, keyed by task id.",
  ),
});
/** Arguments for `log`, after defaults apply. */
export type LogArgs = z.infer<typeof LogArgsSchema>;

/** The settings `log` uses. */
export type LogSettings = Pick<
  z.infer<typeof GlobalArgsSchema>,
  "logAs" | "captureModel" | "captureUrl" | "matchThreshold"
>;

/** The idempotency key for a task: one request per path and text, ever. */
export function idempotencyKey(id: string): string {
  return `obsidian-task-scan:${id}`;
}

/**
 * The Capture request for a candidate no extension covers. Capture shows the
 * description as plain text, so it has no Markdown.
 */
export function requestDraft(
  task: ClassifiedTask,
  searched: MatchItem,
  pick: Answer | undefined,
): {
  title: string;
  description: string;
  candidateExtensions: string[];
  idempotencyKey: string;
} {
  const title = task.text.replace(/\s+/g, " ").trim().slice(0, 120);
  const heading = task.heading && !looksSecret(task.heading)
    ? `, under the heading "${task.heading}"`
    : "";
  const sure = task.confidence === undefined
    ? ""
    : ` (confidence ${task.confidence.toFixed(2)})`;
  const found = searched.found.map((f) => f.name);
  const lines = [
    task.text,
    "",
    `From the Obsidian vault: ${task.path}, line ${task.line}${heading}.`,
    `Jev marked it worth a reusable swamp extension${sure}.`,
    `Searched the registry for: ${
      searched.query || "nothing (no content words)"
    }`,
    `Found: ${found.length ? found.join(", ") : "nothing"}`,
  ];
  if (pick && found.length) {
    lines.push(
      `Jev's pick: ${pick.choice} (confidence ${pick.confidence.toFixed(2)})`,
    );
  }
  lines.push(`Logged by obsidian-task-scan (task ${task.id}).`);
  return {
    title,
    description: lines.join("\n"),
    candidateExtensions: found,
    idempotencyKey: idempotencyKey(task.id),
  };
}

const SKIPPED: Record<
  Exclude<ClassifiedTask["classification"], "candidate">,
  string
> = {
  not_candidate:
    "Not a candidate: Jev said it is a one-off job or needs a person, or was not sure enough.",
  unclassified:
    "Not classified: Jev could not be asked about it. The next run tries again.",
  withheld:
    "Withheld: it looks like it holds a secret, so it is never sent to Jev or Capture.",
};

const PREVIEW =
  "Preview: logAs is empty, so nothing is logged. A live run would log it.";

/** The request a Capture `create_request` result holds, if any. */
function requestIn(
  result: RunResult,
): { id: string; number: number } | undefined {
  if (!result.ok) return undefined;
  for (const r of result.resources) {
    const a = r.attributes ?? {};
    if (
      (r.specName ?? "request") === "request" && typeof a.id === "string" &&
      typeof a.number === "number"
    ) {
      return { id: a.id, number: a.number };
    }
  }
  return undefined;
}

/**
 * Decide each task's outcome, and log in Capture each candidate no extension
 * covers. Nothing is logged that is not sure: a failed search, a missing or
 * odd pick, or a request Capture turned away leaves the task `failed` for the
 * next run. A task the previous run logged for the same person and behavior
 * keeps its request without calling Capture again.
 */
export async function logCandidates(
  tasks: ClassifiedTask[],
  matched: MatchItem[],
  answers: Record<string, Answer>[],
  settings: LogSettings,
  runModel: RunModel | undefined,
  previous?: Logged | null,
): Promise<Pick<Logged, "items" | "counts">> {
  const searches = new Map(matched.map((m) => [m.id, m]));
  const picks: Record<string, Answer> = Object.assign({}, ...answers);
  const before = new Map<string, NonNullable<LoggedItem["request"]>>();
  if (
    previous && previous.logAs === settings.logAs &&
    previous.captureModel === settings.captureModel
  ) {
    for (const item of previous.items) {
      if (item.outcome === "logged" && item.request) {
        before.set(item.id, item.request);
      }
    }
  }
  const counts = { logged: 0, matched: 0, skipped: 0, failed: 0 };
  let calls = 0;
  const items: LoggedItem[] = [];
  for (const task of tasks) {
    const item = await outcomeFor(task);
    counts[item.outcome]++;
    items.push(item);
  }
  return { items, counts };

  async function outcomeFor(task: ClassifiedTask): Promise<LoggedItem> {
    const failed = (reason: string): LoggedItem => ({
      ...task,
      outcome: "failed",
      reason,
    });
    if (task.classification !== "candidate") {
      return {
        ...task,
        outcome: "skipped",
        reason: SKIPPED[task.classification],
      };
    }
    const searched = searches.get(task.id);
    if (!searched) {
      return failed(
        "Not searched for in the registry. The next run tries again.",
      );
    }
    if (searched.searchFailed) {
      return failed("The registry search failed. The next run tries again.");
    }
    const pick = searched.found.length ? picks[task.id] : undefined;
    if (searched.found.length) {
      if (!pick) {
        return failed(
          "Jev was not asked, or did not answer, which extension covers it. The next run asks again.",
        );
      }
      if (pick.choice !== "none") {
        const slot = /^c([1-9])$/.exec(pick.choice);
        const found = slot ? searched.found[Number(slot[1]) - 1] : undefined;
        if (!found) {
          return failed(
            `Jev's pick "${pick.choice}" names no extension that was found. The next run asks again.`,
          );
        }
        if (pick.confidence >= settings.matchThreshold) {
          return { ...task, outcome: "matched", extension: found.name };
        }
      }
    }
    if (!settings.logAs) {
      return { ...task, outcome: "skipped", reason: PREVIEW, wouldLog: true };
    }
    const kept = before.get(task.id);
    if (kept) return { ...task, outcome: "logged", request: kept };
    if (!runModel) {
      return failed("runModel is not available, so Capture cannot be reached.");
    }
    if (calls >= MAX_LOGS) {
      return failed(
        `More than ${MAX_LOGS} requests to log in one run. The next run logs it.`,
      );
    }
    calls++;
    const draft = requestDraft(task, searched, pick);
    let result: RunResult;
    try {
      result = await runModel({
        definition: settings.captureModel,
        method: "create_request",
        arguments: { as: settings.logAs, ...draft },
      });
    } catch (e) {
      result = { ok: false, error: { message: String(e) } };
    }
    if (!result.ok) {
      return failed(
        `Capture did not log it: ${
          result.error.message.slice(0, 300)
        }. The next run tries again.`,
      );
    }
    const request = requestIn(result);
    if (!request) {
      return failed("Capture gave back no request. The next run tries again.");
    }
    const url = `${
      settings.captureUrl.replace(/\/+$/, "")
    }/requests/${request.id}`;
    return { ...task, outcome: "logged", request: { ...request, url } };
  }
}

/** What the methods call. Tests swap `run` and `exec` here to check the wiring without the real behaviour. */
export const behaviour = { run, exec: swampExec };

type Log = (message: string, props?: Record<string, unknown>) => void;

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: { info: Log; warning?: Log };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  /** Runs another behavior's method in process; `log` calls Capture with it. */
  runModel?: RunModel;
}

/** The `@puddleworks/obsidian-task-scan` model type: methods `run`, `classify`, `match` and `log`. */
export const model = {
  type: "@puddleworks/obsidian-task-scan",
  version: "2026.11.02.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.23.4",
      description:
        "Add batchSize, which defaults to 150, so existing settings need no change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.02.1",
      description:
        "Add logAs (empty: preview), captureModel, captureUrl and matchThreshold, which all default, so existing settings need no change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    result: {
      description:
        "The open tasks, each with its file, line, id and withheld flag, and the questions for Jev in batches.",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    classified: {
      description:
        "Every task with its classification (candidate, not_candidate, unclassified or withheld) and confidence.",
      schema: ClassifiedSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    matched: {
      description:
        "What the registry search found for each candidate, and the questions for Jev's pick in batches.",
      schema: MatchedSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    logged: {
      description:
        "Every task with its classification, confidence and outcome: logged (with the Capture request link), matched, skipped or failed.",
      schema: LoggedSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    run: {
      description:
        'List the open task lines ("- [ ]") in an Obsidian vault, leaving out templates and daily notes, and prepare a question for Jev about each.',
      arguments: RunArgsSchema,
      execute: async (args: RunArgs, context: MethodContext) => {
        context.logger.info("Scanning the vault folder {folder}", {
          folder: args.folder,
        });
        const tasks = await behaviour.run(args, context.globalArgs);
        const result: Result = {
          args,
          guidance: GUIDANCE,
          ...await prepare(
            tasks,
            GlobalArgsSchema.parse(context.globalArgs).batchSize,
          ),
          ranAt: new Date().toISOString(),
        };
        const handle = await context.writeResource("result", "result", result);
        // Counts only: task text and note paths stay out of the logs.
        context.logger.info(
          "Found {tasks} open tasks, {withheld} withheld; {questions} questions for Jev",
          {
            tasks: result.items.length,
            withheld: result.items.filter((i) => i.withheld).length,
            questions: result.batches.reduce(
              (n, batch) => n + Object.keys(batch).length,
              0,
            ),
            batches: result.batches.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    classify: {
      description:
        'Classify each task from Jev\'s answers: a candidate when the answer is "extension" with at least the threshold confidence.',
      arguments: ClassifyArgsSchema,
      execute: async (args: ClassifyArgs, context: MethodContext) => {
        context.logger.info(
          "Classifying {tasks} tasks from {answers} answers",
          {
            tasks: args.tasks.length,
            answers: args.answers.reduce(
              (n, batch) => n + Object.keys(batch).length,
              0,
            ),
          },
        );
        const classified: Classified = {
          threshold: args.threshold,
          ...classify(args.tasks, args.answers, args.threshold),
          classifiedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "classified",
          "classified",
          classified,
        );
        context.logger.info(
          "{candidate} candidates, {not_candidate} not candidates, {unclassified} unclassified, {withheld} withheld",
          classified.counts,
        );
        return { dataHandles: [handle] };
      },
    },
    match: {
      description:
        "Search the swamp extension registry for each candidate, and prepare a question for Jev about which extension found, if any, already does it.",
      arguments: MatchArgsSchema,
      execute: async (args: MatchArgs, context: MethodContext) => {
        const candidates =
          args.tasks.filter((t) => t.classification === "candidate").length;
        context.logger.info(
          "Searching the registry for {candidates} candidates",
          {
            candidates,
          },
        );
        const matched: Matched = {
          ...await match(
            args.tasks,
            behaviour.exec,
            GlobalArgsSchema.parse(context.globalArgs).batchSize,
          ),
          guidance: MATCH_GUIDANCE,
          matchedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "matched",
          "matched",
          matched,
        );
        // Counts only: task text, queries and extension names stay out of the logs.
        context.logger.info(
          "{withResults} with extensions found, {nothingFound} with none, {searchFailed} searches failed; {questions} questions for Jev",
          {
            withResults: matched.items.filter((i) => i.found.length).length,
            nothingFound:
              matched.items.filter((i) => !i.found.length && !i.searchFailed)
                .length,
            searchFailed: matched.items.filter((i) => i.searchFailed).length,
            questions: matched.batches.reduce(
              (n, batch) => n + Object.keys(batch).length,
              0,
            ),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    log: {
      description:
        "Log in Capture each candidate no extension covers, as a draft request, and store every task's outcome. With logAs empty it only previews.",
      arguments: LogArgsSchema,
      execute: async (args: LogArgs, context: MethodContext) => {
        const settings = GlobalArgsSchema.parse(context.globalArgs);
        context.logger.info(
          settings.logAs
            ? "Logging the uncovered candidates among {tasks} tasks in Capture"
            : "Previewing {tasks} tasks: logAs is empty, so nothing is logged",
          { tasks: args.tasks.length },
        );
        let previous: Logged | null = null;
        try {
          const read = LoggedSchema.safeParse(
            await context.readResource?.("logged"),
          );
          if (read.success) previous = read.data;
        } catch {
          /* no previous run to reuse: Capture's idempotency key still holds */
        }
        const logged: Logged = {
          logAs: settings.logAs,
          captureModel: settings.captureModel,
          ...await logCandidates(
            args.tasks,
            args.matched,
            args.answers,
            settings,
            context.runModel,
            previous,
          ),
          loggedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource("logged", "logged", logged);
        context.logger.info(
          "{logged} logged, {matched} matched to an extension, {skipped} skipped, {failed} failed",
          logged.counts,
        );
        if (logged.counts.failed) {
          (context.logger.warning ?? context.logger.info)(
            "{failed} candidates were not logged because the registry, Jev or Capture could not be reached or was unsure; the next run tries them again",
            { failed: logged.counts.failed },
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
