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

// Helper: build a tagPositions entry the way findTargets/metadataCache do.
function pos(text, tagText, from = 0) {
    const start = text.indexOf(tagText, from);
    return { position: { start: { offset: start }, end: { offset: start + tagText.length } }, tag: tagText };
}

// Helper: parse the `tags` field back out of a file's frontmatter for semantic assertions.
function fmTags(text) {
    const fm = text.split(/^---\r?$\n?/m, 2)[1];
    const json = parseDocument(fm).toJSON() || {};
    return json.tags ?? json.tag;
}

describe("removeInlineTag (single occurrence)", () => {
    test("removes a tag mid-line and collapses the doubled space", () => {
        const text = "foo #project bar";
        const start = text.indexOf("#project");
        expect(removeInlineTag(text, start, start + "#project".length)).toBe("foo bar");
    });

    test("removes a tag at end of a content line without leaving a trailing space", () => {
        const text = "foo #project";
        const start = text.indexOf("#project");
        expect(removeInlineTag(text, start, start + "#project".length)).toBe("foo");
    });

    test("removes the whole line when the tag is alone on its own line", () => {
        const text = "line1\n#project\nline3";
        const start = text.indexOf("#project");
        expect(removeInlineTag(text, start, start + "#project".length)).toBe("line1\nline3");
    });

    test("removes the last line (and its preceding newline) when the tag is alone at EOF", () => {
        const text = "line1\n#project";
        const start = text.indexOf("#project");
        expect(removeInlineTag(text, start, start + "#project".length)).toBe("line1");
    });
});

describe("removeInlineTags (loop + guard)", () => {
    test("removes multiple occurrences when positions are supplied last-first", () => {
        const text = "a #foo b #foo c";
        const positions = [pos(text, "#foo", 9), pos(text, "#foo", 0)]; // reversed: high offset first
        expect(removeInlineTags(text, positions)).toBe("a b c");
    });

    test("throws TagMismatchError when the text no longer matches the recorded position", () => {
        const text = "foo bar baz";
        const positions = [{ position: { start: { offset: 4 }, end: { offset: 12 } }, tag: "#project" }];
        expect(() => removeInlineTags(text, positions)).toThrow(TagMismatchError);
    });
});

describe("removeFromFrontMatter", () => {
    test("removes an entry from a flow array", () => {
        const text = "---\ntags: [a, project, b]\n---\nbody\n";
        expect(fmTags(removeFromFrontMatter(text, new Tag("project")))).toEqual(["a", "b"]);
    });

    test("removes an item from a block list", () => {
        const text = "---\ntags:\n  - a\n  - project\n  - b\n---\nbody\n";
        expect(fmTags(removeFromFrontMatter(text, new Tag("project")))).toEqual(["a", "b"]);
    });

    test("removes a token from a space-separated string", () => {
        const text = "---\ntags: a project b\n---\nbody\n";
        expect(fmTags(removeFromFrontMatter(text, new Tag("project")))).toBe("a b");
    });

    test("removes sub-tags of the given tag (subtree scope)", () => {
        const text = "---\ntags: [project/work, other]\n---\nbody\n";
        expect(fmTags(removeFromFrontMatter(text, new Tag("project")))).toEqual(["other"]);
    });

    test("leaves an empty tags field (does not delete the key) when the last tag is removed", () => {
        const text = "---\ntags: [project]\n---\nbody\n";
        const out = removeFromFrontMatter(text, new Tag("project"));
        expect(out).toMatch(/^tags:/m); // key still present
        const tags = fmTags(out);
        expect(tags == null || tags.length === 0).toBe(true);
    });

    test("leaves aliases untouched even when they are tag-aliases", () => {
        const text = '---\naliases:\n  - "#project"\ntags: [project]\n---\nbody\n';
        const out = removeFromFrontMatter(text, new Tag("project"));
        expect(out).toContain("#project"); // alias survives
        expect(fmTags(out)).not.toContain("project"); // but the tag is gone
    });

    test("returns the text unchanged when there is no frontmatter", () => {
        const text = "just a body with #project inline\n";
        expect(removeFromFrontMatter(text, new Tag("project"))).toBe(text);
    });
});

describe("removeFromFrontMatter — formatting preservation (review regressions)", () => {
    test("preserves unrelated fields with leading zeros (no YAML re-normalization)", () => {
        const text = "---\nnumber: 007\ntags: [a, project, b]\n---\nbody\n";
        expect(removeFromFrontMatter(text, new Tag("project"))).toContain("number: 007");
    });

    test("preserves an unrelated YAML comment", () => {
        const text = "---\ntags: [a, project]\nnote: keep  # important\n---\nbody\n";
        expect(removeFromFrontMatter(text, new Tag("project"))).toContain("# important");
    });

    test("does not misinterpret $-patterns in unrelated values", () => {
        const text = "---\nnote: a $& b\ntags: [project]\n---\nbody\n";
        const out = removeFromFrontMatter(text, new Tag("project"));
        expect(out).toBe("---\nnote: a $& b\ntags: []\n---\nbody\n");
    });

    test("preserves comma separators in a scalar tags field", () => {
        const text = "---\ntags: a, project, b\n---\nbody\n";
        expect(removeFromFrontMatter(text, new Tag("project"))).toContain("tags: a, b");
    });

    test("emptying a scalar field leaves no quoted-empty-string artifact", () => {
        const text = "---\ntags: project\n---\nbody\n";
        const out = removeFromFrontMatter(text, new Tag("project"));
        expect(out).not.toContain('tags: ""');
        expect(fmTags(out) || []).toHaveLength(0);
    });

    test("emptying a flow array leaves an empty array", () => {
        const text = "---\ntags: [project]\n---\nbody\n";
        expect(fmTags(removeFromFrontMatter(text, new Tag("project")))).toEqual([]);
    });

    test("preserves the exact source of surviving block-list items", () => {
        const text = "---\ntags:\n  - a\n  - project\n  - b\n---\nbody\n";
        const out = removeFromFrontMatter(text, new Tag("project"));
        expect(out).toContain("  - a\n");
        expect(out).toContain("  - b\n");
        expect(out).not.toContain("project");
    });

    test("throws FrontMatterParseError on malformed frontmatter", () => {
        const text = "---\ntags: [a, project\nbad: : :\n---\nbody\n";
        expect(() => removeFromFrontMatter(text, new Tag("project"))).toThrow(FrontMatterParseError);
    });
});

describe("removeInlineTag / removeInlineTags — review regressions", () => {
    test("removes a list-item line that is only a bullet and the tag", () => {
        const text = "intro\n- #project\noutro";
        const start = text.indexOf("#project");
        expect(removeInlineTag(text, start, start + "#project".length)).toBe("intro\noutro");
    });

    test("is order-independent: correct even when positions are supplied document-order", () => {
        const text = "a #foo b #foo c";
        const positions = [pos(text, "#foo", 0), pos(text, "#foo", 9)]; // ascending, the risky order
        expect(removeInlineTags(text, positions)).toBe("a b c");
    });
});
