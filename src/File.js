import { Notice } from "obsidian";
import { CST, parseDocument } from "yaml";
import { Replacement } from "./Tag";
import { removeInlineTags, removeFromFrontMatter } from "./removal";

export class File {

    constructor(app, filename, tagPositions, hasFrontMatter) {
        this.app = app;
        this.filename = filename;
        this.basename = filename.split("/").pop();
        this.tagPositions = tagPositions;
        this.hasFrontMatter = !!hasFrontMatter;
    }

    /** @param {Replacement} replace */
    async renamed(replace) {
        const file = this.app.vault.getAbstractFileByPath(this.filename);
        const original = await this.app.vault.read(file);
        let text = original;

        for (const { position: { start, end }, tag } of this.tagPositions) {
            if (text.slice(start.offset, end.offset) !== tag) {
                const msg = `File ${this.filename} has changed; skipping`;
                new Notice(msg);
                console.error(msg);
                console.debug(text.slice(start.offset, end.offset), tag);
                return;
            }
            text = replace.inString(text, start.offset);
        }

        if (this.hasFrontMatter)
            text = this.replaceInFrontMatter(text, replace);

        if (text !== original) {
            await this.app.vault.modify(file, text);
            return true;
        }
    }

    /** @param {import("./Tag").Tag} tag */
    async removed(tag) {
        // Never let one note abort the whole bulk run, and never let a note the
        // scan matched drop out of the tally silently: any hard failure warns and
        // skips; a note left unchanged is surfaced too, so the tag can't quietly
        // survive a run the user is told "completed".
        try {
            const file = this.app.vault.getAbstractFileByPath(this.filename);
            const original = await this.app.vault.read(file);
            let text = original;

            // The inline pass is guarded against a body that changed since the scan.
            // If it no longer matches we skip the inline edits but still attempt the
            // frontmatter, which is removed against the current on-disk text — so a
            // stale body no longer aborts an otherwise-safe frontmatter removal.
            let inlineStale = false;
            try {
                text = removeInlineTags(text, this.tagPositions);
            } catch (e) {
                inlineStale = true;
                console.error(`Inline tags in ${this.filename} changed since scan; leaving them`, e);
                if (e && e.found !== undefined)
                    console.debug("expected", JSON.stringify(e.expected), "but found", JSON.stringify(e.found));
            }

            if (this.hasFrontMatter) {
                try {
                    text = removeFromFrontMatter(text, tag);
                } catch (e) {
                    return this.skip(e, `Could not process frontmatter of ${this.filename}`);
                }
            }

            if (text !== original) {
                await this.app.vault.modify(file, text);
                return inlineStale ? "partial" : true;
            }
            // Matched by the scan but nothing was removed: the file changed since
            // the scan, or the tag sits in a shape the transforms don't rewrite.
            // Report it instead of dropping it from both tallies.
            return this.skip(
                new Error(`#${tag.name} not removed from ${this.filename}`),
                inlineStale
                    ? `${this.filename} changed since scan; #${tag.name} not removed`
                    : `${this.filename} still contains #${tag.name} in an unsupported form`
            );
        } catch (e) {
            return this.skip(e, `Could not update ${this.filename}`);
        }
    }

    /** Warn about a skipped note and signal it to the caller. */
    skip(e, message) {
        new Notice(message + "; skipping");
        console.error(message, e);
        return "skipped";
    }
    /** @param {Replacement} replace */
    replaceInFrontMatter(text, replace) {
        const [empty, frontMatter] = text.split(/^---\r?$\n?/m, 2);

        // Check for valid, non-empty, properly terminated front matter
        if (empty.trim() !== "" || !frontMatter.trim() || !frontMatter.endsWith("\n"))
            return text;

        const parsed = parseDocument(frontMatter, {keepSourceTokens: true});
        if (parsed.errors.length) {
            const error = `YAML issue with ${this.filename}: ${parsed.errors[0]}`;
            console.error(error); new Notice(error + "; skipping frontmatter");
            return;
        }

        let changed = false, json = parsed.toJSON();

        function setInNode(node, value, afterKey=false) {
            CST.setScalarValue(node.srcToken, value, {afterKey});
            changed = true;
            node.value = value;
        }

        function processField(prop, isAlias) {
            const node = parsed.get(prop, true);
            if (!node) return;
            const field = json[prop];
            if (!field || !field.length) return;
            if (typeof field === "string") {
                const parts = field.split(isAlias ? /(^\s+|\s*,\s*|\s+$)/ : /([\s,]+)/);
                const after = replace.inArray(parts, true, isAlias).join("");
                if (field != after) setInNode(node, after, true);
            } else if (Array.isArray(field)) {
                replace.inArray(field, false, isAlias).forEach((v, i) => {
                    if (field[i] !== v) setInNode(node.get(i, true), v)
                });
            }
        }

        for (const {key: {value:prop}} of parsed.contents.items) {
            if (/^tags?$/i.test(prop)) {
                processField(prop, false);
            } else if (/^alias(es)?$/i.test(prop)) {
                processField(prop, true);
            }
        }
        return changed ? text.replace(frontMatter, CST.stringify(parsed.contents.srcToken)) : text;
    }
}
