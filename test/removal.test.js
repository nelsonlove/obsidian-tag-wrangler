import { describe, test, expect } from "vitest";
import { parseDocument } from "yaml";
import { Tag } from "../src/Tag.js";
import {
    removeInlineTag,
    removeInlineTags,
    removeFromFrontMatter,
    TagMismatchError,
    FrontMatterParseError,
} from "../src/removal.js";

function pos(text, tagText, from = 0) {
    const start = text.indexOf(tagText, from);
    return { position: { start: { offset: start }, end: { offset: start + tagText.length } }, tag: tagText };
}

// Parse the `tags`/`tag` field back out of a file's frontmatter for assertions.
// Returns undefined if the field is absent.
function fmTags(text) {
    const fm = text.split(/^---\r?$\n?/m, 2)[1];
    const json = parseDocument(fm).toJSON() || {};
    return json.tags ?? json.tag;
}
function fmValid(text) {
    const fm = text.split(/^---\r?$\n?/m, 2)[1];
    return parseDocument(fm).errors.length === 0;
}
function fmHasKey(text, key) {
    const fm = text.split(/^---\r?$\n?/m, 2)[1];
    return Object.prototype.hasOwnProperty.call(parseDocument(fm).toJSON() || {}, key);
}

describe("removeInlineTag", () => {
    const cut = (text, tag = "#project") => {
        const s = text.indexOf(tag);
        return removeInlineTag(text, s, s + tag.length);
    };
    test("mid-line: collapses the doubled space", () => expect(cut("foo #project bar")).toBe("foo bar"));
    test("end of content line: no trailing space", () => expect(cut("foo #project")).toBe("foo"));
    test("alone on its own line: line removed", () => expect(cut("line1\n#project\nline3")).toBe("line1\nline3"));
    test("alone at EOF (no trailing newline): line removed", () => expect(cut("line1\n#project")).toBe("line1"));
    test("alone at EOF on a CRLF file: no orphaned carriage return", () => expect(cut("line1\r\n#project")).toBe("line1"));
    test("only a bullet + the tag: whole list line removed", () => expect(cut("intro\n- #project\nouttro")).toBe("intro\nouttro"));
    test("wrapped in parentheses: brackets removed too, no dangling ()", () => expect(cut("text (#project) here")).toBe("text here"));
    test("wrapped in square brackets: no dangling []", () => expect(cut("see [#project] now")).toBe("see now"));
});

describe("removeInlineTags", () => {
    test("removes multiple occurrences (positions last-first)", () => {
        const text = "a #foo b #foo c";
        expect(removeInlineTags(text, [pos(text, "#foo", 9), pos(text, "#foo", 0)])).toBe("a b c");
    });
    test("order-independent: correct even when positions are document-order", () => {
        const text = "a #foo b #foo c";
        expect(removeInlineTags(text, [pos(text, "#foo", 0), pos(text, "#foo", 9)])).toBe("a b c");
    });
    test("throws TagMismatchError when the recorded position no longer matches", () => {
        const positions = [{ position: { start: { offset: 4 }, end: { offset: 12 } }, tag: "#project" }];
        expect(() => removeInlineTags("foo bar baz", positions)).toThrow(TagMismatchError);
    });
});

