import type { MarkdownFenceRendererProps } from "../types";
import { PlantUmlFenceHost } from "./host";

export function PlantUmlFence(props: MarkdownFenceRendererProps) {
  return <PlantUmlFenceHost {...props} />;
}
