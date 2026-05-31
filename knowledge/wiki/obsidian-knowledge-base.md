# Obsidian knowledge base

This page is the **single source of truth** for how agents work with the
V-Amber Obsidian vault. `AGENTS.md`, `CLAUDE.md`, and
[[project-conventions]] intentionally stay short and link here.

Open `D:\myprojects\V-Amber` in Obsidian to browse, follow wikilinks, and
inspect the graph. The vault follows the Amberry39 pattern.

## Structure

| Path | Purpose | Treat as |
|---|---|---|
| `knowledge/wiki/` | Maintained, synthesised pages written by agents. | Editable. |
| `knowledge/wiki/index.md` | Catalog. First page every agent reads. | Editable on new-page only. |
| `knowledge/wiki/log.md` | Chronological maintenance log. | Append-only. |
| `knowledge/raw/` | Source snapshots and redacted evidence. | Append-only. |
| `knowledge/raw/assets/` | Images and attachments for raw notes. | Append-only. |
| `templates/` | Decision / incident / runbook / source-ingest skeletons. | Read-only reference. |

## Quick decisions

These are the questions I keep re-asking; the answers belong in one place.

### Should this knowledge live in the wiki?

Yes when **all** of:
- Future agents (or me, on a cold session) would need to know it.
- It is not trivially recoverable from the code (`git log`, grep, codegraph).
- It is durable — a fact, a contract, a business rule, a learned gotcha.

No when it is conversation state, a one-off troubleshooting step that left a
test behind, or a transient PR detail. Those go in commit messages and stay
out of the wiki.

### New page or append to an existing one?

- **Append** if the topic is already covered. Editing the canonical page beats
  fragmenting knowledge across multiple notes.
- **New page** only when the topic does not fit any existing page and is large
  enough to merit its own URL — usually a new subsystem, a new business flow,
  or a new external integration.
- Adding a paragraph to an existing page does **not** require a new page in
  `index.md`; only new pages do.

### When do I update `index.md`?

Only when creating a new wiki page, deleting one, or renaming one. Routine
edits to existing pages never touch `index.md`.

### When do I append to `log.md`?

For any durable change that an outsider reading the wiki later should be able
to date. Use one entry per logical change, not per file edit.

Skip the log for typo fixes, link repairs, or formatting passes — those are
invisible in real history. The git commit is enough.

### Page vs `documentation-drift.md` vs fix the code?

- If the **code is wrong** and you have time → fix the code, then update the
  wiki to match. No drift entry needed.
- If the **doc is wrong** and you can fix it now → fix the wiki page.
- If you **cannot** fix either right now → add a precise drift note to
  [[documentation-drift]] so the gap is explicit instead of hidden in prose.

## Log entry format

Every entry in `log.md` uses one stable heading shape so agents can scan:

```
## [YYYY-MM-DD] <type> | <short title>
```

`<type>` is one of:

| Type | Use for |
|---|---|
| `ingest` | Importing source material into `raw/`. |
| `maintenance` | Wiki edits, renames, structural reshuffles. |
| `cleanup` | Deleting or merging stale notes. |
| `decision` | A durable choice that future agents must respect. |
| `policy` | A business rule (e.g. unknown-stock policy). |
| `analysis` | Investigation findings without a code change. |
| `feature` | A landed feature worth recording in wiki. |
| `fix` / `reliability` | Bug fix or hardening with durable impact. |
| `ux` | Operator-visible UX change. |
| `parser` / `identity` / etc. | Domain-specific changes when a tighter label helps grep. |

Body: 1–3 short paragraphs. Link to the affected pages with `[[wikilinks]]`
and to source snapshots in `raw/` with `[[../raw/<slug>|<slug>]]`. Do not
copy diffs into the log — link to the commit if needed.

Always convert relative dates to absolute when writing entries
(e.g. "yesterday" → `2026-05-30`).

## Filename conventions

- Lowercase, kebab-cased: `reservation-flow.md`, not `ReservationFlow.md`.
- Stable. Renames break Obsidian wikilinks across the graph — only rename
  when the topic genuinely changed, and `grep -r '\[\[old-name' knowledge/`
  to fix references in the same commit.
- Raw notes: timestamped where useful — `log-review-YYYY-MM-DD-HH-MM.md`,
  `project-wiki-ingest-YYYY-MM-DD.md`.

## Wikilinks

- Prefer `[[page-name]]` over relative paths inside `wiki/`.
- For raw evidence use `[[../raw/<slug>|<slug>]]` so the link reads as the
  slug, not the path.
- Don't proactively backlink. Obsidian builds the backlinks graph from
  outgoing links — there's no need to add a "Mentioned by" section.
- A `[[name]]` that doesn't resolve yet is fine; it marks intent to write
  that page. Don't break the link just because the target is missing.

## Stale and deleted pages

- When a page's subject is done (e.g. all listed items have landed), do not
  delete it immediately. Add a short "Status: resolved (YYYY-MM-DD)" note at
  the top, leave the body, and let the next maintenance pass decide.
- Only delete a page when its content has been migrated elsewhere and the
  delete is recorded in `log.md` as a `cleanup` entry. Update `index.md` in
  the same commit.

## Raw-note contract

A note in `knowledge/raw/` should:

- Stand on its own — readable without the surrounding session context.
- Quote source material literally (transcripts, log lines, operator messages).
- Redact secrets and customer-identifying data before saving.
- Carry a `# Title` and a one-line context lead (date, source, why captured).

The synthesised, opinionated version of what the raw note implies belongs in
`wiki/`, not in `raw/`.

## Safety

- Never store secrets, tokens, credentials, or private customer data in the
  wiki or in `raw/`. Redact and reference secure local files instead.
- Treat `.env`, `logs/`, and `node_modules/` as opaque — do not import them
  into the wiki.
