import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { Code, Workflow } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import type { MarkdownFenceRendererProps } from "../mermaid/types";
import { getDiagramBoxStyle } from "../mermaid/presentation";
import { buildPlantUmlSvgUrl } from "./encode-source";

interface ImageSize {
  width: number;
  height: number;
}

type RenderState =
  | { status: "loading"; url: string | null }
  | { status: "loaded"; url: string; size: ImageSize }
  | { status: "failed" };

// Tall sequence diagrams would otherwise push the rest of the document far down; zoom covers detail.
const MAX_DIAGRAM_BOX_HEIGHT = 640;
const MIN_DIAGRAM_BOX_HEIGHT = 56;
// White sheet around the SVG: PlantUML's default skin draws dark text on a transparent canvas.
const PAPER_PADDING = 12;
const FIT_PADDING = 8;
// Empty band above and below the sheet so the viewport toolbar (top-right) never covers the diagram.
const TOOLBAR_RESERVE = 40;

export function PlantUmlFenceHost({
  code,
  phase,
  inheritedStyles,
  textStyle,
}: MarkdownFenceRendererProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<RenderState>({ status: "loading", url: null });
  const [showSource, setShowSource] = useState(false);
  const [boxWidth, setBoxWidth] = useState(0);
  const isComplete = phase === "complete";

  useEffect(() => {
    if (!isComplete) return;
    let cancelled = false;
    setState({ status: "loading", url: null });
    void (async () => {
      try {
        const url = await buildPlantUmlSvgUrl(code);
        if (!cancelled) setState({ status: "loading", url });
      } catch {
        if (!cancelled) setState({ status: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, isComplete]);

  const handleLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const url = image.src;
    setState({
      status: "loaded",
      url,
      size: {
        width: (image.naturalWidth || 1) + PAPER_PADDING * 2,
        height: (image.naturalHeight || 1) + PAPER_PADDING * 2,
      },
    });
  }, []);
  const handleError = useCallback(() => setState({ status: "failed" }), []);
  const handleBoxLayout = useCallback((event: LayoutChangeEvent) => {
    setBoxWidth(event.nativeEvent.layout.width);
  }, []);
  const showSourcePress = useCallback(() => setShowSource(true), []);
  const showDiagramPress = useCallback(() => setShowSource(false), []);

  const actions = useMemo(
    () => [{ icon: Code, label: t("message.diagram.viewSource"), onPress: showSourcePress }],
    [showSourcePress, t],
  );

  const loaded = state.status === "loaded" ? state : null;
  // Never upscale past the SVG's natural size; small diagrams would only get blurry text.
  const fit = useMemo(
    () => ({ padding: FIT_PADDING, maxWidth: loaded?.size.width }),
    [loaded?.size.width],
  );
  const boxHeight = useMemo(() => {
    if (!loaded) return MIN_DIAGRAM_BOX_HEIGHT;
    const availableWidth = Math.max(1, boxWidth - FIT_PADDING * 2);
    const scale = boxWidth > 0 ? Math.min(1, availableWidth / loaded.size.width) : 1;
    const height = loaded.size.height * scale + FIT_PADDING * 2 + TOOLBAR_RESERVE * 2;
    return Math.min(MAX_DIAGRAM_BOX_HEIGHT, Math.max(MIN_DIAGRAM_BOX_HEIGHT, height));
  }, [boxWidth, loaded]);
  const diagramStyle = useMemo(
    () => [getDiagramBoxStyle(textStyle), containerStyle, { height: boxHeight }],
    [boxHeight, textStyle],
  );

  const pendingUrl = state.status === "loading" ? state.url : null;
  const diagramVisible = isComplete && loaded !== null && !showSource;

  return (
    <>
      {diagramVisible ? null : (
        <View style={sourceContainerStyle}>
          <HighlightedCodeBlock
            code={code}
            language="plantuml"
            inheritedStyles={inheritedStyles}
            textStyle={textStyle}
          />
          {showSource && loaded ? (
            <Pressable
              accessibilityLabel={t("message.diagram.viewDiagram")}
              accessibilityRole="button"
              hitSlop={4}
              onPress={showDiagramPress}
              style={controlStyles.sourceButton}
            >
              {({ hovered }) => (
                <Workflow
                  size={14}
                  color={hovered ? controlStyles.iconHovered.color : controlStyles.icon.color}
                />
              )}
            </Pressable>
          ) : null}
        </View>
      )}
      {pendingUrl ? (
        // Off-screen probe: the box is sized from the SVG's intrinsic size once it loads.
        <img alt="" src={pendingUrl} onLoad={handleLoad} onError={handleError} style={probeStyle} />
      ) : null}
      {diagramVisible && loaded ? (
        <View onLayout={handleBoxLayout}>
          <ZoomableViewport
            accessibilityLabel={t("message.diagram.diagram")}
            actions={actions}
            contentSize={loaded.size}
            fit={fit}
            style={diagramStyle}
            testID="plantuml-viewport"
            wheelActivation="modifier"
          >
            <img
              alt={t("message.diagram.diagram")}
              draggable={false}
              src={loaded.url}
              style={paperStyle}
            />
          </ZoomableViewport>
        </View>
      ) : null}
    </>
  );
}

const sourceContainerStyle: ViewStyle = { position: "relative" };
// Same flex fix as the mermaid host: keep the viewport sized from its explicit height.
const containerStyle: ViewStyle = {
  flexBasis: "auto",
  flexGrow: 0,
  flexShrink: 0,
  overflow: "hidden",
  position: "relative",
};
// The viewport sizes its content box to the fitted size, so the sheet must fill it, not keep the
// SVG's natural size.
const paperStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  padding: PAPER_PADDING,
  backgroundColor: "#ffffff",
  borderRadius: 8,
  objectFit: "contain",
};
const probeStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: "none",
};
const controlStyles = StyleSheet.create((theme) => ({
  sourceButton: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  icon: { color: theme.colors.foregroundMuted },
  iconHovered: { color: theme.colors.foreground },
}));
