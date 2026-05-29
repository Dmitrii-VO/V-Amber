# Obsidian plugins guide

This vault mirrors the plugin workflow used in
`D:\myprojects\AuctionBot Amberry\Amberry39`. Plugin binaries are not copied
into this repository by this wiki pass; this page records the intended workflow
and plugin roles.

## Reference plugin set

The Amberry39 vault enables:

- Omnisearch for fast vault-wide search.
- Templater for `templates/` note creation.
- Obsidian Git for vault synchronization.
- Linter for Markdown cleanup.
- Excalidraw for diagrams when visual architecture helps.
- Real Claudian for Claude-connected workflows.
- Dataview for metadata queries.
- Table Editor for editing Markdown tables.

## V-Amber usage

Use plugins only when they add clear value:

- Use Templater with `templates/source-ingest.md` when capturing new source
  snapshots into `knowledge/raw/`.
- Use `templates/runbook.md` for repeatable diagnostics.
- Use `templates/incident.md` for runtime failures or data-loss events.
- Use `templates/decision.md` for durable architecture or product decisions.
- Use Dataview only for simple frontmatter-driven lists; do not add heavy
  schemas unless the user asks for Obsidian Bases or a richer metadata model.

## Safety

Do not paste secrets, tokens, customer private data, or raw credentials into
plugin-generated notes. Use redacted examples and references to secure local
files instead.
