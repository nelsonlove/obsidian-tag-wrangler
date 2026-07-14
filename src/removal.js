import { parseDocument, isSeq, isScalar } from "yaml";
import { Tag } from "./Tag";

// Raised when a recorded tag position no longer matches the file's current
// text (the file changed between the scan and the removal pass).
export class TagMismatchError extends Error {
    constructor(start, end) {
        super(`Tag position ${start}..${end} no longer matches file text`);
        this.name = "TagMismatchError";
        this.start = start;
        this.end = end;
    }
}

// Remove a single inline tag occupying [start, end).
//   - Tag alone on its own line -> remove the whole line.
//   - Otherwise -> remove the tag plus one adjacent space (prefer trailing).
export function removeInlineTag(text, start, end) {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = text.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = text.length;

    const before = text.slice(lineStart, start);
    const after = text.slice(end, lineEnd);

    if (before.trim() === "" && after.trim() === "") {
        // Tag is alone on its line: drop the entire line.
        if (lineEnd < text.length) {
            return text.slice(0, lineStart) + text.slice(lineEnd + 1);
        }
        // Last line with no trailing newline: also drop the preceding newline.
        const dropFrom = lineStart > 0 ? lineStart - 1 : lineStart;
        return text.slice(0, dropFrom) + text.slice(lineEnd);
    }

    let s = start, e = end;
    if (text[e] === " " || text[e] === "\t") e += 1;
    else if (s > 0 && (text[s - 1] === " " || text[s - 1] === "\t")) s -= 1;
    return text.slice(0, s) + text.slice(e);
}

// Remove every inline tag in `tagPositions` from `text`. Positions must be
// supplied last-first (highest offset first) so earlier offsets stay valid as
// text is cut. Throws TagMismatchError if a position no longer matches.
export function removeInlineTags(text, tagPositions) {
    for (const { position: { start, end }, tag } of tagPositions) {
        if (text.slice(start.offset, end.offset) !== tag) {
            throw new TagMismatchError(start.offset, end.offset);
        }
        text = removeInlineTag(text, start.offset, end.offset);
    }
    return text;
}

// Remove `tag` (and its sub-tags) from the `tags:`/`tag:` fields of a file's
// YAML frontmatter. `aliases:` is deliberately left untouched. Returns the text
// unchanged when there is no valid frontmatter or nothing matched.
export function removeFromFrontMatter(text, tag) {
    const parts = text.split(/^---\r?$\n?/m, 2);
    const [empty, frontMatter] = parts;

    if (parts.length < 2 || empty.trim() !== "" || !frontMatter || !frontMatter.trim() || !frontMatter.endsWith("\n"))
        return text;

    const doc = parseDocument(frontMatter);
    if (doc.errors.length) return text;

    const items = doc.contents && doc.contents.items;
    if (!items) return text;

    const matches = (val) => typeof val === "string" && tag.matches(Tag.toTag(val));

    let changed = false;
    for (const item of items) {
        const prop = item.key && item.key.value;
        if (typeof prop !== "string" || !/^tags?$/i.test(prop)) continue;

        const node = item.value;
        if (isSeq(node)) {
            const before = node.items.length;
            node.items = node.items.filter(it => !matches(isScalar(it) ? it.value : it));
            if (node.items.length !== before) changed = true;
        } else if (isScalar(node) && typeof node.value === "string") {
            const tokens = node.value.split(/([\s,]+)/);
            let removed = false;
            const kept = [];
            for (let i = 0; i < tokens.length; i += 2) {
                if (matches(tokens[i])) { removed = true; continue; }
                if (tokens[i]) kept.push(tokens[i]);
            }
            if (removed) {
                node.value = kept.join(" ");
                changed = true;
            }
        }
    }

    if (!changed) return text;
    return text.replace(frontMatter, doc.toString());
}
