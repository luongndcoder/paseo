import type { MarkdownFenceRendererProps } from "../mermaid/types";
import { PlantUmlFenceHost } from "./host";

export function PlantUmlFence(props: MarkdownFenceRendererProps) {
  return <PlantUmlFenceHost {...props} />;
}
