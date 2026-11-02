# obsidian-task-scan: spec revision 2 (from version 1)

Request: Capture #2 in puddleworks-desk (id `6d47d38e-10cd-4b9a-991d-2e5a272be6b7`; version 1 was agreed at http://localhost:3001/requests/6d47d38e-10cd-4b9a-991d-2e5a272be6b7)

**Reason for the change:** The owner wants the tasks a swamp extension could do found and logged in Capture, not a list of every open task: v1 on the TechWork vault listed 419 tasks, nearly all personal to-dos.

To agree it, in puddleworks-desk: `revise` request #2, write `revision-2.json`'s `content` with `edit_specification`, `propose` it, and the outcome owner `agree`s it. Generated from `revision-2.json`.

## Problem statement

Manually reviewing an Obsidian vault to spot tasks or recurring frustrations that could be turned into puddle requests is slow and easy to miss. A list of every open task does not help: on the owner's main vault it is over 400 lines, nearly all personal to-dos, and the few tasks a swamp extension could do are buried in it.

## Desired outcome

Once a week, the open tasks in an Obsidian vault that a swamp extension could do are picked out, checked against the extensions that already exist, and each new one is logged in Capture as a draft request with the file and line it came from.

## In scope

- Reading the open task lines ("- [ ]") in the vault's Markdown notes, optionally limited to one subfolder
- Leaving out templates and daily notes, which repeat the same routine tasks
- Deciding for each task, using a model and with a confidence, whether it is worth a reusable swamp extension, a one-off job software could do, or needs a person; the model sees the task with its note and nearest heading
- Searching the swamp extension registry for an extension that already covers each candidate
- Creating one draft request in Capture for each candidate no extension covers
- Running on a weekly schedule, and on demand

## Out of scope

- Editing the vault
- Proposing, agreeing or building the requests it creates
- Merging similar tasks into one request
- Tasks that are already done or in progress

## Constraints

- The vault is only read, never written
- A task is logged in Capture at most once, across all runs, keyed on its file path and text
- The model API key comes from a swamp vault, never from the repo
- A task that looks like it holds a secret is not sent to the model or to Capture
- Capture is reached only through the methods of the @puddleworks/capture extension, never by writing its data directly

## Assumptions

- Capture is the @puddleworks/capture swamp extension, in the same swamp repo as this workflow; its create_request takes an idempotency key, so a retry never makes a second request
- The classifier is Jev through @swamp/typesafe-ai, as puddlerouter uses
- Templates live in the vault's Templates folder and daily notes are named YYYY-MM-DD.md

## Acceptance criteria

- **AC1** Every open task outside templates and daily notes is classified as worth an extension, a one-off job or needing a person, with the model's confidence; a task is a candidate when the model says it is worth an extension with at least the configured confidence (default 0.5).
- **AC2** A candidate that an existing registry extension covers is reported with that extension's name and is not logged in Capture.
- **AC3** Each other candidate becomes one draft request in Capture, titled from the task, with the vault-relative file path, line and task text in its description.
- **AC4** Running again with no vault changes creates nothing new in Capture.
- **AC5** The vault's files are unchanged after a run.
- **AC6** Each run stores a result listing every task scanned with its classification, confidence, and whether it was logged (with the Capture request link), matched to an extension, skipped, or failed.
- **AC7** If Capture or the model cannot be reached, the run says so and logs nothing it is unsure of; the tasks it missed are picked up by the next run.
