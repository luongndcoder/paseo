// The markdown preview already renders ```plantuml fences, so a diagram file previews as one fence.
// The fence is longer than any backtick run in the file so the content cannot close it early.
export function plantUmlFileAsMarkdown(content: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}plantuml\n${content}\n${fence}\n`;
}
