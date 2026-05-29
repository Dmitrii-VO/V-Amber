# Obsidian knowledge base

`V-Amber` is the Obsidian vault and project knowledge store for the voice
commerce MVP. Open `D:\myprojects\V-Amber` in Obsidian to browse project
knowledge, follow wikilinks, and inspect the graph.

## Structure

- `knowledge/raw/` stores source material and redacted evidence. Treat it as
  append-only.
- `knowledge/wiki/` stores maintained project knowledge written by agents.
- `knowledge/wiki/index.md` is the catalog agents read first.
- `knowledge/wiki/log.md` is the chronological maintenance record.
- `knowledge/raw/assets/` stores images and attachments for knowledge-base
  notes when needed.
- `templates/` stores note templates for decisions, incidents, runbooks, and
  source ingests.

## Agent workflow

For non-trivial tasks, agents check the wiki index first, then update the wiki
when they discover durable knowledge. Evidence stays in `knowledge/raw/`;
synthesis, procedures, architecture notes, and reusable explanations go in
`knowledge/wiki/`.

Use Obsidian wikilinks for relationships between pages. Keep filenames stable,
lowercase, and kebab-cased.

## Safety

Do not store secrets, tokens, credentials, or private customer data in the wiki.
Use redacted examples and references to secure locations instead.
