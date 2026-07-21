import { describe, test, expect, vi } from "vitest";

// obsidian ships only type declarations, so stub the tiny runtime surface File.js uses.
vi.mock("obsidian", () => ({ Notice: class { constructor(message) { this.message = message; } } }));

import { File } from "../src/File.js";
import { Tag } from "../src/Tag.js";

function fakeApp(content) {
    const store = { content };
    return {
        store,
        vault: {
            getAbstractFileByPath: (path) => ({ path }),
            read: async () => store.content,
            modify: async (_file, text) => { store.content = text; },
        },
    };
}

function inlinePos(text, needle, tag) {
    const start = text.indexOf(needle);
    return { position: { start: { offset: start }, end: { offset: start + needle.length } }, tag };
}

describe("File.removed — bulk-run safety", () => {
    test("removes the tag and reports success", async () => {
        const app = fakeApp("---\ntags: [project, keep]\n---\nbody\n");
        const result = await new File(app, "note.md", [], true).removed(new Tag("project"));
        expect(result).toBe(true);
        expect(app.store.content).toContain("keep");
        expect(app.store.content).not.toContain("project");
    });

    test("a matched note left unchanged is surfaced as skipped, never silently dropped", async () => {
        // hasFrontMatter, but the tag isn't present in a form the transforms rewrite:
        // removed() must not return undefined (which vanishes from every tally).
        const original = "---\nfoo: bar\n---\nbody\n";
        const app = fakeApp(original);
        const result = await new File(app, "note.md", [], true).removed(new Tag("project"));
        expect(result).toBe("skipped");
        expect(app.store.content).toBe(original); // untouched
    });

    test("a body changed since the scan still gets its frontmatter cleaned (partial)", async () => {
        const original = "---\ntags: [project, keep]\n---\nthe body no longer has the tag\n";
        const app = fakeApp(original);
        // recorded inline position now points at text that no longer matches the tag
        const stale = [inlinePos(original, "the body", "#project")];
        const result = await new File(app, "note.md", stale, true).removed(new Tag("project"));
        expect(result).toBe("partial");                 // inline stale, but frontmatter still cleaned
        expect(app.store.content).toContain("keep");
        expect(app.store.content).not.toContain("project");
    });
});
