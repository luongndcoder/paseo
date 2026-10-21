import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { MarkdownFenceRendererProps } from "../mermaid/types";

// Native has no CompressionStream or <img> SVG support here yet, so it keeps the source view.
export function PlantUmlFenceHost({
  code,
  inheritedStyles,
  textStyle,
}: MarkdownFenceRendererProps) {
  return (
    <HighlightedCodeBlock
      code={code}
      language="plantuml"
      inheritedStyles={inheritedStyles}
      textStyle={textStyle}
    />
  );
}
