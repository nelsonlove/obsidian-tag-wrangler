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

// Raised when a file's frontmatter cannot be parsed, so the caller can warn and
// skip the file rather than write a half-processed note (mirrors the rename path).
export class FrontMatterParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "FrontMatterParseError";
    }
}

// A line whose only non-tag content is optional indentation and a single list
// marker ("-", "*", "+", "1.", "1)") — removing the tag should drop the line.
const LIST_MARKER_LINE = /^\s*([-*+]|\d+[.)])?\s*$/;

// Remove a single inline tag occupying [start, end).
//   - Tag alone on its line (or only a bullet + the tag) -> remove the line.
//   - Otherwise -> remove the tag plus one adjacent space (prefer trailing).
export function removeInlineTag(text, start, end) {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = text.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = text.length;

    const before = text.slice(lineStart, start);
    const after = text.slice(end, lineEnd);

    if (LIST_MARKER_LINE.test(before) && after.trim() === "") {
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

// Remove every inline tag in `tagPositions` from `text`. Positions are sorted
// highest-offset-first internally so earlier offsets stay valid as text is cut,
// making the result independent of the caller's ordering. Throws
// TagMismatchError if a recorded position no longer matches the file text.
export function removeInlineTags(text, tagPositions) {
    const ordered = [...tagPositions].sort(
        (a, b) => b.position.start.offset - a.position.start.offset
    );
    for (const { position: { start, end }, tag } of ordered) {
        if (text.slice(start.offset, end.offset) !== tag) {
            throw new TagMismatchError(start.offset, end.offset);
        }
        text = removeInlineTag(text, start.offset, end.offset);
    }
    return text;
}

// Remove `tag` (and its sub-tags) from the `tags:`/`tag:` fields of a file's
// YAML frontmatter. Edits are applied as source-range splices so unrelated
// fields, comments, quoting, and separators are preserved byte-for-byte.
// `aliases:` is deliberately left untouched. Throws FrontMatterParseError if the
// frontmatter is malformed; returns the text unchanged if nothing matched.
export function removeFromFrontMatter(text, tag) {
    const parts = text.split(/^---\r?$\n?/m, 2);
    const [empty, frontMatter] = parts;

    if (parts.length < 2 || empty.trim() !== "" || !frontMatter || !frontMatter.trim() || !frontMatter.endsWith("\n"))
        return text;

    const doc = parseDocument(frontMatter);
    if (doc.errors.length) throw new FrontMatterParseError(doc.errors[0].message);

    const items = doc.contents && doc.contents.items;
    if (!items) return text;

    const matches = (val) => typeof val === "string" && tag.matches(Tag.toTag(val));

    // Each edit is a {start, end, replacement} splice on `frontMatter`.
    const edits = [];
    for (const item of items) {
        const prop = item.key && item.key.value;
        if (typeof prop !== "string" || !/^tags?$/i.test(prop)) continue;

        const node = item.value;
        if (isSeq(node) && node.flow) editFlowSeq(frontMatter, node, matches, edits);
        else if (isSeq(node)) editBlockSeq(frontMatter, node, matches, edits);
        else if (isScalar(node) && typeof node.value === "string") editScalar(frontMatter, node, matches, edits);
    }

    if (!edits.length) return text;

    edits.sort((a, b) => b.start - a.start); // apply highest offset first
    let fm = frontMatter;
    for (const e of edits) fm = fm.slice(0, e.start) + e.replacement + fm.slice(e.end);

    // Function replacement so `$`-patterns in `fm` are inserted literally.
    return text.replace(frontMatter, () => fm);
}

// Block list: drop the whole line of each matching item.
function editBlockSeq(fm, node, matches, edits) {
    for (const it of node.items) {
        if (!matches(isScalar(it) ? it.value : it)) continue;
        const start = it.range[0];
        const lineStart = fm.lastIndexOf("\n", start - 1) + 1;
        let lineEnd = fm.indexOf("\n", start);
        lineEnd = lineEnd === -1 ? fm.length : lineEnd + 1;
        edits.push({ start: lineStart, end: lineEnd, replacement: "" });
    }
}

// Flow array: rebuild from the surviving items' original source text.
function editFlowSeq(fm, node, matches, edits) {
    const kept = node.items.filter(it => !matches(isScalar(it) ? it.value : it));
    if (kept.length === node.items.length) return;
    const inner = kept.map(it => fm.slice(it.range[0], it.range[1])).join(", ");
    edits.push({ start: node.range[0], end: node.range[1], replacement: "[" + inner + "]" });
}

// Scalar string: drop matching tokens plus one adjacent separator, preserving
// the original separator style (commas vs spaces).
function editScalar(fm, node, matches, edits) {
    const [start, end] = node.range;
    const value = fm.slice(start, end);
    const parts = value.split(/([\s,]+)/); // even = token, odd = separator
    let removed = false;
    for (let i = parts.length - (parts.length % 2 === 0 ? 2 : 1); i >= 0; i -= 2) {
        if (!matches(parts[i])) continue;
        removed = true;
        if (i + 1 < parts.length) parts.splice(i, 2);
        else if (i - 1 >= 0) parts.splice(i - 1, 2);
        else parts.splice(i, 1);
    }
    if (!removed) return;

    const out = parts.join("").replace(/^[\s,]+|[\s,]+$/g, "");
    // If the field is now empty, also drop the single space after the colon.
    const s = (out === "" && fm[start - 1] === " ") ? start - 1 : start;
    edits.push({ start: s, end, replacement: out });
}
