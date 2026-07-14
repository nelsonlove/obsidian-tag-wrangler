import { parseDocument, isSeq, isScalar, Document } from "yaml";
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
const CLOSERS = { "(": ")", "[": "]", "{": "}" };

// Remove a single inline tag occupying [start, end).
//   - Tag alone on its line (or only a bullet + the tag) -> remove the line.
//   - Tag wrapped in a bracket pair -> remove the brackets too.
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
        // Last line with no trailing newline: drop the preceding line break (\n or \r\n).
        let dropFrom = lineStart;
        if (lineStart > 0) {
            dropFrom = lineStart - 1;
            if (dropFrom > 0 && text[dropFrom - 1] === "\r") dropFrom -= 1;
        }
        return text.slice(0, dropFrom) + text.slice(lineEnd);
    }

    let s = start, e = end;
    if (CLOSERS[text[s - 1]] && text[e] === CLOSERS[text[s - 1]]) { s -= 1; e += 1; }
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
// YAML frontmatter. Matching is done on parsed AST values (never raw source, so
// quoted tags still match). Edits are source-range splices, so unrelated fields,
// comments, and quoting are preserved byte-for-byte; only the edited field can
// change shape. A field emptied of tags is removed entirely. `aliases:` is left
// untouched. Throws FrontMatterParseError on malformed frontmatter; returns the
// text unchanged if nothing matched.
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
    const edits = [];

    for (const pair of items) {
        const prop = pair.key && pair.key.value;
        if (typeof prop !== "string" || !/^tags?$/i.test(prop)) continue;
        const node = pair.value;

        if (isSeq(node)) {
            const kept = node.items.filter(it => !matches(isScalar(it) ? it.value : it));
            if (kept.length === node.items.length) continue;             // nothing matched
            if (kept.length === 0) { edits.push(fieldRemoval(frontMatter, pair)); continue; }
            if (node.flow) {
                const inner = kept.map(it => frontMatter.slice(it.range[0], it.range[1])).join(", ");
                edits.push({ start: node.range[0], end: node.range[1], replacement: "[" + inner + "]" });
            } else {
                for (const it of node.items) {
                    if (matches(isScalar(it) ? it.value : it)) edits.push(lineRemoval(frontMatter, it.range[0]));
                }
            }
        } else if (isScalar(node) && typeof node.value === "string") {
            const value = String(node.value);
            const parsedToks = value.split(/[\s,]+/).filter(Boolean);
            const keptToks = parsedToks.filter(t => !matches(t));
            if (keptToks.length === parsedToks.length) continue;         // nothing matched
            if (keptToks.length === 0) { edits.push(fieldRemoval(frontMatter, pair)); continue; }

            const quoted = frontMatter.slice(node.range[0], node.range[1]) !== value;
            if (quoted) {
                // Re-render only the VALUE (correct quoting) and splice over the value's
                // span, so the key, any trailing comment, and the line's EOL are preserved.
                edits.push({ start: node.range[0], end: node.range[1], replacement: renderScalarValue(keptToks.join(" ")) });
            } else {
                editPlainScalar(frontMatter, node, matches, edits);      // preserves original separators
            }
        }
    }

    if (!edits.length) return text;

    edits.sort((a, b) => b.start - a.start);
    let fm = frontMatter;
    for (const e of edits) fm = fm.slice(0, e.start) + e.replacement + fm.slice(e.end);

    // Slice-based splice (no regex) so nothing in `fm` is interpreted.
    const at = text.indexOf(frontMatter);
    return text.slice(0, at) + fm + text.slice(at + frontMatter.length);
}

// Full source span of a field: from the start of its key line to the end of its
// value's last line (trailing newline included).
function fieldSpan(fm, pair) {
    const keyStart = pair.key.range[0];
    const start = fm.lastIndexOf("\n", keyStart - 1) + 1;
    const valueEnd = pair.value.range[1];
    const nl = fm.indexOf("\n", Math.max(valueEnd - 1, keyStart));
    const end = nl === -1 ? fm.length : nl + 1;
    return [start, end];
}

function fieldRemoval(fm, pair) {
    const [start, end] = fieldSpan(fm, pair);
    return { start, end, replacement: "" };
}

// Drop the whole source line containing `offset`.
function lineRemoval(fm, offset) {
    const start = fm.lastIndexOf("\n", offset - 1) + 1;
    let end = fm.indexOf("\n", offset);
    end = end === -1 ? fm.length : end + 1;
    return { start, end, replacement: "" };
}

// Plain (unquoted) scalar: drop matching tokens plus one adjacent separator,
// preserving the original separator style (commas vs spaces).
function editPlainScalar(fm, node, matches, edits) {
    const [start, end] = node.range;
    const parts = fm.slice(start, end).split(/([\s,]+)/); // even = token, odd = separator
    for (let i = parts.length - 1; i >= 0; i -= 2) {      // length is always odd
        if (!matches(parts[i])) continue;
        if (i + 1 < parts.length) parts.splice(i, 2);
        else if (i - 1 >= 0) parts.splice(i - 1, 2);
        else parts.splice(i, 1);
    }
    const out = parts.join("").replace(/^[\s,]+|[\s,]+$/g, "");
    edits.push({ start, end, replacement: out });
}

// Render a scalar value via the YAML library so quoting/escaping stays correct.
function renderScalarValue(value) {
    const tmp = new Document();
    tmp.contents = tmp.createNode(value);
    // lineWidth:0 disables folding — a bare value has no key indentation, so a
    // folded continuation line would splice in at column 0 and corrupt the YAML.
    return tmp.toString({ lineWidth: 0 }).replace(/\n$/, "");
}
