import { describe, expect, it } from "vitest";
import { extractMentionedDirectories } from "./mentioned-directories";

describe("extractMentionedDirectories", () => {
  it("finds tilde and absolute directories in inline code and prose", () => {
    const text =
      "Mình đã cập nhật `~/Documents/mobio/momir-docs` và /opt/data/notes, xem `architecture/prior-art.md`.";
    expect(extractMentionedDirectories(text)).toEqual([
      "~/Documents/mobio/momir-docs",
      "/opt/data/notes",
    ]);
  });

  it("uses the parent directory of a mentioned file and drops line suffixes", () => {
    expect(extractMentionedDirectories("see `/a/b/c.md:12` and /a/b/d.md")).toEqual(["/a/b"]);
  });

  it("ignores the workspace root, slash commands, urls and and/or", () => {
    expect(
      extractMentionedDirectories(
        "run /clear, read https://example.com/a/b, use and/or, in /ws/root",
        "/ws/root",
      ),
    ).toEqual([]);
  });

  it("strips trailing punctuation and trailing slashes", () => {
    expect(extractMentionedDirectories("Edited ~/proj/docs/.")).toEqual(["~/proj/docs"]);
    expect(extractMentionedDirectories("Edited `/x/y/`")).toEqual(["/x/y"]);
  });

  it("returns nothing for empty text", () => {
    expect(extractMentionedDirectories(undefined)).toEqual([]);
  });
});
