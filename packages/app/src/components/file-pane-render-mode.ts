export type FilePreviewRenderKind = "markdown" | "html" | "plantuml";

export function isRenderedMarkdownFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

function isRenderedHtmlFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".html") || normalizedPath.endsWith(".htm");
}

const PLANTUML_EXTENSIONS = [".puml", ".plantuml", ".pu"];

function isRenderedPlantUmlFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return PLANTUML_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension));
}

// The markdown preview already renders ```plantuml fences, so a diagram file previews as one fence.
// The fence is longer than any backtick run in the file so the content cannot close it early.
export function plantUmlFileAsMarkdown(content: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}plantuml\n${content}\n${fence}\n`;
}

export function filePreviewRenderKind(filePath: string): FilePreviewRenderKind | null {
  if (isRenderedMarkdownFile(filePath)) return "markdown";
  if (isRenderedHtmlFile(filePath)) return "html";
  if (isRenderedPlantUmlFile(filePath)) return "plantuml";
  return null;
}
