/**
 * @puddleworks/obsidian-task-scan — Find tasks in an Obsidian vault that a swamp extension could do
 *
 * `run` lists the open task lines ("- [ ]") in an Obsidian vault, leaving out
 * templates and daily notes, and prepares one Jev choice question per task.
 * The workflow asks Jev (`@swamp/typesafe-ai`) those questions, then `classify`
 * marks each task a candidate, not a candidate, withheld or unclassified.
 *
 * Output: every task with its file, line, classification and confidence.
 *
 * Out of scope (spec revision 2):
 * - Editing the vault
 * - Proposing, agreeing or building the requests
 * - Merging similar tasks
 * - Done or in-progress tasks
 *
 * Not built yet: checking candidates against the registry and logging them in
 * Capture (revision 2, AC2–AC4 and AC7).
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
});
export type GlobalArgs = z.input<typeof GlobalArgsSchema>;

/** Arguments for `run` — one per specification input. */
export const RunArgsSchema = z.object({
  folder: z.string().default("").describe(
    "Subfolder of the vault to scan, relative to the vault root. Empty scans the whole vault.",
  ),
});
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
});
export type Task = z.infer<typeof TaskSchema>;

/** A task ready for the classifier. */
export const PreparedTaskSchema = TaskSchema.extend({
  /** Stable across runs: depends on the path and text, not the line. */
  id: z.string().regex(/^[0-9a-f]{16}$/),
  /** The text looks like it holds a secret, so it is never sent to the model. */
  withheld: z.boolean(),
});
export type PreparedTask = z.infer<typeof PreparedTaskSchema>;

/** A Jev `choice` question, as `@swamp/typesafe-ai` `ask` takes it. */
export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()),
});
export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;

export const ResultSchema = z.object({
  args: RunArgsSchema,
  items: z.array(PreparedTaskSchema),
  /** One question per task that is not withheld, keyed by task id. */
  questions: z.record(z.string(), ChoiceQuestionSchema),
  ranAt: z.iso.datetime(),
});
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
      const match = taskLine.exec(line);
      if (match) tasks.push({ path, line: index + 1, text: match[1].trim() });
    }
  }
  return tasks;
}

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

const CRITERIA = {
  extension:
    "Software could do it end to end through APIs or CLIs, with no human judgement or physical action.",
  person:
    "It needs a person: a physical action, a conversation, learning, a decision or creative work.",
};

/** Give each task its id and withheld flag, and ask one question per task that is not withheld. */
export async function prepare(
  tasks: Task[],
): Promise<
  { items: PreparedTask[]; questions: Record<string, ChoiceQuestion> }
> {
  const items: PreparedTask[] = [];
  const questions: Record<string, ChoiceQuestion> = {};
  for (const task of tasks) {
    const item = {
      ...task,
      id: await taskId(task),
      withheld: looksSecret(task.text),
    };
    items.push(item);
    if (item.withheld) continue;
    questions[item.id] = {
      type: "choice",
      instructions:
        `Task from a personal to-do list: "${task.text}" (note ${task.path}). ` +
        "Could a swamp extension (a program calling APIs or CLIs, run on demand or on a schedule) " +
        "do this task, or a recurring version of it, for the owner?",
      criteria: CRITERIA,
    };
  }
  return { items, questions };
}

/** One answer from Jev's `ask`: the choice it made and how sure it is. */
export const AnswerSchema = z.looseObject({
  choice: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const ClassifyArgsSchema = z.object({
  tasks: z.array(PreparedTaskSchema).describe("The items from `run`."),
  answers: z.record(z.string(), AnswerSchema).default({}).describe(
    "Jev's answers keyed by task id. Empty when the model could not be reached.",
  ),
  threshold: z.number().min(0).max(1).default(0.7).describe(
    'Least confidence in an "extension" answer for the task to be a candidate.',
  ),
});
export type ClassifyArgs = z.infer<typeof ClassifyArgsSchema>;

export const CLASSIFICATIONS = [
  "candidate",
  "not_candidate",
  "unclassified",
  "withheld",
] as const;

export const ClassifiedTaskSchema = PreparedTaskSchema.extend({
  classification: z.enum(CLASSIFICATIONS),
  choice: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type ClassifiedTask = z.infer<typeof ClassifiedTaskSchema>;

export const ClassifiedSchema = z.object({
  threshold: z.number(),
  items: z.array(ClassifiedTaskSchema),
  counts: z.record(z.enum(CLASSIFICATIONS), z.number().int().min(0)),
  classifiedAt: z.iso.datetime(),
});
export type Classified = z.infer<typeof ClassifiedSchema>;

/** Turn Jev's answers into a classification for every task. */
export function classify(
  tasks: PreparedTask[],
  answers: Record<string, Answer>,
  threshold: number,
): Pick<Classified, "items" | "counts"> {
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

/** What the run method calls. Tests swap `run` here to check the wiring without the real behaviour. */
export const behaviour = { run };

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

export const model = {
  type: "@puddleworks/obsidian-task-scan",
  version: "2026.10.23.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description:
        "The open tasks, each with its file, line, id and withheld flag, and the questions for Jev.",
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
  },
  methods: {
    run: {
      description:
        'List the open task lines ("- [ ]") in an Obsidian vault, leaving out templates and daily notes, and prepare a question for Jev about each.',
      arguments: RunArgsSchema,
      execute: async (args: RunArgs, context: MethodContext) => {
        const tasks = await behaviour.run(args, context.globalArgs);
        const result: Result = {
          args,
          ...await prepare(tasks),
          ranAt: new Date().toISOString(),
        };
        const handle = await context.writeResource("result", "result", result);
        return { dataHandles: [handle] };
      },
    },
    classify: {
      description:
        'Classify each task from Jev\'s answers: a candidate when the answer is "extension" with at least the threshold confidence.',
      arguments: ClassifyArgsSchema,
      execute: async (args: ClassifyArgs, context: MethodContext) => {
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
        return { dataHandles: [handle] };
      },
    },
  },
};