describe("removeFromFrontMatter — matching & removal", () => {
    test("removes an entry from a flow array", () => {
        expect(fmTags(removeFromFrontMatter("---\ntags: [a, project, b]\n---\nx\n", new Tag("project")))).toEqual(["a", "b"]);
    });
    test("removes an item from a block list", () => {
        expect(fmTags(removeFromFrontMatter("---\ntags:\n  - a\n  - project\n  - b\n---\nx\n", new Tag("project")))).toEqual(["a", "b"]);
    });
    test("removes a token from a plain space-separated scalar", () => {
        expect(fmTags(removeFromFrontMatter("---\ntags: a project b\n---\nx\n", new Tag("project")))).toBe("a b");
    });
    test("removes sub-tags of the given tag (subtree scope)", () => {
        expect(fmTags(removeFromFrontMatter("---\ntags: [project/work, other]\n---\nx\n", new Tag("project")))).toEqual(["other"]);
    });
    test("matches and removes a quoted single scalar (was silently surviving)", () => {
        const out = removeFromFrontMatter('---\ntags: "project"\nother: 1\n---\nx\n', new Tag("project"));
        expect(fmHasKey(out, "tags")).toBe(false);      // emptied field removed
        expect(fmTags(out)).toBeUndefined();
    });
    test("removes one tag from a quoted multi-tag scalar, keeping correct quoting", () => {
        const out = removeFromFrontMatter("---\ntags: '#project #keep'\n---\nx\n", new Tag("project"));
        expect(fmTags(out)).toBe("#keep");              // '#keep' must stay quoted to remain a tag
    });
    test("leaves aliases untouched even when they are tag-aliases", () => {
        const out = removeFromFrontMatter('---\naliases:\n  - "#project"\ntags: [project]\n---\nx\n', new Tag("project"));
        expect(out).toContain("#project");              // alias survives
        expect(fmHasKey(out, "tags")).toBe(false);
    });
    test("preserves a trailing comment when a quoted scalar survives removal", () => {
        const out = removeFromFrontMatter('---\ntags: "#a #b" # keep this\n---\nx\n', new Tag("a"));
        expect(out).toContain("# keep this");
        expect(fmTags(out)).toBe("#b");
    });
    test("preserves CRLF line endings when re-rendering a quoted scalar", () => {
        const out = removeFromFrontMatter('---\r\ntags: "#a #b"\r\nx: 1\r\n---\r\nbody\r\n', new Tag("a"));
        expect(out).toContain('"#b"\r\n');
    });
    test("returns the text unchanged when there is no frontmatter", () => {
        const text = "just a body with #project inline\n";
        expect(removeFromFrontMatter(text, new Tag("project"))).toBe(text);
    });
    test("throws FrontMatterParseError on malformed frontmatter", () => {
        expect(() => removeFromFrontMatter("---\ntags: [a, project\nbad: : :\n---\nx\n", new Tag("project"))).toThrow(FrontMatterParseError);
    });
});

    test("re-renders a long surviving quoted scalar as valid single-line YAML", () => {
        const survivors = Array.from({ length: 12 }, (_, i) => `alpha/topic${i}`);
        const text = `---\ntags: "${survivors.join(" ")} removeme"\n---\nbody\n`;
        const out = removeFromFrontMatter(text, new Tag("removeme"));
        expect(fmValid(out)).toBe(true);                 // no column-0 fold corruption
        expect(fmTags(out)).toBe(survivors.join(" "));   // every survivor intact
        expect(out).not.toContain("removeme");
    });

describe("removeFromFrontMatter — emptied fields are removed", () => {
    test("flow array emptied -> field removed", () => {
        const out = removeFromFrontMatter("---\ntags: [project]\nother: 1\n---\nx\n", new Tag("project"));
        expect(fmHasKey(out, "tags")).toBe(false);
        expect(fmHasKey(out, "other")).toBe(true);
    });
    test("block list emptied -> field removed", () => {
        const out = removeFromFrontMatter("---\ntags:\n  - project\nother: 2\n---\nx\n", new Tag("project"));
        expect(fmHasKey(out, "tags")).toBe(false);
        expect(fmHasKey(out, "other")).toBe(true);
    });
    test("scalar emptied -> field removed, no quoted-empty-string artifact", () => {
        const out = removeFromFrontMatter("---\ntags: project\nother: 3\n---\nx\n", new Tag("project"));
        expect(out).not.toContain('tags:');
        expect(fmHasKey(out, "other")).toBe(true);
    });
});

describe("removeFromFrontMatter — preserves unrelated content", () => {
    test("preserves unrelated fields with leading zeros", () => {
        expect(removeFromFrontMatter("---\nnumber: 007\ntags: [a, project, b]\n---\nx\n", new Tag("project"))).toContain("number: 007");
    });
    test("preserves an unrelated YAML comment", () => {
        expect(removeFromFrontMatter("---\ntags: [a, project]\nnote: keep  # important\n---\nx\n", new Tag("project"))).toContain("# important");
    });
    test("does not misinterpret $-patterns in unrelated values", () => {
        const text = "---\nnote: a $& b\ntags: [project]\n---\nbody\n";
        expect(removeFromFrontMatter(text, new Tag("project"))).toBe("---\nnote: a $& b\n---\nbody\n");
    });
    test("preserves comma separators in a plain scalar tags field", () => {
        expect(removeFromFrontMatter("---\ntags: a, project, b\n---\nx\n", new Tag("project"))).toContain("tags: a, b");
    });
    test("preserves the exact source of surviving block-list items", () => {
        const out = removeFromFrontMatter("---\ntags:\n  - a\n  - project\n  - b\n---\nx\n", new Tag("project"));
        expect(out).toContain("  - a\n");
        expect(out).toContain("  - b\n");
        expect(out).not.toContain("project");
    });
});
