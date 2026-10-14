import { describe, expect, it } from "vitest";
import {
  filePreviewRenderKind,
  isRenderedMarkdownFile,
  plantUmlFileAsMarkdown,
} from "@/components/file-pane-render-mode";

describe("isRenderedMarkdownFile", () => {
  it("detects .md files", () => {
    expect(isRenderedMarkdownFile("README.md")).toBe(true);
    expect(isRenderedMarkdownFile("docs/guide.MD")).toBe(true);
  });

  it("detects .markdown files", () => {
    expect(isRenderedMarkdownFile("notes.markdown")).toBe(true);
    expect(isRenderedMarkdownFile("docs/CHANGELOG.MARKDOWN")).toBe(true);
  });

  it("does not treat .mdx files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("page.mdx")).toBe(false);
  });

  it("does not treat other text files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("src/index.ts")).toBe(false);
    expect(isRenderedMarkdownFile("README.md.txt")).toBe(false);
    expect(isRenderedMarkdownFile("plan.html")).toBe(false);
  });
});

describe("filePreviewRenderKind", () => {
  it("maps each renderable extension to its kind", () => {
    expect(filePreviewRenderKind("README.md")).toBe("markdown");
    expect(filePreviewRenderKind("notes.markdown")).toBe("markdown");
    expect(filePreviewRenderKind("plan.html")).toBe("html");
    expect(filePreviewRenderKind("docs/PLAN.HTML")).toBe("html");
    expect(filePreviewRenderKind("plan.htm")).toBe("html");
    expect(filePreviewRenderKind("diagrams/01-c4-l1.puml")).toBe("plantuml");
    expect(filePreviewRenderKind("flow.PLANTUML")).toBe("plantuml");
    expect(filePreviewRenderKind("seq.pu")).toBe("plantuml");
  });

  it("returns null for files without a rendered preview", () => {
    expect(filePreviewRenderKind("src/index.ts")).toBe(null);
    expect(filePreviewRenderKind("page.mdx")).toBe(null);
    expect(filePreviewRenderKind("index.html.erb")).toBe(null);
  });
});

describe("plantUmlFileAsMarkdown", () => {
  it("wraps the file in a plantuml fence", () => {
    expect(plantUmlFileAsMarkdown("@startuml\nA -> B\n@enduml")).toBe(
      "```plantuml\n@startuml\nA -> B\n@enduml\n```\n",
    );
  });

  it("uses a fence longer than any backtick run in the file", () => {
    expect(plantUmlFileAsMarkdown("note: ```code```")).toBe(
      "````plantuml\nnote: ```code```\n````\n",
    );
  });
});
