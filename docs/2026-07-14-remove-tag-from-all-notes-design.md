# Design: "Remove from all notes" tag action

**Date:** 2026-07-14
**Fork:** `nelsonlove/obsidian-tag-wrangler` (of `pjeby/tag-wrangler` v0.6.4)
**Status:** Approved design — pending implementation plan

## Goal

Add a context-menu action to Tag Wrangler that removes a tag (and its entire
sub-tag subtree) from every note in the vault. Tag Wrangler already renames a
tag across all notes; the missing capability is deleting one outright.

## Scope decisions (settled during brainstorming)

- **Subtree scope:** Removing `#project` also removes `#project/work`,
  `#project/home`, etc. — matches how the existing Rename treats a tag as
  covering its whole subtree (`Tag.matches`).
- **Confirmation:** A count-and-confirm dialog before running (not
  type-to-confirm, not silent).
- **Distribution:** GitHub fork + BRAT.

## Naming

- **Repo:** `obsidian-tag-wrangler` (Nelson's convention).
- **Plugin `id`:** stays `tag-wrangler` in `manifest.json`. BRAT installs into
  `.obsidian/plugins/<id>/`, so keeping the id makes this fork **replace** the
  community Tag Wrangler in-place rather than co-installing a second copy.

## Architecture

The rename engine is built entirely around *substituting* a fixed-length
`#old` -> `#new` at known character offsets (`Replacement.inString`,
`File.renamed`). Removal is fundamentally different — it *deletes* text (shifting
offsets) and must drop frontmatter array **elements**, not rewrite their values.
So removal gets its own small path alongside rename, reusing everything that is
scope-agnostic.

### Reused unchanged
- **`findTargets(app, tag)`** — already returns every file containing the tag or
  a sub-tag, with inline tag positions and a frontmatter flag. Positions come
  back reversed (last-first), which is exactly what deletion needs so earlier
  offsets stay valid as we cut.
- **`Progress`** — the existing progress/cancel UI.
- **`Confirm`** (ophidian) — the same modal component rename uses.

### New

**`removeTag(app, tagName)` in `src/renaming.js`** (parallel to `renameTag`):
1. `const tag = new Tag(tagName)`
2. `const targets = await findTargets(app, tag)` — reused; abort if cancelled.
3. If `targets.length === 0`, Notice "No notes contain #tag" and stop.
4. Show the **confirm dialog** with the count (see below). Abort on cancel.
5. Iterate `targets` through `Progress.forEach`, calling `File.removed(tag)` per
   file; count successes.
6. Final Notice: `Operation complete: N file(s) updated`.

**`File.removed(tag)` in `src/File.js`** — the one genuinely new piece:
- **Inline body tags:** walk `this.tagPositions` (already reversed) and cut each
  `#tag` token from the text, applying the whitespace rules below. Keep the
  existing "file changed since scan" guard (`text.slice(start,end) !== tag` ->
  Notice + skip file).
- **Frontmatter:** parse with the same YAML CST approach as `replaceInFrontMatter`,
  but for `tags:`/`tag:` fields *remove* the matching element(s) instead of
  rewriting them (array item / `[a, b]` entry / space- or comma-separated token).

**`plugin.remove(tagName)` in `src/plugin.js`** — mirrors `plugin.rename`:
`try { await removeTag(this.app, tagName) } catch (e) { ... Notice }`.

**Menu item in `setupMenu()`** — one line in the existing `tag-rename` section,
directly under "Rename #tag":

```js
menu.addItem(item("tag-rename", "trash", "Remove #"+tagName+" from all notes",
    () => this.remove(tagName)))
```

Because it lives in the shared `setupMenu`, the action appears on every surface
Tag Wrangler already supports — tag pane, reading view, edit mode, and the
`tags` property pill — with no extra wiring.

## Whitespace & edge-case rules

- Inline mid-line `foo #project bar` -> remove the tag **and one adjacent space**
  -> `foo bar` (avoid a doubled space). Prefer trimming the trailing space; if
  none, trim one leading space.
- A tag **alone on its own line** -> remove the whole line (no blank-line litter).
- Frontmatter array `tags: [a, project, b]` -> `tags: [a, b]`; list form drops the
  `- project` item; string form `tags: a project b` -> `tags: a b`.
- Matching is on the **parsed** YAML value, never the raw source slice, so
  quoted tags (`tags: "foo"`, `tags: '#a #b'`) are removed too rather than
  silently surviving. A surviving quoted scalar is re-rendered via the YAML
  library so quoting stays correct (e.g. `#keep` stays quoted).
- If removal empties the field, **remove the whole field** (key + value lines) —
  leaving no empty-tags artifact (`tags: ""`, `tags:` null, or `tags: []`). Both
  review passes flagged empty-field remnants as noise across a bulk edit.
- Inline tags wrapped in a bracket pair (`(#tag)`, `[#tag]`) remove the brackets
  too; CRLF files do not leave an orphaned carriage return.
- **`aliases:` entries are left untouched**, even when they are tag-aliases —
  those define Tag Wrangler *tag pages*, and "remove the tag" should not silently
  dismantle a tag page. (Rename touches them; removal deliberately does not.)

## Confirmation dialog

After `findTargets` returns, an ophidian `Confirm` with a `mod-warning` OK button:

> **Remove #project and its sub-tags?**
> This will strip `#project` (and any sub-tags) from **N note(s)**.
> This **cannot** be undone.
> `[ Remove ]  [ Cancel ]`

## Testing

The repo has no test harness today. The removal transforms are the risky logic,
so extract them as pure, Obsidian-free functions and add a **minimal vitest**
setup. Cases:

- inline removal mid-line (single-space collapse)
- inline removal when the tag is alone on its line (line removed)
- multiple inline occurrences in one file (reverse-order offset safety)
- subtree match (`#project` removes `#project/work`)
- frontmatter `[array]` form
- frontmatter list form
- frontmatter space-/comma-separated string form
- field emptied -> left as `tags: []`
- `aliases:` tag-alias left untouched
- "file changed since scan" guard skips the file

UI wiring (menu item on each surface) gets **manual verification** in the live
vault: `pnpm build` -> copy `main.js` into the plugin folder -> right-click a
throwaway tag on each surface.

## Distribution

1. Feature branch -> PR into the fork's `master`.
2. Bump `manifest.json` version (e.g. `0.6.4-nelson.1`); keep `id: tag-wrangler`.
3. `pnpm build` to produce `main.js`.
4. Publish a **GitHub Release** with `main.js` + `manifest.json` attached — the
   upstream repo does not commit built output, and a release is BRAT's most
   reliable install source.
5. Add `nelsonlove/obsidian-tag-wrangler` in BRAT.
6. Future upstream updates via `git merge upstream/master`.

## Accepted trade-offs (surfaced in review, deliberately not fixed)

- A YAML comment on a tag *line that is removed* is removed with it: an inline
  comment on a block-list item being deleted, or a trailing comment on a `tags:`
  line that empties out entirely. A comment on a *surviving* tag line is
  preserved. Rationale: a comment on a line that no longer exists is orphaned;
  preserving it would reintroduce empty-field cruft the earlier reviews flagged.
- A rare multi-line *plain/folded* scalar tags value is re-rendered onto one
  line (same as the multi-line flow-array case). The tag is still removed and the
  YAML stays valid; only that one field's layout changes.
- `findTargets` re-parses frontmatter that removal parses again (the metadata
  cache does not expose frontmatter tag offsets), and the two frontmatter editors
  (rename vs removal) are not merged — the rename path has no tests, so refactoring
  it blind is riskier than the duplication. Behaviour is consistent between them.

## Out of scope (YAGNI)

- Undo/restore of removed tags (dialog warns it is irreversible).
- Removing only the exact tag while sparing sub-tags (explicitly chosen against).
- Touching `aliases:` / tag-page definitions.
- Any change to rename behavior.
