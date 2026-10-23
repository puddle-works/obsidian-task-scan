# obsidian-task-scan

Scan Obsidian vault for tasks that could become puddle requests. Built by puddleworks-factory from the app spec `obsidian-task-scan`;
the specification below was agreed before it was handed over.

Spec: [where it was agreed](http://localhost:3001/requests/6d47d38e-10cd-4b9a-991d-2e5a272be6b7), version 1, hash `28f25fc4c513835d9121c7bc4e8169ba74277cf6a3c650b42bdfeafc55dbc9e1`.

## Bounded purpose

List the open task lines ("- [ ]") in an Obsidian vault, with the file each came from, as candidates for puddle requests.

## Inputs (the run form)

- `folder` (string, empty) — Subfolder of the vault to scan, relative to the vault root. Empty scans the whole vault.

## Settings (set once per model instance)

- `vaultPath` — Absolute path to the Obsidian vault folder.

## Output

A list of open tasks, each with the task text, the vault-relative file path and the line number.

## Out of scope

- Creating puddle requests automatically
- AI classification of the matches
- Editing the vault

Anything on this list, or anything beyond the purpose above, needs a new
spec. Do not add it here, and do not add permissions or secrets the
settings above do not name.

## Finishing the draft

1. Replace the `run` stub in `extensions/models/obsidian_task_scan.ts` with the
   real behaviour. Keep the argument names: the workflow and the run form
   depend on them.
2. Give `ResultSchema.items` the shape of the output above, and add tests for
   the behaviour to `extensions/models/obsidian_task_scan_test.ts`. Leave the
   generated tests as they are: they stub `run`, so they keep passing. Tests
   of the behaviour call `run` directly with working settings.
3. If the tests need permissions (`--allow-read`, `--allow-net`, …), add the
   same flags to the "Test it" command in `README.md` and to this app's line
   in the repo `Makefile`.
4. `deno check` and `deno test` must pass before review.
