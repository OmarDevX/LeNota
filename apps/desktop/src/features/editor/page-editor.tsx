import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useId,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { mergeAttributes, Mark, Node, type Editor, type JSONContent } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Highlight } from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { toBlob } from "html-to-image";
import katex from "katex";
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Bold, Check, CircleCheck, ChevronDown, ChevronLeft, ChevronRight,
  CheckSquare, Command, CloudOff, Code, Columns3, Copy, Eraser, Focus, GripHorizontal, Calculator,
  FileText, Heading1, Heading2, Highlighter, History, ImagePlus, Italic, Layers, Link, List,
  ListOrdered, LoaderCircle, Minus, MousePointer2, Paintbrush, Paperclip, PenLine, Pilcrow,
  Plus, Quote, Redo2, Rows3, Star, Strikethrough, Table2, Trash2, Underline, Undo2,
  Square, Circle, ArrowUpRight, Mic, RotateCcw, RotateCw, Search, X, Sigma, WandSparkles, PaintBucket,
  Unlink, ZoomIn, ZoomOut, Moon, Sun, Maximize2, Minimize2, SlidersHorizontal,
  Settings, MoreVertical, Grip,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LENOTA_VERSION } from "@/build-info";
import { notesApi } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { findEnclosingParentheses, findMultiStrokeSigmaCluster } from "./math-ink-structure";
import { composeMixedMath, typedMathToLatex, type MixedMathBounds, type MixedMathPart } from "./mixed-math-composer";
import { repairDuplicateLargeOperatorScripts, repairGeneratedLatexSource, repairUnclosedLatexGroups } from "./latex-repair";
import { confirmAllRecentMathConversions, findReopenableMathConversion, RECENT_MATH_EDIT_WINDOW_MS } from "./recent-math-session";
import { cloudBlocksToTiptap, parseAskDirective } from "./cloud-ai-content";
import { chooseInkContainerTarget } from "./ink-container-target";
import { buildPageAiContext, prunePageAiMemory, renderPageContentForAi, type PageAiMemoryEntry } from "./page-ai-context";
import { isOnRenderedTextLine, textForInlineHandwriting } from "./recognized-text-placement";
import { describeVisualCaptureError, detectVisualImageMimeType, shouldCaptureVisualBaseNode, shouldCaptureVisualNode, visualImageDrawPlacement, visualSelectionBounds } from "./visual-selection";
import { canvasToClientPoint, canvasTransformFromRenderedRect, clientDeltaToCanvasDelta, clientToCanvasPoint } from "./canvas-coordinates";
import { analyzeLatexSolveCandidate } from "./equation-solver";
import { buildMathGraphGeometry, normalizeMathGraphSpec } from "./math-graph";
import { convertedInkColor, themeAwareInkColor } from "./ink-output-color";
import { customSizeOr, parseCustomSize } from "./custom-size";
import { canvasViewportTransform, fitCanvasBounds, normalizeCanvasViewport, type CanvasBounds } from "@/features/layout/app-layout";
import type { Attachment, Page, Tag } from "@/types/domain";

interface PageEditorProps {
  page: Page | null;
  title: string;
  contentJson: string;
  plainText: string;
  saveState: "idle" | "saving" | "saved" | "error";
  availableTags: Tag[];
  onChangeTitle: (value: string) => void;
  onChangeContent: (contentJson: string, plainText: string) => void;
  onToggleFavorite: () => void;
  onAddTag: (tagId: string) => void;
  onCreateTag: () => void;
  onRemoveTag: (tagId: string) => void;
  onOpenHistory: () => void;
  onCreateSnapshot: () => void;
  attachmentCount: number;
  onOpenAttachments: () => void;
  onAttachmentsChanged?: () => void;
  onOpenCommands: () => void;
  onExport: (format: "markdown" | "html" | "text") => void;
  linkablePages: LinkablePage[];
  focusPages: LinkablePage[];
  onOpenInternalPage: (pageId: string, containerId?: string) => void;
  onCreatePage: () => void;
  targetContainerId?: string | null;
  onTargetContainerHandled?: () => void;
  theme: AppTheme;
  focusMode: boolean;
  onToggleTheme: () => void;
  onToggleFocusMode: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  focusBreadcrumb: string;
}

type AppTheme = "dark" | "light";

interface LinkablePage {
  id: string;
  title: string;
  notebookName: string;
  sectionName: string;
}

type ContainerId = string;
type DrawingTool = "select" | "lasso" | "ask" | "pen" | "highlighter" | "eraser" | "fill" | "rectangle" | "ellipse" | "line" | "arrow";
type WorkspaceToolbarMode = "write" | "draw";
type DrawToolbarPanel = "ink" | "shapes" | "ai" | "page";
type AutoInkMode = "smart" | "text" | "shape" | "math";
type CloudAiReadiness = "checking" | "ready" | "missing";

interface InkPoint { x: number; y: number; pressure: number }
interface InkStroke {
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  points: InkPoint[];
}
interface CanvasShape {
  id: string;
  kind: "rectangle" | "ellipse" | "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  fill: string;
  strokeWidth: number;
  rotation?: number;
  zIndex?: number;
}
interface CanvasBackground {
  pattern: "plain" | "grid" | "ruled";
  color: string;
  spacing: number;
}
interface NoteContainer {
  id: ContainerId;
  x: number;
  y: number;
  width: number;
  minHeight: number;
  zIndex: number;
  content: JSONContent;
  plainText: string;
}
interface CanvasDocument {
  type: "lenota-canvas";
  version: 3;
  viewport: { x: number; y: number; zoom: number };
  containers: NoteContainer[];
  ink: InkStroke[];
  shapes: CanvasShape[];
  background: CanvasBackground;
  aiMemory: PageAiMemoryEntry[];
}
interface CanvasSnapshot {
  containers: NoteContainer[];
  ink: InkStroke[];
  shapes: CanvasShape[];
  background: CanvasBackground;
  aiMemory: PageAiMemoryEntry[];
}

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };
const MIN_WIDTH = 180;
const MAX_WIDTH = 1400;
const MIN_HEIGHT = 56;
const HISTORY_LIMIT = 80;

const FONT_CHOICES = [
  // Keep the ink/font picker Fedora-first. Several earlier choices (Arial,
  // Georgia, Times New Roman) commonly fall back to the same Linux font, which
  // made the selector look broken even when the mark itself was being applied.
  { label: "Default", value: "", css: "inherit" },
  { label: "System Sans", value: "system-sans", css: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { label: "DejaVu Sans", value: "dejavu-sans", css: "'DejaVu Sans', sans-serif" },
  { label: "DejaVu Serif", value: "dejavu-serif", css: "'DejaVu Serif', serif" },
  { label: "DejaVu Mono", value: "dejavu-mono", css: "'DejaVu Sans Mono', monospace" },
  { label: "Liberation Sans", value: "liberation-sans", css: "'Liberation Sans', sans-serif" },
  { label: "Liberation Serif", value: "liberation-serif", css: "'Liberation Serif', serif" },
  { label: "Liberation Mono", value: "liberation-mono", css: "'Liberation Mono', monospace" },
  { label: "Noto Sans", value: "noto-sans", css: "'Noto Sans', 'DejaVu Sans', sans-serif" },
  { label: "Noto Serif", value: "noto-serif", css: "'Noto Serif', 'DejaVu Serif', serif" },
] as const;

type FontChoiceValue = typeof FONT_CHOICES[number]["value"];
const LEGACY_FONT_VALUE_MAP: Record<string, FontChoiceValue> = {
  "system-ui, sans-serif": "system-sans",
  "Arial, sans-serif": "liberation-sans",
  "Verdana, sans-serif": "dejavu-sans",
  "Georgia, serif": "dejavu-serif",
  "'Times New Roman', serif": "liberation-serif",
  "'DejaVu Sans', sans-serif": "dejavu-sans",
  "'DejaVu Serif', serif": "dejavu-serif",
  "'Liberation Sans', sans-serif": "liberation-sans",
  "'Liberation Serif', serif": "liberation-serif",
  "'Courier New', monospace": "liberation-mono",
  "'DejaVu Sans Mono', monospace": "dejavu-mono",
  "'Liberation Mono', monospace": "liberation-mono",
};
function normalizeFontChoice(value: unknown): string {
  const raw = String(value ?? "");
  if (!raw) return "";
  if (FONT_CHOICES.some(font => font.value === raw)) return raw;
  return LEGACY_FONT_VALUE_MAP[raw] ?? raw;
}
function fontCssValue(value: unknown): string {
  const normalized = normalizeFontChoice(value);
  return FONT_CHOICES.find(font => font.value === normalized)?.css ?? (String(value ?? "inherit") || "inherit");
}


function ImageNodeView({ node, updateAttributes, selected, editor, getPos }: NodeViewProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const rotation = Number(node.attrs.rotation ?? 0);
  const align = String(node.attrs.imageAlign ?? "left") as "left" | "center" | "right";
  const size = String(node.attrs.imageSize ?? "auto");
  const storedWidth = Number(node.attrs.imageWidth);
  const presetWidth = size === "small" ? 260 : size === "medium" ? 520 : size === "large" ? 900 : null;
  const width = Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : presetWidth;
  const justifyContent = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
  const attachmentId=String(node.attrs.attachmentId??"");
  const printoutPage=Boolean(node.attrs.printoutPage)||/\s-\spage\s+\d+\.png$/i.test(String(node.attrs.title??""));

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const initial = imageRef.current?.getBoundingClientRect().width ?? width ?? 420;
    const move = (e: PointerEvent) => {
      const next = Math.round(clamp(initial + (e.clientX - startX), 48, 1400));
      updateAttributes({ imageSize: "custom", imageWidth: next });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return <NodeViewWrapper
    className={cn("lenota-image-node", selected && "is-selected")}
    data-image-align={align}
    data-pdf-printout-page={printoutPage?"true":undefined}
    data-attachment-id={attachmentId||undefined}
    contentEditable={false}
    style={{ display: "flex", justifyContent, width: "100%" }}
    onPointerDown={(event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (typeof pos === "number") editor.commands.setNodeSelection(pos);
    }}
  >
    <div className="lenota-image-frame" style={{ width: width ? `${width}px` : "fit-content", maxWidth: "100%" }}>
      <img
        ref={imageRef}
        src={String(node.attrs.src ?? "")}
        alt={String(node.attrs.alt ?? "")}
        title={String(node.attrs.title ?? "")}
        draggable={false}
        data-attachment-id={attachmentId||undefined}
        data-pdf-printout-page={printoutPage?"true":undefined}
        data-image-align={align}
        data-image-size={size}
        data-image-width={width ? String(width) : undefined}
        data-image-rotation={String(rotation)}
        style={{ width: width ? "100%" : "auto", maxWidth: "100%", height: "auto", transform: `rotate(${rotation}deg)`, transformOrigin: "center" }}
      />
      {selected && node.attrs.ocrText ? <div className="lenota-image-ocr-badge" title="This image has searchable OCR text">OCR</div> : null}
      {selected ? <>
        <div className="lenota-image-selection" />
        <div title="Resize image" className="lenota-image-resize" onPointerDown={startResize} />
      </> : null}
    </div>
  </NodeViewWrapper>;
}

const FontFamilyStyle = Mark.create({
  name: "fontFamilyStyle",
  addAttributes() { return { value: { default: null } }; },
  parseHTML() { return [{ tag: "span[data-ln-font-family]", getAttrs: (element) => ({ value: normalizeFontChoice((element as HTMLElement).getAttribute("data-ln-font-family")) }) }]; },
  renderHTML({ HTMLAttributes }) {
    const value = normalizeFontChoice(HTMLAttributes.value);
    const css = fontCssValue(value);
    // The CSS variable + explicit font-family give WebKitGTK two equivalent
    // paths. The !important rule in styles.css prevents inherited editor/UI
    // font declarations from visually masking a selected note font.
    return ["span", { "data-ln-font-family": value, style: value ? `--ln-font-family:${css};font-family:${css}` : undefined }, 0];
  },
});
const FontSizeStyle = Mark.create({
  name: "fontSizeStyle",
  addAttributes() { return { value: { default: null } }; },
  parseHTML() { return [{ tag: "span[data-ln-font-size]", getAttrs: (element) => ({ value: (element as HTMLElement).getAttribute("data-ln-font-size") }) }]; },
  renderHTML({ HTMLAttributes }) {
    const value = String(HTMLAttributes.value ?? "");
    return ["span", { "data-ln-font-size": value, style: value ? `font-size:${value}` : undefined }, 0];
  },
});
const TextColorStyle = Mark.create({
  name: "textColorStyle",
  addAttributes() { return { value: { default: null } }; },
  parseHTML() { return [{ tag: "span[data-ln-text-color]", getAttrs: (element) => ({ value: (element as HTMLElement).getAttribute("data-ln-text-color") }) }]; },
  renderHTML({ HTMLAttributes }) {
    const value = String(HTMLAttributes.value ?? "");
    return ["span", { "data-ln-text-color": value, style: value ? `color:${value}` : undefined }, 0];
  },
});
const SuperscriptStyle = Mark.create({ name: "superscriptStyle", parseHTML: () => [{ tag: "sup" }], renderHTML: () => ["sup", 0] });
const SubscriptStyle = Mark.create({ name: "subscriptStyle", excludes: "superscriptStyle", parseHTML: () => [{ tag: "sub" }], renderHTML: () => ["sub", 0] });

const EnhancedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      rotation: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute("data-image-rotation") ?? 0),
        renderHTML: (attributes) => ({ "data-image-rotation": String(Number(attributes.rotation ?? 0) % 360) }),
      },
      imageAlign: {
        default: "left",
        parseHTML: (element) => element.getAttribute("data-image-align") ?? "left",
        renderHTML: (attributes) => ({ "data-image-align": String(attributes.imageAlign ?? "left") }),
      },
      imageSize: {
        default: "auto",
        parseHTML: (element) => element.getAttribute("data-image-size") ?? "auto",
        renderHTML: (attributes) => ({ "data-image-size": String(attributes.imageSize ?? "auto") }),
      },
      attachmentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-attachment-id"),
        renderHTML: (attributes) => attributes.attachmentId ? { "data-attachment-id": String(attributes.attachmentId) } : {},
      },
      storedPath: { default: null, renderHTML: () => ({}) },
      printoutPage: {
        default:false,
        parseHTML:(element)=>element.getAttribute("data-pdf-printout-page")==="true",
        renderHTML:(attributes)=>attributes.printoutPage?{"data-pdf-printout-page":"true"}:{},
      },
      ocrText: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-ocr-text"),
        renderHTML: (attributes) => attributes.ocrText ? { "data-ocr-text": String(attributes.ocrText) } : {},
      },
      imageWidth: {
        default: null,
        parseHTML: (element) => {
          const value = Number(element.getAttribute("data-image-width"));
          return Number.isFinite(value) && value > 0 ? value : null;
        },
        renderHTML: (attributes) => {
          const value = Number(attributes.imageWidth);
          if (!Number.isFinite(value) || value <= 0) return {};
          const width = Math.round(Math.max(1,value));
          return { "data-image-width": String(width), style: `width:${width}px;max-width:100%;height:auto;` };
        },
      },
    };
  },
  addNodeView() { return ReactNodeViewRenderer(ImageNodeView); },
});


type MathAlignment = "left" | "center" | "right";
type MathNodeAction = "solve" | "steps" | "graph";

function normalizeMathAlignment(value: unknown): MathAlignment {
  return value === "left" || value === "right" ? value : "center";
}

function MathNodeView({ node, updateAttributes, selected, editor, getPos }: NodeViewProps) {
  const latex = String(node.attrs.latex ?? "").trim();
  const display = Boolean(node.attrs.display);
  const align = normalizeMathAlignment(node.attrs.align);
  const fontSize = customSizeOr(node.attrs.fontSize,24,1);
  const color = String(node.attrs.color ?? "").trim();
  const targetWidth = Number(node.attrs.targetWidth ?? 0);
  const targetHeight = Number(node.attrs.targetHeight ?? 0);
  const autoFit = Boolean(node.attrs.autoFit);
  const renderRef = useRef<HTMLSpanElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<MathNodeAction | null>(null);
  const alreadyHasResult = /\\(?:Rightarrow|implies|Longrightarrow)\b/.test(latex);
  const solved = Boolean(node.attrs.solved) || alreadyHasResult;
  const solveCandidate = useMemo(() => solved ? null : analyzeLatexSolveCandidate(latex), [latex, solved]);
  // Graph is useful for declarative relations too (for example y=x^2 or
  // x^2+y^2=1), even when there is nothing sensible to "solve". Detect
  // graphability independently from question/solution eligibility.
  const graphable = useMemo(() => {
    if (!latex.includes("=") || !/[xy]/.test(latex)) return false;
    const direct = normalizeMathGraphSpec({ relationLatex: latex, xMin: -10, xMax: 10, yMin: -10, yMax: 10, title: "Graph" });
    return buildMathGraphGeometry(direct, 220, 140, 40, 28).supported;
  }, [latex]);
  // A relation involving both graph axes is normally a definition/curve, not
  // a single-target question. Keep its menu graph-focused rather than showing
  // misleading Solve/Steps actions. One-variable equations remain questions.
  const graphOnlyRelation = graphable && /x/.test(latex) && /y/.test(latex) && !/=\s*$/.test(latex);
  const hasQuestionActions = Boolean(!graphOnlyRelation && (solveCandidate || solved));
  const hasMathActions = hasQuestionActions || graphable;
  const renderedMath = useMemo(() => {
    try {
      return {
        html: katex.renderToString(latex || "?", {
          throwOnError: true,
          displayMode: display,
          output: "htmlAndMathml",
          strict: "ignore",
          trust: false,
        }),
        error: "",
      };
    } catch (error) {
      return { html: "", error: error instanceof Error ? error.message : String(error) };
    }
  }, [latex, display]);
  const html = renderedMath.html;

  // Draw-to-Math owns the original vector ink bounds. On the first render we
  // measure KaTeX at a known font size and scale it to fit those world-space
  // bounds. This makes the recognized equation appear at roughly the size the
  // user actually wrote instead of shrinking back to the editor's text size.
  useLayoutEffect(() => {
    if (!autoFit || targetWidth <= 0 || targetHeight <= 0 || !renderRef.current) return;
    const element = renderRef.current.querySelector<HTMLElement>(".katex") ?? renderRef.current;
    const naturalWidth = Math.max(1, element.scrollWidth || element.offsetWidth);
    const naturalHeight = Math.max(1, element.scrollHeight || element.offsetHeight);
    const fit = Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight);
    const fitted = Math.max(1,Math.round(fontSize * fit * 0.96));
    updateAttributes({ fontSize: fitted, autoFit: false });
  }, [autoFit, fontSize, targetHeight, targetWidth, updateAttributes, html]);

  useEffect(() => {
    if (!actionsOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && actionsRef.current?.contains(target)) return;
      setActionsOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setActionsOpen(false); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [actionsOpen]);

  useEffect(() => { setActionsOpen(false); }, [latex]);

  const getLiveMath = useCallback((expectedLatex?: string) => {
    let pos: number;
    try {
      const resolved = typeof getPos === "function" ? getPos() : undefined;
      if (typeof resolved !== "number") return null;
      pos = resolved;
    } catch { return null; }
    const liveNode = editor.state.doc.nodeAt(pos);
    if (!liveNode || liveNode.type.name !== "mathExpression") return null;
    const liveLatex = String(liveNode.attrs.latex ?? "").trim();
    if (expectedLatex !== undefined && liveLatex !== expectedLatex) return null;
    return { pos, node: liveNode, latex: liveLatex };
  }, [editor, getPos]);

  const selectSelf = () => {
    const live = getLiveMath();
    if (live) editor.commands.setNodeSelection(live.pos);
  };
  const edit = () => {
    const next = window.prompt("Edit LaTeX", latex || String.raw`x^2 + y^2 = z^2`);
    if (next === null) return;
    const clean = next.trim();
    if (!clean) return;
    const validation = validateLatexSource(clean);
    if (!validation.valid) {
      window.alert(`That LaTeX cannot be rendered yet.\n\n${validation.error || "Please correct the expression and try again."}`);
      return;
    }
    updateAttributes({ latex: clean, solved: false });
  };
  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectSelf();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = fontSize;
    const zoom = clamp(renderedCanvasScale(event.currentTarget), .35, 2.5);
    const move = (pointer: PointerEvent) => {
      const delta = ((pointer.clientX - startX) + (pointer.clientY - startY)) / (2 * zoom);
      updateAttributes({ fontSize: Math.max(1,Math.round(startSize + delta)), autoFit: false });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const setAlignment = (nextAlign: MathAlignment) => {
    // Alignment is a block-level visual choice. Turning an inline formula into
    // display math when the user explicitly aligns it avoids moving prose that
    // merely happens to contain an inline symbol.
    updateAttributes({ align: nextAlign, display: true });
    setActionsOpen(false);
  };

  const insertAfterContainingBlock = useCallback((mathPos: number, content: JSONContent[]) => {
    if (!content.length) return false;
    const resolved = editor.state.doc.resolve(mathPos);
    let blockDepth = resolved.depth;
    while (blockDepth > 0 && !resolved.node(blockDepth).isBlock) blockDepth -= 1;
    if (blockDepth <= 0) return false;
    const blockStart = resolved.before(blockDepth);
    const insertPos = blockStart + resolved.node(blockDepth).nodeSize;
    return editor.chain().focus().insertContentAt(insertPos, content).run();
  }, [editor]);

  const insertGraphAfterContainingBlock = useCallback((mathPos: number, specInput: ReturnType<typeof normalizeMathGraphSpec>) => {
    const graphType = editor.schema.nodes.mathGraph;
    if (!graphType) return false;
    const resolved = editor.state.doc.resolve(mathPos);
    let blockDepth = resolved.depth;
    while (blockDepth > 0 && !resolved.node(blockDepth).isBlock) blockDepth -= 1;
    if (blockDepth <= 0) return false;
    const blockStart = resolved.before(blockDepth);
    const insertPos = blockStart + resolved.node(blockDepth).nodeSize;
    const transaction = editor.state.tr.insert(insertPos, graphType.create({
      relationLatex: specInput.relationLatex,
      xMin: specInput.xMin,
      xMax: specInput.xMax,
      yMin: specInput.yMin,
      yMax: specInput.yMax,
      title: specInput.title || "Graph",
    }));
    editor.view.dispatch(transaction);
    return true;
  }, [editor]);

  const solveThisMath = useCallback(async () => {
    if (actionBusy || !solveCandidate) return;
    const originalLatex = latex;
    const live = getLiveMath(originalLatex);
    if (!live) return;
    setActionsOpen(false);
    if (solveCandidate.localSolution) {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(live.pos, undefined, {
        ...live.node.attrs,
        latex: solveCandidate.localSolution.solvedLatex,
        autoFit: false,
        solved: true,
      }));
      return;
    }
    setActionBusy("solve");
    try {
      const response = await notesApi.cloudMathSolve(originalLatex, 45_000);
      if (response.status === "not_solvable") {
        window.alert("Lenota could not solve this expression responsibly. The equation was left unchanged.");
        return;
      }
      const result = repairGeneratedLatexSource(String(response.resultLatex ?? "")).latex;
      const validation = validateLatexSource(result);
      if (!result || !validation.valid) throw new Error(validation.error || "Gemini returned invalid result LaTeX.");
      const lastEquals = originalLatex.lastIndexOf("=");
      const blankRight = lastEquals >= 0 && !originalLatex.slice(lastEquals + 1).trim();
      const solvedLatex = blankRight ? `${originalLatex}${result}` : `${originalLatex}\\quad\\Rightarrow\\quad ${result}`;
      const solvedValidation = validateLatexSource(solvedLatex);
      if (!solvedValidation.valid) throw new Error(solvedValidation.error || "The combined solution is not renderable LaTeX.");
      const current = getLiveMath(originalLatex);
      if (!current) throw new Error("The equation changed while Solve was running, so the result was not inserted.");
      editor.view.dispatch(editor.state.tr.setNodeMarkup(current.pos, undefined, {
        ...current.node.attrs,
        latex: solvedLatex,
        autoFit: false,
        solved: true,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const setup = /not configured|api key|Cloud AI/i.test(message)
        ? "\n\nAdvanced calculus/symbolic solving uses Gemini when the local solver cannot handle the expression. Use Cloud setup in the drawing toolbar first."
        : "";
      window.alert(`Solve failed: ${message}${setup}`);
    } finally { setActionBusy(null); }
  }, [actionBusy, editor, getLiveMath, latex, solveCandidate]);

  const showStepsForThisMath = useCallback(async () => {
    if (actionBusy) return;
    const originalLatex = latex;
    if (!getLiveMath(originalLatex)) return;
    setActionsOpen(false);
    setActionBusy("steps");
    try {
      const response = await notesApi.cloudAsk(
        `Show a concise, rigorous step-by-step solution or analysis for exactly this LaTeX expression. Keep the original equation unchanged. Use a numbered list when there is more than one step, render all mathematics as proper math segments/blocks, and finish with the final mathematical conclusion. Do not discuss unrelated page content.\n\nLATEX:\n${originalLatex}`,
        "",
        45_000,
      );
      const generated = makeGeneratedLatexRenderSafe(cloudBlocksToTiptap(response.blocks)).nodes;
      const current = getLiveMath(originalLatex);
      if (!current) throw new Error("The equation changed while Steps was running, so the explanation was not inserted.");
      if (!insertAfterContainingBlock(current.pos, generated)) throw new Error("Lenota could not insert the generated steps beside this equation.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`Steps failed: ${message}`);
    } finally { setActionBusy(null); }
  }, [actionBusy, getLiveMath, insertAfterContainingBlock, latex]);

  const graphThisMath = useCallback(async () => {
    if (actionBusy) return;
    const originalLatex = latex;
    const initial = getLiveMath(originalLatex);
    if (!initial) return;
    setActionsOpen(false);
    setActionBusy("graph");
    try {
      const direct = normalizeMathGraphSpec({ relationLatex: originalLatex, xMin: -10, xMax: 10, yMin: -10, yMax: 10, title: "Graph" });
      const hasGraphAxisVariable = /\b[xy]\b/.test(originalLatex);
      let graph = hasGraphAxisVariable && buildMathGraphGeometry(direct, 520, 280, 72, 48).supported ? direct : null;
      if (!graph) {
        const response = await notesApi.cloudMathSolve(originalLatex, 45_000, { forceGraph: true });
        if (response.graph) {
          const proposed = normalizeMathGraphSpec({
            relationLatex: String(response.graph.relationLatex ?? ""),
            xMin: Number(response.graph.xMin), xMax: Number(response.graph.xMax),
            yMin: Number(response.graph.yMin), yMax: Number(response.graph.yMax),
            title: String(response.graph.title ?? "Graph"),
          });
          if (proposed.relationLatex && buildMathGraphGeometry(proposed, 520, 280, 72, 48).supported) graph = proposed;
        }
      }
      if (!graph) {
        window.alert("This equation could not be represented safely as a useful 2D x/y graph.");
        return;
      }
      const current = getLiveMath(originalLatex);
      if (!current) throw new Error("The equation changed while Graph was being prepared, so no graph was inserted.");
      if (!insertGraphAfterContainingBlock(current.pos, graph)) throw new Error("Lenota could not insert the graph below this equation.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`Graph failed: ${message}`);
    } finally { setActionBusy(null); }
  }, [actionBusy, getLiveMath, insertGraphAfterContainingBlock, latex]);

  return <NodeViewWrapper
    as="span"
    className={cn(
      "lenota-math-node",
      display && "is-display",
      display && `math-align-${align}`,
      selected && "is-selected",
      actionsOpen && "has-open-actions",
    )}
    contentEditable={false}
    data-lenota-math="true"
    data-latex={latex}
    data-math-font-size={String(Math.round(fontSize))}
    data-math-color={color || undefined}
    data-math-align={align}
    style={{ fontSize: `${fontSize}px`, color: color || undefined }}
    onPointerDown={(event: ReactPointerEvent<HTMLElement>) => { if (event.button === 0) selectSelf(); }}
    onDoubleClick={(event: React.MouseEvent<HTMLElement>) => { event.preventDefault(); event.stopPropagation(); selectSelf(); edit(); }}
    title="Double-click to edit LaTeX"
  >
    {renderedMath.error ? (
      <span ref={renderRef} className="lenota-math-render lenota-math-invalid" title={renderedMath.error}>
        <span aria-hidden="true">⚠</span> Equation needs repair
      </span>
    ) : (
      <span ref={renderRef} className="lenota-math-render" dangerouslySetInnerHTML={{ __html: html }} />
    )}
    {hasMathActions && !renderedMath.error ? <div ref={actionsRef} className={cn("lenota-math-actions no-print", actionsOpen && "is-open")}>
      <button
        type="button"
        aria-label="Equation actions"
        aria-haspopup="menu"
        aria-expanded={actionsOpen}
        title="Equation actions"
        className="lenota-math-more"
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); selectSelf(); }}
        onClick={event => { event.preventDefault(); event.stopPropagation(); setActionsOpen(value => !value); }}
      ><span aria-hidden="true">•••</span></button>
      {actionsOpen ? <div role="menu" className="lenota-math-menu" onPointerDown={event => { event.stopPropagation(); }}>
        {hasQuestionActions ? <>
          <button role="menuitem" type="button" disabled={!solveCandidate || actionBusy !== null} onClick={() => void solveThisMath()}>
            {actionBusy === "solve" ? <LoaderCircle className="size-3.5 animate-spin"/> : <Calculator className="size-3.5"/>}<span>Solve</span>
          </button>
          <button role="menuitem" type="button" disabled={actionBusy !== null} onClick={() => void showStepsForThisMath()}>
            {actionBusy === "steps" ? <LoaderCircle className="size-3.5 animate-spin"/> : <ListOrdered className="size-3.5"/>}<span>Steps</span>
          </button>
        </> : null}
        {(graphable || hasQuestionActions) ? <button role="menuitem" type="button" disabled={actionBusy !== null} onClick={() => void graphThisMath()}>
          {actionBusy === "graph" ? <LoaderCircle className="size-3.5 animate-spin"/> : <ArrowUpRight className="size-3.5"/>}<span>Graph</span>
        </button> : null}
        <div className="lenota-math-menu-divider" />
        <div className="lenota-math-align-menu" aria-label="Equation alignment">
          <span>Align</span>
          <button type="button" title="Align equation left" className={cn(align === "left" && "is-active")} onClick={() => setAlignment("left")}><AlignLeft className="size-3.5"/></button>
          <button type="button" title="Center equation" className={cn(align === "center" && "is-active")} onClick={() => setAlignment("center")}><AlignCenter className="size-3.5"/></button>
          <button type="button" title="Align equation right" className={cn(align === "right" && "is-active")} onClick={() => setAlignment("right")}><AlignRight className="size-3.5"/></button>
        </div>
      </div> : null}
    </div> : null}
    {selected ? <>
      <button type="button" className="lenota-math-edit no-print" onMouseDown={event=>event.preventDefault()} onClick={edit}>Edit</button>
      <button type="button" aria-label="Resize equation" title="Drag to resize equation" className="lenota-math-resize no-print" onPointerDown={beginResize} />
    </> : null}
  </NodeViewWrapper>;
}

const MathExpression = Node.create({
  name: "mathExpression",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: { default: "x" },
      display: { default: false },
      align: { default: "center" },
      solved: { default: false },
      fontSize: { default: 24 },
      color: { default: null },
      targetWidth: { default: null, renderHTML: () => ({}) },
      targetHeight: { default: null, renderHTML: () => ({}) },
      autoFit: { default: false, renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{
      tag: "span[data-lenota-math]",
      getAttrs: (element) => ({
        latex: (element as HTMLElement).getAttribute("data-latex") ?? "x",
        display: (element as HTMLElement).getAttribute("data-display") === "true",
        align: normalizeMathAlignment((element as HTMLElement).getAttribute("data-math-align")),
        solved: (element as HTMLElement).getAttribute("data-math-solved") === "true",
        fontSize: customSizeOr((element as HTMLElement).getAttribute("data-math-font-size"),24,1),
        color: (element as HTMLElement).getAttribute("data-math-color"),
      }),
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, {
      "data-lenota-math": "true",
      "data-latex": String(HTMLAttributes.latex ?? "x"),
      "data-display": String(Boolean(HTMLAttributes.display)),
      "data-math-align": normalizeMathAlignment(HTMLAttributes.align),
      "data-math-solved": String(Boolean(HTMLAttributes.solved)),
      "data-math-font-size": String(customSizeOr(HTMLAttributes.fontSize,24,1)),
      ...(HTMLAttributes.color ? { "data-math-color": String(HTMLAttributes.color), style: `color:${String(HTMLAttributes.color)}` } : {}),
    })];
  },
  addNodeView() { return ReactNodeViewRenderer(MathNodeView); },
});


function MathGraphNodeView({node,selected,deleteNode}:NodeViewProps){
  const spec=useMemo(()=>normalizeMathGraphSpec({
    relationLatex:String(node.attrs.relationLatex??""),
    xMin:Number(node.attrs.xMin??-10),xMax:Number(node.attrs.xMax??10),
    yMin:Number(node.attrs.yMin??-10),yMax:Number(node.attrs.yMax??10),
    title:String(node.attrs.title??""),
  }),[node.attrs.relationLatex,node.attrs.title,node.attrs.xMax,node.attrs.xMin,node.attrs.yMax,node.attrs.yMin]);
  const width=520,height=280;
  const geometry=useMemo(()=>buildMathGraphGeometry(spec,width,height),[spec]);
  const relationHtml=useMemo(()=>{
    try{return katex.renderToString(spec.relationLatex,{throwOnError:false,strict:"ignore",displayMode:false});}
    catch{return "";}
  },[spec.relationLatex]);
  const verticalGrid=[.25,.5,.75].map(fraction=>fraction*width);
  const horizontalGrid=[.25,.5,.75].map(fraction=>fraction*height);
  const compact=(value:number)=>Number(value.toPrecision(4)).toString();
  return <NodeViewWrapper className={cn("lenota-math-graph",selected&&"is-selected")} contentEditable={false} data-lenota-math-graph="true">
    <div className="lenota-math-graph-head">
      <span className="truncate">{spec.title||"Graph"}</span>
      <span className="lenota-math-graph-equation" dangerouslySetInnerHTML={{__html:relationHtml}}/>
      {selected?<button type="button" title="Remove graph" className="lenota-math-graph-remove" onMouseDown={event=>event.preventDefault()} onClick={()=>deleteNode()}>×</button>:null}
    </div>
    <svg className="lenota-math-graph-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Graph of ${spec.relationLatex}`}>
      {verticalGrid.map(x=><line key={`v${x}`} x1={x} y1={0} x2={x} y2={height} className="lenota-math-graph-grid"/>)}
      {horizontalGrid.map(y=><line key={`h${y}`} x1={0} y1={y} x2={width} y2={y} className="lenota-math-graph-grid"/>)}
      {geometry.xAxisY!==null?<line x1={0} y1={geometry.xAxisY} x2={width} y2={geometry.xAxisY} className="lenota-math-graph-axis"/>:null}
      {geometry.yAxisX!==null?<line x1={geometry.yAxisX} y1={0} x2={geometry.yAxisX} y2={height} className="lenota-math-graph-axis"/>:null}
      {geometry.supported?<path d={geometry.path} className="lenota-math-graph-curve"/>:<text x={width/2} y={height/2} textAnchor="middle" className="lenota-math-graph-unavailable">Graph syntax is not locally plottable</text>}
      <text x={6} y={height-7} className="lenota-math-graph-range">x: {compact(spec.xMin)} to {compact(spec.xMax)} · y: {compact(spec.yMin)} to {compact(spec.yMax)}</text>
    </svg>
  </NodeViewWrapper>;
}

const MathGraph = Node.create({
  name:"mathGraph",
  group:"block",
  atom:true,
  selectable:true,
  addAttributes(){return{
    relationLatex:{default:"y=x"},xMin:{default:-10},xMax:{default:10},yMin:{default:-10},yMax:{default:10},title:{default:"Graph"},
  };},
  parseHTML(){return[{tag:"div[data-lenota-math-graph]",getAttrs:(element)=>({
    relationLatex:(element as HTMLElement).getAttribute("data-relation-latex")??"y=x",
    xMin:Number((element as HTMLElement).getAttribute("data-x-min")??-10),xMax:Number((element as HTMLElement).getAttribute("data-x-max")??10),
    yMin:Number((element as HTMLElement).getAttribute("data-y-min")??-10),yMax:Number((element as HTMLElement).getAttribute("data-y-max")??10),
    title:(element as HTMLElement).getAttribute("data-title")??"Graph",
  })}];},
  renderHTML({HTMLAttributes}){return["div",mergeAttributes(HTMLAttributes,{
    "data-lenota-math-graph":"true","data-relation-latex":String(HTMLAttributes.relationLatex??"y=x"),
    "data-x-min":String(HTMLAttributes.xMin??-10),"data-x-max":String(HTMLAttributes.xMax??10),
    "data-y-min":String(HTMLAttributes.yMin??-10),"data-y-max":String(HTMLAttributes.yMax??10),"data-title":String(HTMLAttributes.title??"Graph"),
  })];},
  addNodeView(){return ReactNodeViewRenderer(MathGraphNodeView);},
});

function normalizeIpcBytes(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]).buffer;
  throw new Error("LeNota received an invalid binary attachment response.");
}

async function managedImageBlob(attachmentId:string):Promise<Blob> {
  const buffer=normalizeIpcBytes(await notesApi.readAttachmentBytes(attachmentId));
  const mimeType=detectVisualImageMimeType(new Uint8Array(buffer));
  return new Blob([buffer],{type:mimeType});
}

async function visualImageBlob(image:HTMLImageElement):Promise<Blob> {
  const attachmentId=image.getAttribute("data-attachment-id")??image.closest<HTMLElement>("[data-attachment-id]")?.dataset.attachmentId??"";
  if(attachmentId)return managedImageBlob(attachmentId);
  const source=image.currentSrc||image.src;
  if(!source)throw new Error("A visible selected image has no readable source.");
  try{
    const response=await fetch(source);
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const blob=await response.blob();
    if(!blob.size)throw new Error("empty image");
    return blob;
  }catch(error){
    throw new Error(`A selected legacy image could not be read for AI vision (${describeVisualCaptureError(error)}). Reinsert it into LeNota and try again.`);
  }
}

async function waitForVisualCaptureFrame():Promise<void> {
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
}

async function captureDomBlobWithRetry(
  element:HTMLElement,
  options:NonNullable<Parameters<typeof toBlob>[1]>,
  label:string,
):Promise<Blob> {
  let lastError:unknown=null;
  for(let attempt=0;attempt<3;attempt+=1){
    try{
      const blob=await toBlob(element,options);
      if(blob?.size)return blob;
      lastError=new Error(`${label} returned an empty image.`);
    }catch(error){lastError=error;}
    await waitForVisualCaptureFrame();
  }
  throw new Error(`${label} failed after retrying (${describeVisualCaptureError(lastError)}).`);
}

interface DecodedVisualBlob {source:CanvasImageSource;dispose:()=>void;}

async function decodeVisualBlobForCanvas(blob:Blob,label:string):Promise<DecodedVisualBlob> {
  let lastError:unknown=null;
  if(typeof createImageBitmap==="function"){
    for(let attempt=0;attempt<2;attempt+=1){
      try{
        const bitmap=await createImageBitmap(blob);
        return {source:bitmap,dispose:()=>bitmap.close()};
      }catch(error){lastError=error;await waitForVisualCaptureFrame();}
    }
  }
  const url=URL.createObjectURL(blob);
  const image=document.createElement("img");
  image.decoding="async";
  try{
    await new Promise<void>((resolve,reject)=>{
      image.onload=()=>resolve();
      image.onerror=event=>reject(event);
      image.src=url;
    });
    if(!image.naturalWidth||!image.naturalHeight)throw new Error("decoded image has no pixels");
    return {source:image,dispose:()=>URL.revokeObjectURL(url)};
  }catch(error){
    URL.revokeObjectURL(url);
    const cause=describeVisualCaptureError(error??lastError);
    throw new Error(`${label} could not be decoded for the AI screenshot (${cause}).`);
  }
}

/** html-to-image clones the DOM. If IMG nodes are filtered out without a
 * stable frame height, content below an image can jump upward in the clone.
 * Freezing only the image frame's current layout avoids that while leaving the
 * actual visible image untouched. */
function guardVisualImageLayout(root:HTMLElement):()=>void {
  const guarded=new Map<HTMLElement,{height:string;minHeight:string}>();
  root.querySelectorAll<HTMLImageElement>("img").forEach(image=>{
    const frame=image.closest<HTMLElement>(".lenota-image-frame");
    if(!frame||guarded.has(frame))return;
    const height=frame.offsetHeight;
    if(height<=0)return;
    guarded.set(frame,{height:frame.style.height,minHeight:frame.style.minHeight});
    frame.style.height=`${height}px`;
    frame.style.minHeight=`${height}px`;
  });
  return ()=>guarded.forEach((previous,frame)=>{frame.style.height=previous.height;frame.style.minHeight=previous.minHeight;});
}

function decodePcmWav(context: AudioContext, buffer: ArrayBuffer): AudioBuffer {
  const view = new DataView(buffer);
  const ascii = (offset: number, length: number) => Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
  if (buffer.byteLength < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new Error("This WAV recording has an invalid header.");
  }
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = ascii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkData = offset + 8;
    if (chunkData + chunkSize > buffer.byteLength) break;
    if (chunkId === "fmt " && chunkSize >= 16) {
      audioFormat = view.getUint16(chunkData, true);
      channels = view.getUint16(chunkData + 2, true);
      sampleRate = view.getUint32(chunkData + 4, true);
      bitsPerSample = view.getUint16(chunkData + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkData;
      dataLength = chunkSize;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }
  if (!channels || !sampleRate || dataOffset < 0 || !dataLength) throw new Error("The WAV recording is missing audio data.");
  if (channels > 8) throw new Error("The WAV recording has too many channels.");
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  if (!bytesPerSample) throw new Error("Unsupported WAV sample format.");
  const frameSize = bytesPerSample * channels;
  const frameCount = Math.floor(dataLength / frameSize);
  const decoded = context.createBuffer(channels, frameCount, sampleRate);
  const readSample = (byteOffset: number) => {
    if (audioFormat === 3 && bitsPerSample === 32) return view.getFloat32(byteOffset, true);
    if (audioFormat !== 1) throw new Error(`Unsupported WAV encoding ${audioFormat}.`);
    if (bitsPerSample === 8) return (view.getUint8(byteOffset) - 128) / 128;
    if (bitsPerSample === 16) return view.getInt16(byteOffset, true) / 32768;
    if (bitsPerSample === 24) {
      let value = view.getUint8(byteOffset) | (view.getUint8(byteOffset + 1) << 8) | (view.getUint8(byteOffset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8388608;
    }
    if (bitsPerSample === 32) return view.getInt32(byteOffset, true) / 2147483648;
    throw new Error(`Unsupported ${bitsPerSample}-bit WAV audio.`);
  };
  for (let channel = 0; channel < channels; channel += 1) {
    const output = decoded.getChannelData(channel);
    for (let frame = 0; frame < frameCount; frame += 1) {
      output[frame] = clamp(readSample(dataOffset + frame * frameSize + channel * bytesPerSample), -1, 1);
    }
  }
  return decoded;
}

function AudioCardView({ node }: NodeViewProps) {
  const attachmentId = String(node.attrs.attachmentId ?? "");
  const fileName = String(node.attrs.fileName ?? "Audio recording");
  const storedPath = String(node.attrs.storedPath ?? "");
  const mimeType = String(node.attrs.mimeType ?? "audio/wav");
  const sizeBytes = Number(node.attrs.sizeBytes ?? 0);
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [decodedWav, setDecodedWav] = useState<AudioBuffer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startedAtRef = useRef(0);
  const startOffsetRef = useRef(0);
  const animationRef = useRef<number | null>(null);

  const stopSource = useCallback((keepPosition = true) => {
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop(); } catch { /* already stopped */ }
      try { sourceRef.current.disconnect(); } catch { /* already disconnected */ }
      sourceRef.current = null;
    }
    if (animationRef.current !== null) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
    if (!keepPosition) { startOffsetRef.current = 0; setPosition(0); }
    setPlaying(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    stopSource(false);
    setBlobSrc(null);
    setDecodedWav(null);
    setLoadError(null);
    if (!attachmentId) { setLoadError("Missing audio attachment id"); return; }
    void notesApi.readAttachmentBytes(attachmentId)
      .then(async (raw) => {
        if (disposed) return;
        const buffer = normalizeIpcBytes(raw);
        const looksLikeWav = mimeType.includes("wav") || fileName.toLowerCase().endsWith(".wav");
        if (looksLikeWav) {
          const context = contextRef.current ?? new AudioContext();
          contextRef.current = context;
          const decoded = decodePcmWav(context, buffer);
          if (!disposed) setDecodedWav(decoded);
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType || "application/octet-stream" }));
        if (!disposed) setBlobSrc(objectUrl);
      })
      .catch((error) => { if (!disposed) setLoadError(String(error)); });
    return () => {
      disposed = true;
      stopSource(false);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId, fileName, mimeType, stopSource]);

  useEffect(() => () => { void contextRef.current?.close().catch(() => {}); }, []);

  const updateClock = useCallback(() => {
    const context = contextRef.current;
    const buffer = decodedWav;
    if (!context || !buffer || !sourceRef.current) return;
    const next = Math.min(buffer.duration, startOffsetRef.current + Math.max(0, context.currentTime - startedAtRef.current));
    setPosition(next);
    if (next < buffer.duration) animationRef.current = requestAnimationFrame(updateClock);
  }, [decodedWav]);

  const playPcm = useCallback(async () => {
    const buffer = decodedWav;
    const context = contextRef.current;
    if (!buffer || !context) return;
    if (playing) {
      const elapsed = Math.max(0, context.currentTime - startedAtRef.current);
      startOffsetRef.current = Math.min(buffer.duration, startOffsetRef.current + elapsed);
      setPosition(startOffsetRef.current);
      stopSource(true);
      return;
    }
    if (startOffsetRef.current >= buffer.duration - 0.01) startOffsetRef.current = 0;
    await context.resume();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    sourceRef.current = source;
    startedAtRef.current = context.currentTime;
    source.onended = () => {
      if (sourceRef.current !== source) return;
      sourceRef.current = null;
      startOffsetRef.current = 0;
      setPosition(0);
      setPlaying(false);
      if (animationRef.current !== null) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
    };
    source.start(0, startOffsetRef.current);
    setPlaying(true);
    animationRef.current = requestAnimationFrame(updateClock);
  }, [decodedWav, playing, stopSource, updateClock]);

  const seekPcm = useCallback((next: number) => {
    const buffer = decodedWav;
    const context = contextRef.current;
    if (!buffer || !context) return;
    const target = clamp(next, 0, buffer.duration);
    const wasPlaying = playing;
    stopSource(true);
    startOffsetRef.current = target;
    setPosition(target);
    if (wasPlaying && target < buffer.duration) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      sourceRef.current = source;
      startedAtRef.current = context.currentTime;
      source.onended = () => {
        if (sourceRef.current !== source) return;
        sourceRef.current = null;
        startOffsetRef.current = 0;
        setPosition(0);
        setPlaying(false);
      };
      source.start(0, target);
      setPlaying(true);
      animationRef.current = requestAnimationFrame(updateClock);
    }
  }, [decodedWav, playing, stopSource, updateClock]);

  return <NodeViewWrapper className="note-audio-card" data-lenota-audio="true" data-attachment-id={attachmentId} contentEditable={false}>
    <div className="note-audio-meta">
      <span className="note-audio-icon">🎙</span>
      <span className="note-audio-name">{fileName}</span>
      <span className="note-audio-size">{formatBytes(sizeBytes)}</span>
      <button type="button" className="note-audio-open" onMouseDown={(event) => event.preventDefault()} onClick={() => { if (storedPath) void openPath(storedPath); }}>Open externally</button>
    </div>
    {loadError ? <div className="note-audio-playback-error">Unable to load in-app audio. {loadError}</div> : decodedWav ?
      <div className="note-audio-native-player">
        <button type="button" className="note-audio-play-button" onMouseDown={(event) => event.preventDefault()} onClick={() => void playPcm()}>{playing ? "❚❚" : "▶"}</button>
        <span className="note-audio-time">{formatRecordingTime(Math.floor(position))}</span>
        <input aria-label="Audio position" type="range" min="0" max={Math.max(decodedWav.duration, 0.01)} step="0.01" value={Math.min(position, decodedWav.duration)} onChange={(event) => seekPcm(Number(event.target.value))} className="note-audio-seek" />
        <span className="note-audio-time">{formatRecordingTime(Math.ceil(decodedWav.duration))}</span>
      </div> : blobSrc ? <audio key={blobSrc} className="note-audio-player" controls preload="metadata" src={blobSrc} onError={() => setLoadError("WebKit could not decode this imported audio format. Use Open externally.")}>
        Audio playback is not supported by this WebKit build.
      </audio> : <div className="note-audio-loading">Loading recording…</div>}
  </NodeViewWrapper>;
}

const AudioCard = Node.create({
  name: "audioCard",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      attachmentId: { default: null },
      fileName: { default: "Audio recording" },
      storedPath: { default: null },
      src: { default: null },
      mimeType: { default: "audio/wav" },
      sizeBytes: { default: 0 },
    };
  },
  parseHTML() { return [{ tag: "div[data-lenota-audio]" }]; },
  renderHTML({ HTMLAttributes }) {
    const fileName = String(HTMLAttributes.fileName ?? "Audio recording");
    const size = Number(HTMLAttributes.sizeBytes ?? 0);
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-lenota-audio": "true",
      class: "note-audio-card",
    }),
      ["div", { class: "note-audio-meta" }, ["span", { class: "note-audio-icon" }, "🎙"], ["span", { class: "note-audio-name" }, fileName], ["span", { class: "note-audio-size" }, formatBytes(size)]],
      ["div", { class: "note-audio-export-note" }, "Audio recording is stored as a managed attachment."],
    ];
  },
  addNodeView() { return ReactNodeViewRenderer(AudioCardView); },
});

const AttachmentCard = Node.create({
  name: "attachmentCard",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      attachmentId: { default: null },
      fileName: { default: "Attachment" },
      storedPath: { default: null },
      mimeType: { default: "application/octet-stream" },
      sizeBytes: { default: 0 },
    };
  },
  parseHTML() { return [{ tag: "div[data-lenota-attachment]" }]; },
  renderHTML({ HTMLAttributes }) {
    const fileName = String(HTMLAttributes.fileName ?? "Attachment");
    const size = Number(HTMLAttributes.sizeBytes ?? 0);
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-lenota-attachment": "true",
      class: "note-attachment-card",
      contenteditable: "false",
      title: "Open attachment",
    }), ["span", { class: "note-attachment-icon" }, "📎"], ["span", { class: "note-attachment-name" }, fileName], ["span", { class: "note-attachment-size" }, formatBytes(size)]];
  },
});

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
function formatRecordingTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function encodePcm16Wav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const frameCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + frameCount * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + frameCount * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, frameCount * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

interface WavCaptureSession {
  pageId: string;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  sink: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
}
function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

interface CustomSizeInputProps {
  value: number | null;
  recommended: readonly number[];
  onCommit: (value: number) => void;
  onClear?: () => void;
  minimum?: number;
  unit?: string;
  title: string;
  ariaLabel: string;
  className?: string;
}

/** A number field backed by recommended datalist choices. The user can type
 * any positive decimal; presets are shortcuts, not limits. */
function CustomSizeInput({ value, recommended, onCommit, onClear, minimum=.1, unit="px", title, ariaLabel, className }: CustomSizeInputProps) {
  const listId=useId();
  const [draft,setDraft]=useState(value===null?"":String(value));
  useEffect(()=>setDraft(value===null?"":String(value)),[value]);
  const commit=()=>{
    if(!draft.trim()){
      if(onClear)onClear();
      else setDraft(value===null?"":String(value));
      return;
    }
    const parsed=parseCustomSize(draft,minimum);
    if(parsed===null){setDraft(value===null?"":String(value));return;}
    setDraft(String(parsed));
    onCommit(parsed);
  };
  return <span className={cn("custom-size-input inline-flex h-7 shrink-0 items-center overflow-hidden rounded border border-white/10 bg-[#25252a] text-neutral-300",className)} title={title}>
    <input
      type="number"
      inputMode="decimal"
      min={minimum}
      step="any"
      list={listId}
      aria-label={ariaLabel}
      value={draft}
      placeholder="Size"
      onChange={event=>setDraft(event.target.value)}
      onBlur={commit}
      onFocus={event=>event.currentTarget.select()}
      onKeyDown={event=>{
        if(event.key==="Enter"){event.preventDefault();event.currentTarget.blur();}
        if(event.key==="Escape"){event.preventDefault();setDraft(value===null?"":String(value));event.currentTarget.blur();}
      }}
      className="custom-size-input-field h-full min-w-0 flex-1 border-0 bg-transparent px-1.5 text-right text-[11px] text-inherit outline-none"
    />
    <datalist id={listId}>{recommended.map(size=><option key={size} value={size}/>)}</datalist>
    {unit?<span className="custom-size-input-unit shrink-0 pr-1.5 text-[9px] text-neutral-500">{unit}</span>:null}
    <select
      aria-label={`${ariaLabel} recommended values`}
      title={`Recommended ${ariaLabel.toLowerCase()} values`}
      value=""
      onChange={event=>{
        const parsed=parseCustomSize(event.target.value,minimum);
        if(parsed===null)return;
        setDraft(String(parsed));
        onCommit(parsed);
      }}
      className="custom-size-preset h-full w-5 shrink-0 border-0 border-l border-white/10 bg-transparent p-0 text-[9px] text-neutral-500 outline-none"
    >
      <option value="">⌄</option>
      {recommended.map(size=><option key={`preset-${size}`} value={size}>{size}</option>)}
    </select>
  </span>;
}

function renderedCanvasScale(element: Element | null) {
  const world=element?.closest<HTMLElement>(".canvas-world");
  if(world){
    const rect=world.getBoundingClientRect();
    return canvasTransformFromRenderedRect(rect,world.offsetWidth,world.offsetHeight,1).scaleX;
  }
  return 1;
}
function deepClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function documentHasMeaningfulContent(content: JSONContent): boolean {
  const visit = (node: JSONContent): boolean => {
    if (node.type === "text") return Boolean(node.text?.trim());
    if (["image", "attachmentCard", "audioCard", "mathExpression", "mathGraph", "table", "horizontalRule"].includes(node.type ?? "")) return true;
    return Array.isArray(node.content) && node.content.some(visit);
  };
  return visit(content);
}
function parseLegacyDocument(contentJson: string, plainText: string): JSONContent {
  try {
    const parsed = JSON.parse(contentJson) as JSONContent & { text?: string };
    if (parsed.type === "doc") return parsed;
    if (parsed.type === "plain-text-v1" && typeof parsed.text === "string") {
      return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: parsed.text }] }] };
    }
  } catch { /* use plain text */ }
  return plainText ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: plainText }] }] } : EMPTY_DOC;
}
function loadCanvas(contentJson: string, plainText: string): CanvasDocument {
  try {
    const parsed = JSON.parse(contentJson) as { type?: string; version?: number; viewport?: { x?: number; y?: number; zoom?: number }; containers?: NoteContainer[]; ink?: InkStroke[]; shapes?: CanvasShape[]; background?: Partial<CanvasBackground>; aiMemory?: PageAiMemoryEntry[] };
    if (parsed.type === "lenota-canvas" && (parsed.version === 1 || parsed.version === 2 || parsed.version === 3) && Array.isArray(parsed.containers)) {
      const loadedContainers=parsed.containers.map((item, index) => ({
        id: item.id || newId(),
        x: Number(item.x) || 160,
        y: Number(item.y) || 160,
        width: Math.max(MIN_WIDTH,Number(item.width) || 520),
        minHeight: Math.max(MIN_HEIGHT, Number(item.minHeight) || MIN_HEIGHT),
        zIndex: Number(item.zIndex) || index + 1,
        content: item.content?.type === "doc" ? item.content : EMPTY_DOC,
        plainText: typeof item.plainText === "string" ? item.plainText : "",
      }));
      const loadedMemory=Array.isArray(parsed.aiMemory)?parsed.aiMemory.filter(entry=>
        entry&&typeof entry.prompt==="string"&&typeof entry.answer==="string"
      ).slice(-50).map(entry=>({
        prompt:entry.prompt.slice(0,20_000),answer:entry.answer.slice(0,40_000),createdAt:Number(entry.createdAt)||0,
        ...(typeof entry.containerId==="string"&&entry.containerId?{containerId:entry.containerId}:{}),
      })):[];
      return {
        type: "lenota-canvas",
        version: 3,
        viewport: { x: parsed.viewport?.x ?? 100, y: parsed.viewport?.y ?? 80, zoom: clamp(parsed.viewport?.zoom ?? 1, .35, 2.5) },
        containers: loadedContainers,
        ink: Array.isArray(parsed.ink) ? parsed.ink.filter(stroke => Array.isArray(stroke.points) && stroke.points.length > 0) : [],
        shapes: Array.isArray(parsed.shapes) ? parsed.shapes.filter(shape => ["rectangle","ellipse","line","arrow"].includes(shape.kind)).map((shape, index) => ({ ...shape, zIndex: Number(shape.zIndex) || index + 1 })) : [],
        background: {
          pattern: parsed.background?.pattern === "grid" || parsed.background?.pattern === "ruled" || parsed.background?.pattern === "plain" ? parsed.background.pattern : "grid",
          color: typeof parsed.background?.color === "string" ? parsed.background.color : "#151823",
          spacing: Math.max(1,Number(parsed.background?.spacing) || 24),
        },
        aiMemory: prunePageAiMemory(loadedContainers,loadedMemory),
      };
    }
  } catch { /* migrate legacy page */ }
  return {
    type: "lenota-canvas",
    version: 3,
    viewport: { x: 120, y: 100, zoom: 1 },
    containers: [{ id: newId(), x: 180, y: 180, width: 620, minHeight: 120, zIndex: 1, content: parseLegacyDocument(contentJson, plainText), plainText }],
    ink: [],
    shapes: [],
    background: { pattern: "grid", color: "#151823", spacing: 24 },
    aiMemory: [],
  };
}
function aggregateText(containers: NoteContainer[]) {
  return containers.slice().sort((a, b) => a.y - b.y || a.x - b.x).map(item => item.plainText.trim()).filter(Boolean).join("\n\n");
}
function extractDocumentSearchText(content: JSONContent): string {
  const chunks: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "text" && node.text) chunks.push(node.text);
    if (node.type === "image" && typeof node.attrs?.ocrText === "string" && node.attrs.ocrText.trim()) chunks.push(node.attrs.ocrText.trim());
    if (node.type === "mathExpression" && typeof node.attrs?.latex === "string" && node.attrs.latex.trim()) chunks.push(node.attrs.latex.trim());
    if (node.type === "mathGraph" && typeof node.attrs?.relationLatex === "string" && node.attrs.relationLatex.trim()) chunks.push(`[graph: ${node.attrs.relationLatex.trim()}]`);
    if ((node.type === "attachmentCard" || node.type === "audioCard") && typeof node.attrs?.fileName === "string") chunks.push(node.attrs.fileName);
    node.content?.forEach(walk);
  };
  walk(content);
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}
function isImageAttachment(attachment: Attachment) { return attachment.mimeType.startsWith("image/"); }
function isAudioAttachment(attachment: Attachment) { return attachment.mimeType.startsWith("audio/"); }
function attachmentNode(attachment: Attachment): JSONContent {
  if (isImageAttachment(attachment)) {
    return {
      type: "image",
      attrs: {
        src: convertFileSrc(attachment.storedPath),
        alt: attachment.fileName,
        title: attachment.fileName,
        attachmentId: attachment.id,
        storedPath: attachment.storedPath,
        ocrText: null,
      },
    };
  }
  if (isAudioAttachment(attachment)) {
    return {
      type: "audioCard",
      attrs: {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        storedPath: attachment.storedPath,
        src: convertFileSrc(attachment.storedPath),
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
    };
  }
  return {
    type: "attachmentCard",
    attrs: {
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      storedPath: attachment.storedPath,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    },
  };
}
function documentForAttachments(attachments: Attachment[]): JSONContent {
  return { type: "doc", content: [...attachments.map(attachmentNode), { type: "paragraph" }] };
}
function pointToSegmentDistance(point: InkPoint, a: InkPoint, b: InkPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
function strokeHit(stroke: InkStroke, point: InkPoint, radius: number) {
  for (let i = 1; i < stroke.points.length; i += 1) {
    if (pointToSegmentDistance(point, stroke.points[i - 1], stroke.points[i]) <= radius + stroke.width / 2) return true;
  }
  return false;
}
function strokePath(points: InkPoint[]) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} l .01 .01`;
  let result = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const mx = (previous.x + current.x) / 2;
    const my = (previous.y + current.y) / 2;
    result += ` Q ${previous.x} ${previous.y} ${mx} ${my}`;
  }
  const last = points[points.length - 1];
  result += ` L ${last.x} ${last.y}`;
  return result;
}

function eraseInkAt(strokes: InkStroke[], point: InkPoint, radius: number): InkStroke[] {
  const output: InkStroke[] = [];
  for (const stroke of strokes) {
    const keep = stroke.points.map(p => Math.hypot(p.x - point.x, p.y - point.y) > radius + stroke.width / 2);
    if (keep.every(Boolean)) { output.push(stroke); continue; }
    let run: InkPoint[] = [];
    const flush = () => {
      if (run.length >= 2) output.push({ ...stroke, id: newId(), points: run });
      run = [];
    };
    stroke.points.forEach((p, index) => { if (keep[index]) run.push(p); else flush(); });
    flush();
  }
  return output;
}
function shapeBounds(shape: CanvasShape) {
  return { left: Math.min(shape.x1, shape.x2), top: Math.min(shape.y1, shape.y2), right: Math.max(shape.x1, shape.x2), bottom: Math.max(shape.y1, shape.y2) };
}
function rotatedShapeBounds(shape: CanvasShape) {
  const points = shapeControlPoints(shape);
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}
function strokeBounds(stroke: InkStroke) {
  const xs = stroke.points.map(point => point.x);
  const ys = stroke.points.map(point => point.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}
function canvasDocumentBounds(containers: NoteContainer[], shapes: CanvasShape[], strokes: InkStroke[]): CanvasBounds | null {
  const bounds: CanvasBounds[] = containers.map(item => ({
    left: item.x,
    top: item.y,
    right: item.x + Math.max(MIN_WIDTH, item.width),
    bottom: item.y + Math.max(100, item.minHeight),
  }));
  bounds.push(...shapes.map(rotatedShapeBounds));
  bounds.push(...strokes.filter(stroke => stroke.points.length > 0).map(strokeBounds));
  if (!bounds.length) return null;
  return {
    left: Math.min(...bounds.map(item => item.left)),
    top: Math.min(...bounds.map(item => item.top)),
    right: Math.max(...bounds.map(item => item.right)),
    bottom: Math.max(...bounds.map(item => item.bottom)),
  };
}
function selectedInkBounds(strokes: InkStroke[], ids: Set<string>) {
  const selected = strokes.filter(stroke => ids.has(stroke.id));
  if (!selected.length) return null;
  const bounds = selected.map(strokeBounds);
  return {
    left: Math.min(...bounds.map(item => item.left)),
    top: Math.min(...bounds.map(item => item.top)),
    right: Math.max(...bounds.map(item => item.right)),
    bottom: Math.max(...bounds.map(item => item.bottom)),
  };
}

function inkGroupBounds(strokes: InkStroke[]) {
  if (!strokes.length) return null;
  const bounds = strokes.map(strokeBounds);
  return {
    left: Math.min(...bounds.map(item=>item.left)),
    top: Math.min(...bounds.map(item=>item.top)),
    right: Math.max(...bounds.map(item=>item.right)),
    bottom: Math.max(...bounds.map(item=>item.bottom)),
  };
}
function pathLength(points: InkPoint[]) {
  let length = 0;
  for (let index=1; index<points.length; index+=1) length += Math.hypot(points[index].x-points[index-1].x, points[index].y-points[index-1].y);
  return length;
}
function recognizedTextStyle(strokes: InkStroke[], text: string, theme: AppTheme) {
  const bounds = inkGroupBounds(strokes);
  const lines = groupInkIntoTextLines(strokes);
  const lineCount = Math.max(1, lines.length || text.split(/\n+/).filter(Boolean).length || 1);
  const height = bounds ? Math.max(10, bounds.bottom - bounds.top) : 28;
  const lineHeight = height / lineCount;
  const fontSize = clamp(Math.round(lineHeight * 0.88), 10, 180);
  return { color: convertedInkColor(strokes, theme), fontSize };
}
function recognizedTextDocument(text: string, strokes: InkStroke[], theme: AppTheme, fontFamily = ""): JSONContent {
  const visual = recognizedTextStyle(strokes, text, theme);
  const marks: JSONContent[] = [
    { type: "fontSizeStyle", attrs: { value: `${visual.fontSize}px` } },
    { type: "textColorStyle", attrs: { value: visual.color } },
  ];
  const normalizedFont = normalizeFontChoice(fontFamily);
  if (normalizedFont) marks.push({ type: "fontFamilyStyle", attrs: { value: normalizedFont } });
  const paragraphs = text.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => ({
    type: "paragraph",
    content: [{ type: "text", text: line, marks }],
  })) as JSONContent[];
  return { type: "doc", content: paragraphs.length ? paragraphs : [{ type: "paragraph" }] };
}
function pointLineDistance(point: InkPoint, a: InkPoint, b: InkPoint) {
  const dx=b.x-a.x, dy=b.y-a.y;
  const denominator=dx*dx+dy*dy;
  if (!denominator) return Math.hypot(point.x-a.x,point.y-a.y);
  const t=clamp(((point.x-a.x)*dx+(point.y-a.y)*dy)/denominator,0,1);
  return Math.hypot(point.x-(a.x+t*dx), point.y-(a.y+t*dy));
}
interface InkGeometryRecognition {
  shape: { kind: CanvasShape["kind"]; x1: number; y1: number; x2: number; y2: number };
  confidence: number;
}
function recognizeInkGeometry(strokes: InkStroke[]): InkGeometryRecognition | null {
  const usable = strokes.filter(stroke => stroke.tool === "pen" && stroke.points.length >= 2);
  if (!usable.length) return null;
  const bounds = inkGroupBounds(usable); if (!bounds) return null;
  const width = Math.max(1, bounds.right - bounds.left), height = Math.max(1, bounds.bottom - bounds.top), diag = Math.hypot(width, height);
  if (diag < 24) return null;

  const straightMetrics = (stroke: InkStroke) => {
    const points = stroke.points, a = points[0], b = points[points.length - 1];
    const direct = Math.max(1, Math.hypot(b.x-a.x,b.y-a.y));
    const length = Math.max(direct, pathLength(points));
    const meanError = points.reduce((sum, point) => sum + pointLineDistance(point, a, b), 0) / Math.max(1, points.length) / direct;
    const maxError = Math.max(...points.map(point => pointLineDistance(point, a, b))) / direct;
    return { a, b, direct, length, pathRatio: length/direct, meanError, maxError, angle: Math.atan2(b.y-a.y,b.x-a.x) };
  };
  const angleDifference = (a: number, b: number) => {
    let diff = Math.abs(a-b) % Math.PI;
    if (diff > Math.PI/2) diff = Math.PI-diff;
    return diff;
  };

  // Arrow recognition is deliberately strict: a genuinely straight shaft plus
  // one or two short diagonal head strokes touching the same endpoint. This is
  // much less likely to steal ordinary handwriting than a generic bounding-box
  // heuristic.
  if (usable.length >= 2 && usable.length <= 4) {
    const ordered = [...usable].sort((a,b) => pathLength(b.points)-pathLength(a.points));
    const shaft = ordered[0], sm = straightMetrics(shaft);
    if (sm.direct > 42 && sm.pathRatio < 1.09 && sm.maxError < .055) {
      for (const end of [sm.a, sm.b]) {
        const heads = ordered.slice(1).filter(stroke => {
          const hm = straightMetrics(stroke);
          if (hm.direct < 8 || hm.direct > sm.direct*.52 || hm.pathRatio > 1.18) return false;
          const touches = Math.min(Math.hypot(hm.a.x-end.x,hm.a.y-end.y),Math.hypot(hm.b.x-end.x,hm.b.y-end.y));
          const angle = angleDifference(sm.angle, hm.angle);
          return touches < Math.max(12,sm.direct*.13) && angle > Math.PI/10 && angle < Math.PI*.44;
        });
        if (heads.length >= 1) {
          const other = end === sm.b ? sm.a : sm.b;
          return { shape:{kind:"arrow",x1:other.x,y1:other.y,x2:end.x,y2:end.y}, confidence: heads.length >= 2 ? .98 : .93 };
        }
      }
    }
  }

  // A single short straight stroke is inherently ambiguous with 1/I/l or '/'.
  // Return a graded confidence here; Smart mode applies an additional long-line
  // requirement below rather than blindly turning characters into shapes.
  if (usable.length === 1) {
    const m = straightMetrics(usable[0]);
    if (m.direct > 28 && m.pathRatio < 1.075 && m.meanError < .027 && m.maxError < .07) {
      const lengthBoost = clamp((m.direct-45)/180,0,1);
      const quality = clamp(1-(m.meanError/.027),0,1);
      return { shape:{kind:"line",x1:m.a.x,y1:m.a.y,x2:m.b.x,y2:m.b.y}, confidence:.76+lengthBoost*.15+quality*.07 };
    }
  }

  if (width < 22 || height < 22) return null;
  const points = usable.flatMap(stroke => stroke.points);
  const minDimension = Math.max(1, Math.min(width,height));

  // Closed ellipses/circles: require endpoint closure AND broad angular
  // coverage. The old detector only measured radial error, which caused many
  // letters and arbitrary scribbles to be interpreted as rectangles first.
  if (usable.length === 1) {
    const stroke = usable[0], first = stroke.points[0], last = stroke.points[stroke.points.length-1];
    const closure = Math.hypot(first.x-last.x,first.y-last.y)/diag;
    const cx=(bounds.left+bounds.right)/2, cy=(bounds.top+bounds.bottom)/2, rx=width/2, ry=height/2;
    const radialError = points.reduce((sum,point)=>sum+Math.abs(Math.hypot((point.x-cx)/rx,(point.y-cy)/ry)-1),0)/Math.max(1,points.length);
    const ellipseCorners=[{x:bounds.left,y:bounds.top},{x:bounds.right,y:bounds.top},{x:bounds.right,y:bounds.bottom},{x:bounds.left,y:bounds.bottom}];
    const nearestCornerRatio=Math.min(...ellipseCorners.map(corner=>Math.min(...points.map(point=>Math.hypot(point.x-corner.x,point.y-corner.y)))/minDimension));
    const bins = new Set(points.map(point => {
      const angle = Math.atan2((point.y-cy)/ry,(point.x-cx)/rx);
      return Math.floor((((angle+Math.PI)/(Math.PI*2))*16))%16;
    }));
    const perimeter = Math.PI*(3*(rx+ry)-Math.sqrt(Math.max(0,(3*rx+ry)*(rx+3*ry))));
    const lengthRatio = pathLength(stroke.points)/Math.max(1,perimeter);
    if (closure < .30 && radialError < .235 && nearestCornerRatio > .08 && bins.size >= 10 && lengthRatio > .50 && lengthRatio < 1.90) {
      const confidence = clamp(.75 + (1-radialError/.235)*.13 + (bins.size/16)*.08 - closure*.08,.75,.99);
      return { shape:{kind:"ellipse",x1:bounds.left,y1:bounds.top,x2:bounds.right,y2:bounds.bottom}, confidence };
    }
  }

  // Rectangle, single-stroke form: a rectangle must actually visit all four
  // corners and spend most of its path near the four edges. Merely touching all
  // sides of its own bounding box is NOT evidence of a rectangle (every glyph
  // does that), which was the source of the old false positives.
  if (usable.length === 1) {
    const stroke=usable[0], first=stroke.points[0], last=stroke.points[stroke.points.length-1];
    const closure=Math.hypot(first.x-last.x,first.y-last.y)/diag;
    const corners=[
      {x:bounds.left,y:bounds.top},{x:bounds.right,y:bounds.top},
      {x:bounds.right,y:bounds.bottom},{x:bounds.left,y:bounds.bottom},
    ];
    const cornerDistances=corners.map(corner=>Math.min(...points.map(point=>Math.hypot(point.x-corner.x,point.y-corner.y)))/minDimension);
    const edgeDistance=(point:InkPoint)=>Math.min(Math.abs(point.x-bounds.left),Math.abs(point.x-bounds.right),Math.abs(point.y-bounds.top),Math.abs(point.y-bounds.bottom));
    const edgeError=points.reduce((sum,point)=>sum+edgeDistance(point),0)/Math.max(1,points.length)/minDimension;
    const sideTolerance=Math.max(4,minDimension*.10);
    const sideCoverage=[
      points.filter(point=>Math.abs(point.x-bounds.left)<sideTolerance).length/points.length,
      points.filter(point=>Math.abs(point.x-bounds.right)<sideTolerance).length/points.length,
      points.filter(point=>Math.abs(point.y-bounds.top)<sideTolerance).length/points.length,
      points.filter(point=>Math.abs(point.y-bounds.bottom)<sideTolerance).length/points.length,
    ];
    const worstCorner=Math.max(...cornerDistances), weakestSide=Math.min(...sideCoverage);
    if (closure < .28 && worstCorner < .30 && edgeError < .11 && weakestSide > .055) {
      const confidence=clamp(.79+(1-worstCorner/.30)*.08+(1-edgeError/.11)*.07+(Math.min(1,weakestSide/.14))*.03,.79,.99);
      return { shape:{kind:"rectangle",x1:bounds.left,y1:bounds.top,x2:bounds.right,y2:bounds.bottom}, confidence };
    }
  }

  // Four-stroke box. This supports the common "draw each side separately"
  // gesture while remaining much stricter than the former perimeter heuristic.
  if (usable.length === 4) {
    const metrics=usable.map(straightMetrics);
    if (metrics.every(m=>m.pathRatio<1.16&&m.meanError<.055)) {
      const horizontal=metrics.filter(m=>Math.abs(Math.cos(m.angle))>.88);
      const vertical=metrics.filter(m=>Math.abs(Math.sin(m.angle))>.88);
      if(horizontal.length===2&&vertical.length===2){
        const horizontalCenters=horizontal.map(m=>(m.a.y+m.b.y)/2).sort((a,b)=>a-b);
        const verticalCenters=vertical.map(m=>(m.a.x+m.b.x)/2).sort((a,b)=>a-b);
        const edgePlacement=Math.max(
          Math.abs(horizontalCenters[0]-bounds.top),Math.abs(horizontalCenters[1]-bounds.bottom),
          Math.abs(verticalCenters[0]-bounds.left),Math.abs(verticalCenters[1]-bounds.right),
        )/minDimension;
        const endpoints=metrics.flatMap(m=>[m.a,m.b]);
        const corners=[{x:bounds.left,y:bounds.top},{x:bounds.right,y:bounds.top},{x:bounds.right,y:bounds.bottom},{x:bounds.left,y:bounds.bottom}];
        const cornerError=Math.max(...corners.map(corner=>Math.min(...endpoints.map(point=>Math.hypot(point.x-corner.x,point.y-corner.y)))/minDimension));
        if(edgePlacement<.16&&cornerError<.24){
          return {shape:{kind:"rectangle",x1:bounds.left,y1:bounds.top,x2:bounds.right,y2:bounds.bottom},confidence:clamp(.90+(1-edgePlacement/.16)*.04+(1-cornerError/.24)*.04,.90,.98)};
        }
      }
    }
  }
  return null;
}
function groupInkIntoTextLines(strokes: InkStroke[]): InkStroke[][] {
  const pen=strokes.filter(stroke=>stroke.tool==="pen"&&stroke.points.length>0);
  if(pen.length<2)return pen.length?[pen]:[];
  const ordered=[...pen].sort((a,b)=>{const ab=strokeBounds(a),bb=strokeBounds(b);return ((ab.top+ab.bottom)/2)-((bb.top+bb.bottom)/2)||ab.left-bb.left;});
  const lines:{strokes:InkStroke[];top:number;bottom:number;center:number}[]=[];
  for(const stroke of ordered){
    const b=strokeBounds(stroke),center=(b.top+b.bottom)/2,height=Math.max(8,b.bottom-b.top);
    let best:number|null=null,bestDistance=Infinity;
    for(let index=0;index<lines.length;index+=1){
      const line=lines[index],lineHeight=Math.max(8,line.bottom-line.top);
      const verticalOverlap=Math.max(0,Math.min(line.bottom,b.bottom)-Math.max(line.top,b.top));
      const overlapRatio=verticalOverlap/Math.max(1,Math.min(lineHeight,height));
      const distance=Math.abs(center-line.center);
      if((overlapRatio>.18||distance<Math.max(lineHeight,height)*.72)&&distance<bestDistance){best=index;bestDistance=distance;}
    }
    if(best===null)lines.push({strokes:[stroke],top:b.top,bottom:b.bottom,center});
    else {const line=lines[best];line.strokes.push(stroke);line.top=Math.min(line.top,b.top);line.bottom=Math.max(line.bottom,b.bottom);line.center=(line.top+line.bottom)/2;}
  }
  return lines.sort((a,b)=>a.top-b.top).map(line=>line.strokes.sort((a,b)=>strokeBounds(a).left-strokeBounds(b).left));
}

type InkRasterPurpose = "text" | "math";

function detectFractionSplit(strokes: InkStroke[]): { numerator: InkStroke[]; denominator: InkStroke[] } | null {
  const pen=strokes.filter(stroke=>stroke.tool==="pen"&&stroke.points.length>=2);
  const overall=inkGroupBounds(pen);
  if(!overall||pen.length<3)return null;
  const overallWidth=Math.max(1,overall.right-overall.left);
  let best:{score:number;numerator:InkStroke[];denominator:InkStroke[]}|null=null;
  for(const bar of pen){
    const b=strokeBounds(bar),width=b.right-b.left,height=b.bottom-b.top;
    if(width<Math.max(32,overallWidth*.22))continue;
    if(height>Math.max(7,width*.10))continue;
    const length=pathLength(bar.points);
    if(length/Math.max(1,width)>1.38)continue;
    const y=(b.top+b.bottom)/2;
    const left=b.left-width*.06,right=b.right+width*.06;
    const numerator=pen.filter(stroke=>{
      if(stroke.id===bar.id)return false;
      const sb=strokeBounds(stroke),cy=(sb.top+sb.bottom)/2;
      return cy<y-2 && sb.right>left && sb.left<right;
    });
    const denominator=pen.filter(stroke=>{
      if(stroke.id===bar.id)return false;
      const sb=strokeBounds(stroke),cy=(sb.top+sb.bottom)/2;
      return cy>y+2 && sb.right>left && sb.left<right;
    });
    if(!numerator.length||!denominator.length)continue;
    const nb=inkGroupBounds(numerator),db=inkGroupBounds(denominator);
    if(!nb||!db)continue;
    const nOverlap=Math.max(0,Math.min(nb.right,b.right)-Math.max(nb.left,b.left))/Math.max(1,Math.min(nb.right-nb.left,width));
    const dOverlap=Math.max(0,Math.min(db.right,b.right)-Math.max(db.left,b.left))/Math.max(1,Math.min(db.right-db.left,width));
    if(nOverlap<.2||dOverlap<.2)continue;
    const verticalGap=Math.min(Math.abs(y-nb.bottom),Math.abs(db.top-y));
    const score=(width/overallWidth)*2+nOverlap+dOverlap-Math.min(.5,verticalGap/Math.max(30,overallWidth));
    if(!best||score>best.score)best={score,numerator,denominator};
  }
  return best?{numerator:best.numerator,denominator:best.denominator}:null;
}

function detectPlusSplit(strokes: InkStroke[]): { left: InkStroke[]; right: InkStroke[]; symbolOnly: boolean } | null {
  const pen = strokes.filter(stroke => stroke.tool === "pen" && stroke.points.length >= 2);
  if (pen.length < 2) return null;
  const overall = inkGroupBounds(pen);
  if (!overall) return null;
  const overallWidth = Math.max(1, overall.right - overall.left);
  const straight = (stroke: InkStroke) => {
    const a = stroke.points[0], b = stroke.points[stroke.points.length - 1];
    const direct = Math.max(1, Math.hypot(b.x-a.x,b.y-a.y));
    return pathLength(stroke.points) / direct < 1.28;
  };
  for (let i=0;i<pen.length;i+=1) for (let j=i+1;j<pen.length;j+=1) {
    const a=pen[i],b=pen[j],ab=strokeBounds(a),bb=strokeBounds(b);
    const aW=ab.right-ab.left,aH=ab.bottom-ab.top,bW=bb.right-bb.left,bH=bb.bottom-bb.top;
    if (!straight(a) || !straight(b)) continue;
    const horizontal = aW > aH*2.6 ? {stroke:a,bounds:ab,w:aW,h:aH} : bW > bH*2.6 ? {stroke:b,bounds:bb,w:bW,h:bH} : null;
    const vertical = aH > aW*2.6 ? {stroke:a,bounds:ab,w:aW,h:aH} : bH > bW*2.6 ? {stroke:b,bounds:bb,w:bW,h:bH} : null;
    if (!horizontal || !vertical || horizontal.stroke.id === vertical.stroke.id) continue;
    const hx=(horizontal.bounds.left+horizontal.bounds.right)/2,hy=(horizontal.bounds.top+horizontal.bounds.bottom)/2;
    const vx=(vertical.bounds.left+vertical.bounds.right)/2,vy=(vertical.bounds.top+vertical.bounds.bottom)/2;
    const tolerance=Math.max(5,Math.min(horizontal.w,vertical.h)*.24);
    const crossing = vx >= horizontal.bounds.left-tolerance && vx <= horizontal.bounds.right+tolerance && hy >= vertical.bounds.top-tolerance && hy <= vertical.bounds.bottom+tolerance;
    if (!crossing || Math.abs(hx-vx)>horizontal.w*.38 || Math.abs(hy-vy)>vertical.h*.38) continue;
    const plusIds=new Set([horizontal.stroke.id,vertical.stroke.id]);
    const cx=(hx+vx)/2;
    const remaining=pen.filter(stroke=>!plusIds.has(stroke.id));
    if (!remaining.length) return {left:[],right:[],symbolOnly:true};
    if (Math.max(horizontal.w,vertical.h) > overallWidth*.34) continue;
    const margin=Math.max(3,horizontal.w*.12);
    const left=remaining.filter(stroke=>{const sb=strokeBounds(stroke);return (sb.left+sb.right)/2 < cx-margin;});
    const right=remaining.filter(stroke=>{const sb=strokeBounds(stroke);return (sb.left+sb.right)/2 > cx+margin;});
    if (left.length && right.length && left.length+right.length===remaining.length) return {left,right,symbolOnly:false};
  }
  return null;
}

function detectScriptSplit(strokes: InkStroke[]): { base: InkStroke[]; script: InkStroke[]; position:"sup"|"sub" } | null {
  const pen=strokes.filter(stroke=>stroke.tool==="pen"&&stroke.points.length>=2);
  const overall=inkGroupBounds(pen);
  if(!overall||pen.length<2)return null;
  const width=Math.max(1,overall.right-overall.left),height=Math.max(1,overall.bottom-overall.top);
  if(width<30||height<18)return null;
  const classify=(position:"sup"|"sub")=>{
    const script=pen.filter(stroke=>{
      const b=strokeBounds(stroke),cx=(b.left+b.right)/2,cy=(b.top+b.bottom)/2;
      const rightEnough=cx>overall.left+width*.48;
      const vertical=position==="sup"?cy<overall.top+height*.38:cy>overall.top+height*.62;
      return rightEnough&&vertical;
    });
    if(!script.length||script.length===pen.length)return null;
    const ids=new Set(script.map(stroke=>stroke.id));
    const base=pen.filter(stroke=>!ids.has(stroke.id));
    const bb=inkGroupBounds(base),sb=inkGroupBounds(script);
    if(!bb||!sb)return null;
    const baseWidth=bb.right-bb.left,baseHeight=Math.max(1,bb.bottom-bb.top),scriptHeight=Math.max(1,sb.bottom-sb.top);
    if(sb.left<bb.left+baseWidth*.30||scriptHeight>baseHeight*.85)return null;
    if(position==="sup"&&sb.bottom>bb.top+baseHeight*.72)return null;
    if(position==="sub"&&sb.top<bb.top+baseHeight*.28)return null;
    return {base,script,position};
  };
  return classify("sup")??classify("sub");
}

function detectEqualsSplit(strokes: InkStroke[]): { left: InkStroke[]; right: InkStroke[]; symbolOnly: boolean } | null {
  const pen=strokes.filter(stroke=>stroke.tool==="pen"&&stroke.points.length>=2);
  if(pen.length<2)return null;
  const overall=inkGroupBounds(pen);
  if(!overall)return null;
  const overallWidth=Math.max(1,overall.right-overall.left);
  const candidates=pen.map(stroke=>{
    const b=strokeBounds(stroke),width=b.right-b.left,height=b.bottom-b.top;
    const a=stroke.points[0],z=stroke.points[stroke.points.length-1];
    const direct=Math.max(1,Math.hypot(z.x-a.x,z.y-a.y));
    const straight=pathLength(stroke.points)/direct<1.22;
    return {stroke,b,width,height,straight,cy:(b.top+b.bottom)/2,cx:(b.left+b.right)/2};
  }).filter(item=>item.straight&&item.width>18&&item.width>item.height*3.2);
  for(let i=0;i<candidates.length;i+=1)for(let j=i+1;j<candidates.length;j+=1){
    const a=candidates[i],b=candidates[j];
    const widthRatio=Math.min(a.width,b.width)/Math.max(a.width,b.width);
    if(widthRatio<.58)continue;
    const overlap=Math.max(0,Math.min(a.b.right,b.b.right)-Math.max(a.b.left,b.b.left))/Math.max(1,Math.min(a.width,b.width));
    const gap=Math.abs(a.cy-b.cy);
    const avgWidth=(a.width+b.width)/2;
    if(overlap<=.58||gap<=3||gap>=avgWidth*.42)continue;
    const equalsIds=new Set([a.stroke.id,b.stroke.id]);
    const remaining=pen.filter(stroke=>!equalsIds.has(stroke.id));
    if(!remaining.length)return {left:[],right:[],symbolOnly:true};
    if(Math.max(a.width,b.width)>overallWidth*.42)continue;
    const cx=(a.cx+b.cx)/2,margin=Math.max(3,avgWidth*.10);
    const left=remaining.filter(stroke=>{const sb=strokeBounds(stroke);return (sb.left+sb.right)/2<cx-margin;});
    const right=remaining.filter(stroke=>{const sb=strokeBounds(stroke);return (sb.left+sb.right)/2>cx+margin;});
    if(left.length+right.length===remaining.length&&(left.length||right.length))return {left,right,symbolOnly:false};
  }
  return null;
}

function detectEqualsInkStructure(strokes: InkStroke[]): boolean {
  return detectEqualsSplit(strokes)!==null;
}

interface LargeOperatorInkLayout {
  operator: InkStroke[];
  upper: InkStroke[];
  lower: InkStroke[];
  body: InkStroke[];
}

/**
 * Find a visually dominant operator near the left side of an expression
 * without deciding which operator it is. The layout is sent as a small vector
 * hint alongside the full raster so Gemini preserves \sum/\prod/\int limits.
 */
function detectLargeOperatorInkLayout(strokes: InkStroke[]): LargeOperatorInkLayout | null {
  const pen=strokes.filter(stroke=>stroke.tool==="pen"&&stroke.points.length>=2);
  const overall=inkGroupBounds(pen);
  if(!overall||pen.length<2)return null;
  const width=Math.max(1,overall.right-overall.left),height=Math.max(1,overall.bottom-overall.top);
  if(width<34||height<34)return null;

  const described=pen.map(stroke=>{
    const b=strokeBounds(stroke);
    return {
      stroke,b,
      width:Math.max(1,b.right-b.left),
      height:Math.max(1,b.bottom-b.top),
      cx:(b.left+b.right)/2,
      cy:(b.top+b.bottom)/2,
    };
  });
  const medianHeight=[...described].map(item=>item.height).sort((a,b)=>a-b)[Math.floor(described.length/2)]||height;

  const sigmaIndices=findMultiStrokeSigmaCluster(pen);
  let operator:InkStroke[];
  if(sigmaIndices){
    const ids=new Set(sigmaIndices);
    operator=pen.filter((_stroke,index)=>ids.has(index));
  }else{
    // A large operator is normally left-of-center, vertically dominant, and
    // its center sits in the middle band. This is the fallback for integrals,
    // products, and one-stroke sigma styles.
    const centralCandidates=described.filter(item=>
      item.cx<=overall.left+width*.48 &&
      item.cy>=overall.top+height*.16 &&
      item.cy<=overall.bottom-height*.16 &&
      item.height>=Math.max(24,height*.34,medianHeight*1.12)
    );
    if(!centralCandidates.length)return null;
    const seed=centralCandidates.sort((a,b)=>(a.cx-overall.left)-(b.cx-overall.left)||b.height-a.height)[0];
    const clusterRight=seed.b.right+Math.max(12,seed.width*.62);
    const clusterLeft=seed.b.left-Math.max(8,seed.width*.28);
    operator=described.filter(item=>
      item.cx>=clusterLeft&&item.cx<=clusterRight&&
      item.cy>=overall.top+height*.12&&item.cy<=overall.bottom-height*.12&&
      (item.height>=seed.height*.34||item.stroke.id===seed.stroke.id)
    ).map(item=>item.stroke);
  }
  const opBounds=inkGroupBounds(operator);
  if(!opBounds)return null;
  const opW=Math.max(1,opBounds.right-opBounds.left),opH=Math.max(1,opBounds.bottom-opBounds.top);
  if(opH<height*.34||opBounds.left>overall.left+width*.34)return null;

  const opIds=new Set(operator.map(stroke=>stroke.id));
  const others=pen.filter(stroke=>!opIds.has(stroke.id));
  if(!others.length)return {operator,upper:[],lower:[],body:[]};

  const upper:InkStroke[]=[];
  const lower:InkStroke[]=[];
  const body:InkStroke[]=[];
  const nearLimitLeft=opBounds.left-opW*.35;
  const nearLimitRight=opBounds.right+Math.max(opW*1.25,opH*.72);
  for(const stroke of others){
    const b=strokeBounds(stroke),cx=(b.left+b.right)/2,cy=(b.top+b.bottom)/2;
    const strokeH=Math.max(1,b.bottom-b.top);
    const nearOperator=cx>=nearLimitLeft&&cx<=nearLimitRight;
    const smallEnough=strokeH<=opH*.72;
    if(nearOperator&&smallEnough&&cy<opBounds.top+opH*.20){upper.push(stroke);continue;}
    if(nearOperator&&smallEnough&&cy>opBounds.bottom-opH*.20){lower.push(stroke);continue;}
    body.push(stroke);
  }

  // Body glyphs should normally continue to the right. Preserve anything that
  // overlaps the operator slightly because handwritten radicals/parentheses can
  // start very close to it, but reject a layout consisting only of unrelated
  // strokes far to the left.
  const bodyUseful=body.filter(stroke=>{
    const b=strokeBounds(stroke);
    return (b.left+b.right)/2>opBounds.left+opW*.18;
  });
  return {operator,upper,lower,body:bodyUseful};
}

function mathNeedsContinuation(latex:string): boolean {
  const compact=latex.replace(/\s+/g,"");
  const match=compact.match(/^(\\(?:sum|prod|int|oint|iint|iiint))/);
  if(!match)return false;
  const rest=compact.slice(match[1].length);
  const hasUpper=/\^\{/.test(rest);
  const hasLower=/_\{/.test(rest);
  const tail=rest.replace(/^(?:[_^]\{[^{}]*\})+/,"");
  const hasBody=tail.length>0;
  // Large operators are usually followed by limits and/or a body. Only these
  // incomplete cases get an extra grace period, so ordinary live math remains
  // fast.
  if(!hasBody)return true;
  const bodySignal=tail.replace(/\\[A-Za-z]+/g,"x").replace(/[{}_^]/g,"");
  if(match[1]==="\\sum"||match[1]==="\\prod"){
    if(!hasUpper||!hasLower)return true;
    if(bodySignal.length<=2)return true;
  }
  if(/\\(?:int|oint|iint|iiint)/.test(match[1])&&bodySignal.length<=2&&!/d[A-Za-z]/.test(tail))return true;
  return false;
}

function sigmaLikeStrokeScore(stroke:InkStroke):number {
  if(stroke.tool!=="pen"||stroke.points.length<8)return 0;
  const b=strokeBounds(stroke),width=Math.max(1,b.right-b.left),height=Math.max(1,b.bottom-b.top);
  if(width<28||height<32||width/height<.48||width/height>1.75)return 0;
  const points=stroke.points;
  const start=points[0],end=points[points.length-1];
  const endpointDistance=Math.hypot(end.x-start.x,end.y-start.y);
  const diagonal=Math.hypot(width,height);
  const bend=pathLength(points)/Math.max(1,endpointDistance);
  if(bend<1.28||endpointDistance<diagonal*.28)return 0;
  const top=points.filter(point=>point.y<=b.top+height*.24);
  const bottom=points.filter(point=>point.y>=b.bottom-height*.24);
  const middle=points.filter(point=>point.y>=b.top+height*.34&&point.y<=b.bottom-height*.34);
  if(top.length<2||bottom.length<2||!middle.length)return 0;
  const spread=(items:InkPoint[])=>Math.max(...items.map(point=>point.x))-Math.min(...items.map(point=>point.x));
  const topSpread=spread(top)/width,bottomSpread=spread(bottom)/width;
  const middleSpread=spread(middle)/width;
  let score=.30;
  score+=clamp((topSpread-.38)/.45,0,1)*.22;
  score+=clamp((bottomSpread-.38)/.45,0,1)*.22;
  score+=clamp((bend-1.28)/1.4,0,1)*.14;
  score+=middleSpread>.18?.08:0;
  score+=width>=42&&height>=46?.08:0;
  return clamp(score,0,1);
}

interface LatexValidation {
  valid: boolean;
  error: string;
}
interface StabilizedMathRecognition extends LatexValidation {
  latex: string;
  repaired: boolean;
  suspicious: boolean;
  issues: string[];
}

class CloudLatexError extends Error {
  override name="CloudLatexError";
}


function cloudInkVectorHint(strokes:InkStroke[]):string {
  const pen=strokes.filter(stroke=>stroke.tool==="pen");
  const hints:string[]=[];
  const sigma=findMultiStrokeSigmaCluster(pen)!==null||pen.some(stroke=>sigmaLikeStrokeScore(stroke)>=.72);
  if(sigma)hints.push("The leading large operator is a summation sign (\\sum), not a fraction or integral.");
  const large=detectLargeOperatorInkLayout(pen);
  if(large&&findEnclosingParentheses(large.body))hints.push("The expression to the right of the large operator is enclosed in parentheses.");
  if(detectEqualsInkStructure(pen))hints.push("The expression contains an equals sign.");
  if(detectPlusSplit(pen))hints.push("The expression contains a plus sign.");
  return hints.join(" ");
}

function validateLatexSource(latex:string): LatexValidation {
  const source=latex.trim();
  if(!source)return {valid:false,error:"The expression is empty."};
  try{
    katex.renderToString(source,{throwOnError:true,displayMode:true,output:"htmlAndMathml",strict:"ignore",trust:false});
    return {valid:true,error:""};
  }catch(error){
    return {valid:false,error:error instanceof Error?error.message:String(error)};
  }
}

function makeGeneratedLatexRenderSafe(nodes:JSONContent[]):{nodes:JSONContent[];degraded:number} {
  let degraded=0;
  const visit=(node:JSONContent):JSONContent=>{
    if(node.type==="mathExpression"){
      const raw=String(node.attrs?.latex??"").trim();
      const repaired=repairGeneratedLatexSource(raw).latex;
      const validation=validateLatexSource(repaired);
      if(validation.valid)return {...node,attrs:{...(node.attrs??{}),latex:repaired}};
      // One malformed formula must never discard an otherwise useful Gemini
      // answer. Keep that fragment as readable source text while preserving
      // every other valid math node as editable KaTeX.
      degraded+=1;
      return {type:"text",text:raw||"[unrenderable math]"};
    }
    return node.content?{...node,content:node.content.map(visit)}:node;
  };
  return {nodes:nodes.map(visit),degraded};
}

function normalizeRecognizedLatexSource(raw:string): {latex:string;repaired:boolean;issues:string[]} {
  let latex=raw.trim();
  const original=latex;
  const issues:string[]=[];
  // Vision recognition sometimes returns display delimiters even though KaTeX is
  // already rendering in display mode.
  latex=latex.replace(/^\$\$([\s\S]*)\$\$$/,'$1').replace(/^\\\[([\s\S]*)\\\]$/,'$1').replace(/^\\\(([\s\S]*)\\\)$/,'$1').trim();
  latex=latex.replace(/[−–—]/g,'-').replace(/×/g,String.raw`\times `).replace(/÷/g,String.raw`\div `);

  // Styling wrappers are visual OCR noise for handwritten symbols and can make
  // repairs much harder. Only unwrap simple single-token wrappers so authored
  // equations using meaningful text/style groups are not flattened.
  let previous="";
  while(previous!==latex){
    previous=latex;
    latex=latex.replace(/\\(?:mathsf|mathrm|mathbf|mathit|textit|textbf|operatorname)\{([A-Za-z0-9])\}/g,'$1');
  }

  // Empty structures are almost always hallucinated by formula OCR.
  const beforeEmpty=latex;
  latex=latex.replace(/\\sqrt\{\}/g,'').replace(/\\(?:text|mathrm|mathsf|mathbf|mathit)\{\}/g,'').replace(/[_^]\{\}/g,'');
  if(latex!==beforeEmpty)issues.push("removed empty OCR constructs");

  // OCR sometimes nests another script inside an integral limit after
  // hallucinating an empty radical, e.g. _{_{\diagup}}. Flatten that wrapper
  // first, then discard a limit that consists only of a diagonal artifact.
  const beforeNested=latex;
  latex=latex.replace(/([_^])\{[_^]\{([^{}]*)\}\}/g,(_m,marker,value)=>`${marker}{${value}}`);
  if(latex!==beforeNested)issues.push("flattened nested OCR script");
  const beforeDiagonal=latex;
  latex=latex.replace(/[_^]\{\\(?:diagup|diagdown)\}/g,'').replace(/[_^]\{\s*[\\/]\s*\}/g,'').replace(/[_^]\{\}/g,'');
  if(latex!==beforeDiagonal)issues.push("removed isolated diagonal OCR artifact");

  // Repair duplicate limits with a balanced-brace parser. Regex-only repair
  // missed the reported nested suffix and left KaTeX's Double subscript error.
  const scriptRepair=repairDuplicateLargeOperatorScripts(latex);
  latex=scriptRepair.latex;
  if(scriptRepair.repaired)issues.push("repaired duplicated large-operator limits");

  const groupRepair=repairUnclosedLatexGroups(latex);
  latex=groupRepair.latex;
  if(groupRepair.repaired)issues.push("closed unfinished OCR group");

  // Normalize common differential tails without changing ordinary variables.
  latex=latex.replace(/\\mathrm\{d\}\s*([A-Za-z])/g,String.raw`\,d$1`);
  latex=latex.replace(/\\mathop\{d\}\s*([A-Za-z])/g,String.raw`\,d$1`);
  latex=latex.replace(/\s+/g,' ').trim();
  return {latex,repaired:latex!==original,issues};
}

function stabilizeRecognizedLatex(raw:string): StabilizedMathRecognition {
  const normalized=normalizeRecognizedLatexSource(raw);
  const issues=[...normalized.issues];
  // These slash commands are legal in some TeX environments but are commonly
  // hallucinated from diagonal pen strokes in handwritten limits. Do not
  // silently auto-commit them; manual review can still keep them if intended.
  const suspiciousTokens=/\\(?:diagup|diagdown|backslash)\b/.test(normalized.latex);
  if(suspiciousTokens)issues.push("ambiguous diagonal symbol");
  const repeatedScripts=/(?:_\{[^{}]*\}|\^\{[^{}]*\}){3,}/.test(normalized.latex);
  if(repeatedScripts)issues.push("too many adjacent scripts");
  const validation=validateLatexSource(normalized.latex);
  return {
    latex:normalized.latex,
    repaired:normalized.repaired,
    suspicious:suspiciousTokens||repeatedScripts,
    issues,
    valid:validation.valid,
    error:validation.error,
  };
}

async function rasterizeInkGroup(strokes: InkStroke[], purpose:InkRasterPurpose="text"): Promise<number[]> {
  const bounds=inkGroupBounds(strokes);
  if(!bounds)throw new Error("No ink selected.");
  const rawWidth=Math.max(1,bounds.right-bounds.left),rawHeight=Math.max(1,bounds.bottom-bounds.top);
  const isMath=purpose!=="text";
  const padding=isMath?Math.max(30,Math.min(72,Math.max(rawWidth,rawHeight)*.09)):28;
  const width=Math.max(48,rawWidth+padding*2),height=Math.max(48,rawHeight+padding*2);
  // A clean, consistently weighted raster helps Gemini read thin mouse and pen
  // strokes without changing the original ink stored by the page.
  let scale=clamp((purpose==="math"?1500:1200)/Math.max(width,height),1,4);
  if(purpose==="math"&&height*scale<180)scale=Math.min(5,180/height);
  const canvas=document.createElement("canvas");
  canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);
  const ctx=canvas.getContext("2d");if(!ctx)throw new Error("Unable to prepare ink recognition canvas.");
  ctx.fillStyle="#ffffff";ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.lineCap="round";ctx.lineJoin="round";
  for(const stroke of strokes){
    if(stroke.tool==="highlighter")continue;
    ctx.strokeStyle="#000000";
    ctx.lineWidth=isMath?clamp(2.4*scale,3.2,9):Math.max(2,stroke.width*scale);
    ctx.beginPath();
    stroke.points.forEach((point,index)=>{const x=(point.x-bounds.left+padding)*scale,y=(point.y-bounds.top+padding)*scale;if(index===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();
  }
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("Unable to rasterize ink.")),"image/png"));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}
function mathDocument(latex:string, display=true, drawnSize?:{width:number;height:number}, color?:string): JSONContent {
  const fit = drawnSize && drawnSize.width > 0 && drawnSize.height > 0;
  return {type:"doc",content:[{type:"paragraph",content:[{type:"mathExpression",attrs:{
    latex,
    display,
    fontSize: fit ? 32 : 24,
    targetWidth: fit ? clamp(drawnSize.width, 24, 1800) : null,
    targetHeight: fit ? clamp(drawnSize.height, 16, 900) : null,
    autoFit: Boolean(fit),
    color: color || null,
  }}]}]};
}

function firstMathLatex(content: JSONContent): string | null {
  if(content.type==="mathExpression"&&typeof content.attrs?.latex==="string")return String(content.attrs.latex);
  for(const child of content.content??[]){const found=firstMathLatex(child);if(found!==null)return found;}
  return null;
}
function replaceFirstMathLatex(content: JSONContent, latex:string): JSONContent {
  let replaced=false;
  const visit=(node:JSONContent):JSONContent=>{
    if(!replaced&&node.type==="mathExpression"){
      replaced=true;
      return {...node,attrs:{...(node.attrs??{}),latex,autoFit:true,solved:false}};
    }
    if(!node.content?.length)return node;
    return {...node,content:node.content.map(visit)};
  };
  return visit(content);
}


function containerMathContentBounds(item:NoteContainer):MixedMathBounds {
  let fontSize=16,targetWidth=0,targetHeight=0;
  const visit=(node:JSONContent)=>{
    if(node.type==="mathExpression"){
      fontSize=Math.max(fontSize,Number(node.attrs?.fontSize??24));
      targetWidth=Math.max(targetWidth,Number(node.attrs?.targetWidth??0));
      targetHeight=Math.max(targetHeight,Number(node.attrs?.targetHeight??0));
    }
    for(const mark of node.marks??[]){
      if(mark.type!=="fontSizeStyle")continue;
      const parsed=Number.parseFloat(String(mark.attrs?.value??""));
      if(Number.isFinite(parsed))fontSize=Math.max(fontSize,parsed);
    }
    node.content?.forEach(visit);
  };
  visit(item.content);
  fontSize=Math.max(1,fontSize);
  const lines=item.plainText.split(/\n+/).map(line=>line.trim()).filter(Boolean);
  const longest=Math.max(1,...lines.map(line=>Array.from(line).length));
  const measuredWidth=targetWidth||Math.max(fontSize*.7,Math.min(item.width-24,longest*fontSize*.62+8));
  const measuredHeight=targetHeight||Math.max(fontSize*1.3,Math.max(1,lines.length)*fontSize*1.35);
  const left=item.x+16,top=item.y+14;
  return {left,top,right:left+Math.max(12,measuredWidth),bottom:top+Math.max(14,measuredHeight)};
}

function pointInPolygon(point: InkPoint, polygon: InkPoint[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
function rotatePoint(x:number,y:number,cx:number,cy:number,degrees:number) {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}
function shapeControlPoints(shape: CanvasShape) {
  if (shape.kind === "line" || shape.kind === "arrow") {
    const mx = (shape.x1 + shape.x2) / 2, my = (shape.y1 + shape.y2) / 2;
    return [
      { x: shape.x1, y: shape.y1, pressure: .5 },
      { x: mx, y: my, pressure: .5 },
      { x: shape.x2, y: shape.y2, pressure: .5 },
    ];
  }
  const b = shapeBounds(shape), cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2, rotation = shape.rotation ?? 0;
  const raw = [
    { x: b.left, y: b.top }, { x: cx, y: b.top }, { x: b.right, y: b.top },
    { x: b.right, y: cy }, { x: b.right, y: b.bottom }, { x: cx, y: b.bottom },
    { x: b.left, y: b.bottom }, { x: b.left, y: cy }, { x: cx, y: cy },
  ];
  return raw.map(point => ({ ...rotatePoint(point.x, point.y, cx, cy, rotation), pressure: .5 }));
}
function shapeIntersectsPolygon(shape: CanvasShape, polygon: InkPoint[]) {
  if (polygon.length < 3) return false;
  return shapeControlPoints(shape).some(point => pointInPolygon(point, polygon));
}
function backgroundStyle(
  background: CanvasBackground,
  theme: AppTheme = "dark",
  viewport: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: 1 },
): CSSProperties {
  const backgroundColor = themeAwareCanvasColor(background.color, theme);
  const line = theme === "light" ? "rgba(65,55,45,.085)" : "rgba(255,255,255,.055)";
  const safeViewport = normalizeCanvasViewport(viewport);
  const spacing = Math.max(1, background.spacing) * safeViewport.zoom;
  let backgroundImage = "none";
  let backgroundPosition = "0 0";
  let backgroundSize = "auto";
  if (background.pattern === "grid") {
    backgroundImage = `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`;
    backgroundPosition = `${safeViewport.x}px ${safeViewport.y}px`;
    backgroundSize = `${spacing}px ${spacing}px`;
  } else if (background.pattern === "ruled") {
    backgroundImage = `linear-gradient(${line} 1px, transparent 1px)`;
    backgroundPosition = `0 ${safeViewport.y}px`;
    backgroundSize = `100% ${spacing}px`;
  }
  // The CSS reference themes used to force a normal-mode dot grid with
  // !important, which made the saved CanvasBackground appear broken. Mirror
  // the live page background into CSS variables so both themes/modes can keep
  // their visual chrome while the actual paper style remains data-driven.
  return {
    backgroundColor,
    backgroundImage,
    backgroundPosition,
    backgroundSize,
    "--ln-page-background-color": backgroundColor,
    "--ln-page-background-image": backgroundImage,
    "--ln-page-background-position": backgroundPosition,
    "--ln-page-background-size": backgroundSize,
  } as CSSProperties;
}

function themeAwareCanvasColor(color: string, theme: AppTheme): string {
  const normalized = color.toLocaleLowerCase();
  const isDefaultDark = normalized === "#242428" || normalized === "#222226" || normalized === "#151823";
  const isDefaultLight = normalized === "#f7f3ea" || normalized === "#f8f7f3";
  return theme === "light" && isDefaultDark
    ? "#f7f3ea"
    : theme === "dark" && isDefaultLight
      ? "#242428"
      : color;
}

function themeAwareStroke(color: string, theme: AppTheme): string {
  return themeAwareInkColor(color, theme);
}

function SaveIndicator({ state }: { state: PageEditorProps["saveState"] }) {
  if (state === "saving") return <span className="flex items-center gap-1.5 text-xs text-neutral-500"><LoaderCircle className="size-3.5 animate-spin" /> Saving</span>;
  if (state === "error") return <span className="flex items-center gap-1.5 text-xs text-red-400"><CloudOff className="size-3.5" /> Save failed</span>;
  return <span className="flex items-center gap-1.5 text-xs text-neutral-500"><CircleCheck className="size-4" /> Saved</span>;
}
function ToolbarButton({ active=false, disabled=false, label, onClick, children }: { active?: boolean; disabled?: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} className={cn("grid size-8 shrink-0 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-white/8 hover:text-white disabled:opacity-35", active && "bg-violet-500/20 text-violet-200")} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</button>;
}
function WorkspaceToolbarTabs({ mode, aiActive, onChange, onInsert, onMath, onOpenAi, contextTools }: { mode: WorkspaceToolbarMode; aiActive: boolean; onChange: (mode: WorkspaceToolbarMode) => void; onInsert: () => void; onMath: () => void; onOpenAi: () => void; contextTools?: ReactNode }) {
  const tabClass = (active: boolean) => cn(
    "flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
    active ? "bg-violet-500/20 text-violet-100" : "text-neutral-400 hover:bg-white/8 hover:text-white",
  );
  return <div className="workspace-mode-tabs flex shrink-0 items-center gap-1 border-r border-white/10 bg-[#18181b] px-2">
    <button type="button" className={tabClass(mode === "write")} aria-pressed={mode === "write"} onMouseDown={event=>event.preventDefault()} onClick={()=>onChange("write")}><PenLine className="size-3.5"/>Write</button>
    <button type="button" className={tabClass(mode === "draw" && !aiActive)} aria-pressed={mode === "draw" && !aiActive} onMouseDown={event=>event.preventDefault()} onClick={()=>onChange("draw")}><Paintbrush className="size-3.5"/>Draw</button>
    <button type="button" className={tabClass(false)} onMouseDown={event=>event.preventDefault()} onClick={onInsert}><Plus className="size-3.5"/>Insert</button>
    <button type="button" className={tabClass(false)} onMouseDown={event=>event.preventDefault()} onClick={onMath}><Sigma className="size-3.5"/>Math</button>
    <button type="button" className={tabClass(aiActive)} aria-pressed={aiActive} onMouseDown={event=>event.preventDefault()} onClick={onOpenAi}><WandSparkles className="size-3.5"/>AI</button>
    {contextTools}
  </div>;
}
function setLink(editor: Editor) {
  const previousUrl = editor.getAttributes("link").href as string | undefined;
  const url = window.prompt("Link URL", previousUrl ?? "https://")?.trim();
  if (url === undefined) return;
  if (!url) editor.chain().focus().extendMarkRange("link").unsetLink().run();
  else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}
function editImageAltText(editor: Editor) {
  const attrs = editor.getAttributes("image") as { alt?: string; title?: string };
  const alt = window.prompt("Image alternative text", attrs.alt ?? "")?.trim();
  if (alt === undefined) return;
  editor.chain().focus().updateAttributes("image", { alt }).run();
}

function rotateSelectedImage(editor: Editor, delta: number) {
  const attrs = editor.getAttributes("image") as { rotation?: number };
  const current = Number(attrs.rotation ?? 0);
  const rotation = ((current + delta) % 360 + 360) % 360;
  editor.chain().updateAttributes("image", { rotation }).run();
}

function setSelectedImageSize(editor: Editor, imageSize: "auto" | "small" | "medium" | "large") {
  editor.chain().updateAttributes("image", { imageSize, imageWidth: null }).run();
}
function setSelectedImageWidth(editor: Editor, imageWidth: number) {
  const width = Math.round(Math.max(1,imageWidth));
  editor.chain().updateAttributes("image", { imageSize: "custom", imageWidth: width }).run();
}

function setSelectedImageAlign(editor: Editor, imageAlign: "left" | "center" | "right") {
  editor.chain().focus().updateAttributes("image", { imageAlign }).run();
}

function setFontFamily(editor: Editor, value: string) {
  const normalized = normalizeFontChoice(value);
  if (!normalized) editor.chain().focus().unsetMark("fontFamilyStyle").run();
  else editor.chain().focus().setMark("fontFamilyStyle", { value: normalized }).run();
}
function setFontSize(editor: Editor, value: string) {
  if (!value) editor.chain().focus().unsetMark("fontSizeStyle").run();
  else editor.chain().focus().setMark("fontSizeStyle", { value }).run();
}
function setTextColor(editor: Editor, value: string) {
  editor.chain().focus().setMark("textColorStyle", { value }).run();
}
function clearRichFormatting(editor: Editor) {
  editor.chain().focus().unsetAllMarks().clearNodes().run();
}
async function recognizeSelectedImage(editor: Editor) {
  const attrs = editor.getAttributes("image") as { attachmentId?: string | null; ocrText?: string | null };
  if (!attrs.attachmentId) { window.alert("OCR is available for images imported by LeNota. Re-drop older legacy images if this image has no managed attachment id."); return; }
  const language = window.prompt("OCR language (Tesseract language code)", "eng")?.trim();
  if (!language) return;
  try {
    const text = (await notesApi.ocrAttachment(attrs.attachmentId, language)).trim();
    editor.chain().focus().updateAttributes("image", { ocrText: text || null }).run();
    window.alert(text ? `OCR complete. The image is now searchable.\n\n${text.slice(0, 3500)}${text.length>3500?"\n…":""}` : "OCR completed but no text was detected.");
  } catch (error) { window.alert(`OCR failed: ${String(error)}`); }
}


interface PageTextMatch { containerId: string; from: number; to: number }
function findMatchesInEditor(containerId: string, editor: Editor, query: string): PageTextMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || editor.isDestroyed) return [];
  const matches: PageTextMatch[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const haystack = node.text.toLocaleLowerCase();
    let start = 0;
    while (start <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, start);
      if (found < 0) break;
      matches.push({ containerId, from: pos + found, to: pos + found + needle.length });
      start = found + Math.max(needle.length, 1);
    }
    return true;
  });
  return matches;
}

function setInternalPageLink(editor: Editor, pages: LinkablePage[]) {
  if (pages.length === 0) return;
  const options = pages.slice(0, 150).map((page, index) => `${index + 1}. ${page.title} — ${page.notebookName} / ${page.sectionName}`).join("\n");
  const answer = window.prompt(`Link to page\n\n${options}\n\nType a page number or part of its title:`, "1")?.trim();
  if (!answer) return;
  const index = Number.parseInt(answer, 10) - 1;
  const normalized = answer.toLocaleLowerCase();
  const page = Number.isInteger(index) && index >= 0 && index < pages.length
    ? pages[index]
    : pages.find((candidate) => candidate.title.toLocaleLowerCase().includes(normalized));
  if (!page) return;
  const href = `lenota://page/${encodeURIComponent(page.id)}`;
  const { from, to } = editor.state.selection;
  if (from !== to) editor.chain().focus().setLink({ href }).run();
  else editor.chain().focus().insertContent({ type: "text", text: page.title, marks: [{ type: "link", attrs: { href } }] }).run();
}
function clearSelectedMathNode(editor: Editor | null) {
  if (!editor || editor.isDestroyed) return;
  const selection = editor.state.selection as typeof editor.state.selection & { node?: { type?: { name?: string } } };
  if (selection.node?.type?.name !== "mathExpression") return;
  // ProseMirror keeps a NodeSelection even after its editor loses focus. That
  // is useful internally, but in a multi-container canvas it made equations in
  // old containers remain visibly selected forever. Move the inactive editor
  // to a normal caret position immediately after the math atom instead.
  editor.commands.setTextSelection(Math.min(selection.to, editor.state.doc.content.size));
}

function insertOrEditMath(editor: Editor) {
  const selected = editor.isActive("mathExpression");
  const previous = selected ? String(editor.getAttributes("mathExpression").latex ?? "") : "";
  const latex = window.prompt(selected ? "Edit LaTeX" : "Insert LaTeX equation", previous || String.raw`\frac{-b \pm \sqrt{b^2-4ac}}{2a}`)?.trim();
  if (!latex) return;
  const validation=validateLatexSource(latex);
  if(!validation.valid){window.alert(`That LaTeX cannot be rendered yet.\n\n${validation.error}`);return;}
  if (selected) editor.chain().focus().updateAttributes("mathExpression", { latex, solved:false }).run();
  else editor.chain().focus().insertContent({ type:"mathExpression", attrs:{ latex, display:false } }).run();
}

function EditorToolbar({ editor, linkablePages }: { editor: Editor | null; linkablePages: LinkablePage[] }) {
  const [, refresh] = useState(0);
  const liveEditor = editor && !editor.isDestroyed ? editor : null;
  const mathSelectionPosRef = useRef<number | null>(null);
  const mathInspectorRef = useRef<HTMLDivElement | null>(null);
  const mathInspectorPointerRef = useRef(false);

  const currentMathSelectionPos = (target: Editor | null) => {
    if (!target || target.isDestroyed) return null;
    const selection = target.state.selection as typeof target.state.selection & { node?: { type?: { name?: string } } };
    // Only a real ProseMirror NodeSelection counts as selected math. A normal
    // text caret positioned immediately before a math atom must not resurrect
    // the inspector or the blue selection state.
    return selection.node?.type?.name === "mathExpression" ? selection.from : null;
  };

  useEffect(() => {
    if (!liveEditor) {
      mathSelectionPosRef.current = null;
      return;
    }
    const update = () => {
      if (liveEditor.isDestroyed) return;
      const selectedPos = currentMathSelectionPos(liveEditor);
      if (selectedPos !== null) {
        mathSelectionPosRef.current = selectedPos;
      } else {
        const active = document.activeElement;
        const focusInsideInspector = active instanceof globalThis.Node && Boolean(mathInspectorRef.current?.contains(active));
        // Clicking a form control in the inspector can make WebKitGTK report a
        // transient text selection in ProseMirror while focus is moving. Keep
        // the inspected math node pinned during that interaction. A genuine
        // selection change back inside the editor still clears the pin.
        if (!mathInspectorPointerRef.current && !focusInsideInspector && liveEditor.isFocused) {
          mathSelectionPosRef.current = null;
        }
      }
      refresh(v => v + 1);
    };
    liveEditor.on("selectionUpdate", update);
    liveEditor.on("transaction", update);
    return () => {
      if (!liveEditor.isDestroyed) {
        liveEditor.off("selectionUpdate", update);
        liveEditor.off("transaction", update);
      }
    };
  }, [liveEditor]);

  const run = (fn: (e: Editor) => void) => { if (liveEditor && !liveEditor.isDestroyed) fn(liveEditor); };
  const imageSelected = Boolean(liveEditor?.isActive("image"));
  const imageAttrs = imageSelected && liveEditor ? liveEditor.getAttributes("image") as { imageWidth?: number | null; imageSize?: string; imageAlign?: string; rotation?: number; alt?: string; attachmentId?: string | null; ocrText?: string | null } : {};

  const selectedMathPos = currentMathSelectionPos(liveEditor);
  if (selectedMathPos !== null) mathSelectionPosRef.current = selectedMathPos;
  if (!liveEditor) mathSelectionPosRef.current = null;
  const pinnedMathPos = mathSelectionPosRef.current;
  const pinnedMathNode = liveEditor && pinnedMathPos !== null ? liveEditor.state.doc.nodeAt(pinnedMathPos) : null;
  if (pinnedMathPos !== null && (!pinnedMathNode || pinnedMathNode.type.name !== "mathExpression")) {
    mathSelectionPosRef.current = null;
  }
  const mathSelected = Boolean(pinnedMathNode && pinnedMathNode.type.name === "mathExpression");

  const restoreMathSelection = () => {
    if (!liveEditor || liveEditor.isDestroyed) return false;
    const pos = mathSelectionPosRef.current;
    if (pos === null) return false;
    const node = liveEditor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "mathExpression") {
      mathSelectionPosRef.current = null;
      return false;
    }
    const current = currentMathSelectionPos(liveEditor);
    if (current !== pos) liveEditor.commands.setNodeSelection(pos);
    return true;
  };

  const updateSelectedMath = (attrs: Record<string, unknown>) => {
    if (!liveEditor || liveEditor.isDestroyed) return;
    const pos = mathSelectionPosRef.current;
    if (pos === null) return;
    const node = liveEditor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "mathExpression") {
      mathSelectionPosRef.current = null;
      refresh(v => v + 1);
      return;
    }
    // Update the pinned node directly instead of relying on updateAttributes(),
    // which operates on the *current* ProseMirror selection. External inputs
    // can temporarily disturb that selection in WebKitGTK. This transaction is
    // position-stable and then explicitly restores the node selection without
    // stealing DOM focus from the inspector control.
    liveEditor.view.dispatch(liveEditor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
    if (!liveEditor.isDestroyed) liveEditor.commands.setNodeSelection(pos);
  };

  const mathAttrs = mathSelected && pinnedMathNode ? pinnedMathNode.attrs as { latex?: string; display?: boolean; align?: MathAlignment; fontSize?: number; color?: string | null } : {};
  const selectedMathSize = customSizeOr(mathAttrs.fontSize,24,1);
  const selectedImageWidth = Number(imageAttrs.imageWidth ?? 520);
  const fontFamily = normalizeFontChoice(liveEditor?.getAttributes("fontFamilyStyle")?.value ?? "");
  const fontSize = String(liveEditor?.getAttributes("fontSizeStyle")?.value ?? "");
  const textColor = String(liveEditor?.getAttributes("textColorStyle")?.value ?? "#e4e4e7");
  return <>
  <div className="editor-toolbar-scroll no-print flex min-w-0 flex-nowrap items-center gap-0.5 overflow-x-auto border-b border-white/8 bg-[#1d1d21] px-3 py-1.5">
    <ToolbarButton label="Undo" disabled={!liveEditor || !liveEditor.can().undo()} onClick={() => run(e => e.chain().focus().undo().run())}><Undo2 className="size-4" /></ToolbarButton>
    <ToolbarButton label="Redo" disabled={!liveEditor || !liveEditor.can().redo()} onClick={() => run(e => e.chain().focus().redo().run())}><Redo2 className="size-4" /></ToolbarButton><span className="mx-1 h-5 w-px bg-white/10" />
    <ToolbarButton active={!!liveEditor?.isActive("paragraph")} label="Paragraph" onClick={() => run(e => e.chain().focus().setParagraph().run())}><Pilcrow className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("heading", {level:1})} label="Heading 1" onClick={() => run(e => e.chain().focus().toggleHeading({level:1}).run())}><Heading1 className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("heading", {level:2})} label="Heading 2" onClick={() => run(e => e.chain().focus().toggleHeading({level:2}).run())}><Heading2 className="size-4" /></ToolbarButton><span className="mx-1 h-5 w-px bg-white/10" />
    <select title="Font family" aria-label="Font family" value={fontFamily} onPointerDown={event=>event.stopPropagation()} onChange={e=>liveEditor&&setFontFamily(liveEditor,e.target.value)} style={{fontFamily:fontCssValue(fontFamily)}} className="h-7 max-w-36 rounded border border-white/10 bg-[#25252a] px-1.5 text-xs text-neutral-300">
      {FONT_CHOICES.map(font=><option key={font.label} value={font.value} style={{fontFamily:font.css}}>{font.label}</option>)}
    </select>
    <CustomSizeInput
      title="Font size — type any positive value"
      ariaLabel="Font size"
      value={parseCustomSize(Number.parseFloat(fontSize),.1)}
      recommended={[8,9,10,11,12,14,16,18,20,24,28,32,36,48,64,72]}
      onCommit={size=>liveEditor&&setFontSize(liveEditor,`${size}px`)}
      onClear={()=>liveEditor&&setFontSize(liveEditor,"")}
      className="w-20"
    />
    <input title="Text color" aria-label="Text color" type="color" value={/^#[0-9a-f]{6}$/i.test(textColor)?textColor:"#e4e4e7"} onChange={e=>liveEditor&&setTextColor(liveEditor,e.target.value)} className="h-7 w-8 cursor-pointer rounded border border-white/10 bg-transparent p-0.5"/>
    <ToolbarButton active={!!liveEditor?.isActive("superscriptStyle")} label="Superscript" onClick={()=>run(e=>e.chain().focus().toggleMark("superscriptStyle").unsetMark("subscriptStyle").run())}><span className="text-[11px] font-semibold">x²</span></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("subscriptStyle")} label="Subscript" onClick={()=>run(e=>e.chain().focus().toggleMark("subscriptStyle").unsetMark("superscriptStyle").run())}><span className="text-[11px] font-semibold">x₂</span></ToolbarButton>
    <ToolbarButton label="Clear formatting" onClick={()=>run(clearRichFormatting)}><Eraser className="size-4"/></ToolbarButton><span className="mx-1 h-5 w-px bg-white/10" />
    <ToolbarButton active={!!liveEditor?.isActive("bold")} label="Bold" onClick={() => run(e => e.chain().focus().toggleBold().run())}><Bold className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("italic")} label="Italic" onClick={() => run(e => e.chain().focus().toggleItalic().run())}><Italic className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("underline")} label="Underline" onClick={() => run(e => e.chain().focus().toggleUnderline().run())}><Underline className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("strike")} label="Strike" onClick={() => run(e => e.chain().focus().toggleStrike().run())}><Strikethrough className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("highlight")} label="Highlight" onClick={() => run(e => e.chain().focus().toggleHighlight().run())}><Highlighter className="size-4" /></ToolbarButton>
    <input title="Highlight color" aria-label="Highlight color" type="color" value="#facc15" onChange={e=>run(editor=>editor.chain().focus().setHighlight({color:e.target.value}).run())} className="h-7 w-8 cursor-pointer rounded border border-white/10 bg-transparent p-0.5"/>
    <ToolbarButton active={!!liveEditor?.isActive("code")} label="Inline code" onClick={() => run(e => e.chain().focus().toggleCode().run())}><Code className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("codeBlock")} label="Code block" onClick={() => run(e => e.chain().focus().toggleCodeBlock().run())}><span className="text-[10px] font-semibold">{`{ }`}</span></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("mathExpression")} label="Math / LaTeX (Ctrl+Alt+M)" onClick={() => liveEditor && insertOrEditMath(liveEditor)}><Sigma className="size-4" /></ToolbarButton><span className="mx-1 h-5 w-px bg-white/10" />
    <ToolbarButton active={!!liveEditor?.isActive("bulletList")} label="Bullet list" onClick={() => run(e => e.chain().focus().toggleBulletList().run())}><List className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("orderedList")} label="Numbered list" onClick={() => run(e => e.chain().focus().toggleOrderedList().run())}><ListOrdered className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("taskList")} label="Task list" onClick={() => run(e => e.chain().focus().toggleTaskList().run())}><CheckSquare className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("blockquote")} label="Quote" onClick={() => run(e => e.chain().focus().toggleBlockquote().run())}><Quote className="size-4" /></ToolbarButton>
    <ToolbarButton label="Rule" onClick={() => run(e => e.chain().focus().setHorizontalRule().run())}><Minus className="size-4" /></ToolbarButton><span className="mx-1 h-5 w-px bg-white/10" />
    <ToolbarButton active={!!liveEditor?.isActive({textAlign:"left"})} label="Align left" onClick={() => run(e => e.chain().focus().setTextAlign("left").run())}><AlignLeft className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive({textAlign:"center"})} label="Align center" onClick={() => run(e => e.chain().focus().setTextAlign("center").run())}><AlignCenter className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive({textAlign:"right"})} label="Align right" onClick={() => run(e => e.chain().focus().setTextAlign("right").run())}><AlignRight className="size-4" /></ToolbarButton>
    <ToolbarButton active={!!liveEditor?.isActive("link")} label="Link" onClick={() => liveEditor && setLink(liveEditor)}><Link className="size-4" /></ToolbarButton>
    <ToolbarButton label="Link to page" disabled={!liveEditor || linkablePages.length === 0} onClick={() => liveEditor && setInternalPageLink(liveEditor, linkablePages)}><FileText className="size-4" /></ToolbarButton>
    <ToolbarButton label="Insert current date (Alt+Shift+D)" onClick={()=>run(e=>e.chain().focus().insertContent(new Intl.DateTimeFormat(undefined,{dateStyle:"medium"}).format(new Date())).run())}><span className="text-[10px] font-semibold">Date</span></ToolbarButton>
    <ToolbarButton label="Insert current time (Alt+Shift+T)" onClick={()=>run(e=>e.chain().focus().insertContent(new Intl.DateTimeFormat(undefined,{timeStyle:"short"}).format(new Date())).run())}><span className="text-[10px] font-semibold">Time</span></ToolbarButton>
    <ToolbarButton label="Image alt text" disabled={!liveEditor?.isActive("image")} onClick={() => liveEditor && editImageAltText(liveEditor)}><ImagePlus className="size-4" /></ToolbarButton>
    {liveEditor?.isActive("image") ? <>
      <ToolbarButton label="Rotate image left 90°" onClick={() => liveEditor && rotateSelectedImage(liveEditor, -90)}><RotateCcw className="size-4" /></ToolbarButton>
      <ToolbarButton label="Rotate image right 90°" onClick={() => liveEditor && rotateSelectedImage(liveEditor, 90)}><RotateCw className="size-4" /></ToolbarButton>
      <ToolbarButton label="Small image" onClick={() => liveEditor && setSelectedImageSize(liveEditor, "small")}><span className="text-[10px] font-semibold">S</span></ToolbarButton>
      <ToolbarButton label="Medium image" onClick={() => liveEditor && setSelectedImageSize(liveEditor, "medium")}><span className="text-[10px] font-semibold">M</span></ToolbarButton>
      <ToolbarButton label="Large image" onClick={() => liveEditor && setSelectedImageSize(liveEditor, "large")}><span className="text-[10px] font-semibold">L</span></ToolbarButton>
      <ToolbarButton label="Reset image size" onClick={() => liveEditor && setSelectedImageSize(liveEditor, "auto")}><span className="text-[10px] font-semibold">1:1</span></ToolbarButton>
      <ToolbarButton label="Align image left" onClick={() => liveEditor && setSelectedImageAlign(liveEditor, "left")}><AlignLeft className="size-4" /></ToolbarButton>
      <ToolbarButton label="Center image" onClick={() => liveEditor && setSelectedImageAlign(liveEditor, "center")}><AlignCenter className="size-4" /></ToolbarButton>
      <ToolbarButton label="Align image right" onClick={() => liveEditor && setSelectedImageAlign(liveEditor, "right")}><AlignRight className="size-4" /></ToolbarButton>
    </> : null}
    <ToolbarButton disabled={!liveEditor?.isActive("link")} label="Unlink" onClick={() => run(e => e.chain().focus().unsetLink().run())}><Unlink className="size-4" /></ToolbarButton>
    <ToolbarButton label="Insert table" onClick={() => run(e => e.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run())}><Table2 className="size-4" /></ToolbarButton>
    <ToolbarButton disabled={!liveEditor?.isActive("table")} label="Add row" onClick={() => run(e => e.chain().focus().addRowAfter().run())}><Rows3 className="size-4" /></ToolbarButton>
    <ToolbarButton disabled={!liveEditor?.isActive("table")} label="Add column" onClick={() => run(e => e.chain().focus().addColumnAfter().run())}><Columns3 className="size-4" /></ToolbarButton>
    <ToolbarButton disabled={!liveEditor?.isActive("table")} label="Delete row" onClick={() => run(e => e.chain().focus().deleteRow().run())}><span className="text-[10px] font-semibold">−Row</span></ToolbarButton>
    <ToolbarButton disabled={!liveEditor?.isActive("table")} label="Delete column" onClick={() => run(e => e.chain().focus().deleteColumn().run())}><span className="text-[10px] font-semibold">−Col</span></ToolbarButton>
    <ToolbarButton disabled={!liveEditor?.isActive("table")} label="Merge cells" onClick={() => run(e => e.chain().focus().mergeCells().run())}><span className="text-[10px] font-semibold">Merge</span></ToolbarButton>
    <ToolbarButton disabled={!liveEditor?.isActive("table")} label="Split cell" onClick={() => run(e => e.chain().focus().splitCell().run())}><span className="text-[10px] font-semibold">Split</span></ToolbarButton>
    <ToolbarButton disabled={!liveEditor?.isActive("table")} label="Toggle header row" onClick={() => run(e => e.chain().focus().toggleHeaderRow().run())}><span className="text-[10px] font-semibold">Header</span></ToolbarButton>
    <ToolbarButton disabled={!liveEditor?.isActive("table")} label="Delete table" onClick={() => run(e => e.chain().focus().deleteTable().run())}><Trash2 className="size-4" /></ToolbarButton>
  </div>
  {imageSelected && liveEditor ? <div className="legacy-inline-inspector no-print flex flex-wrap items-center gap-2 border-b border-violet-400/20 bg-violet-500/8 px-3 py-2 text-xs text-neutral-300">
    <span className="font-semibold text-violet-200">Image selected</span>
    <span className="text-neutral-500">Drag its corner handles, or use:</span>
    <Button size="sm" variant="ghost" onClick={() => rotateSelectedImage(liveEditor, -90)}><RotateCcw className="size-3.5"/>Rotate left</Button>
    <Button size="sm" variant="ghost" onClick={() => rotateSelectedImage(liveEditor, 90)}><RotateCw className="size-3.5"/>Rotate right</Button>
    <div className="flex items-center gap-1 rounded-md border border-white/10 bg-black/10 px-2 py-1">
      <span>Size</span>
      <button className="rounded px-1.5 py-0.5 hover:bg-white/10" onMouseDown={e=>e.preventDefault()} onClick={()=>setSelectedImageSize(liveEditor,"small")}>S</button>
      <button className="rounded px-1.5 py-0.5 hover:bg-white/10" onMouseDown={e=>e.preventDefault()} onClick={()=>setSelectedImageSize(liveEditor,"medium")}>M</button>
      <button className="rounded px-1.5 py-0.5 hover:bg-white/10" onMouseDown={e=>e.preventDefault()} onClick={()=>setSelectedImageSize(liveEditor,"large")}>L</button>
      <button className="rounded px-1.5 py-0.5 hover:bg-white/10" onMouseDown={e=>e.preventDefault()} onClick={()=>setSelectedImageSize(liveEditor,"auto")}>Original</button>
    </div>
    <label className="flex items-center gap-2 rounded-md border border-white/10 bg-black/10 px-2 py-1">
      <span>Width</span>
      <CustomSizeInput title="Image width — type any positive value" ariaLabel="Image width" value={customSizeOr(selectedImageWidth,520,1)} recommended={[260,420,520,720,900,1200,1400]} minimum={1} onCommit={width=>setSelectedImageWidth(liveEditor,width)} className="w-28"/>
    </label>
    <div className="flex items-center rounded-md border border-white/10 bg-black/10 p-0.5">
      <button title="Align left" className={cn("rounded p-1.5 hover:bg-white/10",String(imageAttrs.imageAlign??"left")==="left"&&"bg-violet-500/25 text-violet-100")} onMouseDown={e=>e.preventDefault()} onClick={()=>setSelectedImageAlign(liveEditor,"left")}><AlignLeft className="size-3.5"/></button>
      <button title="Center image" className={cn("rounded p-1.5 hover:bg-white/10",imageAttrs.imageAlign==="center"&&"bg-violet-500/25 text-violet-100")} onMouseDown={e=>e.preventDefault()} onClick={()=>setSelectedImageAlign(liveEditor,"center")}><AlignCenter className="size-3.5"/></button>
      <button title="Align right" className={cn("rounded p-1.5 hover:bg-white/10",imageAttrs.imageAlign==="right"&&"bg-violet-500/25 text-violet-100")} onMouseDown={e=>e.preventDefault()} onClick={()=>setSelectedImageAlign(liveEditor,"right")}><AlignRight className="size-3.5"/></button>
    </div>
    <Button size="sm" variant="ghost" onClick={() => editImageAltText(liveEditor)}>Alt text</Button>
    <Button size="sm" variant="ghost" disabled={!imageAttrs.attachmentId} onClick={() => void recognizeSelectedImage(liveEditor)}><Search className="size-3.5"/>OCR</Button>
    <Button size="sm" variant="ghost" onMouseDown={e=>e.preventDefault()} onClick={()=>liveEditor.chain().focus().deleteSelection().run()}><Trash2 className="size-3.5"/>Remove image</Button>
    <span className="text-neutral-500">Rotation {Number(imageAttrs.rotation ?? 0)}° · {String(imageAttrs.imageAlign ?? "left")}</span>
  </div> : null}
  {mathSelected && liveEditor ? <div
    ref={mathInspectorRef}
    data-math-inspector="true"
    className="legacy-inline-inspector no-print flex flex-wrap items-center gap-2 border-b border-cyan-400/15 bg-cyan-500/5 px-3 py-2 text-xs text-neutral-300"
    onPointerDownCapture={event=>{
      mathInspectorPointerRef.current=true;
      event.stopPropagation();
      restoreMathSelection();
    }}
    onPointerUpCapture={()=>{
      window.setTimeout(()=>{mathInspectorPointerRef.current=false;},0);
    }}
    onPointerCancelCapture={()=>{mathInspectorPointerRef.current=false;}}
    onClickCapture={()=>{restoreMathSelection();}}
    onMouseDownCapture={event=>{
      const target=event.target as HTMLElement;
      // Buttons should never steal focus from the selected equation. Inputs and
      // selects still receive native focus so typing, sliders, color pickers,
      // and dropdowns work normally.
      if(!target.closest("input,select,textarea"))event.preventDefault();
    }}
    onFocusCapture={()=>{restoreMathSelection();}}
  >
    <span className="flex items-center gap-1 font-semibold text-cyan-200"><Sigma className="size-3.5"/>Math selected</span>
    <input aria-label="LaTeX source" className="h-8 min-w-72 flex-1 rounded border border-white/10 bg-black/15 px-2 font-mono text-xs text-neutral-200 outline-none focus:border-cyan-400/40" value={String(mathAttrs.latex??"")} onChange={event=>updateSelectedMath({latex:event.target.value,solved:false})}/>
    <Button size="sm" variant="ghost" onClick={()=>updateSelectedMath({display:!Boolean(mathAttrs.display)})}>{mathAttrs.display?"Display":"Inline"}</Button>
    <div className="flex items-center rounded-md border border-white/10 bg-black/10 p-0.5" aria-label="Equation alignment">
      <button title="Align equation left" className={cn("rounded p-1.5 hover:bg-white/10",normalizeMathAlignment(mathAttrs.align)==="left"&&"bg-cyan-500/20 text-cyan-100")} onClick={()=>updateSelectedMath({display:true,align:"left"})}><AlignLeft className="size-3.5"/></button>
      <button title="Center equation" className={cn("rounded p-1.5 hover:bg-white/10",normalizeMathAlignment(mathAttrs.align)==="center"&&"bg-cyan-500/20 text-cyan-100")} onClick={()=>updateSelectedMath({display:true,align:"center"})}><AlignCenter className="size-3.5"/></button>
      <button title="Align equation right" className={cn("rounded p-1.5 hover:bg-white/10",normalizeMathAlignment(mathAttrs.align)==="right"&&"bg-cyan-500/20 text-cyan-100")} onClick={()=>updateSelectedMath({display:true,align:"right"})}><AlignRight className="size-3.5"/></button>
    </div>
    <input title="Equation color" aria-label="Equation color" type="color" value={/^#[0-9a-f]{6}$/i.test(String(mathAttrs.color??""))?String(mathAttrs.color):"#d4d4d8"} onChange={event=>updateSelectedMath({color:event.target.value})} className="h-7 w-8 cursor-pointer rounded border border-white/10 bg-transparent p-0.5"/>
    <label className="flex items-center gap-2 rounded-md border border-white/10 bg-black/10 px-2 py-1">
      <span>Size</span>
      <button title="Smaller equation" className="rounded px-1.5 py-0.5 hover:bg-white/10" onClick={()=>updateSelectedMath({fontSize:Math.max(1,selectedMathSize-4),autoFit:false})}>−</button>
      <CustomSizeInput title="Equation size — type any positive value" ariaLabel="Equation size" value={selectedMathSize} recommended={[12,16,20,24,32,48,64,96,144,220]} minimum={1} onCommit={size=>updateSelectedMath({fontSize:size,autoFit:false})} className="w-24"/>
      <button title="Larger equation" className="rounded px-1.5 py-0.5 hover:bg-white/10" onClick={()=>updateSelectedMath({fontSize:selectedMathSize+4,autoFit:false})}>+</button>
    </label>
    <select aria-label="Math template" className="h-8 rounded border border-white/10 bg-[#25252a] px-2 text-xs" value="" onChange={event=>{const latex=event.target.value;if(latex)updateSelectedMath({latex,solved:false});event.currentTarget.value="";}}><option value="">Template…</option><option value={String.raw`\frac{a}{b}`}>Fraction</option><option value={String.raw`\sqrt{x}`}>Square root</option><option value={String.raw`\int_{a}^{b} f(x)\,dx`}>Integral</option><option value={String.raw`\sum_{i=1}^{n} i`}>Summation</option><option value={String.raw`\begin{bmatrix} a & b \\ c & d \end{bmatrix}`}>Matrix</option><option value={String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`}>Quadratic formula</option></select>
    <Button size="sm" variant="ghost" onClick={()=>void navigator.clipboard.writeText(String(mathAttrs.latex??""))}>Copy LaTeX</Button>
    <Button size="sm" variant="ghost" onClick={()=>{if(restoreMathSelection())liveEditor.chain().deleteSelection().run();}}><Trash2 className="size-3.5"/>Remove</Button>
  </div> : null}
  </>;
}

function NoteContainerView({ item, selected, autoFocus, onSelect, onEditorReady, registerEditor, onChange, onMoveStart, onMoveDelta, onMoveEnd, onResizeStart, onResize, onResizeEnd, onBlur, onDelete, onDuplicate, onCopyLink, onOpenInternalPage, onAsk }: {
  item: NoteContainer;
  selected: boolean;
  autoFocus: boolean;
  onSelect: (additive?: boolean) => void;
  onEditorReady: (editor: Editor) => void;
  registerEditor: (id: string, editor: Editor | null) => void;
  onChange: (content: JSONContent, plainText: string) => void;
  onMoveStart: () => void;
  onMoveDelta: (dx:number,dy:number)=>void;
  onMoveEnd: () => void;
  onResizeStart: () => void;
  onResize:(width:number)=>void;
  onResizeEnd: () => void;
  onBlur: () => void;
  onDelete:()=>void;
  onDuplicate:()=>void;
  onCopyLink:()=>void;
  onOpenInternalPage:(pageId:string, containerId?:string)=>void;
  onAsk:(prompt:string,range:{from:number;to:number})=>void;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading:{levels:[1,2,3]}, link:{openOnClick:false,autolink:true,linkOnPaste:true,protocols:["lenota"]} }),
      EnhancedImage,
      MathExpression,
      MathGraph,
      FontFamilyStyle,
      FontSizeStyle,
      TextColorStyle,
      SuperscriptStyle,
      SubscriptStyle,
      AudioCard,
      AttachmentCard,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({nested:true}),
      TableKit.configure({table:{resizable:true}}),
      TextAlign.configure({types:["heading","paragraph"]}),
      Placeholder.configure({placeholder:"Type a note…  /ask for Gemini"}),
      CharacterCount,
    ],
    content: item.content,
    editorProps: {
      attributes: { class:"tiptap note-container-editor ui-selectable", dir:"auto", spellcheck:"true" },
      handleKeyDown: (view,event) => {
        if(event.key!=="Enter"||event.shiftKey||event.isComposing)return false;
        const selection=view.state.selection;
        if(!selection.empty||selection.$from.depth!==1||selection.$from.parent.type.name!=="paragraph")return false;
        const prompt=parseAskDirective(selection.$from.parent.textContent);
        if(!prompt)return false;
        event.preventDefault();
        const from=selection.$from.before(1);
        onAsk(prompt,{from,to:from+selection.$from.parent.nodeSize});
        return true;
      },
      handleDOMEvents: {
        click: (_view, event) => {
          const target = event.target as HTMLElement | null;
          const anchor = target?.closest<HTMLAnchorElement>("a[href]");
          const href = anchor?.getAttribute("href") ?? "";
          if (href.startsWith("lenota://page/")) {
            event.preventDefault();
            try {
              const raw = href.slice("lenota://page/".length);
              const [encodedPageId, fragment = ""] = raw.split("#", 2);
              const pageId = decodeURIComponent(encodedPageId);
              const params = new URLSearchParams(fragment);
              const containerId = params.get("container") ?? undefined;
              onOpenInternalPage(pageId, containerId);
            } catch { /* malformed imported link */ }
            return true;
          }
          const openAudio = target?.closest<HTMLElement>("[data-open-audio]");
          if (openAudio) {
            const audioCard = target?.closest<HTMLElement>("[data-lenota-audio]");
            const audioPath = audioCard?.getAttribute("storedpath") ?? audioCard?.getAttribute("storedPath");
            if (audioPath) { void openPath(audioPath); return true; }
          }
          const card = target?.closest<HTMLElement>("[data-lenota-attachment]");
          const path = card?.getAttribute("storedpath") ?? card?.getAttribute("storedPath");
          if (path) { void openPath(path); return true; }
          return false;
        },
      },
    },
    onFocus: ({editor}) => { onSelect(); onEditorReady(editor); },
    onBlur: () => onBlur(),
    onUpdate: ({editor}) => { const json=editor.getJSON(); onChange(json, extractDocumentSearchText(json)); },
    onCreate: ({editor}) => { registerEditor(item.id, editor); if (selected) onEditorReady(editor); },
    onDestroy: () => registerEditor(item.id, null),
  });
  useEffect(() => {
    if (!autoFocus || !editor) return;
    const frame = requestAnimationFrame(() => editor.commands.focus("end"));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, editor]);


  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1) return;
    event.preventDefault(); event.stopPropagation(); if (!selected || event.shiftKey) onSelect(event.shiftKey); onMoveStart();
    let lastX = event.clientX;
    let lastY = event.clientY;
    const world=event.currentTarget.closest<HTMLElement>(".canvas-world");
    const move=(e:PointerEvent)=>{
      const zoom = renderedCanvasScale(world);
      const dx = (e.clientX - lastX) / zoom;
      const dy = (e.clientY - lastY) / zoom;
      lastX = e.clientX; lastY = e.clientY;
      onMoveDelta(dx, dy);
    };
    const up=()=>{onMoveEnd();window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up)};
    window.addEventListener("pointermove",move); window.addEventListener("pointerup",up);
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1) return;
    event.preventDefault(); event.stopPropagation(); onSelect(); onResizeStart(); const startX=event.clientX, initial=item.width;
    const world=event.currentTarget.closest<HTMLElement>(".canvas-world");
    const move=(e:PointerEvent)=>onResize(clamp(initial+(e.clientX-startX)/renderedCanvasScale(world),MIN_WIDTH,MAX_WIDTH));
    const up=()=>{onResizeEnd();window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up)};
    window.addEventListener("pointermove",move); window.addEventListener("pointerup",up);
  };
  return <div
    className={cn("note-container group absolute", selected && "is-selected")}
    data-note-container-id={item.id}
    style={{left:item.x,top:item.y,width:item.width,minHeight:item.minHeight,zIndex:selected?800000+item.zIndex:item.zIndex}}
    onPointerDown={(e)=>{
      if (e.button === 1) return;
      e.stopPropagation();
      const target = e.target as HTMLElement;
      // Clicking anywhere else in this container is a genuine deselection of
      // its current equation. A math node is different: its NodeView has just
      // established the NodeSelection, so also claim this editor for the top
      // toolbar immediately. Without this, the equation can turn blue on the
      // first click while the Math selected inspector waits for a second click
      // (the editor focus event arrives too late / may not arrive for an atom).
      if (target.closest(".lenota-math-node") && editor) onEditorReady(editor);
      else clearSelectedMathNode(editor);
      if (e.shiftKey) { e.preventDefault(); onSelect(true); }
      else onSelect(false);
    }}
  >
    <div className="note-container-outline pointer-events-none absolute inset-0" />
    <div className="note-container-chrome absolute -top-7 left-0 right-0 z-10 flex h-7 items-center justify-between px-1" onPointerDown={startDrag}>
      <div className="note-container-drag flex h-6 min-w-12 cursor-move items-center rounded-t border border-b-0 border-white/15 bg-[#26262b]/95 px-2 shadow-sm"><GripHorizontal className="size-4 text-neutral-400"/></div>
      <div className="note-container-actions flex items-center gap-0.5 rounded-md border border-white/10 bg-[#202024]/95 p-0.5 shadow-lg">
        <button title="Copy link to this note container" className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white" onPointerDown={e=>e.stopPropagation()} onClick={onCopyLink}><Link className="size-3.5"/></button>
        <button title="Duplicate container" className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white" onPointerDown={e=>e.stopPropagation()} onClick={onDuplicate}><Copy className="size-3.5"/></button>
        <button title="Delete container" className="rounded p-1 text-neutral-400 hover:bg-red-500/15 hover:text-red-300" onPointerDown={e=>e.stopPropagation()} onClick={onDelete}><Trash2 className="size-3.5"/></button>
      </div>
    </div>
    {editor ? <EditorContent editor={editor}/> : <div className="p-4 text-sm text-neutral-500">Loading…</div>}
    <div title="Resize container" className="note-container-resize absolute bottom-0 right-0 size-4 cursor-ew-resize" onPointerDown={startResize}/>
  </div>;
}

export function PageEditor(props: PageEditorProps) {
  const { page, title, contentJson, plainText, saveState, availableTags, onChangeTitle, onChangeContent, onToggleFavorite, onAddTag, onCreateTag, onRemoveTag, onOpenHistory, onCreateSnapshot, attachmentCount, onOpenAttachments, onAttachmentsChanged, onOpenCommands, onExport, linkablePages, focusPages, onOpenInternalPage, onCreatePage, targetContainerId, onTargetContainerHandled, theme, focusMode, onToggleTheme, onToggleFocusMode, canGoBack, canGoForward, onGoBack, onGoForward, focusBreadcrumb } = props;
  const initialCanvas = useMemo(() => loadCanvas(contentJson, plainText), []);
  const [containers, setContainers] = useState<NoteContainer[]>(initialCanvas.containers);
  const [ink, setInk] = useState<InkStroke[]>(initialCanvas.ink);
  const [shapes, setShapes] = useState<CanvasShape[]>(initialCanvas.shapes);
  const [background, setBackground] = useState<CanvasBackground>(initialCanvas.background);
  const [viewport, setViewport] = useState(initialCanvas.viewport);
  const [aiMemory,setAiMemory]=useState<PageAiMemoryEntry[]>(initialCanvas.aiMemory);
  const [selectedIds, setSelectedIds] = useState<Set<ContainerId>>(new Set());
  const [selectedShapeIds, setSelectedShapeIds] = useState<Set<string>>(new Set());
  const [selectedInkIds, setSelectedInkIds] = useState<Set<string>>(new Set());
  const [lassoPath, setLassoPath] = useState<InkPoint[] | null>(null);
  const [marquee, setMarquee] = useState<{x:number;y:number;width:number;height:number}|null>(null);
  const [focusRequestId, setFocusRequestId] = useState<ContainerId | null>(null);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem("lenota:layout:v028:inspector-open") === "1");
  const [toolShelfOpen, setToolShelfOpen] = useState(false);
  const [focusToolMenu, setFocusToolMenu] = useState<"layers" | "fill" | null>(null);
  useEffect(() => {
    if (focusMode) {
      setToolShelfOpen(false);
      setFocusToolMenu(null);
    }
  }, [focusMode]);
  const [, setInspectorRevision] = useState(0);
  const [toolbarMode, setToolbarMode] = useState<WorkspaceToolbarMode>(() => localStorage.getItem("lenota:toolbar-mode") === "draw" ? "draw" : "write");
  const [drawToolbarPanel, setDrawToolbarPanel] = useState<DrawToolbarPanel>(() => {
    const stored = localStorage.getItem("lenota:draw-toolbar-panel");
    return stored === "shapes" || stored === "ai" || stored === "page" ? stored : "ink";
  });
  const [drawToolbarHost, setDrawToolbarHost] = useState<HTMLDivElement | null>(null);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("select");
  const [penColor, setPenColor] = useState("#d4d4d8");
  const [penWidth, setPenWidth] = useState(2.5);
  const [highlighterColor, setHighlighterColor] = useState("#fde047");
  const [highlighterWidth, setHighlighterWidth] = useState(18);
  const [shapeFillColor, setShapeFillColor] = useState("transparent");
  const [dropActive, setDropActive] = useState(false);
  const [spacePanning, setSpacePanning] = useState(false);
  const [audioRecording, setAudioRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [findStatus, setFindStatus] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [aiTaskStatus, setAiTaskStatus] = useState("");
  const [autoInkEnabled, setAutoInkEnabled] = useState(() => localStorage.getItem("lenota:auto-ink-enabled") === "1");
  const [autoInkMode, setAutoInkMode] = useState<AutoInkMode>(() => {
    const stored = localStorage.getItem("lenota:auto-ink-mode");
    return stored === "text" || stored === "shape" || stored === "math" ? stored : "smart";
  });
  const [autoInkDelay, setAutoInkDelay] = useState(() => {
    const stored = Number(localStorage.getItem("lenota:auto-ink-delay") || "550");
    return stored === 350 || stored === 850 ? stored : 550;
  });
  const [inkRecognitionLanguage, setInkRecognitionLanguage] = useState(() => localStorage.getItem("lenota:ink-ocr-language") || "eng");
  const [cloudAiReadiness,setCloudAiReadiness]=useState<CloudAiReadiness>("checking");
  const [cloudAiBusy,setCloudAiBusy]=useState(false);
  const [cloudAiError,setCloudAiError]=useState("");
  const [inkOutputFontFamily, setInkOutputFontFamily] = useState(() => normalizeFontChoice(localStorage.getItem("lenota:ink-output-font") || ""));
  const [autoInkStatus, setAutoInkStatus] = useState("");
  const [latestRecentMathId,setLatestRecentMathId]=useState<string|null>(null);
  const findCursorRef = useRef(0);
  const currentFindRef = useRef<PageTextMatch | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const floatingZoomRef = useRef<HTMLSpanElement>(null);
  const statusZoomRef = useRef<HTMLSpanElement>(null);
  const editorsRef = useRef(new Map<string, Editor>());
  const historyRef = useRef<{undo: CanvasSnapshot[]; redo: CanvasSnapshot[]}>({undo:[],redo:[]});
  const stateRef = useRef({containers, ink, shapes, background, viewport, aiMemory}); stateRef.current={containers,ink,shapes,background,viewport,aiMemory};
  const drawingRef = useRef<InkStroke | null>(null);
  const shapeDrawingRef = useRef<CanvasShape | null>(null);
  const clipboardRef = useRef<{containers:NoteContainer[];shapes:CanvasShape[];ink:InkStroke[]}>({containers:[],shapes:[],ink:[]});
  const insertAttachmentsRef = useRef<(paths:string[], clientX:number, clientY:number)=>Promise<void>>(async()=>{});
  const lastNativeDropRef = useRef<{signature:string; at:number}>({signature:"",at:0});
  const wheelCommitRef = useRef<number | null>(null);
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => {});
  const viewportFrameRef = useRef<number | null>(null);
  const pendingViewportDomRef = useRef<{x:number;y:number;zoom:number} | null>(null);
  const wavCaptureRef = useRef<WavCaptureSession | null>(null);
  const mountedRef = useRef(true);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const microphonePermissionApprovedRef = useRef(false);
  const onChangeContentRef = useRef(onChangeContent);
  const pendingPublishRef = useRef<{contentJson:string;plainText:string}|null>(null);
  const publishScheduledRef = useRef(false);
  const autoInkPendingRef = useRef<Set<string>>(new Set());
  const autoInkTimerRef = useRef<number | null>(null);
  const autoInkRunningRef = useRef(false);
  const autoInkGenerationRef = useRef(0);
  const recentMathConversionsRef = useRef(new Map<string, {
    containerId:string;
    sourceStrokes:InkStroke[];
    bounds:{left:number;top:number;right:number;bottom:number};
    latex:string;
    revision:number;
    expiresAt:number;
  }>());
  const recentMathExpiryTimerRef=useRef<number|null>(null);

  useEffect(() => { onChangeContentRef.current = onChangeContent; }, [onChangeContent]);
  useEffect(() => { localStorage.setItem("lenota:auto-ink-enabled", autoInkEnabled ? "1" : "0"); }, [autoInkEnabled]);
  useEffect(() => { localStorage.setItem("lenota:auto-ink-mode", autoInkMode); }, [autoInkMode]);
  useEffect(() => { localStorage.setItem("lenota:auto-ink-delay", String(autoInkDelay)); }, [autoInkDelay]);
  useEffect(() => { localStorage.setItem("lenota:ink-ocr-language", inkRecognitionLanguage); }, [inkRecognitionLanguage]);
  useEffect(() => { localStorage.setItem("lenota:ink-output-font", inkOutputFontFamily); }, [inkOutputFontFamily]);
  useEffect(() => { localStorage.setItem("lenota:toolbar-mode", toolbarMode); }, [toolbarMode]);
  useEffect(() => { localStorage.setItem("lenota:draw-toolbar-panel", drawToolbarPanel); }, [drawToolbarPanel]);
  useEffect(() => { localStorage.setItem("lenota:layout:v028:inspector-open", inspectorOpen ? "1" : "0"); }, [inspectorOpen]);
  useEffect(() => {
    const editor = activeEditor && !activeEditor.isDestroyed ? activeEditor : null;
    if (!editor) return;
    const update = () => setInspectorRevision((value) => value + 1);
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      if (!editor.isDestroyed) {
        editor.off("selectionUpdate", update);
        editor.off("transaction", update);
      }
    };
  }, [activeEditor]);
  useEffect(()=>{
    let active=true;
    void notesApi.cloudAiStatus().then(status=>{
      if(!active)return;
      setCloudAiReadiness(status.configured?"ready":"missing");
    }).catch(()=>{if(active)setCloudAiReadiness("missing");});
    return()=>{active=false;};
  },[]);
  useEffect(() => () => {
    if (autoInkTimerRef.current !== null) window.clearTimeout(autoInkTimerRef.current);
    if (recentMathExpiryTimerRef.current !== null) window.clearTimeout(recentMathExpiryTimerRef.current);
    if (wheelCommitRef.current !== null) window.clearTimeout(wheelCommitRef.current);
    if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => wheelHandlerRef.current(event);
    // React delegates wheel events through a passive root listener in some
    // WebKit/Chromium builds. A native non-passive listener prevents the
    // browser's own scroll/zoom from running on top of LeNota's canvas motion.
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [page?.id]);

  const publish = useCallback((nextContainers: NoteContainer[], nextInk = stateRef.current.ink, nextViewport = stateRef.current.viewport, nextShapes = stateRef.current.shapes, nextBackground = stateRef.current.background, nextAiMemory = stateRef.current.aiMemory) => {
    const validAiMemory=prunePageAiMemory(nextContainers,nextAiMemory);
    const document: CanvasDocument = { type:"lenota-canvas", version:3, viewport:nextViewport, containers:nextContainers, ink:nextInk, shapes:nextShapes, background:nextBackground, aiMemory:validAiMemory };
    pendingPublishRef.current = { contentJson: JSON.stringify(document), plainText: aggregateText(nextContainers) };
    if (publishScheduledRef.current) return;
    publishScheduledRef.current = true;
    queueMicrotask(() => {
      publishScheduledRef.current = false;
      const pending = pendingPublishRef.current;
      pendingPublishRef.current = null;
      if (pending) onChangeContentRef.current(pending.contentJson, pending.plainText);
    });
  }, []);
  useEffect(() => {
    if (!page) return;
    const fitKey=`lenota:canvas:v026:fitted:${page.id}`;
    try { if(localStorage.getItem(fitKey)==="1")return; } catch { /* fit is still safe without persistence */ }
    let secondFrame=0;
    const firstFrame=requestAnimationFrame(()=>{
      secondFrame=requestAnimationFrame(()=>{
        const rect=canvasRef.current?.getBoundingClientRect();
        const bounds=canvasDocumentBounds(stateRef.current.containers,stateRef.current.shapes,stateRef.current.ink);
        if(!rect||rect.width<240||rect.height<180||!bounds)return;
        const next=fitCanvasBounds(bounds,rect.width,rect.height,72,1.1);
        stateRef.current={...stateRef.current,viewport:next};
        setViewport(next);
        publish(stateRef.current.containers,stateRef.current.ink,next,stateRef.current.shapes,stateRef.current.background);
        try { localStorage.setItem(fitKey,"1"); } catch { /* optional migration marker */ }
      });
    });
    return()=>{cancelAnimationFrame(firstFrame);if(secondFrame)cancelAnimationFrame(secondFrame);};
  },[page,publish]);
  const pushHistory = useCallback(() => {
    const history = historyRef.current;
    history.undo.push({containers: deepClone(stateRef.current.containers), ink: deepClone(stateRef.current.ink), shapes: deepClone(stateRef.current.shapes), background: deepClone(stateRef.current.background), aiMemory: deepClone(stateRef.current.aiMemory)});
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
  }, []);
  const mutate = useCallback((fn:(items:NoteContainer[])=>NoteContainer[], record=false) => {
    if (record) pushHistory();
    const next=fn(stateRef.current.containers);
    const nextMemory=prunePageAiMemory(next,stateRef.current.aiMemory);
    stateRef.current={...stateRef.current,containers:next,aiMemory:nextMemory};
    setContainers(next);setAiMemory(nextMemory);
    publish(next,stateRef.current.ink,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background,nextMemory);
  },[publish,pushHistory]);
  const mutateInk = useCallback((fn:(items:InkStroke[])=>InkStroke[], record=false) => {
    if (record) pushHistory();
    setInk(current=>{const next=fn(current);stateRef.current={...stateRef.current,ink:next};publish(stateRef.current.containers,next);return next;});
  },[publish,pushHistory]);
  const mutateShapes = useCallback((fn:(items:CanvasShape[])=>CanvasShape[], record=false) => {
    if (record) pushHistory();
    setShapes(current=>{const next=fn(current);stateRef.current={...stateRef.current,shapes:next};publish(stateRef.current.containers,stateRef.current.ink,stateRef.current.viewport,next);return next;});
  },[publish,pushHistory]);
  const setContainersTransient = useCallback((fn:(items:NoteContainer[])=>NoteContainer[]) => {
    setContainers(current => {
      const next = fn(current);
      stateRef.current = { ...stateRef.current, containers: next };
      return next;
    });
  }, []);
  const setInkTransient = useCallback((fn:(items:InkStroke[])=>InkStroke[]) => {
    setInk(current => {
      const next = fn(current);
      stateRef.current = { ...stateRef.current, ink: next };
      return next;
    });
  }, []);
  const setShapesTransient = useCallback((fn:(items:CanvasShape[])=>CanvasShape[]) => {
    setShapes(current => {
      const next = fn(current);
      stateRef.current = { ...stateRef.current, shapes: next };
      return next;
    });
  }, []);
  const commitCanvas = useCallback(() => {
    publish(stateRef.current.containers, stateRef.current.ink, stateRef.current.viewport, stateRef.current.shapes, stateRef.current.background);
  }, [publish]);
  const updateBackground = useCallback((next:CanvasBackground) => {
    pushHistory();
    // Keep the render state, history state, and serialized page state on the
    // exact same CanvasBackground object. Previously React rendered `next`
    // while stateRef still pointed at the old paper, so a later viewport or
    // canvas mutation could publish the stale background back over the user's
    // Inspector change.
    stateRef.current={...stateRef.current,background:next};
    setBackground(next);
    publish(stateRef.current.containers,stateRef.current.ink,stateRef.current.viewport,stateRef.current.shapes,next);
  },[publish,pushHistory]);
  const registerEditor = useCallback((id:string, editor:Editor|null)=>{ if(editor)editorsRef.current.set(id,editor); else editorsRef.current.delete(id); },[]);
  const select = useCallback((id: string, additive=false) => {
    setFocusRequestId(null);
    // A Tiptap editor retains its NodeSelection when focus moves to another
    // note container. Clear math selections in every *other* editor so only
    // the equation in the currently interacted-with container can stay blue.
    editorsRef.current.forEach((editor, editorId) => {
      if (editorId !== id) clearSelectedMathNode(editor);
    });
    // If this pointer interaction is moving to another container, retire the
    // previous toolbar editor immediately. The new editor will claim the
    // toolbar from its normal onFocus callback. This also drops any pinned
    // Math selected inspector belonging to the old container.
    const targetEditor = editorsRef.current.get(id) ?? null;
    setActiveEditor(current => current && current !== targetEditor ? null : current);
    if (!additive) { setSelectedShapeIds(new Set()); setSelectedInkIds(new Set()); }
    setSelectedIds(current => {
      if (!additive) return new Set([id]);
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  },[]);
  const clearSelection = () => {
    editorsRef.current.forEach(editor => {
      clearSelectedMathNode(editor);
      if (editor.isFocused) editor.commands.blur();
    });
    setSelectedIds(new Set()); setSelectedShapeIds(new Set()); setSelectedInkIds(new Set()); setFocusRequestId(null); setActiveEditor(null);
  };
  const pruneEmptyContainer = useCallback((id:string) => {
    const item = stateRef.current.containers.find(container => container.id === id);
    if (!item || documentHasMeaningfulContent(item.content)) return;
    // OneNote-style: an abandoned empty note container should disappear instead of
    // leaving invisible hit targets scattered across the page.
    const next=stateRef.current.containers.filter(container=>container.id!==id);
    const nextMemory=prunePageAiMemory(next,stateRef.current.aiMemory);
    stateRef.current={...stateRef.current,containers:next,aiMemory:nextMemory};
    setContainers(next);setAiMemory(nextMemory);
    publish(next,stateRef.current.ink,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background,nextMemory);
    setSelectedIds(current => { const next = new Set(current); next.delete(id); return next; });
    setFocusRequestId(current => current === id ? null : current);
  }, [publish]);
  const addContainer = useCallback((x?:number,y?:number, content:JSONContent=EMPTY_DOC, text="", width=520) => {
    // Creating a new container is also a real selection change. Do not leave a
    // math atom in the previous container carrying a stale NodeSelection.
    editorsRef.current.forEach(clearSelectedMathNode);
    setActiveEditor(null);
    const rect=canvasRef.current?.getBoundingClientRect();
    const px=x ?? ((rect?.width ?? 800)/2 - viewport.x)/viewport.zoom - 260;
    const py=y ?? ((rect?.height ?? 600)/2 - viewport.y)/viewport.zoom - 80;
    const item:NoteContainer={id:newId(),x:px,y:py,width:clamp(width,MIN_WIDTH,MAX_WIDTH),minHeight:100,zIndex:Math.max(...stateRef.current.containers.map(i=>i.zIndex),0)+1,content,plainText:text};
    pushHistory();
    setContainers(items=>{const next=[...items,item];stateRef.current={...stateRef.current,containers:next};publish(next,stateRef.current.ink);return next;});
    setSelectedIds(new Set([item.id])); setFocusRequestId(item.id);
    return item.id;
  },[publish,pushHistory,viewport]);

  const collectPageMatches = useCallback((query: string) => {
    const matches: PageTextMatch[] = [];
    for (const item of stateRef.current.containers) {
      const editor = editorsRef.current.get(item.id);
      if (editor && !editor.isDestroyed) matches.push(...findMatchesInEditor(item.id, editor, query));
    }
    return matches;
  }, []);
  const revealFindMatch = useCallback((match: PageTextMatch, index: number, total: number) => {
    const editor = editorsRef.current.get(match.containerId);
    const item = stateRef.current.containers.find((container) => container.id === match.containerId);
    if (!editor || editor.isDestroyed || !item) return;
    setDrawingTool("select");
    setSelectedShapeIds(new Set()); setSelectedInkIds(new Set()); setSelectedIds(new Set([item.id]));
    setFocusRequestId(null); setActiveEditor(editor);
    editor.commands.setTextSelection({ from: match.from, to: match.to });
    editor.commands.focus();
    currentFindRef.current = match;
    setFindStatus(`${index + 1} of ${total}`);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      const zoom = stateRef.current.viewport.zoom;
      const next = {
        zoom,
        x: rect.width / 2 - (item.x + item.width / 2) * zoom,
        y: rect.height / 2 - (item.y + Math.max(item.minHeight, 100) / 2) * zoom,
      };
      stateRef.current = { ...stateRef.current, viewport: next };
      setViewport(next);
    }
  }, []);
  const findNext = useCallback((direction = 1) => {
    const matches = collectPageMatches(findQuery);
    if (!matches.length) { currentFindRef.current = null; setFindStatus(findQuery.trim() ? "No matches" : "Type to find"); return; }
    let index = findCursorRef.current;
    if (direction < 0) index = (index - 1 + matches.length) % matches.length;
    else index = index % matches.length;
    const match = matches[index];
    revealFindMatch(match, index, matches.length);
    findCursorRef.current = direction < 0 ? index : (index + 1) % matches.length;
  }, [collectPageMatches, findQuery, revealFindMatch]);
  const replaceCurrent = useCallback(() => {
    const match = currentFindRef.current;
    if (!match || !findQuery.trim()) { findNext(1); return; }
    const editor = editorsRef.current.get(match.containerId);
    if (!editor || editor.isDestroyed) return;
    const selected = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");
    if (selected.toLocaleLowerCase() !== findQuery.trim().toLocaleLowerCase()) { findNext(1); return; }
    editor.chain().focus().insertContent(replaceQuery).run();
    findCursorRef.current = 0;
    queueMicrotask(() => findNext(1));
  }, [findNext, findQuery, replaceQuery]);
  const replaceAll = useCallback(() => {
    const query = findQuery.trim();
    if (!query) return;
    let replaced = 0;
    for (const item of stateRef.current.containers) {
      const editor = editorsRef.current.get(item.id);
      if (!editor || editor.isDestroyed) continue;
      const matches = findMatchesInEditor(item.id, editor, query).sort((a,b)=>b.from-a.from);
      if (!matches.length) continue;
      let tr = editor.state.tr;
      for (const match of matches) { tr = tr.insertText(replaceQuery, match.from, match.to); replaced += 1; }
      editor.view.dispatch(tr);
    }
    currentFindRef.current = null; findCursorRef.current = 0; setFindStatus(`Replaced ${replaced}`);
  }, [findQuery, replaceQuery]);

  const insertManagedAttachment = useCallback((attachment: Attachment) => {
    const node = attachmentNode(attachment);
    const editor = activeEditor && !activeEditor.isDestroyed ? activeEditor : null;
    if (editor) {
      editor.chain().focus().insertContent(node).run();
      return;
    }
    const width = isAudioAttachment(attachment) ? 540 : isImageAttachment(attachment) ? 420 : 380;
    addContainer(undefined, undefined, { type: "doc", content: [node, { type: "paragraph" }] }, "", width);
  }, [activeEditor, addContainer]);

  const stopAudioRecording = useCallback(() => {
    const session = wavCaptureRef.current;
    if (!session) return;
    wavCaptureRef.current = null;
    session.processor.onaudioprocess = null;
    try { session.source.disconnect(); } catch { /* already disconnected */ }
    try { session.processor.disconnect(); } catch { /* already disconnected */ }
    try { session.sink.disconnect(); } catch { /* already disconnected */ }
    session.stream.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    if (recordingTimerRef.current !== null) { window.clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
    if (mountedRef.current) { setAudioRecording(false); setRecordingSeconds(0); }
    void session.context.close().catch(() => {});
    const bytes = encodePcm16Wav(session.chunks, session.sampleRate);
    if (bytes.byteLength <= 44) return;
    if (bytes.byteLength > 100_000_000) { if (mountedRef.current) window.alert("Recording exceeded the 100 MB per-recording limit and was not inserted."); return; }
    void (async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const attachment = await notesApi.importAttachmentBytes(session.pageId, `Recording ${stamp}.wav`, "audio/wav", Array.from(bytes));
      if (mountedRef.current && page?.id === session.pageId) {
        insertManagedAttachment(attachment);
        onAttachmentsChanged?.();
      }
    })().catch((error) => { console.error("Unable to save WAV recording", error); if (mountedRef.current) window.alert(`Unable to save audio recording: ${String(error)}`); });
  }, [page, insertManagedAttachment, onAttachmentsChanged]);

  const startAudioRecording = useCallback(async () => {
    if (!page || audioRecording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      window.alert("Audio recording is not available in this WebKitGTK build.");
      return;
    }
    if (!microphonePermissionApprovedRef.current) {
      const allowed = window.confirm("Allow LeNota to use your microphone for audio notes?\n\nThe microphone is only used while the red recording indicator is active.");
      if (!allowed) return;
      microphonePermissionApprovedRef.current = true;
    }
    try {
      await notesApi.prepareMicrophoneAccess();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mediaStreamRef.current = stream;
      const AudioContextCtor = window.AudioContext;
      if (!AudioContextCtor) throw new Error("Web Audio capture is unavailable in this WebKitGTK build.");
      const context = new AudioContextCtor();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const sink = context.createGain();
      sink.gain.value = 0;
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
      wavCaptureRef.current = { pageId: page.id, stream, context, source, processor, sink, chunks, sampleRate: context.sampleRate };
      setRecordingSeconds(0);
      setAudioRecording(true);
      recordingTimerRef.current = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
    } catch (error) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      const session = wavCaptureRef.current;
      wavCaptureRef.current = null;
      if (session) void session.context.close().catch(() => {});
      if (mountedRef.current) {
        setAudioRecording(false);
        window.alert(`Microphone access failed: ${String(error)}\n\nIf Fedora has microphone privacy disabled for applications, enable microphone access in System Settings and try again.`);
      }
    }
  }, [page, audioRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
      const session = wavCaptureRef.current;
      wavCaptureRef.current = null;
      if (session) {
        session.processor.onaudioprocess = null;
        session.stream.getTracks().forEach((track) => track.stop());
        void session.context.close().catch(() => {});
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const insertPdfPrintout = useCallback(async () => {
    if (!page) return;
    const sourcePath = await open({
      multiple: false,
      directory: false,
      title: "Insert PDF printout",
      filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    });
    if (!sourcePath || Array.isArray(sourcePath)) return;

    const qualityAnswer = window.prompt("PDF printout quality (96 = compact, 144 = standard, 200 = high, 300 = very high)", "144");
    if (qualityAnswer === null) return;
    const dpi = clamp(Number.parseInt(qualityAnswer, 10) || 144, 72, 300);
    const rangeAnswer = window.prompt("PDF page range: use all, a single page like 4, or a range like 2-8", "all")?.trim().toLowerCase();
    if (rangeAnswer === undefined) return;
    let firstPage: number | null = null;
    let lastPage: number | null = null;
    if (rangeAnswer && rangeAnswer !== "all") {
      const rangeMatch = rangeAnswer.match(/^(\d+)\s*-\s*(\d+)$/);
      const singleMatch = rangeAnswer.match(/^\d+$/);
      if (rangeMatch) { firstPage = Number(rangeMatch[1]); lastPage = Number(rangeMatch[2]); }
      else if (singleMatch) { firstPage = Number(rangeAnswer); lastPage = firstPage; }
      else { window.alert("Use 'all', a page number such as 4, or a range such as 2-8."); return; }
      if (!firstPage || !lastPage || firstPage > lastPage) { window.alert("That PDF page range is invalid."); return; }
    }
    const sizeAnswer = window.prompt("Inserted page image size: small, medium, large, or original", "large")?.trim().toLowerCase();
    if (sizeAnswer === undefined) return;
    const printoutSize: "auto" | "small" | "medium" | "large" = sizeAnswer === "small" || sizeAnswer === "medium" || sizeAnswer === "large" ? sizeAnswer : "auto";
    const autoOcr = window.confirm("Make this PDF printout searchable with local OCR after inserting it?\n\nChoose Cancel to insert pages without OCR.");
    const ocrLanguage = autoOcr ? (window.prompt("PDF OCR language (Tesseract code)", "eng")?.trim() || "eng") : null;

    try {
      // Keep the source PDF as a normal attachment and render managed page images
      // into the note, matching OneNote's printout model closely.
      await notesApi.importAttachment(page.id, sourcePath);
      const pages = await notesApi.renderPdfPrintout(page.id, sourcePath, { dpi, firstPage, lastPage });
      if (!pages.length) return;
      const nodes: JSONContent[] = [];
      for (const attachment of pages) {
        const node = attachmentNode(attachment);
        if (node.type === "image") {
          let ocrText: string | null = null;
          if (ocrLanguage) {
            try { ocrText = (await notesApi.ocrAttachment(attachment.id, ocrLanguage)).trim() || null; }
            catch (ocrError) { console.warn("PDF page OCR failed", attachment.fileName, ocrError); }
          }
          node.attrs = { ...(node.attrs ?? {}), imageSize: printoutSize, ocrText, printoutPage:true };
        }
        nodes.push(node);
      }
      const editor = activeEditor && !activeEditor.isDestroyed ? activeEditor : null;
      if (editor) editor.chain().focus().insertContent(nodes).run();
      else {
        const content = { type: "doc", content: [...nodes, { type: "paragraph" }] } as JSONContent;
        addContainer(undefined, undefined, content, "", printoutSize === "large" ? 940 : 760);
      }
      onAttachmentsChanged?.();
    } catch (error) {
      console.error("Unable to insert PDF printout", error);
      window.alert(String(error));
    }
  }, [page, activeEditor, addContainer, onAttachmentsChanged]);

  const syncViewportDom=(next:{x:number;y:number;zoom:number})=>{
    if(worldRef.current)worldRef.current.style.transform=canvasViewportTransform(next);
    if(canvasRef.current){
      const style=backgroundStyle(stateRef.current.background,theme,next);
      const position=String(style.backgroundPosition??"0 0");
      const size=String(style.backgroundSize??"auto");
      canvasRef.current.style.backgroundPosition=position;
      canvasRef.current.style.backgroundSize=size;
      canvasRef.current.style.setProperty("--ln-page-background-position",position);
      canvasRef.current.style.setProperty("--ln-page-background-size",size);
    }
    const label=`${Math.round(next.zoom*100)}%`;
    if(floatingZoomRef.current)floatingZoomRef.current.textContent=label;
    if(statusZoomRef.current)statusZoomRef.current.textContent=label;
  };
  const previewViewport=(next:{x:number;y:number;zoom:number})=>{
    const safe=normalizeCanvasViewport(next);
    stateRef.current={...stateRef.current,viewport:safe};
    pendingViewportDomRef.current=safe;
    // Wheel and pointer events can arrive much faster than the display can
    // draw. Coalesce them to one DOM transform per animation frame.
    if(viewportFrameRef.current===null){
      viewportFrameRef.current=requestAnimationFrame(()=>{
        viewportFrameRef.current=null;
        const pending=pendingViewportDomRef.current;
        pendingViewportDomRef.current=null;
        if(pending)syncViewportDom(pending);
      });
    }
    return safe;
  };
  const commitViewport=()=>{
    const safe=normalizeCanvasViewport(stateRef.current.viewport);
    stateRef.current={...stateRef.current,viewport:safe};
    if(viewportFrameRef.current!==null){cancelAnimationFrame(viewportFrameRef.current);viewportFrameRef.current=null;}
    pendingViewportDomRef.current=null;
    syncViewportDom(safe);
    setViewport(safe);
    publish(stateRef.current.containers,stateRef.current.ink,safe,stateRef.current.shapes,stateRef.current.background);
    wheelCommitRef.current=null;
  };
  const scheduleViewportCommit=(delay=140)=>{
    if(wheelCommitRef.current!==null)window.clearTimeout(wheelCommitRef.current);
    wheelCommitRef.current=window.setTimeout(commitViewport,delay);
  };
  const updateViewport=(next:{x:number;y:number;zoom:number})=>{
    if(wheelCommitRef.current!==null){window.clearTimeout(wheelCommitRef.current);wheelCommitRef.current=null;}
    previewViewport(next);
    commitViewport();
  };
  const copyContainerLink = useCallback((containerId: string) => {
    if (!page) return;
    const link = `lenota://page/${encodeURIComponent(page.id)}#container=${encodeURIComponent(containerId)}`;
    void navigator.clipboard.writeText(link).catch(() => { window.prompt("Copy link to note container", link); });
  }, [page]);

  const renderedCanvasTransform = useCallback(() => {
    const world=worldRef.current;
    if(world){
      const rect=world.getBoundingClientRect();
      return canvasTransformFromRenderedRect(rect,world.offsetWidth,world.offsetHeight,stateRef.current.viewport.zoom);
    }
    const rect=canvasRef.current?.getBoundingClientRect();
    const current=stateRef.current.viewport;
    return {left:(rect?.left??0)+current.x,top:(rect?.top??0)+current.y,scaleX:current.zoom,scaleY:current.zoom};
  },[]);
  const worldPoint = useCallback((clientX:number,clientY:number):InkPoint => {
    const point=clientToCanvasPoint(clientX,clientY,renderedCanvasTransform());
    return {...point,pressure:1};
  },[renderedCanvasTransform]);
  const worldDelta = useCallback((clientDx:number,clientDy:number) => clientDeltaToCanvasDelta(clientDx,clientDy,renderedCanvasTransform()),[renderedCanvasTransform]);
  const clientPoint = useCallback((x:number,y:number) => canvasToClientPoint(x,y,renderedCanvasTransform()),[renderedCanvasTransform]);

  useEffect(() => {
    if (!targetContainerId) return;
    const item = stateRef.current.containers.find((container) => container.id === targetContainerId);
    if (!item) { onTargetContainerHandled?.(); return; }
    setDrawingTool("select");
    setSelectedShapeIds(new Set());
    setSelectedInkIds(new Set());
    setSelectedIds(new Set([item.id]));
    setFocusRequestId(item.id);
    const frame = requestAnimationFrame(() => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const zoom = stateRef.current.viewport.zoom;
        const next = {
          zoom,
          x: rect.width / 2 - (item.x + item.width / 2) * zoom,
          y: rect.height / 2 - (item.y + Math.max(item.minHeight, 100) / 2) * zoom,
        };
        stateRef.current = { ...stateRef.current, viewport: next };
        setViewport(next);
        publish(stateRef.current.containers, stateRef.current.ink, next, stateRef.current.shapes, stateRef.current.background);
      }
      onTargetContainerHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [targetContainerId, onTargetContainerHandled, publish]);

  const undoCanvas = useCallback(() => {
    const history = historyRef.current;
    const snapshot = history.undo.pop();
    if (!snapshot) return;
    history.redo.push({containers:deepClone(stateRef.current.containers),ink:deepClone(stateRef.current.ink),shapes:deepClone(stateRef.current.shapes),background:deepClone(stateRef.current.background),aiMemory:deepClone(stateRef.current.aiMemory)});
    stateRef.current={...stateRef.current,containers:snapshot.containers,ink:snapshot.ink,shapes:snapshot.shapes,background:snapshot.background,aiMemory:snapshot.aiMemory};
    setContainers(snapshot.containers); setInk(snapshot.ink); setShapes(snapshot.shapes); setBackground(snapshot.background); setAiMemory(snapshot.aiMemory); publish(snapshot.containers,snapshot.ink,stateRef.current.viewport,snapshot.shapes,snapshot.background,snapshot.aiMemory); clearSelection();
  },[publish]);
  const redoCanvas = useCallback(() => {
    const history = historyRef.current;
    const snapshot = history.redo.pop();
    if (!snapshot) return;
    history.undo.push({containers:deepClone(stateRef.current.containers),ink:deepClone(stateRef.current.ink),shapes:deepClone(stateRef.current.shapes),background:deepClone(stateRef.current.background),aiMemory:deepClone(stateRef.current.aiMemory)});
    stateRef.current={...stateRef.current,containers:snapshot.containers,ink:snapshot.ink,shapes:snapshot.shapes,background:snapshot.background,aiMemory:snapshot.aiMemory};
    setContainers(snapshot.containers); setInk(snapshot.ink); setShapes(snapshot.shapes); setBackground(snapshot.background); setAiMemory(snapshot.aiMemory); publish(snapshot.containers,snapshot.ink,stateRef.current.viewport,snapshot.shapes,snapshot.background,snapshot.aiMemory); clearSelection();
  },[publish]);

  const insertAttachments = useCallback(async (paths:string[], clientX:number, clientY:number) => {
    if (!page || paths.length === 0) return;
    setDropActive(false);
    const imported: Attachment[] = [];
    for (const path of paths) {
      try { imported.push(await notesApi.importAttachment(page.id,path)); }
      catch (error) { console.error("Failed to import dropped file",path,error); }
    }
    if (!imported.length) return;
    onAttachmentsChanged?.();
    const element = document.elementFromPoint(clientX,clientY) as HTMLElement | null;
    const containerElement = element?.closest<HTMLElement>("[data-note-container-id]");
    const containerId = containerElement?.dataset.noteContainerId;
    const editor = containerId ? editorsRef.current.get(containerId) : null;
    if (editor) {
      const position = editor.view.posAtCoords({left:clientX,top:clientY})?.pos ?? editor.state.doc.content.size;
      editor.commands.insertContentAt(position, imported.map(attachmentNode));
      editor.commands.focus();
      setSelectedIds(new Set([containerId!]));
      setActiveEditor(editor);
      return;
    }
    const point=worldPoint(clientX,clientY);
    const images = imported.filter(isImageAttachment);
    const width = images.length ? 420 : 360;
    addContainer(point.x,point.y,documentForAttachments(imported),"",width);
  },[addContainer,onAttachmentsChanged,page,worldPoint]);

  insertAttachmentsRef.current = insertAttachments;

  // Register the native Tauri drop listener once. Registering it from a render-dependent
  // effect can leak listeners because onDragDropEvent resolves asynchronously, causing
  // one physical drop to be imported multiple times.
  useEffect(()=>{
    let disposed=false;
    let unlisten: (()=>void)|undefined;
    void getCurrentWebview().onDragDropEvent(event=>{
      const payload = event.payload;
      if (payload.type === "over") setDropActive(true);
      else if (payload.type === "leave") setDropActive(false);
      else if (payload.type === "drop") {
        setDropActive(false);
        const dpr = window.devicePixelRatio || 1;
        const paths=[...payload.paths];
        const x=payload.position.x/dpr, y=payload.position.y/dpr;
        const signature=`${paths.join("\u0000")}|${Math.round(x)}|${Math.round(y)}`;
        const now=performance.now();
        if(lastNativeDropRef.current.signature===signature && now-lastNativeDropRef.current.at<750)return;
        lastNativeDropRef.current={signature,at:now};
        void insertAttachmentsRef.current(paths,x,y);
      }
    }).then(fn=>{
      if(disposed) fn(); else unlisten=fn;
    });
    return()=>{disposed=true;unlisten?.();};
  },[]);

  useEffect(()=>{
    if(!page)return;
    const handlePaste=(event:ClipboardEvent)=>{
      const images=Array.from(event.clipboardData?.files??[]).filter(file=>file.type.startsWith("image/"));
      if(!images.length)return;
      event.preventDefault();
      void (async()=>{
        const imported:Attachment[]=[];
        for(const file of images){
          if(file.size>25_000_000){console.warn("Skipped pasted image larger than 25 MB",file.name);continue;}
          const bytes=Array.from(new Uint8Array(await file.arrayBuffer()));
          imported.push(await notesApi.importAttachmentBytes(page.id,file.name||`pasted-image-${Date.now()}.png`,file.type||"image/png",bytes));
        }
        if(!imported.length)return; onAttachmentsChanged?.();
        if(activeEditor){activeEditor.chain().focus().insertContent(imported.map(attachmentNode)).run();return;}
        addContainer(undefined,undefined,documentForAttachments(imported),"",420);
      })().catch(error=>console.error("Unable to paste image",error));
    };
    window.addEventListener("paste",handlePaste,true);return()=>window.removeEventListener("paste",handlePaste,true);
  },[activeEditor,addContainer,onAttachmentsChanged,page]);

  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(!page)return;
      const active=document.activeElement as HTMLElement | null;
      const typing=active?.getAttribute("contenteditable")==="true" || active?.tagName==="INPUT" || active?.tagName==="TEXTAREA" || active?.tagName==="SELECT";
      const commandKey=e.ctrlKey||e.metaKey;
      if(commandKey&&(e.key.toLowerCase()==="f"||e.key.toLowerCase()==="h")){e.preventDefault();setFindOpen(true);queueMicrotask(()=>document.querySelector<HTMLInputElement>("[data-page-find-input]")?.focus());return;}
      if(e.altKey&&e.shiftKey&&activeEditor&&!activeEditor.isDestroyed&&(e.key.toLowerCase()==="d"||e.key.toLowerCase()==="t")){
        e.preventDefault();
        const text=e.key.toLowerCase()==="d"?new Intl.DateTimeFormat(undefined,{dateStyle:"medium"}).format(new Date()):new Intl.DateTimeFormat(undefined,{timeStyle:"short"}).format(new Date());
        activeEditor.chain().focus().insertContent(text).run();return;
      }
      if(commandKey&&e.altKey&&e.key.toLowerCase()==="m"&&activeEditor&&!activeEditor.isDestroyed){e.preventDefault();insertOrEditMath(activeEditor);return;}
      if(commandKey&&!typing&&(e.key.toLowerCase()==="c"||e.key.toLowerCase()==="x")&&(selectedIds.size||selectedShapeIds.size||selectedInkIds.size)){
        e.preventDefault();
        clipboardRef.current={containers:deepClone(stateRef.current.containers.filter(item=>selectedIds.has(item.id))),shapes:deepClone(stateRef.current.shapes.filter(item=>selectedShapeIds.has(item.id))),ink:deepClone(stateRef.current.ink.filter(item=>selectedInkIds.has(item.id)))};
        if(e.key.toLowerCase()==="x"){pushHistory();const cids=new Set(selectedIds),sids=new Set(selectedShapeIds),iids=new Set(selectedInkIds);const nextShapes=stateRef.current.shapes.filter(item=>!sids.has(item.id));const nextInk=stateRef.current.ink.filter(item=>!iids.has(item.id));const nextContainers=stateRef.current.containers.filter(item=>!cids.has(item.id));const nextMemory=prunePageAiMemory(nextContainers,stateRef.current.aiMemory);stateRef.current={...stateRef.current,containers:nextContainers,shapes:nextShapes,ink:nextInk,aiMemory:nextMemory};setShapes(nextShapes);setInk(nextInk);setContainers(nextContainers);setAiMemory(nextMemory);publish(nextContainers,nextInk,stateRef.current.viewport,nextShapes,stateRef.current.background,nextMemory);clearSelection();}
        return;
      }
      if(commandKey&&!typing&&e.key.toLowerCase()==="v"&&(clipboardRef.current.containers.length||clipboardRef.current.shapes.length||clipboardRef.current.ink.length)){
        e.preventDefault();pushHistory();const top=Math.max(...stateRef.current.containers.map(item=>item.zIndex),0);
        const pastedContainers=clipboardRef.current.containers.map((item,index)=>({...deepClone(item),id:newId(),x:item.x+36,y:item.y+36,zIndex:top+index+1}));
        const pastedShapes=clipboardRef.current.shapes.map(item=>({...deepClone(item),id:newId(),x1:item.x1+36,y1:item.y1+36,x2:item.x2+36,y2:item.y2+36}));
        const pastedInk=clipboardRef.current.ink.map(item=>({...deepClone(item),id:newId(),points:item.points.map(point=>({...point,x:point.x+36,y:point.y+36}))}));
        const nextShapes=[...stateRef.current.shapes,...pastedShapes], nextInk=[...stateRef.current.ink,...pastedInk];setShapes(nextShapes);setInk(nextInk);setContainers(items=>{const next=[...items,...pastedContainers];stateRef.current={...stateRef.current,containers:next,shapes:nextShapes,ink:nextInk};publish(next,nextInk,stateRef.current.viewport,nextShapes);return next;});setSelectedIds(new Set(pastedContainers.map(item=>item.id)));setSelectedShapeIds(new Set(pastedShapes.map(item=>item.id)));setSelectedInkIds(new Set(pastedInk.map(item=>item.id)));return;
      }
      if((e.ctrlKey||e.metaKey)&&e.altKey&&e.key.toLowerCase()==="n"){e.preventDefault();addContainer();}
      if(commandKey&&!typing&&e.key.toLowerCase()==="a"){e.preventDefault();setSelectedIds(new Set(stateRef.current.containers.map(item=>item.id)));setSelectedShapeIds(new Set(stateRef.current.shapes.map(item=>item.id)));setSelectedInkIds(new Set(stateRef.current.ink.map(item=>item.id)));setActiveEditor(null);return;}
      if(commandKey&&!typing&&e.key.toLowerCase()==="d"&&(selectedIds.size||selectedShapeIds.size||selectedInkIds.size)){
        e.preventDefault();pushHistory();const top=Math.max(...stateRef.current.containers.map(item=>item.zIndex),0);
        const copies=stateRef.current.containers.filter(item=>selectedIds.has(item.id)).map((item,index)=>({...deepClone(item),id:newId(),x:item.x+28,y:item.y+28,zIndex:top+index+1}));
        let nextShapeZ=Math.max(0,...stateRef.current.shapes.map(item=>item.zIndex??0)); const shapeCopies=stateRef.current.shapes.filter(item=>selectedShapeIds.has(item.id)).map(item=>({...deepClone(item),id:newId(),x1:item.x1+28,y1:item.y1+28,x2:item.x2+28,y2:item.y2+28,zIndex:++nextShapeZ}));
        const inkCopies=stateRef.current.ink.filter(item=>selectedInkIds.has(item.id)).map(item=>({...deepClone(item),id:newId(),points:item.points.map(point=>({...point,x:point.x+28,y:point.y+28}))}));
        const nextShapes=[...stateRef.current.shapes,...shapeCopies], nextInk=[...stateRef.current.ink,...inkCopies];setShapes(nextShapes);setInk(nextInk);setContainers(current=>{const next=[...current,...copies];stateRef.current={...stateRef.current,containers:next,shapes:nextShapes,ink:nextInk};publish(next,nextInk,stateRef.current.viewport,nextShapes);return next;});setSelectedIds(new Set(copies.map(item=>item.id)));setSelectedShapeIds(new Set(shapeCopies.map(item=>item.id)));setSelectedInkIds(new Set(inkCopies.map(item=>item.id)));return;
      }
      if(e.key==="Escape"){
        if(findOpen){e.preventDefault();setFindOpen(false);currentFindRef.current=null;setFindStatus("");return;}
        if(drawingTool!=="select"){e.preventDefault();setDrawingTool("select");return;}
        if(activeEditor?.isFocused){e.preventDefault();activeEditor.commands.blur();setActiveEditor(null);return;}
        clearSelection();
      }
      if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==="z" && document.activeElement?.getAttribute("contenteditable")!=="true"){e.preventDefault();redoCanvas();}
      else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z" && document.activeElement?.getAttribute("contenteditable")!=="true"){e.preventDefault();undoCanvas();}
      if((e.key==="Delete"||e.key==="Backspace")&&(selectedIds.size||selectedShapeIds.size||selectedInkIds.size)&&!typing){
        e.preventDefault();pushHistory();
        const ids=new Set(selectedIds); const shapeIds=new Set(selectedShapeIds); const inkIds=new Set(selectedInkIds);
        const nextShapes=stateRef.current.shapes.filter(s=>!shapeIds.has(s.id));
        const nextInk=stateRef.current.ink.filter(stroke=>!inkIds.has(stroke.id));
        const nextContainers=stateRef.current.containers.filter(item=>!ids.has(item.id));
        const nextMemory=prunePageAiMemory(nextContainers,stateRef.current.aiMemory);
        stateRef.current={...stateRef.current,containers:nextContainers,shapes:nextShapes,ink:nextInk,aiMemory:nextMemory};
        setShapes(nextShapes);setInk(nextInk);setContainers(nextContainers);setAiMemory(nextMemory);
        publish(nextContainers,nextInk,stateRef.current.viewport,nextShapes,stateRef.current.background,nextMemory);
        clearSelection();
      }
      if((selectedIds.size||selectedShapeIds.size||selectedInkIds.size)&&!typing&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){
        e.preventDefault();const step=e.shiftKey?10:1;
        const dx=e.key==="ArrowRight"?step:e.key==="ArrowLeft"?-step:0;
        const dy=e.key==="ArrowDown"?step:e.key==="ArrowUp"?-step:0;
        pushHistory();
        const ids=new Set(selectedIds), shapeIds=new Set(selectedShapeIds), inkIds=new Set(selectedInkIds);
        const nextContainers=stateRef.current.containers.map(i=>ids.has(i.id)?{...i,x:i.x+dx,y:i.y+dy}:i);
        const nextShapes=stateRef.current.shapes.map(i=>shapeIds.has(i.id)?{...i,x1:i.x1+dx,y1:i.y1+dy,x2:i.x2+dx,y2:i.y2+dy}:i);
        const nextInk=stateRef.current.ink.map(stroke=>inkIds.has(stroke.id)?{...stroke,points:stroke.points.map(point=>({...point,x:point.x+dx,y:point.y+dy}))}:stroke);
        setContainers(nextContainers);setShapes(nextShapes);setInk(nextInk);stateRef.current={...stateRef.current,containers:nextContainers,shapes:nextShapes,ink:nextInk};publish(nextContainers,nextInk,stateRef.current.viewport,nextShapes);
      }
    };
    window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);
  },[activeEditor,addContainer,drawingTool,findOpen,mutate,page,publish,pushHistory,redoCanvas,selectedIds,selectedShapeIds,selectedInkIds,undoCanvas]);

  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{
      const active=document.activeElement as HTMLElement|null;
      const typing=active?.getAttribute("contenteditable")==="true"||["INPUT","TEXTAREA","SELECT"].includes(active?.tagName??"");
      if(e.code==="Space"&&!typing&&!e.repeat){e.preventDefault();setSpacePanning(true);}
    };
    const up=(e:KeyboardEvent)=>{if(e.code==="Space")setSpacePanning(false);};
    const blur=()=>setSpacePanning(false);
    window.addEventListener("keydown",down);window.addEventListener("keyup",up);window.addEventListener("blur",blur);
    return()=>{window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);window.removeEventListener("blur",blur);};
  },[]);

  if(!page)return <main className="grid h-full min-h-0 min-w-0 place-items-center bg-[#222226] text-sm text-neutral-500">Select or create a page.</main>;
  const pageTagIds=new Set(page.tags.map(t=>t.id)); const unusedTags=availableTags.filter(t=>!pageTagIds.has(t.id));
  const focusPageOptions=focusPages.length
    ? focusPages
    : [linkablePages.find(item=>item.id===page.id)??{id:page.id,title:title.trim()||"Untitled page",notebookName:"",sectionName:""}];
  const zoomAt=(factor:number,clientX?:number,clientY?:number,transient=false)=>{
    const rect=canvasRef.current?.getBoundingClientRect();
    const cx=clientX!==undefined?clientX-(rect?.left??0):(rect?.width??800)/2;
    const cy=clientY!==undefined?clientY-(rect?.top??0):(rect?.height??600)/2;
    const current=stateRef.current.viewport;
    const nextZoom=clamp(current.zoom*factor,.35,2.5);
    const worldX=(cx-current.x)/current.zoom,worldY=(cy-current.y)/current.zoom;
    const next={zoom:nextZoom,x:cx-worldX*nextZoom,y:cy-worldY*nextZoom};
    if(transient){previewViewport(next);scheduleViewportCommit();}
    else updateViewport(next);
  };
  const wheelCanvas=(e:WheelEvent)=>{
    e.preventDefault();
    // WebKitGTK can report wheel deltas in pixels, lines, or pages. Treating a
    // page-sized delta as pixels caused apparently random multi-screen jumps.
    const rect = canvasRef.current?.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? Math.max(480, rect?.height ?? 720) : 1;
    const dx = clamp(e.deltaX * unit, -180, 180);
    const dy = clamp(e.deltaY * unit, -180, 180);
    if(e.ctrlKey || e.metaKey){
      if (Math.abs(dy) < 0.01) return;
      // Trackpad pinch on WebKitGTK arrives as Ctrl+wheel. Use the magnitude
      // instead of a fixed zoom step so two-finger pinch feels continuous.
      const factor=clamp(Math.exp(-dy*0.0028),.84,1.19);
      zoomAt(factor,e.clientX,e.clientY,true);
      return;
    }
    const current=stateRef.current.viewport;
    const horizontal=e.shiftKey&&Math.abs(dx)<1?dy:dx;
    const vertical=e.shiftKey&&Math.abs(dx)<1?0:dy;
    const next={...current,x:clamp(current.x-horizontal,-50000,50000),y:clamp(current.y-vertical,-50000,50000)};
    previewViewport(next);
    scheduleViewportCommit();
  };
  wheelHandlerRef.current=wheelCanvas;
  const startPan=(e:ReactPointerEvent<HTMLDivElement>)=>{
    const middleButton = e.button === 1;
    if(!middleButton && (drawingTool!=="select" || (!e.shiftKey&&!spacePanning)))return;
    e.preventDefault();
    const sx=e.clientX,sy=e.clientY,startViewport=stateRef.current.viewport;
    const applyPan=(clientX:number,clientY:number)=>{
      const next={...startViewport,x:startViewport.x+clientX-sx,y:startViewport.y+clientY-sy};
      return previewViewport(next);
    };
    const move=(p:PointerEvent)=>{applyPan(p.clientX,p.clientY);};
    const up=(p:PointerEvent)=>{applyPan(p.clientX,p.clientY);commitViewport();window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up)};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
  };
  const selectOrCreate=(e:ReactPointerEvent<HTMLDivElement>)=>{
    if(drawingTool!=="select" || e.button!==0 || e.shiftKey || spacePanning)return;
    const target=e.target as HTMLElement;
    if(target.closest(".note-container,.canvas-shape,button,input,select,.canvas-floating-ui"))return;
    e.preventDefault();
    editorsRef.current.forEach(editor => { if (editor.isFocused) editor.commands.blur(); });
    setActiveEditor(null);
    const start=worldPoint(e.clientX,e.clientY); const startClient={x:e.clientX,y:e.clientY}; let dragged=false;
    const move=(p:PointerEvent)=>{
      const current=worldPoint(p.clientX,p.clientY);
      if(Math.hypot(p.clientX-startClient.x,p.clientY-startClient.y)>5)dragged=true;
      if(dragged)setMarquee({x:Math.min(start.x,current.x),y:Math.min(start.y,current.y),width:Math.abs(current.x-start.x),height:Math.abs(current.y-start.y)});
    };
    const up=(p:PointerEvent)=>{
      const current=worldPoint(p.clientX,p.clientY);
      window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);
      setMarquee(null);
      if(!dragged){clearSelection();addContainer(start.x,start.y);return;}
      const box={left:Math.min(start.x,current.x),top:Math.min(start.y,current.y),right:Math.max(start.x,current.x),bottom:Math.max(start.y,current.y)};
      setSelectedIds(new Set(stateRef.current.containers.filter(item=>{
        const element=canvasRef.current?.querySelector<HTMLElement>(`[data-note-container-id="${item.id}"]`);
        if(!element)return item.x<box.right&&item.x+item.width>box.left&&item.y<box.bottom&&item.y+item.minHeight>box.top;
        const rect=element.getBoundingClientRect();
        const topLeft=worldPoint(rect.left,rect.top),bottomRight=worldPoint(rect.right,rect.bottom);
        return topLeft.x<box.right&&bottomRight.x>box.left&&topLeft.y<box.bottom&&bottomRight.y>box.top;
      }).map(item=>item.id)));
      setSelectedShapeIds(new Set(stateRef.current.shapes.filter(shape=>{const b=rotatedShapeBounds(shape);return b.left<box.right&&b.right>box.left&&b.top<box.bottom&&b.bottom>box.top}).map(shape=>shape.id)));
      setSelectedInkIds(new Set(stateRef.current.ink.filter(stroke=>{const b=strokeBounds(stroke);return b.left<box.right&&b.right>box.left&&b.top<box.bottom&&b.bottom>box.top}).map(stroke=>stroke.id)));
      setActiveEditor(null);
    };
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
  };
  const findInkTargetContainer = useCallback((strokes:InkStroke[]):NoteContainer|undefined=>{
    const bounds=inkGroupBounds(strokes);if(!bounds)return;
    const targets=stateRef.current.containers.map(item=>{
      const element=canvasRef.current?.querySelector<HTMLElement>(`[data-note-container-id="${item.id}"]`);
      if(!element)return {id:item.id,zIndex:item.zIndex,bounds:{left:item.x,top:item.y,right:item.x+item.width,bottom:item.y+item.minHeight}};
      const rect=element.getBoundingClientRect();
      const topLeft=worldPoint(rect.left,rect.top),bottomRight=worldPoint(rect.right,rect.bottom);
      return {id:item.id,zIndex:item.zIndex,bounds:{left:topLeft.x,top:topLeft.y,right:bottomRight.x,bottom:bottomRight.y}};
    });
    const id=chooseInkContainerTarget(bounds,targets);
    return id?stateRef.current.containers.find(item=>item.id===id):undefined;
  },[worldPoint]);
  const replaceInkGroupWithContainer = useCallback((strokes:InkStroke[], content:JSONContent, text:string, preferredWidth?:number) => {
    const bounds=inkGroupBounds(strokes); if(!bounds)return;
    const ids=new Set(strokes.map(stroke=>stroke.id));
    const nextInk=stateRef.current.ink.filter(stroke=>!ids.has(stroke.id));
    const target=findInkTargetContainer(strokes);
    const targetEditor=target?editorsRef.current.get(target.id):undefined;
    if(target&&targetEditor&&!targetEditor.isDestroyed){
      const blocks=content.type==="doc"?(content.content??[]):[content];
      if(blocks.length){
        pushHistory();
        let inserted=false;
        if(!documentHasMeaningfulContent(targetEditor.getJSON())){
          inserted=targetEditor.commands.setContent(content,{emitUpdate:false});
        }else{
          const centerClient=clientPoint((bounds.left+bounds.right)/2,(bounds.top+bounds.bottom)/2);
          const hit=targetEditor.view.posAtCoords({left:centerClient.x,top:centerClient.y});
          const position=hit?.pos??targetEditor.state.doc.content.size;
          const caret=targetEditor.view.coordsAtPos(position);
          const inlineTemplate=blocks.length===1&&blocks[0]?.type==="paragraph"&&blocks[0].content?.length===1&&blocks[0].content[0]?.type==="text"
            ?blocks[0].content[0]:null;
          const canInsertInline=!!hit&&!!inlineTemplate&&!text.includes("\n")&&
            isOnRenderedTextLine(centerClient.y,caret.top,caret.bottom);
          if(canInsertInline&&inlineTemplate){
            const documentSize=targetEditor.state.doc.content.size;
            const before=targetEditor.state.doc.textBetween(Math.max(0,position-1),position,"\n");
            const after=targetEditor.state.doc.textBetween(position,Math.min(documentSize,position+1),"\n");
            const inlineText=textForInlineHandwriting(text,before,after);
            inserted=!!inlineText&&targetEditor.commands.insertContentAt(position,{...inlineTemplate,text:inlineText},{updateSelection:false});
          }else{
            let blockPosition=targetEditor.state.doc.content.size;
            if(hit){
              const resolved=targetEditor.state.doc.resolve(position);
              if(resolved.depth>=1)blockPosition=centerClient.y<caret.top?resolved.before(1):resolved.after(1);
            }
            inserted=targetEditor.commands.insertContentAt(blockPosition,blocks,{updateSelection:false});
          }
        }
        if(inserted){
          const updatedContent=targetEditor.getJSON();
          const updatedItem={...target,content:updatedContent,plainText:extractDocumentSearchText(updatedContent)};
          const nextContainers=stateRef.current.containers.map(item=>item.id===target.id?updatedItem:item);
          recentMathConversionsRef.current.delete(target.id);
          setLatestRecentMathId(current=>current===target.id?null:current);
          stateRef.current={...stateRef.current,containers:nextContainers,ink:nextInk};
          setContainers(nextContainers);setInk(nextInk);
          publish(nextContainers,nextInk,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background);
          setSelectedInkIds(new Set());setSelectedShapeIds(new Set());setSelectedIds(new Set([target.id]));setFocusRequestId(null);
          return {item:updatedItem,appended:true};
        }
      }
    }
    const width=clamp(preferredWidth??Math.max(220,bounds.right-bounds.left+40),MIN_WIDTH,MAX_WIDTH);
    const item:NoteContainer={id:newId(),x:bounds.left,y:bounds.top,width,minHeight:Math.max(72,bounds.bottom-bounds.top+30),zIndex:Math.max(0,...stateRef.current.containers.map(container=>container.zIndex))+1,content,plainText:text};
    pushHistory();
    const nextContainers=[...stateRef.current.containers,item];
    setInk(nextInk);setContainers(nextContainers);
    stateRef.current={...stateRef.current,ink:nextInk,containers:nextContainers};
    publish(nextContainers,nextInk,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background);
    setSelectedInkIds(new Set());setSelectedShapeIds(new Set());setSelectedIds(new Set([item.id]));setFocusRequestId(null);
    return {item,appended:false};
  },[clientPoint,findInkTargetContainer,publish,pushHistory]);
  const replaceInkGroupWithShape = useCallback((strokes:InkStroke[], recognized:{kind:CanvasShape["kind"];x1:number;y1:number;x2:number;y2:number}) => {
    const ids=new Set(strokes.map(stroke=>stroke.id));
    const nextInk=stateRef.current.ink.filter(stroke=>!ids.has(stroke.id));
    const shape:CanvasShape={id:newId(),...recognized,stroke:convertedInkColor(strokes,theme)??penColor,fill:"transparent",strokeWidth:Math.max(.1,strokes[0]?.width??2),zIndex:Math.max(0,...stateRef.current.shapes.map(item=>item.zIndex??0))+1};
    const nextShapes=[...stateRef.current.shapes,shape];
    pushHistory();setInk(nextInk);setShapes(nextShapes);stateRef.current={...stateRef.current,ink:nextInk,shapes:nextShapes};
    publish(stateRef.current.containers,nextInk,stateRef.current.viewport,nextShapes,stateRef.current.background);
    setSelectedInkIds(new Set());setSelectedIds(new Set());setSelectedShapeIds(new Set([shape.id]));
  },[penColor,publish,pushHistory,theme]);
  const recognizeInkGroupCloud = useCallback(async(strokes:InkStroke[],mode:"auto"|"math"|"text")=>{
    if(cloudAiReadiness!=="ready")throw new Error("Gemini Cloud AI is not configured. Click Cloud setup in the drawing toolbar first.");
    setCloudAiBusy(true);
    setAutoInkStatus(mode==="math"?"Gemini is reading math…":mode==="text"?"Gemini is reading handwriting…":"Gemini is reading ink…");
    try{
      const bytes=await rasterizeInkGroup(strokes,mode==="text"?"text":"math");
      const result=await notesApi.recognizeCloudInk(bytes,mode,inkRecognitionLanguage,cloudInkVectorHint(strokes),15_000);
      setCloudAiError("");
      return result;
    }catch(error){
      const message=(error instanceof Error?error.message:String(error)).slice(0,2400);
      setCloudAiError(message);
      throw error;
    }finally{setCloudAiBusy(false);}
  },[cloudAiReadiness,inkRecognitionLanguage]);
  const recognizeInkGroupText = useCallback(async(strokes:InkStroke[])=>{
    const result=await recognizeInkGroupCloud(strokes,"text");
    if(result.kind!=="text")throw new Error("Gemini did not return handwriting text.");
    return {text:result.text.trim(),confidence:null as number|null,engine:result.engine};
  },[recognizeInkGroupCloud]);
  const recognizeInkGroupMath = useCallback(async(strokes:InkStroke[]):Promise<StabilizedMathRecognition>=>{
    const result=await recognizeInkGroupCloud(strokes,"math");
    if(result.kind!=="math")throw new Error("Gemini did not return mathematical LaTeX.");
    const recognized=stabilizeRecognizedLatex(result.latex.trim());
    if(!recognized.latex||!recognized.valid)throw new CloudLatexError(recognized.error||"Gemini returned invalid LaTeX.");
    setAutoInkStatus("Gemini math ready ✓");
    return {...recognized,issues:[...recognized.issues,"Gemini whole-expression vision"]};
  },[recognizeInkGroupCloud]);
  const configureGeminiCloud = useCallback(async(forgetKey=false)=>{
    if(forgetKey){
      if(!window.confirm("Forget the saved Gemini API key and disable Cloud AI?"))return;
      try{
        await notesApi.configureCloudAi(null);
        setCloudAiReadiness("missing");setCloudAiError("");setAutoInkStatus("Gemini key removed");
      }catch(error){window.alert("Unable to remove the Gemini key: "+String(error));}
      return;
    }
    if(cloudAiReadiness==="ready"){
      window.alert("Gemini Cloud AI is configured and is the active recognizer for handwritten text, math, and /ask. Each /ask request also includes the current page's text, tables, code, and LaTeX equations as page memory. Shift-click the button to forget the key.");
      return;
    }
    const approved=window.confirm(
      "Enable Gemini Cloud AI?\n\nHandwriting images sent for recognition are uploaded to Google Gemini. When you use /ask, the request and the current page's text, tables, code, and LaTeX equations are uploaded so Gemini can answer using the page as memory. Other pages are not uploaded. Google states that free-tier submissions may be used to improve its products.\n\nCreate a Gemini API key at https://aistudio.google.com/app/apikey and then return here. Continue?"
    );
    if(!approved)return;
    const apiKey=window.prompt("Paste your Gemini API key. It will be stored in LeNota app data with owner-only file permissions.")?.trim();
    if(!apiKey)return;
    setCloudAiReadiness("checking");
    try{
      const status=await notesApi.configureCloudAi(apiKey);
      setCloudAiReadiness(status.configured?"ready":"missing");
      setCloudAiError("");
      setAutoInkStatus(status.configured?"Gemini Cloud AI enabled":"Gemini setup failed");
    }catch(error){
      setCloudAiReadiness("missing");
      window.alert("Gemini setup failed: "+String(error));
    }
  },[cloudAiReadiness]);
  const registerMathConversion = useCallback((item:NoteContainer|undefined,strokes:InkStroke[],latex:string)=>{
    if(!item)return;
    const bounds=inkGroupBounds(strokes);if(!bounds)return;
    const revision=Date.now();
    recentMathConversionsRef.current.set(item.id,{
      containerId:item.id,
      sourceStrokes:deepClone(strokes),
      bounds:{...bounds},
      latex,
      revision,
      expiresAt:Date.now()+RECENT_MATH_EDIT_WINDOW_MS,
    });
    setLatestRecentMathId(item.id);
    if(recentMathExpiryTimerRef.current!==null)window.clearTimeout(recentMathExpiryTimerRef.current);
    recentMathExpiryTimerRef.current=window.setTimeout(()=>{
      const entry=recentMathConversionsRef.current.get(item.id);
      if(entry?.revision===revision&&entry.expiresAt<=Date.now())recentMathConversionsRef.current.delete(item.id);
      setLatestRecentMathId(current=>current===item.id?null:current);
      recentMathExpiryTimerRef.current=null;
    },RECENT_MATH_EDIT_WINDOW_MS+50);
    setAutoInkStatus("Gemini math converted ✓");
  },[]);
  const confirmAllMath = useCallback(()=>{
    const confirmed=confirmAllRecentMathConversions(recentMathConversionsRef.current);
    if(recentMathExpiryTimerRef.current!==null){
      window.clearTimeout(recentMathExpiryTimerRef.current);
      recentMathExpiryTimerRef.current=null;
    }
    setLatestRecentMathId(null);
    if(!confirmed)return;
    setAutoInkStatus(confirmed===1?"Math confirmed ✓":`${confirmed} equations confirmed ✓`);
  },[]);
  const reopenRecentMathAt = useCallback((point:{x:number;y:number})=>{
    const now=Date.now();
    for(const [id,entry] of recentMathConversionsRef.current){
      if(entry.expiresAt<now){recentMathConversionsRef.current.delete(id);continue;}
      if(!stateRef.current.containers.some(container=>container.id===entry.containerId)){recentMathConversionsRef.current.delete(id);continue;}
    }
    const bestId=findReopenableMathConversion(recentMathConversionsRef.current,point,now);
    if(!bestId)return false;
    const entry=recentMathConversionsRef.current.get(bestId);if(!entry)return false;
    recentMathConversionsRef.current.delete(bestId);
    setLatestRecentMathId(current=>{
      if(current!==bestId)return current;
      if(recentMathExpiryTimerRef.current!==null){window.clearTimeout(recentMathExpiryTimerRef.current);recentMathExpiryTimerRef.current=null;}
      return null;
    });
    const sourceIds=new Set(entry.sourceStrokes.map(stroke=>stroke.id));
    const existingIds=new Set(stateRef.current.ink.map(stroke=>stroke.id));
    const restored=entry.sourceStrokes.filter(stroke=>!existingIds.has(stroke.id)).map(stroke=>deepClone(stroke));
    const nextInk=[...stateRef.current.ink,...restored];
    const nextContainers=stateRef.current.containers.filter(container=>container.id!==entry.containerId);
    stateRef.current={...stateRef.current,ink:nextInk,containers:nextContainers};
    setInk(nextInk);setContainers(nextContainers);
    sourceIds.forEach(id=>autoInkPendingRef.current.add(id));
    publish(nextContainers,nextInk,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background);
    setSelectedIds(new Set());setActiveEditor(null);setAutoInkStatus("Math reopened · keep writing…");
    return true;
  },[publish]);
  const runAutoInkRecognition = useCallback(async(ids:Set<string>)=>{
    if(!autoInkEnabled||autoInkRunningRef.current||!ids.size)return;
    const strokes=stateRef.current.ink.filter(stroke=>ids.has(stroke.id)&&stroke.tool==="pen");
    if(!strokes.length)return;
    const generation=autoInkGenerationRef.current;
    const requeueIfChanged=async(delay:number)=>{
      await new Promise(resolve=>window.setTimeout(resolve,delay));
      if(autoInkGenerationRef.current===generation)return false;
      strokes.forEach(stroke=>autoInkPendingRef.current.add(stroke.id));
      setAutoInkStatus("Grouping ink…");
      return true;
    };
    const waitForMathContinuation=async(latex:string)=>{
      if(!mathNeedsContinuation(latex))return false;
      const partialGeneration=autoInkGenerationRef.current;
      setAutoInkStatus("Math: add limits/body…");
      await new Promise(resolve=>window.setTimeout(resolve,1400));
      if(autoInkGenerationRef.current===partialGeneration)return false;
      strokes.forEach(stroke=>autoInkPendingRef.current.add(stroke.id));
      setAutoInkStatus("Grouping full math expression…");
      return true;
    };
    autoInkRunningRef.current=true;
    try{
      if(autoInkMode==="shape"||autoInkMode==="smart"){
        const geometry=recognizeInkGeometry(strokes);
        if(geometry){
          const bounds=inkGroupBounds(strokes);
          const diagonal=bounds?Math.hypot(bounds.right-bounds.left,bounds.bottom-bounds.top):0;
          const area=bounds?Math.max(0,(bounds.right-bounds.left)*(bounds.bottom-bounds.top)):0;
          const kind=geometry.shape.kind;
          const threshold=kind==="arrow"?.90:kind==="line"?.92:kind==="ellipse"?.88:.90;
          const largeEnough=kind==="line"?diagonal>=110:(kind==="ellipse"||kind==="rectangle")?area>=4300&&diagonal>=58:diagonal>=58;
          if(autoInkMode==="shape"){
            if(geometry.confidence>=.74){replaceInkGroupWithShape(strokes,geometry.shape);setAutoInkStatus("Shape converted ✓");return;}
            setAutoInkStatus("Need a clearer shape");return;
          }
          if(geometry.confidence>=threshold&&largeEnough){
            replaceInkGroupWithShape(strokes,geometry.shape);setAutoInkStatus("Shape converted ✓");return;
          }
        }else if(autoInkMode==="shape"){
          setAutoInkStatus("Need a clearer shape");return;
        }
      }
      if(cloudAiReadiness!=="ready"){
        setAutoInkStatus("Cloud setup required · ink kept");
        return;
      }
      const result=await recognizeInkGroupCloud(strokes,autoInkMode==="smart"?"auto":autoInkMode);
      if(await requeueIfChanged(result.kind==="math"?260:90))return;
      if(result.kind==="math"){
        const math=stabilizeRecognizedLatex(result.latex.trim());
        if(!math.valid||math.suspicious||!math.latex){setAutoInkStatus("Gemini math needs review · ink kept");return;}
        if(await waitForMathContinuation(math.latex))return;
        const bounds=inkGroupBounds(strokes);if(!bounds)return;
        const drawnSize={width:Math.max(24,bounds.right-bounds.left),height:Math.max(16,bounds.bottom-bounds.top)};
        const placement=replaceInkGroupWithContainer(strokes,mathDocument(math.latex,true,drawnSize,convertedInkColor(strokes,theme)),math.latex,Math.max(260,drawnSize.width+80));
        if(placement?.appended)setAutoInkStatus("Gemini math added to note ✓");
        else registerMathConversion(placement?.item,strokes,math.latex);
        return;
      }
      const text=result.text.trim();
      if(!text){setAutoInkStatus("Gemini found no handwriting · ink kept");return;}
      const content=recognizedTextDocument(text,strokes,theme,inkOutputFontFamily);
      const bounds=inkGroupBounds(strokes);
      const placement=replaceInkGroupWithContainer(strokes,content,text,bounds?Math.max(MIN_WIDTH,bounds.right-bounds.left+36):undefined);
      setAutoInkStatus(placement?.appended?"Gemini text added to note ✓":"Gemini text converted ✓");
    }catch(error){
      console.warn("Gemini recognition left the original ink unchanged",error);
      const message=String(error);
      setAutoInkStatus(/429|RESOURCE_EXHAUSTED/i.test(message)?"Gemini rate limit · ink kept":/timeout/i.test(message)?"Gemini timed out · ink kept":"Gemini unavailable · ink kept");
    }finally{
      autoInkRunningRef.current=false;
      window.setTimeout(()=>setAutoInkStatus(""),2600);
    }
  },[autoInkEnabled,autoInkMode,cloudAiReadiness,inkOutputFontFamily,recognizeInkGroupCloud,registerMathConversion,replaceInkGroupWithContainer,replaceInkGroupWithShape,theme]);
  const scheduleAutoInkRecognition = useCallback((strokeId:string)=>{
    if(!autoInkEnabled)return;
    autoInkGenerationRef.current += 1;
    autoInkPendingRef.current.add(strokeId);
    if(autoInkTimerRef.current!==null)window.clearTimeout(autoInkTimerRef.current);
    const flush=()=>{
      if(autoInkRunningRef.current){autoInkTimerRef.current=window.setTimeout(flush,450);return;}
      const ids=new Set(autoInkPendingRef.current);autoInkPendingRef.current.clear();autoInkTimerRef.current=null;
      void runAutoInkRecognition(ids);
    };
    autoInkTimerRef.current=window.setTimeout(flush,autoInkDelay);
  },[autoInkDelay,autoInkEnabled,runAutoInkRecognition]);

  const captureVisualSelection = useCallback(async(polygon:InkPoint[])=>{
    const bounds=visualSelectionBounds(polygon);if(!bounds)throw new Error("Draw a larger lasso around the part you want to ask about.");
    const world=worldRef.current??canvasRef.current?.querySelector<HTMLElement>(".canvas-world");
    if(!world)throw new Error("The page canvas is unavailable.");
    await waitForVisualCaptureFrame();
    const scale=Math.min(2,1600/Math.max(bounds.width,bounds.height));
    const outputWidth=Math.max(1,Math.round(bounds.width*scale));
    const outputHeight=Math.max(1,Math.round(bounds.height*scale));
    const hiddenClasses=new Set([
      "canvas-floating-ui","note-container-chrome","note-container-outline","note-container-resize",
      "mixed-selection-box","shape-selection-box","shape-resize-handle","shape-rotate-handle",
      "shape-endpoint-handle","ink-selection-box","lasso-preview",
    ]);
    const foregroundClasses=new Set(["canvas-shapes-layer","canvas-ink-layer"]);
    const intersectsSelection=(image:HTMLImageElement)=>{
      const rect=image.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return false;
      const topLeft=worldPoint(rect.left,rect.top),bottomRight=worldPoint(rect.right,rect.bottom);
      return topLeft.x<bounds.right&&bottomRight.x>bounds.left&&topLeft.y<bounds.bottom&&bottomRight.y>bounds.top;
    };
    const selectedImages=[...world.querySelectorAll<HTMLImageElement>("img")].filter(intersectsSelection).sort((a,b)=>{
      const containerZ=(image:HTMLImageElement)=>Number.parseInt(getComputedStyle(image.closest<HTMLElement>("[data-note-container-id]")??image).zIndex||"0",10)||0;
      return containerZ(a)-containerZ(b);
    });
    const captureStyle={
      transform:`translate(${-bounds.left}px, ${-bounds.top}px)`,
      transformOrigin:"top left",position:"relative",left:"0",top:"0",width:"8000px",height:"8000px",
    } as const;
    const commonCapture={
      width:Math.ceil(bounds.width),height:Math.ceil(bounds.height),
      canvasWidth:outputWidth,canvasHeight:outputHeight,pixelRatio:1,
      cacheBust:false,preferredFontFormat:"woff2" as const,
    };

    // html-to-image is dependable for text/SVG/CSS in WebKitGTK, but asking it
    // to clone IMG resources creates a second, unnecessary image load. That
    // load is what intermittently rejected with a bare browser `error` event.
    // Keep the image frames at their current layout size, exclude IMG nodes
    // entirely, and composite the original managed image/PDF bytes below.
    let base:Blob;
    let foreground:Blob|null=null;
    const releaseImageLayout=guardVisualImageLayout(world);
    try{
      base=await captureDomBlobWithRetry(world,{
        ...commonCapture,backgroundColor:background.color,style:captureStyle,
        filter:node=>{
          const element=node as HTMLElement;
          if(element?.classList&&[...foregroundClasses].some(className=>element.classList.contains(className)))return false;
          return shouldCaptureVisualBaseNode(node,hiddenClasses);
        },
      },"Visible page capture");

      if(world.querySelector(".canvas-shapes-layer,.canvas-ink-layer")){
        foreground=await captureDomBlobWithRetry(world,{
          ...commonCapture,backgroundColor:"transparent",
          style:{...captureStyle,background:"transparent",backgroundImage:"none"},
          filter:node=>{
            const element=node as HTMLElement;
            if(element===world)return true;
            if(!shouldCaptureVisualNode(node,hiddenClasses))return false;
            if(!element?.closest)return false;
            return Boolean(element.closest(".canvas-shapes-layer,.canvas-ink-layer"));
          },
        },"Drawing overlay capture");
      }
    }finally{releaseImageLayout();}

    const canvas=document.createElement("canvas");canvas.width=outputWidth;canvas.height=outputHeight;
    const context=canvas.getContext("2d");if(!context)throw new Error("LeNota could not compose the selected image.");
    context.save();
    context.beginPath();
    polygon.forEach((point,index)=>{
      const x=(point.x-bounds.left)*scale,y=(point.y-bounds.top)*scale;
      if(index===0)context.moveTo(x,y);else context.lineTo(x,y);
    });
    context.closePath();context.clip();

    const baseImage=await decodeVisualBlobForCanvas(base,"Visible page capture");
    try{context.drawImage(baseImage.source,0,0,outputWidth,outputHeight);}finally{baseImage.dispose();}

    for(const image of selectedImages){
      const rect=image.getBoundingClientRect();
      const center=worldPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      const fallbackScale=renderedCanvasTransform();
      const logicalWidth=image.offsetWidth>0?image.offsetWidth:rect.width/Math.max(.0001,fallbackScale.scaleX);
      const logicalHeight=image.offsetHeight>0?image.offsetHeight:rect.height/Math.max(.0001,fallbackScale.scaleY);
      const rotation=Number(image.dataset.imageRotation??0);
      const placement=visualImageDrawPlacement(center,logicalWidth,logicalHeight,rotation,bounds,scale);
      if(placement.width<=0||placement.height<=0)continue;
      const opacity=clamp(Number.parseFloat(getComputedStyle(image).opacity||"1"),0,1);
      let decoded:DecodedVisualBlob|null=null;
      let source:CanvasImageSource|null=null;
      try{
        const blob=await visualImageBlob(image);
        try{
          decoded=await decodeVisualBlobForCanvas(blob,"Selected image/PDF layer");
          source=decoded.source;
        }catch(error){
          // The managed bytes are preferred, but WebKit can occasionally fail
          // a decoder even though the exact same element is already rendered.
          // Reuse those resident pixels instead of failing the whole selection.
          if(image.complete&&image.naturalWidth>0&&image.naturalHeight>0)source=image;
          else throw error;
        }
        if(!source)throw new Error("Selected image/PDF layer produced no drawable pixels.");
        context.save();
        try{
          context.globalAlpha=opacity;
          context.translate(placement.centerX,placement.centerY);
          context.rotate(placement.rotationRadians);
          context.drawImage(source,-placement.width/2,-placement.height/2,placement.width,placement.height);
        }finally{context.restore();}
      }catch(error){
        if(!source&&image.complete&&image.naturalWidth>0&&image.naturalHeight>0){
          context.save();
          try{
            context.globalAlpha=opacity;
            context.translate(placement.centerX,placement.centerY);
            context.rotate(placement.rotationRadians);
            context.drawImage(image,-placement.width/2,-placement.height/2,placement.width,placement.height);
          }finally{context.restore();}
        }else throw error;
      }finally{decoded?.dispose();}
    }

    if(foreground){
      const foregroundImage=await decodeVisualBlobForCanvas(foreground,"Drawing overlay capture");
      try{context.drawImage(foregroundImage.source,0,0,outputWidth,outputHeight);}finally{foregroundImage.dispose();}
    }
    context.restore();
    const masked=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("LeNota could not encode the selected image.")),"image/png"));
    return {bounds,bytes:Array.from(new Uint8Array(await masked.arrayBuffer()))};
  },[background.color,renderedCanvasTransform,worldPoint]);

  const askAboutVisualSelection = useCallback(async(polygon:InkPoint[])=>{
    if(cloudAiReadiness!=="ready"){
      window.alert("Gemini Cloud AI is not configured. Click Cloud setup, then use Ask selection again.");return;
    }
    if(cloudAiBusy)return;
    const prompt=window.prompt("What do you want to ask Gemini about this selected region?","Explain this part clearly.")?.trim();
    if(!prompt)return;
    setCloudAiBusy(true);setAiTaskStatus("Capturing selected region…");
    try{
      const capture=await captureVisualSelection(polygon);
      setAiTaskStatus("Gemini is examining the selection…");
      const pageContext=buildPageAiContext(title,stateRef.current.containers.map(item=>({
        id:item.id,x:item.x,y:item.y,content:editorsRef.current.get(item.id)?.getJSON()??item.content,
      })),stateRef.current.aiMemory);
      const response=await notesApi.cloudAskSelection(capture.bytes,prompt,pageContext,30_000);
      const generated=makeGeneratedLatexRenderSafe(cloudBlocksToTiptap(response.blocks));
      const blocks=generated.nodes;
      const content:JSONContent={type:"doc",content:blocks};
      const answer=renderPageContentForAi(blocks);
      const width=clamp(Math.max(420,Math.min(680,capture.bounds.width)),MIN_WIDTH,MAX_WIDTH);
      const x=capture.bounds.right+24+width<=8000?capture.bounds.right+24:Math.max(0,capture.bounds.left-width-24);
      const item:NoteContainer={
        id:newId(),x,y:Math.max(0,capture.bounds.top),width,minHeight:120,
        zIndex:Math.max(0,...stateRef.current.containers.map(container=>container.zIndex))+1,
        content,plainText:extractDocumentSearchText(content),
      };
      const nextMemory=[...stateRef.current.aiMemory,{prompt:`[Visual selection] ${prompt}`,answer,createdAt:Date.now(),containerId:item.id}].slice(-50);
      pushHistory();
      const nextContainers=[...stateRef.current.containers,item];
      stateRef.current={...stateRef.current,containers:nextContainers,aiMemory:nextMemory};
      setContainers(nextContainers);setAiMemory(nextMemory);setSelectedIds(new Set([item.id]));
      setSelectedInkIds(new Set());setSelectedShapeIds(new Set());setFocusRequestId(null);setDrawingTool("select");
      publish(nextContainers,stateRef.current.ink,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background,nextMemory);
      setCloudAiError("");setAiTaskStatus("Gemini visual answer inserted ✓");
      window.setTimeout(()=>setAiTaskStatus(current=>current==="Gemini visual answer inserted ✓"?"":current),2600);
    }catch(error){
      const message=describeVisualCaptureError(error).slice(0,2400);
      setCloudAiError(message);setAiTaskStatus("");
      window.alert(`Ask selection failed: ${message}\n\nNothing on the page was changed.`);
    }finally{setCloudAiBusy(false);}
  },[captureVisualSelection,cloudAiBusy,cloudAiReadiness,publish,pushHistory,title]);

  const drawPointerDownCapture=(e:ReactPointerEvent<HTMLDivElement>)=>{
    if(drawingTool==="select" || e.button!==0)return;
    const point={...worldPoint(e.clientX,e.clientY),pressure:e.pressure>0?e.pressure:.5};
    const eventTarget=e.target as HTMLElement;
    if(drawingTool==="fill"){
      const shapeElement=eventTarget.closest<SVGElement>(".canvas-shape");
      const shapeId=shapeElement?.dataset.shapeId;
      const shape=shapeId?stateRef.current.shapes.find(item=>item.id===shapeId):undefined;
      if(!shape || (shape.kind!=="rectangle"&&shape.kind!=="ellipse"))return;
      e.preventDefault();e.stopPropagation();
      const fill=shapeFillColor==="transparent"?"#8b5cf6":shapeFillColor;
      if(shapeFillColor==="transparent")setShapeFillColor(fill);
      mutateShapes(items=>items.map(item=>item.id===shape.id?{...item,fill}:item),true);
      setSelectedShapeIds(new Set([shape.id]));
      setSelectedIds(new Set());setSelectedInkIds(new Set());setActiveEditor(null);
      return;
    }
    const directManipulation=eventTarget.closest(".canvas-floating-ui,.shape-selection-box,.shape-resize-handle,.shape-rotate-handle,.shape-endpoint-handle,.ink-selection-box,.note-container-chrome,.note-container-resize,button,input,select,a");
    const noteContainer=eventTarget.closest<HTMLElement>("[data-note-container-id]");
    // Direct-manipulation UI always wins over the currently armed drawing tool.
    // Exception: a recent automatic math container is still an active ink
    // session. Pen-down inside it must restore its source strokes before the
    // container swallows the event, or limits/body strokes get fragmented.
    const recentId=noteContainer?.dataset.noteContainerId;
    const canReopenRecentMath=drawingTool==="pen"&&autoInkEnabled&&
      (autoInkMode==="smart"||autoInkMode==="math")&&!!recentId&&recentMathConversionsRef.current.has(recentId);
    const canDrawOverNote=!!noteContainer&&(drawingTool==="pen"||drawingTool==="highlighter"||drawingTool==="eraser"||drawingTool==="ask");
    if(directManipulation||noteContainer&&!(canDrawOverNote||canReopenRecentMath))return;
    e.preventDefault();e.stopPropagation();
    // Invalidate an in-flight automatic recognition as soon as the user starts
    // the next pen stroke, not only after pointer-up. This prevents the previous
    // symbol from committing while the next symbol is literally being drawn.
    if(drawingTool==="pen"&&autoInkEnabled)autoInkGenerationRef.current += 1;
    if(drawingTool==="pen"&&autoInkEnabled&&(autoInkMode==="smart"||autoInkMode==="math"))reopenRecentMathAt(point);
    if(drawingTool==="lasso"||drawingTool==="ask"){
      const askMode=drawingTool==="ask";
      clearSelection();
      const polygon:InkPoint[]=[point];
      setLassoPath(polygon);
      const move=(p:PointerEvent)=>{
        const current={...worldPoint(p.clientX,p.clientY),pressure:.5};
        const last=polygon[polygon.length-1];
        if(!last || Math.hypot(current.x-last.x,current.y-last.y)>2/stateRef.current.viewport.zoom){
          polygon.push(current);
          setLassoPath([...polygon]);
        }
      };
      const up=()=>{
        setLassoPath(null);
        if(askMode){
          window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);
          void askAboutVisualSelection([...polygon]);return;
        }
        const inkIds=new Set(stateRef.current.ink.filter(stroke=>{
          if(stroke.points.some(strokePoint=>pointInPolygon(strokePoint,polygon)))return true;
          const center=strokeBounds(stroke);
          return pointInPolygon({x:(center.left+center.right)/2,y:(center.top+center.bottom)/2,pressure:.5},polygon);
        }).map(stroke=>stroke.id));
        const shapeIds=new Set(stateRef.current.shapes.filter(shape=>shapeIntersectsPolygon(shape,polygon)).map(shape=>shape.id));
        const containerIds=new Set(stateRef.current.containers.filter(item=>{
          const element=canvasRef.current?.querySelector<HTMLElement>(`[data-note-container-id="${item.id}"]`);
          let left=item.x,top=item.y,right=item.x+item.width,bottom=item.y+item.minHeight;
          if(element){
            const rect=element.getBoundingClientRect();
            const a=worldPoint(rect.left,rect.top),b=worldPoint(rect.right,rect.bottom);
            left=a.x;top=a.y;right=b.x;bottom=b.y;
          }
          const samples=[
            {x:left,y:top,pressure:.5},{x:right,y:top,pressure:.5},
            {x:right,y:bottom,pressure:.5},{x:left,y:bottom,pressure:.5},
            {x:(left+right)/2,y:(top+bottom)/2,pressure:.5},
          ];
          // Wide note containers often contain only a short token at their
          // upper-left edge (for example a limit "5"). Lasso the visible
          // content, not only the mostly empty resizable box.
          const contentBounds=containerMathContentBounds(item);
          samples.push(
            {x:contentBounds.left,y:contentBounds.top,pressure:.5},
            {x:(contentBounds.left+contentBounds.right)/2,y:(contentBounds.top+contentBounds.bottom)/2,pressure:.5},
          );
          return samples.some(sample=>pointInPolygon(sample,polygon));
        }).map(item=>item.id));
        setSelectedInkIds(inkIds);
        setSelectedShapeIds(shapeIds);
        setSelectedIds(containerIds);
        setActiveEditor(null);
        window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);
      };
      window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);return;
    }
    if(drawingTool==="eraser"){
      pushHistory();
      const erase=(p:PointerEvent)=>{const at={...worldPoint(p.clientX,p.clientY),pressure:.5};setInk(items=>eraseInkAt(items,at,10/stateRef.current.viewport.zoom));};
      setInk(items=>eraseInkAt(items,point,10/stateRef.current.viewport.zoom));
      const up=()=>{setInk(current=>{publish(stateRef.current.containers,current);return current;});window.removeEventListener("pointermove",erase);window.removeEventListener("pointerup",up)};
      window.addEventListener("pointermove",erase);window.addEventListener("pointerup",up); return;
    }
    if(drawingTool==="rectangle"||drawingTool==="ellipse"||drawingTool==="line"||drawingTool==="arrow"){
      pushHistory(); clearSelection();
      const shape:CanvasShape={id:newId(),kind:drawingTool,x1:point.x,y1:point.y,x2:point.x,y2:point.y,stroke:penColor,fill:(drawingTool==="rectangle"||drawingTool==="ellipse")?shapeFillColor:"transparent",strokeWidth:penWidth,zIndex:Math.max(0,...stateRef.current.shapes.map(item=>item.zIndex??0))+1};
      shapeDrawingRef.current=shape; setShapes(items=>[...items,shape]); setSelectedShapeIds(new Set([shape.id]));
      const move=(p:PointerEvent)=>{
        const current=worldPoint(p.clientX,p.clientY);
        let x2=current.x,y2=current.y;
        if(p.shiftKey){
          const dx=current.x-shape.x1,dy=current.y-shape.y1;
          if(shape.kind==="rectangle"||shape.kind==="ellipse"){const size=Math.max(Math.abs(dx),Math.abs(dy));x2=shape.x1+Math.sign(dx||1)*size;y2=shape.y1+Math.sign(dy||1)*size;}
          else {const length=Math.hypot(dx,dy);const angle=Math.round(Math.atan2(dy,dx)/(Math.PI/4))*(Math.PI/4);x2=shape.x1+Math.cos(angle)*length;y2=shape.y1+Math.sin(angle)*length;}
        }
        setShapes(items=>items.map(item=>item.id===shape.id?{...item,x2,y2}:item));
      };
      const up=()=>{shapeDrawingRef.current=null;setShapes(current=>{publish(stateRef.current.containers,stateRef.current.ink,stateRef.current.viewport,current);return current;});window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);};
      window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);return;
    }
    pushHistory();
    const stroke:InkStroke={id:newId(),tool:drawingTool,color:drawingTool==="highlighter"?highlighterColor:penColor,width:drawingTool==="highlighter"?highlighterWidth:penWidth,points:[point]};
    drawingRef.current=stroke; setInk(items=>[...items,stroke]);
    const move=(p:PointerEvent)=>{const current={...worldPoint(p.clientX,p.clientY),pressure:p.pressure>0?p.pressure:.5};setInk(items=>items.map(item=>item.id===stroke.id?{...item,points:[...item.points,current]}:item));};
    const up=()=>{drawingRef.current=null;setInk(current=>{stateRef.current={...stateRef.current,ink:current};publish(stateRef.current.containers,current);if(stroke.tool==="pen")scheduleAutoInkRecognition(stroke.id);return current;});window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
  };
  const moveSelected=(sourceId:string,dx:number,dy:number)=>{const ids=selectedIds.has(sourceId)?new Set(selectedIds):new Set([sourceId]);setContainersTransient(items=>items.map(i=>ids.has(i.id)?{...i,x:i.x+dx,y:i.y+dy}:i));};
  const deleteContainer=(id:string)=>{pushHistory();const next=stateRef.current.containers.filter(item=>item.id!==id);const nextMemory=prunePageAiMemory(next,stateRef.current.aiMemory);stateRef.current={...stateRef.current,containers:next,aiMemory:nextMemory};setContainers(next);setAiMemory(nextMemory);publish(next,stateRef.current.ink,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background,nextMemory);setSelectedIds(current=>{const selected=new Set(current);selected.delete(id);return selected;});setActiveEditor(null);};
  const duplicateContainer=(item:NoteContainer)=>{const copy={...deepClone(item),id:newId(),x:item.x+32,y:item.y+32,zIndex:Math.max(...containers.map(i=>i.zIndex),0)+1};pushHistory();setContainers(items=>{const next=[...items,copy];publish(next,stateRef.current.ink);return next;});setSelectedIds(new Set([copy.id]));};
  const alignSelected=(axis:"left"|"top")=>{
    const containerItems=stateRef.current.containers.filter(i=>selectedIds.has(i.id));
    const shapeItems=stateRef.current.shapes.filter(i=>selectedShapeIds.has(i.id));
    if(containerItems.length+shapeItems.length<2)return;
    pushHistory();
    const bounds=[...containerItems.map(item=>({id:item.id,type:"container" as const,b:{left:item.x,top:item.y,right:item.x+item.width,bottom:item.y+item.minHeight}})),...shapeItems.map(item=>({id:item.id,type:"shape" as const,b:rotatedShapeBounds(item)}))];
    const target=axis==="left"?Math.min(...bounds.map(item=>item.b.left)):Math.min(...bounds.map(item=>item.b.top));
    const containerDelta=new Map(bounds.filter(item=>item.type==="container").map(item=>[item.id,axis==="left"?target-item.b.left:target-item.b.top]));
    const shapeDelta=new Map(bounds.filter(item=>item.type==="shape").map(item=>[item.id,axis==="left"?target-item.b.left:target-item.b.top]));
    const nextContainers=stateRef.current.containers.map(item=>containerDelta.has(item.id)?{...item,[axis==="left"?"x":"y"]:item[axis==="left"?"x":"y"]+containerDelta.get(item.id)!}:item);
    const nextShapes=stateRef.current.shapes.map(item=>{const delta=shapeDelta.get(item.id);if(delta===undefined)return item;return axis==="left"?{...item,x1:item.x1+delta,x2:item.x2+delta}:{...item,y1:item.y1+delta,y2:item.y2+delta};});
    setContainers(nextContainers);setShapes(nextShapes);stateRef.current={...stateRef.current,containers:nextContainers,shapes:nextShapes};publish(nextContainers,stateRef.current.ink,stateRef.current.viewport,nextShapes);
  };
  const snapSelectedToGrid=()=>{
    if(!selectedIds.size&&!selectedShapeIds.size&&!selectedInkIds.size)return;
    pushHistory();
    const step=background.pattern==="plain"?20:background.spacing;
    const snap=(value:number)=>Math.round(value/step)*step;
    const nextContainers=stateRef.current.containers.map(item=>selectedIds.has(item.id)?{...item,x:snap(item.x),y:snap(item.y)}:item);
    const nextShapes=stateRef.current.shapes.map(item=>{if(!selectedShapeIds.has(item.id))return item;const b=rotatedShapeBounds(item),dx=snap(b.left)-b.left,dy=snap(b.top)-b.top;return {...item,x1:item.x1+dx,y1:item.y1+dy,x2:item.x2+dx,y2:item.y2+dy};});
    const nextInk=stateRef.current.ink.map(item=>{if(!selectedInkIds.has(item.id))return item;const b=strokeBounds(item),dx=snap(b.left)-b.left,dy=snap(b.top)-b.top;return {...item,points:item.points.map(point=>({...point,x:point.x+dx,y:point.y+dy}))};});
    setContainers(nextContainers);setShapes(nextShapes);setInk(nextInk);stateRef.current={...stateRef.current,containers:nextContainers,shapes:nextShapes,ink:nextInk};publish(nextContainers,nextInk,stateRef.current.viewport,nextShapes);
  };
  const layerSelected=(front:boolean)=>{
    if(!selectedIds.size&&!selectedShapeIds.size)return;
    pushHistory();
    let nextContainers=stateRef.current.containers;
    let nextShapes=stateRef.current.shapes;
    if(selectedIds.size){
      const selected=new Set(selectedIds);
      const boundary=front?Math.max(...nextContainers.map(i=>i.zIndex),0)+1:Math.min(...nextContainers.map(i=>i.zIndex),0)-selected.size-1;
      let offset=0;
      nextContainers=nextContainers.map(i=>selected.has(i.id)?{...i,zIndex:boundary+offset++}:i);
    }
    if(selectedShapeIds.size){
      const selected=new Set(selectedShapeIds);
      const values=nextShapes.map(i=>i.zIndex??0);
      const boundary=front?Math.max(...values,0)+1:Math.min(...values,0)-selected.size-1;
      let offset=0;
      nextShapes=nextShapes.map(i=>selected.has(i.id)?{...i,zIndex:boundary+offset++}:i);
    }
    setContainers(nextContainers);setShapes(nextShapes);stateRef.current={...stateRef.current,containers:nextContainers,shapes:nextShapes};publish(nextContainers,stateRef.current.ink,stateRef.current.viewport,nextShapes);
  };
  const fillSelectedShapes=(fill:string)=>{
    const ids=new Set(selectedShapeIds);
    if(!stateRef.current.shapes.some(item=>ids.has(item.id)&&(item.kind==="rectangle"||item.kind==="ellipse")))return;
    mutateShapes(items=>items.map(item=>ids.has(item.id)&&(item.kind==="rectangle"||item.kind==="ellipse")?{...item,fill}:item),true);
  };
  const applyShapeFill=(fill:string)=>{
    setShapeFillColor(fill);
    fillSelectedShapes(fill);
  };
  const distributeSelected=(axis:"horizontal"|"vertical")=>{
    if(selectedIds.size<3)return; const selected=containers.filter(i=>selectedIds.has(i.id)); pushHistory();
    if(axis==="horizontal"){const sorted=[...selected].sort((a,b)=>a.x-b.x);const min=sorted[0].x,max=sorted[sorted.length-1].x,step=(max-min)/(sorted.length-1);const positions=new Map(sorted.map((item,index)=>[item.id,min+index*step]));mutate(items=>items.map(i=>positions.has(i.id)?{...i,x:positions.get(i.id)!}:i));}
    else {const sorted=[...selected].sort((a,b)=>a.y-b.y);const min=sorted[0].y,max=sorted[sorted.length-1].y,step=(max-min)/(sorted.length-1);const positions=new Map(sorted.map((item,index)=>[item.id,min+index*step]));mutate(items=>items.map(i=>positions.has(i.id)?{...i,y:positions.get(i.id)!}:i));}
  };
  const mergeSelectedContainers=()=>{
    if(selectedIds.size<2)return; const chosen=containers.filter(item=>selectedIds.has(item.id)).sort((a,b)=>a.y-b.y||a.x-b.x); pushHistory();
    const mergedContent:JSONContent={type:"doc",content:chosen.flatMap((item,index)=>[...(item.content.content??[]),...(index<chosen.length-1?[{type:"paragraph"} as JSONContent]:[])])};
    const merged:NoteContainer={id:newId(),x:Math.min(...chosen.map(i=>i.x)),y:Math.min(...chosen.map(i=>i.y)),width:Math.max(...chosen.map(i=>i.width)),minHeight:Math.max(MIN_HEIGHT,...chosen.map(i=>i.minHeight)),zIndex:Math.max(...containers.map(i=>i.zIndex),0)+1,content:mergedContent,plainText:chosen.map(i=>i.plainText).filter(Boolean).join("\n\n")};
    const ids=new Set(selectedIds);setContainers(items=>{const next=[...items.filter(item=>!ids.has(item.id)),merged];publish(next);return next;});setSelectedIds(new Set([merged.id]));setFocusRequestId(merged.id);
  };
  const beginShapeHandle=(shape:CanvasShape,handle:"nw"|"ne"|"sw"|"se"|"start"|"end"|"rotate",event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.button===1)return;
    event.preventDefault();event.stopPropagation();pushHistory();
    const original=deepClone(shape), bounds=shapeBounds(original);
    const originalCenter={x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2};
    const angle=original.rotation??0;
    const rotateVector=(x:number,y:number,degrees:number)=>{
      const r=degrees*Math.PI/180,c=Math.cos(r),sn=Math.sin(r);
      return {x:x*c-y*sn,y:x*sn+y*c};
    };
    const move=(p:PointerEvent)=>{
      const current=worldPoint(p.clientX,p.clientY);
      setShapesTransient(items=>items.map(item=>{
        if(item.id!==shape.id)return item;
        if(handle==="rotate"){
          const degrees=Math.atan2(current.y-originalCenter.y,current.x-originalCenter.x)*180/Math.PI+90;
          const snapped=p.shiftKey?Math.round(degrees/15)*15:Math.round(degrees*10)/10;
          return {...item,rotation:snapped};
        }
        if(handle==="start")return {...item,x1:current.x,y1:current.y};
        if(handle==="end")return {...item,x2:current.x,y2:current.y};

        // Resize in the shape's own rotated coordinate frame while pinning the
        // opposite corner in world space. This keeps resize handles stable
        // after any rotation instead of changing the rotation pivot mid-drag.
        const west=handle.includes("w"), north=handle.includes("n");
        const oppositeLocal={x:west?bounds.right:bounds.left,y:north?bounds.bottom:bounds.top};
        const oppositeWorld=rotatePoint(oppositeLocal.x,oppositeLocal.y,originalCenter.x,originalCenter.y,angle);
        const deltaWorld={x:current.x-oppositeWorld.x,y:current.y-oppositeWorld.y};
        const deltaLocal=rotateVector(deltaWorld.x,deltaWorld.y,-angle);
        const minSize=18;
        const signedWidth=(west?-1:1)*Math.max(minSize,Math.abs(deltaLocal.x));
        const signedHeight=(north?-1:1)*Math.max(minSize,Math.abs(deltaLocal.y));
        const correctedWorldDelta=rotateVector(signedWidth,signedHeight,angle);
        const draggedWorld={x:oppositeWorld.x+correctedWorldDelta.x,y:oppositeWorld.y+correctedWorldDelta.y};
        const center={x:(oppositeWorld.x+draggedWorld.x)/2,y:(oppositeWorld.y+draggedWorld.y)/2};
        let width=Math.abs(signedWidth),height=Math.abs(signedHeight);
        if(p.shiftKey){
          const ratio=Math.max(0.01,(bounds.right-bounds.left)/Math.max(1,bounds.bottom-bounds.top));
          if(width/Math.max(1,height)>ratio)height=width/ratio;else width=height*ratio;
          const constrainedDelta=rotateVector((west?-1:1)*width,(north?-1:1)*height,angle);
          const constrainedDragged={x:oppositeWorld.x+constrainedDelta.x,y:oppositeWorld.y+constrainedDelta.y};
          center.x=(oppositeWorld.x+constrainedDragged.x)/2;center.y=(oppositeWorld.y+constrainedDragged.y)/2;
        }
        return {...item,x1:center.x-width/2,y1:center.y-height/2,x2:center.x+width/2,y2:center.y+height/2,rotation:angle};
      }));
    };
    const up=()=>{commitCanvas();window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
  };
  const moveInkSelection=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(!selectedInkIds.size||event.button===1)return;
    event.preventDefault();event.stopPropagation();pushHistory();
    let lastX=event.clientX,lastY=event.clientY;const ids=new Set(selectedInkIds);
    const move=(p:PointerEvent)=>{const delta=worldDelta(p.clientX-lastX,p.clientY-lastY);lastX=p.clientX;lastY=p.clientY;setInkTransient(items=>items.map(stroke=>ids.has(stroke.id)?{...stroke,points:stroke.points.map(point=>({...point,x:point.x+delta.x,y:point.y+delta.y}))}:stroke));};
    const up=()=>{commitCanvas();window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
  };
  const combineSelectionAsMath = async () => {
    if(ocrBusy||(!selectedIds.size&&!selectedInkIds.size))return;
    const selectedContainers=stateRef.current.containers.filter(item=>selectedIds.has(item.id));
    const selectedInk=stateRef.current.ink.filter(stroke=>selectedInkIds.has(stroke.id)&&stroke.tool==="pen");
    const parts:MixedMathPart[]=[];

    for(const item of selectedContainers){
      const existingMath=firstMathLatex(item.content)?.trim()??"";
      const latex=existingMath||typedMathToLatex(item.plainText);
      if(!latex)continue;
      parts.push({id:`container:${item.id}`,latex,bounds:containerMathContentBounds(item),source:existingMath?"math":"text"});
    }

    setOcrBusy(true);
    setAiTaskStatus(selectedInk.length?"Gemini is reading the drawn part, then combining typed math…":"Combining typed math…");
    try{
      if(selectedInk.length){
        const bounds=inkGroupBounds(selectedInk);
        if(bounds){
          const recognized=await recognizeInkGroupMath(selectedInk);
          if(!recognized.valid||!recognized.latex)throw new Error(recognized.error||"The drawn part could not be read as math.");
          const latex=recognized.latex;
          parts.push({id:"selected-ink",latex,bounds,source:"ink"});
        }
      }

      if(!parts.length){window.alert("The selection contains no typed math or readable pen ink.");return;}
      const composition=composeMixedMath(parts);
      if(!composition.latex){window.alert("LeNota could not compose this selection as math.");return;}
      const roleNote=composition.operatorId
        ?`\n\nPlaced ${composition.upperIds.length} upper, ${composition.lowerIds.length} lower, and ${composition.bodyIds.length} body item(s) from their canvas positions.`
        :"\n\nTyped items were combined in their canvas order.";
      const reviewed=window.prompt(`Combined LaTeX — edit before replacing the selected ink/text.${roleNote}`,composition.latex)?.trim();
      if(!reviewed)return;
      const validation=validateLatexSource(reviewed);
      if(!validation.valid){window.alert(`That LaTeX cannot be rendered, so the original selection was kept.\n\n${validation.error}`);return;}

      const partBounds=parts.map(part=>part.bounds);
      const bounds={
        left:Math.min(...partBounds.map(item=>item.left)),top:Math.min(...partBounds.map(item=>item.top)),
        right:Math.max(...partBounds.map(item=>item.right)),bottom:Math.max(...partBounds.map(item=>item.bottom)),
      };
      const drawnSize={width:Math.max(80,bounds.right-bounds.left),height:Math.max(40,bounds.bottom-bounds.top)};
      const content=mathDocument(reviewed,true,drawnSize,selectedInk.length?convertedInkColor(selectedInk,theme):undefined);
      const item:NoteContainer={
        id:newId(),x:bounds.left,y:bounds.top,
        width:clamp(Math.max(300,drawnSize.width+100),MIN_WIDTH,MAX_WIDTH),
        minHeight:Math.max(72,Math.min(900,drawnSize.height+30)),
        zIndex:Math.max(0,...stateRef.current.containers.map(container=>container.zIndex))+1,
        content,plainText:reviewed,
      };
      const containerIds=new Set(selectedContainers.map(container=>container.id));
      const inkIds=new Set(selectedInk.map(stroke=>stroke.id));
      const nextContainers=[...stateRef.current.containers.filter(container=>!containerIds.has(container.id)),item];
      const nextInk=stateRef.current.ink.filter(stroke=>!inkIds.has(stroke.id));
      const nextMemory=prunePageAiMemory(nextContainers,stateRef.current.aiMemory);
      pushHistory();
      stateRef.current={...stateRef.current,containers:nextContainers,ink:nextInk,aiMemory:nextMemory};
      setContainers(nextContainers);setInk(nextInk);setAiMemory(nextMemory);
      publish(nextContainers,nextInk,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background,nextMemory);
      setSelectedIds(new Set([item.id]));setSelectedInkIds(new Set());setSelectedShapeIds(new Set());
      setActiveEditor(null);setDrawingTool("select");setAutoInkStatus("Selection combined as editable LaTeX ✓");
    }catch(error){
      window.alert(`Combine selection as math failed: ${String(error)}\n\nThe typed containers and ink were kept unchanged.`);
    }finally{
      setOcrBusy(false);setAiTaskStatus("");
    }
  };
  const recognizeSelectedInk = async () => {
    if (ocrBusy || !selectedInkIds.size) return;
    const bounds = selectedInkBounds(stateRef.current.ink, selectedInkIds);
    if (!bounds) return;
    const selected = stateRef.current.ink.filter(stroke => selectedInkIds.has(stroke.id));
    setOcrBusy(true);
    setAiTaskStatus("Gemini is reading handwriting…");
    try {
      const recognized = await recognizeInkGroupText(selected);
      if (!recognized.text.trim()) { window.alert("No handwriting text was detected."); return; }
      const reviewed=window.prompt(`Recognized handwriting (${recognized.engine})\n\nEdit before inserting:`,recognized.text.trim())?.trim();
      if(!reviewed)return;
      const content = recognizedTextDocument(reviewed, selected, theme, inkOutputFontFamily);
      const preferredWidth=Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,bounds.right-bounds.left+40));
      const shouldReplace=window.confirm("Replace the original handwriting with the recognized text? Choose Cancel to keep the ink and insert the text below it.");
      if(shouldReplace)replaceInkGroupWithContainer(selected,content,reviewed,preferredWidth);
      else addContainer(bounds.left,bounds.bottom+24,content,reviewed,preferredWidth);
    } catch (error) {
      window.alert(`Gemini handwriting recognition failed: ${String(error)}\n\nYour ink was kept unchanged.`);
    } finally { setOcrBusy(false); setAiTaskStatus(""); }
  };

  const recognizeSelectedInkAsMath = async () => {
    if (ocrBusy || !selectedInkIds.size) return;
    const selected = stateRef.current.ink.filter(stroke => selectedInkIds.has(stroke.id));
    const bounds = inkGroupBounds(selected); if(!bounds)return;
    setOcrBusy(true);
    setAiTaskStatus("Gemini is reading the equation…");
    try {
      const math = await recognizeInkGroupMath(selected);
      if(!math.latex){window.alert("No mathematical expression was detected.");return;}
      const reviewNote=!math.valid
        ?`\n\nThe AI result is not valid LaTeX yet. Correct it below or choose Cancel to keep the ink unchanged.\n\n${math.error}`
        :math.suspicious?"\n\nThis result contains an ambiguous symbol and should be reviewed."
        :math.repaired?"\n\nLeNota repaired a malformed OCR structure before previewing it.":"";
      const reviewed = window.prompt(`Recognized LaTeX — edit it before inserting if needed${reviewNote}`, math.latex)?.trim();
      if(!reviewed)return;
      const validation=validateLatexSource(reviewed);
      if(!validation.valid){window.alert(`That correction still cannot be rendered, so the original ink was kept.\n\n${validation.error}`);return;}
      const drawnSize={width:Math.max(24,bounds.right-bounds.left),height:Math.max(16,bounds.bottom-bounds.top)};
      const content=mathDocument(reviewed,true,drawnSize,convertedInkColor(selected,theme));
      const text=reviewed;
      const shouldReplace=window.confirm("Insert the recognized equation and remove the original ink? Choose Cancel to keep the ink too.");
      if(shouldReplace)replaceInkGroupWithContainer(selected,content,text,Math.max(300,drawnSize.width+120));
      else addContainer(bounds.left,bounds.bottom+24,content,text,Math.max(300,drawnSize.width+120));
      setDrawingTool("select");
    } catch(error) {
      window.alert(`Draw to Math failed: ${String(error)}`);
    } finally { setOcrBusy(false); setAiTaskStatus(""); }
  };

  const runCloudAsk = useCallback(async(containerId:string,prompt:string,range:{from:number;to:number})=>{
    const editor=editorsRef.current.get(containerId);
    if(!editor||editor.isDestroyed)return;
    if(cloudAiReadiness!=="ready"){
      window.alert("Gemini Cloud AI is not configured. Click Cloud setup in the drawing toolbar, then press Enter on the /ask command again.");
      return;
    }
    const wasEditable=editor.isEditable;
    editor.setEditable(false);
    setAiTaskStatus("Gemini is answering /ask…");
    try{
      const pageContext=buildPageAiContext(title,stateRef.current.containers.map(item=>({
        id:item.id,x:item.x,y:item.y,
        content:editorsRef.current.get(item.id)?.getJSON()??item.content,
      })),stateRef.current.aiMemory);
      const response=await notesApi.cloudAsk(prompt,pageContext,30_000);
      const generated=makeGeneratedLatexRenderSafe(cloudBlocksToTiptap(response.blocks));
      const content=generated.nodes;
      if(editor.isDestroyed)return;
      editor.setEditable(wasEditable);
      if(!editor.chain().focus().insertContentAt(range,content).run())throw new Error("The generated content could not be inserted into this note.");
      const nextMemory=[...stateRef.current.aiMemory,{
        prompt,
        answer:renderPageContentForAi(content),
        createdAt:Date.now(),
        containerId,
      }].slice(-50);
      const updatedContent=editor.getJSON();
      const nextContainers=stateRef.current.containers.map(item=>item.id===containerId?{
        ...item,content:updatedContent,plainText:extractDocumentSearchText(updatedContent),
      }:item);
      stateRef.current={...stateRef.current,containers:nextContainers,aiMemory:nextMemory};
      setContainers(nextContainers);setAiMemory(nextMemory);
      publish(nextContainers,stateRef.current.ink,stateRef.current.viewport,stateRef.current.shapes,stateRef.current.background,nextMemory);
      setCloudAiError("");
      setAiTaskStatus("Gemini answer inserted ✓");
      window.setTimeout(()=>setAiTaskStatus(current=>current==="Gemini answer inserted ✓"?"":current),2600);
    }catch(error){
      const message=(error instanceof Error?error.message:String(error)).slice(0,2400);
      setCloudAiError(message);
      window.alert(`Gemini /ask failed: ${message}\n\nThe /ask command was kept so you can retry it.`);
      setAiTaskStatus("");
    }finally{
      if(!editor.isDestroyed)editor.setEditable(wasEditable);
    }
  },[cloudAiReadiness,publish,title]);

  const convertSelectedInkToShape = () => {
    if (!selectedInkIds.size) return;
    const bounds = selectedInkBounds(stateRef.current.ink, selectedInkIds);
    if (!bounds) return;
    const answer = window.prompt("Convert selected ink to shape: rectangle, ellipse, line, or arrow", "rectangle")?.trim().toLowerCase();
    if (!answer) return;
    if (!["rectangle", "ellipse", "line", "arrow"].includes(answer)) { window.alert("Choose rectangle, ellipse, line, or arrow."); return; }
    const selected = stateRef.current.ink.filter(stroke => selectedInkIds.has(stroke.id));
    const firstStroke = selected[0];
    const lastStroke = selected[selected.length - 1];
    const firstPoint = firstStroke?.points[0];
    const lastPoint = lastStroke?.points[lastStroke.points.length - 1];
    const zIndex = Math.max(0, ...stateRef.current.shapes.map(item => item.zIndex ?? 0)) + 1;
    const shape: CanvasShape = {
      id: newId(), kind: answer as CanvasShape["kind"],
      x1: answer === "line" || answer === "arrow" ? (firstPoint?.x ?? bounds.left) : bounds.left,
      y1: answer === "line" || answer === "arrow" ? (firstPoint?.y ?? bounds.top) : bounds.top,
      x2: answer === "line" || answer === "arrow" ? (lastPoint?.x ?? bounds.right) : bounds.right,
      y2: answer === "line" || answer === "arrow" ? (lastPoint?.y ?? bounds.bottom) : bounds.bottom,
      stroke: convertedInkColor(selected,theme) ?? firstStroke?.color ?? penColor, fill: "transparent", strokeWidth: Math.max(.1,firstStroke?.width ?? 2), zIndex,
    };
    pushHistory();
    const ids = new Set(selectedInkIds);
    const nextInk = stateRef.current.ink.filter(item => !ids.has(item.id));
    const nextShapes = [...stateRef.current.shapes, shape];
    setInk(nextInk); setShapes(nextShapes);
    stateRef.current = { ...stateRef.current, ink: nextInk, shapes: nextShapes };
    publish(stateRef.current.containers, nextInk, stateRef.current.viewport, nextShapes, stateRef.current.background);
    setSelectedInkIds(new Set()); setSelectedShapeIds(new Set([shape.id])); setDrawingTool("select");
  };

  const recognizeAllPageImages = async () => {
    if (ocrBusy) return;
    const language = window.prompt("OCR language for all unrecognized images on this page", "eng")?.trim();
    if (!language) return;
    const targets: { editor: Editor; position: number; attachmentId: string }[] = [];
    for (const editor of editorsRef.current.values()) {
      if (editor.isDestroyed) continue;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === "image" && node.attrs.attachmentId && !node.attrs.ocrText) {
          targets.push({ editor, position, attachmentId: String(node.attrs.attachmentId) });
        }
      });
    }
    if (!targets.length) { window.alert("There are no unrecognized managed images on this page."); return; }
    setOcrBusy(true);
    let completed = 0;
    try {
      for (const target of targets) {
        const text = (await notesApi.ocrAttachment(target.attachmentId, language)).trim();
        if (target.editor.isDestroyed) continue;
        target.editor.commands.command(({ tr }) => {
          const node = tr.doc.nodeAt(target.position);
          if (!node || node.type.name !== "image") return false;
          tr.setNodeMarkup(target.position, undefined, { ...node.attrs, ocrText: text || null });
          return true;
        });
        completed += 1;
      }
      window.alert(`OCR completed for ${completed} image${completed === 1 ? "" : "s"}. Recognized text is now included in normal note search.`);
    } catch (error) { window.alert(`Page OCR stopped: ${String(error)}`); }
    finally { setOcrBusy(false); }
  };

  const inkSelection=selectedInkBounds(ink,selectedInkIds);
  const selectionBounds=(()=>{
    const bounds:{left:number;top:number;right:number;bottom:number}[]=[];
    for(const item of stateRef.current.containers){if(selectedIds.has(item.id))bounds.push({left:item.x,top:item.y,right:item.x+item.width,bottom:item.y+item.minHeight});}
    for(const shape of stateRef.current.shapes){if(selectedShapeIds.has(shape.id))bounds.push(rotatedShapeBounds(shape));}
    for(const stroke of stateRef.current.ink){if(selectedInkIds.has(stroke.id))bounds.push(strokeBounds(stroke));}
    if(bounds.length<2)return null;
    return {left:Math.min(...bounds.map(b=>b.left)),top:Math.min(...bounds.map(b=>b.top)),right:Math.max(...bounds.map(b=>b.right)),bottom:Math.max(...bounds.map(b=>b.bottom))};
  })();
  const fitSelection=()=>{
    if(!selectionBounds)return;
    const rect=canvasRef.current?.getBoundingClientRect();if(!rect)return;
    const width=Math.max(1,selectionBounds.right-selectionBounds.left),height=Math.max(1,selectionBounds.bottom-selectionBounds.top);
    const zoom=clamp(Math.min((rect.width-120)/width,(rect.height-120)/height),.35,2.5);
    const centerX=(selectionBounds.left+selectionBounds.right)/2,centerY=(selectionBounds.top+selectionBounds.bottom)/2;
    updateViewport({zoom,x:rect.width/2-centerX*zoom,y:rect.height/2-centerY*zoom});
  };
  const fitCanvas=()=>{
    const rect=canvasRef.current?.getBoundingClientRect();if(!rect)return;
    const bounds=canvasDocumentBounds(stateRef.current.containers,stateRef.current.shapes,stateRef.current.ink);
    if(!bounds){updateViewport({x:88,y:72,zoom:1});return;}
    for(const item of stateRef.current.containers){
      const element=worldRef.current?.querySelector<HTMLElement>(`[data-note-container-id="${item.id}"]`);
      if(element)bounds.bottom=Math.max(bounds.bottom,item.y, item.y+element.offsetHeight);
    }
    updateViewport(fitCanvasBounds(bounds,rect.width,rect.height,72,1.15));
  };

  const liveInspectorEditor = activeEditor && !activeEditor.isDestroyed ? activeEditor : null;
  const inspectorMathSelected = Boolean(liveInspectorEditor?.isActive("mathExpression"));
  const inspectorImageSelected = Boolean(liveInspectorEditor?.isActive("image"));
  const inspectorMathAttrs = inspectorMathSelected && liveInspectorEditor ? liveInspectorEditor.getAttributes("mathExpression") as { latex?: string; display?: boolean; align?: MathAlignment; fontSize?: number; color?: string | null } : {};
  const inspectorImageAttrs = inspectorImageSelected && liveInspectorEditor ? liveInspectorEditor.getAttributes("image") as { imageWidth?: number | null } : {};
  const selectedNote = containers.find((item) => selectedIds.has(item.id)) ?? null;
  const selectedShape = shapes.find((item) => selectedShapeIds.has(item.id)) ?? null;
  const selectedStroke = ink.find((item) => selectedInkIds.has(item.id)) ?? null;
  const selectionCount = selectedIds.size + selectedShapeIds.size + selectedInkIds.size;
  const triggerSelectedMathAction = (label: "Solve" | "Steps" | "Graph") => {
    const node = document.querySelector<HTMLElement>(".note-container.is-selected .lenota-math-node.is-selected");
    const more = node?.querySelector<HTMLButtonElement>(".lenota-math-more");
    if (!node || !more) return;
    if (!node.querySelector(".lenota-math-menu")) more.click();
    requestAnimationFrame(() => {
      const action = [...node.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((button) => button.textContent?.trim() === label);
      action?.click();
    });
  };

  return <main className={cn("editor-shell relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden", focusMode && "is-focus-mode")}>
    {focusMode ? <>
      <div className="focus-calm-brand no-print fixed left-5 top-5 z-[1000006] flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl border border-white/10 bg-violet-600 text-white shadow-lg shadow-violet-950/20"><PenLine className="size-[18px]"/></div>
        <span className="text-base font-semibold text-neutral-100">LeNota</span>
        <span className="lenota-build-badge">v{LENOTA_VERSION}</span>
        {focusBreadcrumb ? <span className="focus-calm-breadcrumb ml-3 text-sm text-neutral-500">{focusBreadcrumb}</span> : null}
      </div>
      <div className="focus-calm-status no-print fixed right-7 top-7 z-[1000006]"><SaveIndicator state={saveState}/></div>
    </> : null}
    <div className="editor-mode-bar no-print flex min-w-0 shrink-0 items-center border-b border-white/8 bg-[#1d1d21]">
      <div className="app-topbar-brand flex w-[218px] shrink-0 items-center gap-3 px-4">
        <div className="grid size-9 place-items-center rounded-lg bg-violet-600 text-white shadow-lg shadow-violet-950/25"><PenLine className="size-[18px]"/></div>
        <span className="text-lg font-semibold tracking-[-.02em] text-neutral-50">LeNota</span>
        <span className="lenota-build-badge">v{LENOTA_VERSION}</span>
      </div>
      <div className="app-topbar-history flex shrink-0 items-center gap-1">
        <button type="button" aria-label="Back" title="Back" disabled={!canGoBack} className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white disabled:opacity-30" onClick={onGoBack}><ChevronLeft className="size-5"/></button>
        <button type="button" aria-label="Forward" title="Forward" disabled={!canGoForward} className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white disabled:opacity-30" onClick={onGoForward}><ChevronRight className="size-5"/></button>
      </div>
      <div className="normal-page-context min-w-0">
        {focusBreadcrumb?<div className="normal-page-breadcrumb truncate">{focusBreadcrumb}</div>:null}
        <input className="normal-page-title ui-selectable min-w-0 border-0 bg-transparent outline-none" aria-label="Page title" placeholder="Untitled page" value={title} onChange={e=>onChangeTitle(e.target.value)}/>
      </div>
      <WorkspaceToolbarTabs
        mode={toolbarMode}
        aiActive={toolbarMode === "draw" && drawToolbarPanel === "ai"}
        onChange={mode=>{setFocusToolMenu(null);setToolbarMode(mode);if(mode==="write"){setDrawingTool("select");setToolShelfOpen(true);}else{if(drawToolbarPanel==="ai")setDrawToolbarPanel("ink");setToolShelfOpen(!focusMode);}}}
        onInsert={()=>{setFocusToolMenu(null);addContainer();setToolbarMode("write");setToolShelfOpen(false);}}
        onMath={()=>{setFocusToolMenu(null);if(liveInspectorEditor)insertOrEditMath(liveInspectorEditor);else{addContainer();setToolbarMode("write");setToolShelfOpen(true);}}}
        onOpenAi={()=>{setFocusToolMenu(null);setToolbarMode("draw");setDrawToolbarPanel("ai");setDrawingTool("select");setToolShelfOpen(true);}}
        contextTools={!focusMode?<div className="workspace-context-tools" role="toolbar" aria-label="Layer and fill tools">
          <button type="button" className={focusToolMenu==="layers"?"is-menu-open":""} title="Layers" aria-label="Layers" aria-expanded={focusToolMenu==="layers"} aria-disabled={!selectedIds.size&&!selectedShapeIds.size} onClick={()=>setFocusToolMenu(value=>value==="layers"?null:"layers")}><Layers className="size-4"/><span>Layers</span></button>
          <button type="button" className={drawingTool==="fill"?"is-active":""} title="Fill tool — click a rectangle or ellipse to fill it" aria-label="Fill" aria-pressed={drawingTool==="fill"} aria-expanded={focusToolMenu==="fill"} onClick={()=>{setToolbarMode("draw");setToolShelfOpen(false);setDrawingTool("fill");if(shapeFillColor==="transparent")setShapeFillColor("#8b5cf6");setFocusToolMenu(value=>value==="fill"?null:"fill");}}><PaintBucket className="size-4"/><span>Fill</span></button>
          {focusToolMenu==="layers"?<div className="normal-tool-popover normal-tool-popover-layers" role="menu" aria-label="Layer controls">
            {selectedIds.size||selectedShapeIds.size?<><button type="button" role="menuitem" onClick={()=>{layerSelected(true);setFocusToolMenu(null);}}><ArrowUpToLine className="size-4"/>Bring to front</button><button type="button" role="menuitem" onClick={()=>{layerSelected(false);setFocusToolMenu(null);}}><ArrowDownToLine className="size-4"/>Send to back</button></>:<div className="normal-tool-hint">Select a note or shape first.</div>}
          </div>:null}
          {focusToolMenu==="fill"?<div className="normal-tool-popover normal-tool-popover-fill" role="menu" aria-label="Fill controls">
            <div className="normal-tool-hint">{shapes.some(item=>selectedShapeIds.has(item.id)&&(item.kind==="rectangle"||item.kind==="ellipse"))?"Changes the selected shape and new shapes.":"Choose a fill for new rectangles/ellipses, or select one to recolor it."}</div>
            <label className="normal-fill-color">Fill color<input aria-label="Shape fill color" type="color" value={(shapes.find(item=>selectedShapeIds.has(item.id)&&(item.kind==="rectangle"||item.kind==="ellipse")&&item.fill!=="transparent")?.fill)||(shapeFillColor!=="transparent"?shapeFillColor:"#8b5cf6")} onChange={event=>applyShapeFill(event.target.value)}/></label>
            <button type="button" role="menuitem" onClick={()=>{applyShapeFill("transparent");setFocusToolMenu(null);}}><X className="size-4"/>No fill</button>
          </div>:null}
        </div>:undefined}
      />
      {focusMode ? <div className="focus-reference-tools" role="toolbar" aria-label="Focus drawing tools">
        <span/>
        <button type="button" className={drawingTool==="pen"?"is-active":""} title="Pen" onClick={()=>{setFocusToolMenu(null);setToolShelfOpen(false);setToolbarMode("draw");setDrawToolbarPanel("ink");setDrawingTool("pen");}}><PenLine className="size-5"/></button>
        <button type="button" className={drawingTool==="highlighter"?"is-active":""} title="Highlighter" onClick={()=>{setFocusToolMenu(null);setToolShelfOpen(false);setToolbarMode("draw");setDrawToolbarPanel("ink");setDrawingTool("highlighter");}}><Highlighter className="size-5"/></button>
        <button type="button" className={drawingTool==="eraser"?"is-active":""} title="Eraser" onClick={()=>{setFocusToolMenu(null);setToolShelfOpen(false);setToolbarMode("draw");setDrawToolbarPanel("ink");setDrawingTool("eraser");}}><Eraser className="size-5"/></button>
        <button type="button" className={drawingTool==="lasso"?"is-active":""} title="Lasso" onClick={()=>{setFocusToolMenu(null);setToolShelfOpen(false);setToolbarMode("draw");setDrawToolbarPanel("ink");setDrawingTool("lasso");}}><MousePointer2 className="size-5"/></button>
        <span/>
        <button type="button" className={focusToolMenu==="layers"?"is-menu-open":""} title="Layers" aria-expanded={focusToolMenu==="layers"} disabled={!selectedIds.size&&!selectedShapeIds.size} onClick={()=>setFocusToolMenu(value=>value==="layers"?null:"layers")}><Layers className="size-5"/></button>
        <button type="button" className={drawingTool==="fill"?"is-active":""} title="Fill tool — click a rectangle or ellipse to fill it" aria-label="Fill" aria-pressed={drawingTool==="fill"} aria-expanded={focusToolMenu==="fill"} onClick={()=>{setToolbarMode("draw");setToolShelfOpen(false);setDrawingTool("fill");if(shapeFillColor==="transparent")setShapeFillColor("#8b5cf6");setFocusToolMenu(value=>value==="fill"?null:"fill");}}><PaintBucket className="size-5"/></button>
        <button type="button" title="Undo" disabled={!historyRef.current.undo.length} onClick={()=>{setFocusToolMenu(null);undoCanvas();}}><Undo2 className="size-5"/></button>
        {focusToolMenu==="layers"?<div className="focus-tool-popover focus-tool-popover-layers" role="menu" aria-label="Layer controls">
          <button type="button" role="menuitem" onClick={()=>{layerSelected(true);setFocusToolMenu(null);}}><ArrowUpToLine className="size-4"/>Bring to front</button>
          <button type="button" role="menuitem" onClick={()=>{layerSelected(false);setFocusToolMenu(null);}}><ArrowDownToLine className="size-4"/>Send to back</button>
        </div>:null}
        {focusToolMenu==="fill"?<div className="focus-tool-popover focus-tool-popover-fill" role="menu" aria-label="Fill controls">
          <label className="focus-fill-color">Fill color<input aria-label="Focused mode shape fill color" type="color" value={(shapes.find(item=>selectedShapeIds.has(item.id)&&(item.kind==="rectangle"||item.kind==="ellipse")&&item.fill!=="transparent")?.fill)||(shapeFillColor!=="transparent"?shapeFillColor:"#8b5cf6")} onChange={event=>applyShapeFill(event.target.value)}/></label>
          <button type="button" role="menuitem" onClick={()=>{applyShapeFill("transparent");setFocusToolMenu(null);}}><X className="size-4"/>No fill</button>
        </div>:null}
      </div> : null}
      <div className="app-topbar-actions ml-auto flex shrink-0 items-center gap-1 px-3">
        {!focusMode?<><button type="button" className="topbar-undo grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white" title="Undo" disabled={!historyRef.current.undo.length} onClick={undoCanvas}><Undo2 className="size-4"/></button><button type="button" className="topbar-redo grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white" title="Redo" disabled={!historyRef.current.redo.length} onClick={redoCanvas}><Redo2 className="size-4"/></button><span className="topbar-divider h-7 w-px bg-white/10"/></>:null}
        <SaveIndicator state={saveState}/>
        <button type="button" className="page-favorite-action grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white" title="Favorite page" onClick={onToggleFavorite}><Star className={cn("size-[18px]",page.isFavorite&&"fill-amber-400 text-amber-400")}/></button>
        <button type="button" className={cn("grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white",toolShelfOpen&&"bg-violet-500/15 text-violet-200")} title="Toggle active tool shelf" onClick={()=>{setFocusToolMenu(null);setToolShelfOpen(value=>!value);}}><Settings className="size-4"/></button>
        <button type="button" className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white" title="Find on this page" onClick={()=>setFindOpen(true)}><Search className="size-4"/></button>
        <button type="button" className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white" title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={onToggleTheme}>{theme === "dark"?<Sun className="size-4"/>:<Moon className="size-4"/>}</button>
        {!focusMode?<button type="button" className={cn("page-inspector-action grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white",inspectorOpen&&"bg-violet-500/15 text-violet-200")} title="Toggle inspector" aria-label="Toggle inspector" aria-pressed={inspectorOpen} onClick={()=>{setFocusToolMenu(null);setInspectorOpen(value=>!value);}}><SlidersHorizontal className="size-4"/></button>:null}
        <button type="button" className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white" title={`${focusMode?"Exit":"Enter"} Focus Mode`} onClick={onToggleFocusMode}>{focusMode?<Minimize2 className="size-4"/>:<Maximize2 className="size-4"/>}</button>
        <button type="button" className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white" title="More commands" onClick={onOpenCommands}><MoreVertical className="size-4"/></button>
      </div>
    </div>
    <div className={cn("topbar-editor-tools no-print min-w-0 overflow-hidden rounded-xl border border-white/10 shadow-2xl",toolShelfOpen&&"is-open")} aria-hidden={!toolShelfOpen}>
      {toolbarMode === "write"
        ? <EditorToolbar editor={activeEditor} linkablePages={linkablePages}/>
        : <div ref={setDrawToolbarHost} className="h-11 min-w-0 w-full overflow-hidden"/>}
    </div>
    <div className="editor-actions-bar no-print flex flex-wrap items-center justify-between gap-2 border-b border-white/8 bg-[#202024] px-4 py-2" style={{ display: "none" }} aria-hidden="true">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {page.tags.map(tag=><button key={tag.id} className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-1 text-xs text-neutral-300" onClick={()=>onRemoveTag(tag.id)}><span className="size-2 rounded-full" style={{backgroundColor:tag.color}}/>{tag.name}<span className="text-neutral-600">×</span></button>)}
        <select aria-label="Add tag" className="h-7 rounded-md border border-white/10 bg-[#29292e] px-2 text-xs text-neutral-300" value="" onChange={e=>{if(e.target.value==="__create")onCreateTag();else if(e.target.value)onAddTag(e.target.value)}}><option value="">Add tag…</option>{unusedTags.map(tag=><option key={tag.id} value={tag.id}>{tag.name}</option>)}<option value="__create">Create new tag…</option></select>
      </div>
      <div className="flex items-center gap-1.5">
        <SaveIndicator state={saveState}/>{aiTaskStatus&&<span className="max-w-72 truncate rounded-md border border-violet-400/15 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-200" title={aiTaskStatus}>{aiTaskStatus}</span>}<Button variant="ghost" onClick={()=>setFindOpen(true)} title="Find or replace on this page (Ctrl+F)"><Search className="size-4"/>Find</Button><Button variant="ghost" onClick={()=>addContainer()} title="New note container (Ctrl+Alt+N)"><Plus className="size-4"/>Container</Button>
        <Button variant="ghost" onClick={onOpenAttachments}><Paperclip className="size-4"/>{attachmentCount||""}</Button>
        <Button variant="ghost" onClick={() => void insertPdfPrintout()} title="Insert PDF as page printout"><FileText className="size-4"/>PDF printout</Button>
        <Button variant="ghost" disabled={ocrBusy} onClick={() => void recognizeAllPageImages()} title="OCR every unrecognized image on this page"><Search className={cn("size-4", ocrBusy && "animate-pulse")}/>{ocrBusy ? "OCR…" : "OCR page"}</Button>
        <Button
          variant={audioRecording ? "default" : "ghost"}
          onClick={() => audioRecording ? stopAudioRecording() : void startAudioRecording()}
          title={audioRecording ? "Stop audio recording" : "Record audio into this page"}
        ><Mic className={cn("size-4", audioRecording && "animate-pulse")}/>{audioRecording ? `Stop ${formatRecordingTime(recordingSeconds)}` : "Record"}</Button>
        <select className="h-8 rounded-md border border-white/10 bg-[#29292e] px-2 text-xs text-neutral-300" value="" onChange={e=>e.target.value&&onExport(e.target.value as "markdown"|"html"|"text")}><option value="">Export…</option><option value="markdown">Markdown</option><option value="html">HTML</option><option value="text">Plain text</option></select>
        <Button size="icon" variant="ghost" onClick={onOpenCommands}><Command className="size-4"/></Button><Button size="icon" variant="ghost" onClick={onCreateSnapshot}><History className="size-4"/></Button><Button variant="ghost" onClick={onOpenHistory}>Versions</Button><Button size="icon" variant="ghost" onClick={onToggleFavorite}><Star className={cn("size-4",page.isFavorite&&"fill-amber-400 text-amber-400")}/></Button>
      </div>
    </div>
    <div className="editor-title-bar relative flex min-h-[68px] items-center gap-3 border-b border-white/8 bg-[#222226] px-5 py-2.5">
      <div className="min-w-0 flex-1">
        {focusBreadcrumb?<div className="normal-page-header-breadcrumb">{focusBreadcrumb}</div>:null}
        <input className="ui-selectable w-full border-0 bg-transparent text-2xl font-semibold tracking-[-.02em] text-neutral-50 outline-none placeholder:text-neutral-600" placeholder="Untitled page" value={title} onChange={e=>onChangeTitle(e.target.value)}/>
        <div className="mt-1 flex items-center gap-1.5 overflow-hidden">
          {page.tags.slice(0,4).map(tag=><button key={tag.id} className="flex shrink-0 items-center gap-1 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-200" onClick={()=>onRemoveTag(tag.id)}>#{tag.name}</button>)}
          {aiTaskStatus?<span className="truncate text-[10px] text-cyan-300">{aiTaskStatus}</span>:null}
        </div>
      </div>
      <button type="button" className="no-print grid size-9 shrink-0 place-items-center rounded-lg text-neutral-400 hover:bg-white/8 hover:text-white" title="Favorite page" onClick={onToggleFavorite}><Star className={cn("size-[18px]",page.isFavorite&&"fill-amber-400 text-amber-400")}/></button>
    </div>
    {findOpen ? <div className="no-print flex flex-wrap items-center gap-2 border-b border-violet-400/15 bg-[#1d1d21] px-4 py-2 text-xs text-neutral-300">
      <Search className="size-4 text-violet-300"/>
      <input data-page-find-input className="h-8 min-w-48 rounded border border-white/10 bg-[#29292e] px-2 outline-none focus:border-violet-400/50" placeholder="Find on this page" value={findQuery} onChange={e=>{setFindQuery(e.target.value);findCursorRef.current=0;currentFindRef.current=null;setFindStatus("");}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();findNext(e.shiftKey?-1:1);}}}/>
      <input className="h-8 min-w-48 rounded border border-white/10 bg-[#29292e] px-2 outline-none focus:border-violet-400/50" placeholder="Replace with" value={replaceQuery} onChange={e=>setReplaceQuery(e.target.value)}/>
      <Button size="sm" variant="ghost" onClick={()=>findNext(-1)}>Previous</Button><Button size="sm" variant="ghost" onClick={()=>findNext(1)}>Next</Button>
      <Button size="sm" variant="ghost" onClick={replaceCurrent}>Replace</Button><Button size="sm" variant="ghost" onClick={replaceAll}>Replace all</Button>
      <span className="min-w-20 text-neutral-500">{findStatus}</span><button title="Close find" className="ml-auto rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>{setFindOpen(false);currentFindRef.current=null;setFindStatus("");}}><X className="size-4"/></button>
    </div> : null}
    <div className="editor-stage flex min-h-0 min-w-0 flex-1 overflow-hidden">
    {focusMode ? <aside className="focus-page-strip no-print" aria-label="Focus mode pages">
      <button type="button" className="focus-page-create" title="Create new page" aria-label="Create new page" onClick={onCreatePage}><Plus className="size-4"/><span>New page</span></button>
      {focusPageOptions.map((item,index)=><button key={item.id} type="button" className={cn("focus-page-thumb",item.id===page.id&&"is-active")} aria-current={item.id===page.id?"page":undefined} data-page-index={index+1} title={`${index+1}. ${item.title}`} onClick={()=>item.id!==page.id&&onOpenInternalPage(item.id)}>
        <span className="focus-page-mini"><i/><i/><i/><i/></span><small>{index+1}</small>
      </button>)}
      <ChevronDown className="focus-page-strip-more size-4"/>
    </aside> : null}
    <div ref={canvasRef} className={cn("note-canvas relative min-h-0 min-w-0 flex-1 overflow-hidden",drawingTool!=="select"&&"is-drawing",drawingTool==="fill"&&"is-fill-tool",spacePanning&&"is-panning",dropActive&&"is-drop-target")} style={backgroundStyle(background,theme,viewport)} onPointerDown={(e)=>{startPan(e);selectOrCreate(e)}} onPointerDownCapture={drawPointerDownCapture}>
      {toolbarMode === "draw" && drawToolbarHost ? createPortal(<div className="canvas-drawing-toolbar flex h-11 min-w-0 w-full flex-nowrap items-center gap-1 bg-[#1d1d21] px-2 py-1.5">
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-white/10 bg-black/15 p-0.5">
          {(["ink","shapes","ai","page"] as DrawToolbarPanel[]).map(panel=><button key={panel} type="button" className={cn("rounded px-2 py-1 text-[10px] font-semibold capitalize text-neutral-400 hover:bg-white/10 hover:text-white",drawToolbarPanel===panel&&"bg-violet-500/25 text-violet-100")} onClick={()=>setDrawToolbarPanel(panel)}>{panel}</button>)}
        </div>
        <span className="mx-0.5 h-5 w-px bg-white/10"/>
        {drawToolbarPanel==="ink"&&<>
          <button title="Select / type" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="select"&&"bg-violet-500/20 text-violet-200")} onClick={()=>setDrawingTool("select")}><MousePointer2 className="size-4"/></button>
          <button title="Lasso notes, shapes, and ink" className={cn("rounded px-1.5 py-1 text-[10px] font-medium text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="lasso"&&"bg-violet-500/20 text-violet-200")} onClick={()=>{clearSelection();setDrawingTool("lasso")}}>Lasso</button>
          <button title="Lasso a visible region and ask Gemini about its screenshot" disabled={cloudAiReadiness==="checking"||cloudAiBusy} className={cn("flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-neutral-400 hover:bg-cyan-500/15 hover:text-cyan-100 disabled:opacity-40",drawingTool==="ask"&&"bg-cyan-500/20 text-cyan-100")} onClick={()=>{clearSelection();setDrawingTool("ask")}}><WandSparkles className="size-3.5"/>Ask selection</button>
          <button title="Pen" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="pen"&&"bg-violet-500/20 text-violet-200")} onClick={()=>{clearSelection();setDrawingTool("pen")}}><PenLine className="size-4"/></button>
          <button title="Highlighter" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="highlighter"&&"bg-violet-500/20 text-violet-200")} onClick={()=>{clearSelection();setDrawingTool("highlighter")}}><Paintbrush className="size-4"/></button>
          <button title="Stroke eraser" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="eraser"&&"bg-violet-500/20 text-violet-200")} onClick={()=>{clearSelection();setDrawingTool("eraser")}}><Eraser className="size-4"/></button>
          <input title="Ink color" aria-label="Ink color" type="color" value={drawingTool==="highlighter"?highlighterColor:penColor} onChange={e=>drawingTool==="highlighter"?setHighlighterColor(e.target.value):setPenColor(e.target.value)} className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"/>
          <CustomSizeInput
            title="Pen/highlighter width — type any positive value"
            ariaLabel="Pen or highlighter width"
            value={drawingTool==="highlighter"?highlighterWidth:penWidth}
            recommended={drawingTool==="highlighter"?[10,14,18,24,32]:[1,1.5,2.5,4,6,9]}
            onCommit={size=>drawingTool==="highlighter"?setHighlighterWidth(size):setPenWidth(size)}
            className="w-20"
          />
        </>}
        {drawToolbarPanel==="shapes"&&<>
          <button title="Select / move shapes" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="select"&&"bg-violet-500/20 text-violet-200")} onClick={()=>setDrawingTool("select")}><MousePointer2 className="size-4"/></button>
          <button title="Rectangle" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="rectangle"&&"bg-violet-500/20 text-violet-200")} onClick={()=>{clearSelection();setDrawingTool("rectangle")}}><Square className="size-4"/></button>
          <button title="Ellipse" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="ellipse"&&"bg-violet-500/20 text-violet-200")} onClick={()=>{clearSelection();setDrawingTool("ellipse")}}><Circle className="size-4"/></button>
          <button title="Line" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="line"&&"bg-violet-500/20 text-violet-200")} onClick={()=>{clearSelection();setDrawingTool("line")}}><Minus className="size-4"/></button>
          <button title="Arrow" className={cn("rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white",drawingTool==="arrow"&&"bg-violet-500/20 text-violet-200")} onClick={()=>{clearSelection();setDrawingTool("arrow")}}><ArrowUpRight className="size-4"/></button>
          <input title="Shape stroke color" aria-label="Shape stroke color" type="color" value={penColor} onChange={e=>setPenColor(e.target.value)} className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"/>
          <span className="mx-0.5 h-5 w-px bg-white/10"/>
          <PaintBucket className="size-4 shrink-0 text-neutral-500"/>
          <input title="Fill color for rectangles and ellipses" aria-label="New shape fill color" type="color" value={shapeFillColor!=="transparent"?shapeFillColor:"#8b5cf6"} onChange={e=>setShapeFillColor(e.target.value)} className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"/>
          <button type="button" title="Toggle fill for new rectangles and ellipses" className={cn("rounded px-1.5 py-1 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white",shapeFillColor!=="transparent"&&"bg-violet-500/20 text-violet-200")} onClick={()=>setShapeFillColor(value=>value==="transparent"?"#8b5cf6":"transparent")}>{shapeFillColor==="transparent"?"No fill":"Filled"}</button>
          <CustomSizeInput title="Shape line width — type any positive value" ariaLabel="Shape line width" value={penWidth} recommended={[1,1.5,2.5,4,6,9]} onCommit={setPenWidth} className="w-20"/>
        </>}
        {drawToolbarPanel==="ai"&&<>
        <button title="Automatically recognize pen strokes after you pause" className={cn("flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white",autoInkEnabled&&"bg-violet-500/20 text-violet-200")} onClick={()=>setAutoInkEnabled(value=>!value)}><WandSparkles className="size-3.5"/>Auto</button>
        {autoInkEnabled&&<select title="Auto recognition pause" aria-label="Auto recognition pause" value={String(autoInkDelay)} onChange={e=>setAutoInkDelay(Number(e.target.value))} className="h-7 rounded border border-white/10 bg-[#25252a] px-1 text-[10px] text-neutral-300"><option value="350">0.35s</option><option value="550">0.55s</option><option value="850">0.85s</option></select>}
        <select title="Automatic ink recognition mode" aria-label="Automatic ink recognition mode" disabled={!autoInkEnabled} value={autoInkMode} onChange={e=>setAutoInkMode(e.target.value as AutoInkMode)} className="h-7 rounded border border-white/10 bg-[#25252a] px-1 text-[10px] text-neutral-300 disabled:opacity-40"><option value="smart">Smart · mixed ink</option><option value="text">Text only</option><option value="shape">Shape only</option><option value="math">Math only · always recognize</option></select>
        <button type="button" disabled={cloudAiReadiness==="checking"||cloudAiBusy} title={cloudAiError?"Gemini Cloud AI failed. Click to see the exact error; Shift-click to forget the key.":cloudAiReadiness==="missing"?"Set up Gemini for handwriting, math, and page-aware /ask.":"Gemini is active. /ask uses current-page content and saved page conversation memory. Shift-click to forget the key."} onClick={event=>{if(cloudAiError&&!event.shiftKey){window.alert("Gemini Cloud AI error:\n\n"+cloudAiError+"\n\nYour original ink or /ask command was kept.");setCloudAiError("");return;}void configureGeminiCloud(event.shiftKey);}} className={cn("rounded border px-1.5 py-1 text-[10px] disabled:opacity-50",cloudAiError?"border-red-400/35 bg-red-500/15 text-red-100":cloudAiReadiness==="ready"?"border-cyan-400/35 bg-cyan-500/15 text-cyan-100":"border-white/10 text-neutral-400 hover:bg-white/10")}>
          {cloudAiBusy?"Gemini reading…":cloudAiReadiness==="checking"?"Gemini checking…":cloudAiError?"Gemini error":cloudAiReadiness==="ready"?"Gemini Cloud ✓":"Cloud setup"}
        </button>
        <button title={`Handwriting language hint: ${inkRecognitionLanguage}`} disabled={autoInkMode==="shape"||autoInkMode==="math"} className="rounded px-1.5 py-1 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white disabled:opacity-35" onClick={()=>{const next=window.prompt("Handwriting language or script hint for Gemini (for example: English, Arabic, eng, or ara)",inkRecognitionLanguage)?.trim();if(next)setInkRecognitionLanguage(next);}}>{inkRecognitionLanguage}</button>
        <select title="Font used for newly recognized handwriting text" aria-label="Recognized handwriting font" disabled={autoInkMode==="shape"||autoInkMode==="math"} value={inkOutputFontFamily} onChange={e=>setInkOutputFontFamily(normalizeFontChoice(e.target.value))} style={{fontFamily:fontCssValue(inkOutputFontFamily)}} className="h-7 max-w-36 rounded border border-white/10 bg-[#25252a] px-1 text-[10px] text-neutral-300 disabled:opacity-40">{FONT_CHOICES.map(font=><option key={`ink-${font.label}`} value={font.value} style={{fontFamily:font.css}}>{font.label}</option>)}</select>
        {latestRecentMathId&&<button type="button" title="Confirm every currently editable automatic equation on this page. Future pen strokes will keep them as LaTeX instead of reopening their original ink." onClick={confirmAllMath} className="flex items-center gap-1 rounded border border-emerald-400/35 bg-emerald-500/15 px-1.5 py-1 text-[10px] text-emerald-100 hover:bg-emerald-500/25"><Check className="size-3"/>Confirm all math</button>}
        {autoInkStatus&&<span className="max-w-24 truncate px-1 text-[10px] text-violet-300" title={autoInkStatus}>{autoInkStatus}</span>}
        </>}
        {drawToolbarPanel==="page"&&<>
        <select title="Page ruling" aria-label="Page ruling" value={background.pattern} onChange={e=>updateBackground({...background,pattern:e.target.value as CanvasBackground["pattern"]})} className="h-7 rounded border border-white/10 bg-[#25252a] px-1.5 text-xs text-neutral-300"><option value="plain">Plain</option><option value="ruled">Ruled</option><option value="grid">Grid</option></select>
        <input title="Page color" aria-label="Page color" type="color" value={themeAwareCanvasColor(background.color,theme)} onChange={e=>updateBackground({...background,color:e.target.value})} className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"/>
        {background.pattern!=="plain"&&<CustomSizeInput title="Rule/grid spacing — type any positive value" ariaLabel="Rule/grid spacing" value={background.spacing} recommended={[8,12,16,20,24,32,48,64]} minimum={1} onCommit={spacing=>updateBackground({...background,spacing})} className="w-20"/>}
        <span className="mx-0.5 h-5 w-px bg-white/10"/><button title="Canvas undo" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white disabled:opacity-30" disabled={!historyRef.current.undo.length} onClick={undoCanvas}><Undo2 className="size-4"/></button><button title="Canvas redo" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white disabled:opacity-30" disabled={!historyRef.current.redo.length} onClick={redoCanvas}><Redo2 className="size-4"/></button>
        </>}
      </div>, drawToolbarHost) : null}
      {dropActive&&<div className="pointer-events-none absolute inset-3 z-[9999] grid place-items-center rounded-xl border-2 border-dashed border-violet-400/70 bg-violet-500/8"><div className="flex items-center gap-2 rounded-lg bg-[#18181b]/95 px-4 py-2 text-sm text-violet-100 shadow-xl"><ImagePlus className="size-5"/>Drop image or file into this page</div></div>}
      <div className="canvas-zoom-controls canvas-floating-ui absolute left-3 bottom-3 z-[10000] flex flex-wrap items-center gap-1 rounded-lg border border-white/10 bg-[#18181b]/95 p-1 shadow-xl">
        <button className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>zoomAt(.9,undefined,undefined,true)}><ZoomOut className="size-4"/></button><span ref={floatingZoomRef} className="min-w-12 text-center text-xs text-neutral-400">{Math.round(viewport.zoom*100)}%</span><button className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>zoomAt(1.1,undefined,undefined,true)}><ZoomIn className="size-4"/></button><button title={`${focusMode?"Exit":"Enter"} Focus Mode`} className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={onToggleFocusMode}>{focusMode?<Minimize2 className="size-4"/>:<Maximize2 className="size-4"/>}</button>
      </div>
      {(selectedIds.size>0||selectedShapeIds.size>0||selectedInkIds.size>0)&&<div className="canvas-floating-ui absolute bottom-3 right-3 z-[10000] flex flex-wrap items-center justify-end gap-1 rounded-lg border border-white/10 bg-[#18181b]/95 p-1 shadow-xl">
        <span className="px-2 text-xs text-neutral-500">{selectedIds.size + selectedShapeIds.size + selectedInkIds.size} selected</span>{selectionBounds&&<button title="Fit selection in view" className="rounded px-2 py-1 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white" onClick={fitSelection}>Fit</button>}
        {selectedIds.size>0&&<button title="Combine selected typed text, existing math symbols, and pen ink into one editable LaTeX equation" disabled={ocrBusy} className="flex items-center gap-1 rounded bg-cyan-500/12 px-2 py-1 text-[10px] text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50" onClick={()=>void combineSelectionAsMath()}><Sigma className="size-3"/>{ocrBusy?"Combining…":"Combine → math"}</button>}
        {selectedIds.size>1&&<button title="Merge selected note containers" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={mergeSelectedContainers}><Layers className="size-4"/></button>}
        {(selectedIds.size>0||selectedShapeIds.size>0)&&<><button title="Bring to front" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>layerSelected(true)}><ArrowUpToLine className="size-4"/></button><button title="Send to back" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>layerSelected(false)}><ArrowDownToLine className="size-4"/></button></>}
        {selectedShapeIds.size>0&&<>
          <input title="Shape stroke color" aria-label="Shape stroke color" type="color" value={shapes.find(s=>selectedShapeIds.has(s.id))?.stroke??penColor} onChange={e=>{pushHistory();const ids=new Set(selectedShapeIds);mutateShapes(items=>items.map(item=>ids.has(item.id)?{...item,stroke:e.target.value}:item));}} className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"/>
          {shapes.some(s=>selectedShapeIds.has(s.id)&&(s.kind==="rectangle"||s.kind==="ellipse"))&&<>
            <input title="Shape fill color" aria-label="Shape fill color" type="color" value={(shapes.find(s=>selectedShapeIds.has(s.id)&&s.fill!=="transparent")?.fill as string)||"#8b5cf6"} onChange={e=>{pushHistory();const ids=new Set(selectedShapeIds);mutateShapes(items=>items.map(item=>ids.has(item.id)&&(item.kind==="rectangle"||item.kind==="ellipse")?{...item,fill:e.target.value}:item));}} className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"/>
            <button title="No shape fill" className="rounded px-1.5 py-1 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>{pushHistory();const ids=new Set(selectedShapeIds);mutateShapes(items=>items.map(item=>ids.has(item.id)?{...item,fill:"transparent"}:item));}}>No fill</button>
          </>}
          <CustomSizeInput title="Shape line width — type any positive value" ariaLabel="Selected shape line width" value={shapes.find(s=>selectedShapeIds.has(s.id))?.strokeWidth??2} recommended={[1,2,3,5,8]} onCommit={strokeWidth=>{pushHistory();const ids=new Set(selectedShapeIds);mutateShapes(items=>items.map(item=>ids.has(item.id)?{...item,strokeWidth}:item));}} className="w-20"/>
          <button title="Delete selected shapes" className="rounded p-1.5 text-neutral-400 hover:bg-red-500/15 hover:text-red-300" onClick={()=>{pushHistory();const ids=new Set(selectedShapeIds);mutateShapes(items=>items.filter(item=>!ids.has(item.id)));setSelectedShapeIds(new Set());}}><Trash2 className="size-4"/></button>
        </>}
        {selectedInkIds.size>0&&<>
          {selectedIds.size===0&&<><button title="Recognize selected handwriting as text using Gemini" disabled={ocrBusy} className="rounded px-2 py-1 text-[10px] text-neutral-300 hover:bg-white/10 disabled:opacity-50" onClick={()=>void recognizeSelectedInk()}>{ocrBusy ? "Reading…" : "Ink → text"}</button>
          <button title="Recognize selected handwritten equation as editable LaTeX math" disabled={ocrBusy} className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-neutral-300 hover:bg-white/10 disabled:opacity-50" onClick={()=>void recognizeSelectedInkAsMath()}><Sigma className="size-3"/>Ink → math</button>
          <button title="Convert selected ink to a clean shape" className="rounded px-2 py-1 text-[10px] text-neutral-300 hover:bg-white/10" onClick={convertSelectedInkToShape}>Ink → shape</button></>}
          <button title="Delete selected ink" className="rounded p-1.5 text-neutral-400 hover:bg-red-500/15 hover:text-red-300" onClick={()=>{pushHistory();const ids=new Set(selectedInkIds);mutateInk(items=>items.filter(item=>!ids.has(item.id)));setSelectedInkIds(new Set());}}><Eraser className="size-4"/></button>
        </>}
        {(selectedIds.size+selectedShapeIds.size)>1&&<><button title="Align left" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>alignSelected("left")}><AlignLeft className="size-4"/></button><button title="Align top" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>alignSelected("top")}><Layers className="size-4"/></button></>}
        <button title="Snap selection to page grid" className="rounded px-2 py-1 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white" onClick={snapSelectedToGrid}>Snap</button>
        {selectedIds.size>2&&<><button title="Distribute horizontally" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>distributeSelected("horizontal")}><Columns3 className="size-4"/></button><button title="Distribute vertically" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" onClick={()=>distributeSelected("vertical")}><Rows3 className="size-4"/></button></>}
      </div>}
      <div ref={worldRef} className="canvas-world absolute origin-top-left" style={{transform:canvasViewportTransform(viewport),width:8000,height:8000}}>
        {containers.map(item=><NoteContainerView key={item.id} item={item} selected={selectedIds.has(item.id)} autoFocus={focusRequestId===item.id} onSelect={(additive)=>select(item.id,additive)} onEditorReady={setActiveEditor} registerEditor={registerEditor} onChange={(content,text)=>mutate(items=>items.map(i=>i.id===item.id?{...i,content,plainText:text}:i))} onMoveStart={pushHistory} onMoveDelta={(dx,dy)=>moveSelected(item.id,dx,dy)} onMoveEnd={commitCanvas} onResizeStart={pushHistory} onResize={width=>setContainersTransient(items=>items.map(i=>i.id===item.id?{...i,width}:i))} onResizeEnd={commitCanvas} onBlur={()=>pruneEmptyContainer(item.id)} onDelete={()=>deleteContainer(item.id)} onDuplicate={()=>duplicateContainer(item)} onCopyLink={()=>copyContainerLink(item.id)} onOpenInternalPage={onOpenInternalPage} onAsk={(prompt,range)=>void runCloudAsk(item.id,prompt,range)}/>) }
        {marquee&&<div className="pointer-events-none absolute z-[950000] border border-violet-400/80 bg-violet-500/10" style={{left:marquee.x,top:marquee.y,width:marquee.width,height:marquee.height}}/>}
        {selectionBounds&&<div className="mixed-selection-box pointer-events-none absolute z-[900070]" style={{left:selectionBounds.left-6,top:selectionBounds.top-6,width:Math.max(18,selectionBounds.right-selectionBounds.left+12),height:Math.max(18,selectionBounds.bottom-selectionBounds.top+12)}}/>}
        <svg className="canvas-shapes-layer pointer-events-none absolute inset-0 z-[899999] overflow-visible" width="8000" height="8000" aria-label="Drawing shapes">
          <defs><marker id="lenota-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L8,3 z" fill="context-stroke"/></marker></defs>
          {[...shapes].sort((a,b)=>(a.zIndex??0)-(b.zIndex??0)).map(shape=>{
            const b=shapeBounds(shape), selected=selectedShapeIds.has(shape.id), cx=(b.left+b.right)/2, cy=(b.top+b.bottom)/2;
            const onShapePointerDown=(e:ReactPointerEvent<SVGElement>)=>{
              if(e.button===1)return;
              if(drawingTool!=="select")return;
              e.preventDefault();e.stopPropagation();
              const ids=e.shiftKey?new Set([...selectedShapeIds,shape.id]):(selectedShapeIds.has(shape.id)&&selectedShapeIds.size>1?new Set(selectedShapeIds):new Set([shape.id]));
              setSelectedShapeIds(ids);setSelectedInkIds(new Set());if(!e.shiftKey)setSelectedIds(new Set());setActiveEditor(null);pushHistory();
              let lastX=e.clientX,lastY=e.clientY;
              const move=(p:PointerEvent)=>{
                const delta=worldDelta(p.clientX-lastX,p.clientY-lastY);lastX=p.clientX;lastY=p.clientY;
                setShapesTransient(items=>items.map(item=>ids.has(item.id)?{...item,x1:item.x1+delta.x,y1:item.y1+delta.y,x2:item.x2+delta.x,y2:item.y2+delta.y}:item));
              };
              const up=()=>{commitCanvas();window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);};
              window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
            };
            const common={stroke:themeAwareStroke(shape.stroke,theme),strokeWidth:shape.strokeWidth,fill:shape.fill,className:`canvas-shape ${selected?"is-selected":""}`,"data-shape-id":shape.id,style:{pointerEvents:drawingTool==="fill"?"all":"visiblePainted"} as CSSProperties,onPointerDown:onShapePointerDown};
            const transform=shape.rotation?`rotate(${shape.rotation} ${cx} ${cy})`:undefined;
            if(shape.kind==="rectangle")return <rect key={shape.id} x={b.left} y={b.top} width={Math.max(1,b.right-b.left)} height={Math.max(1,b.bottom-b.top)} transform={transform} {...common}/>;
            if(shape.kind==="ellipse")return <ellipse key={shape.id} cx={cx} cy={cy} rx={Math.max(1,Math.abs(shape.x2-shape.x1)/2)} ry={Math.max(1,Math.abs(shape.y2-shape.y1)/2)} transform={transform} {...common}/>;
            return <line key={shape.id} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} markerEnd={shape.kind==="arrow"?"url(#lenota-arrow)":undefined} {...common}/>;
          })}
        </svg>
        {selectedShapeIds.size>1&&shapes.filter(shape=>selectedShapeIds.has(shape.id)).map(shape=>{
          const b=shapeBounds(shape);
          if(shape.kind==="line"||shape.kind==="arrow")return <div key={`multi-outline-${shape.id}`} className="pointer-events-none absolute z-[900080] border border-dashed border-violet-400/85" style={{left:Math.min(shape.x1,shape.x2)-4,top:Math.min(shape.y1,shape.y2)-4,width:Math.max(8,Math.abs(shape.x2-shape.x1)+8),height:Math.max(8,Math.abs(shape.y2-shape.y1)+8)}}/>;
          return <div key={`multi-outline-${shape.id}`} className="shape-selection-box shape-selection-box-multi pointer-events-none absolute z-[900080]" style={{left:b.left,top:b.top,width:Math.max(8,b.right-b.left),height:Math.max(8,b.bottom-b.top),transform:`rotate(${shape.rotation??0}deg)`}}/>;
        })}
        {selectedShapeIds.size===1&&shapes.filter(shape=>selectedShapeIds.has(shape.id)).map(shape=>{
          const b=shapeBounds(shape);
          if(shape.kind==="line"||shape.kind==="arrow")return <div key={`handles-${shape.id}`} className="pointer-events-none absolute inset-0 z-[900100]">
            <div className="shape-endpoint-handle pointer-events-auto absolute" style={{left:shape.x1-5,top:shape.y1-5}} onPointerDown={e=>beginShapeHandle(shape,"start",e)}/>
            <div className="shape-endpoint-handle pointer-events-auto absolute" style={{left:shape.x2-5,top:shape.y2-5}} onPointerDown={e=>beginShapeHandle(shape,"end",e)}/>
          </div>;
          return <div key={`handles-${shape.id}`} className="shape-selection-box pointer-events-none absolute z-[900100]" style={{left:b.left,top:b.top,width:Math.max(8,b.right-b.left),height:Math.max(8,b.bottom-b.top),transform:`rotate(${shape.rotation??0}deg)`}}>
            <div className="shape-rotate-stem"/><div title="Rotate shape" className="shape-rotate-handle pointer-events-auto" onPointerDown={e=>beginShapeHandle(shape,"rotate",e)}/>
            {(["nw","ne","sw","se"] as const).map(handle=><div key={handle} className={`shape-resize-handle shape-resize-${handle} pointer-events-auto`} onPointerDown={e=>beginShapeHandle(shape,handle,e)}/>)}
          </div>;
        })}
        <svg className="canvas-ink-layer pointer-events-none absolute inset-0 z-[900000] overflow-visible" width="8000" height="8000" aria-hidden="true">
          {ink.map(stroke=><g key={stroke.id}>
            {selectedInkIds.has(stroke.id)&&<path d={strokePath(stroke.points)} fill="none" stroke="#a78bfa" strokeWidth={stroke.width+7} strokeLinecap="round" strokeLinejoin="round" opacity=".28"/>}
            <path d={strokePath(stroke.points)} fill="none" stroke={themeAwareStroke(stroke.color,theme)} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" opacity={stroke.tool==="highlighter"?.32:1} style={{mixBlendMode:stroke.tool==="highlighter"?"multiply":"normal"}}/>
          </g>)}
          {lassoPath&&lassoPath.length>1&&<path className="lasso-preview" d={`${strokePath(lassoPath)} Z`} fill={drawingTool==="ask"?"rgba(34,211,238,.07)":"rgba(139,92,246,.05)"} stroke={drawingTool==="ask"?"#67e8f9":"#a78bfa"} strokeWidth={1.5/stateRef.current.viewport.zoom} strokeDasharray={`${6/stateRef.current.viewport.zoom} ${5/stateRef.current.viewport.zoom}`}/>} 
        </svg>
        {inkSelection&&<div title="Drag selected ink" className="ink-selection-box absolute z-[900150] cursor-move" style={{left:inkSelection.left-8,top:inkSelection.top-8,width:Math.max(20,inkSelection.right-inkSelection.left+16),height:Math.max(20,inkSelection.bottom-inkSelection.top+16)}} onPointerDown={moveInkSelection}/>}
      </div>
      </div>
      {!focusMode && inspectorOpen ? <aside className="context-inspector no-print w-[292px] shrink-0 overflow-y-auto border-l border-white/8 bg-[#17191f] text-sm">
        <div className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-white/8 bg-[#17191f]/95 px-4 backdrop-blur">
          <div>
            <div className="font-semibold text-neutral-100">Inspector</div>
            <div className="text-[11px] text-neutral-600">{selectionCount ? `${selectionCount} canvas item${selectionCount === 1 ? "" : "s"} selected` : "Page settings"}</div>
          </div>
          <button type="button" className="grid size-8 place-items-center rounded-lg text-neutral-500 hover:bg-white/8 hover:text-white" title="Close inspector" onClick={()=>setInspectorOpen(false)}><X className="size-4"/></button>
        </div>

        <div className="space-y-3 p-3">
          {inspectorMathSelected && liveInspectorEditor ? <section className="inspector-card space-y-3 rounded-xl border border-cyan-400/15 bg-cyan-500/[.045] p-3">
            <div className="flex items-center gap-2 font-semibold text-cyan-200"><Sigma className="size-4"/>Equation</div>
            <div className="inspector-equation-preview" style={{color:themeAwareStroke(String(inspectorMathAttrs.color??(theme==="light"?"#25231f":"#d4d4d8")),theme)}} dangerouslySetInnerHTML={{__html:katex.renderToString(String(inspectorMathAttrs.latex??"?"),{throwOnError:false,strict:"ignore",displayMode:true,output:"htmlAndMathml",trust:false})}}/>
            <label className="block text-[11px] font-medium text-neutral-500">LaTeX source
              <textarea className="ui-selectable mt-1 min-h-20 w-full resize-y rounded-lg border border-white/10 bg-black/15 p-2 font-mono text-xs text-neutral-200 outline-none focus:border-cyan-400/40" value={String(inspectorMathAttrs.latex??"")} onChange={event=>liveInspectorEditor.chain().updateAttributes("mathExpression",{latex:event.target.value,solved:false}).run()}/>
            </label>
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-neutral-500">Alignment</div>
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/8 bg-black/10 p-1">
                {(["left","center","right"] as MathAlignment[]).map(align=><button key={align} type="button" title={`Align ${align}`} className={cn("grid h-8 place-items-center rounded-md text-neutral-500 hover:bg-white/8 hover:text-white",normalizeMathAlignment(inspectorMathAttrs.align)===align&&"bg-violet-500/20 text-violet-100")} onMouseDown={event=>event.preventDefault()} onClick={()=>liveInspectorEditor.chain().focus().updateAttributes("mathExpression",{display:true,align}).run()}>{align==="left"?<AlignLeft className="size-4"/>:align==="center"?<AlignCenter className="size-4"/>:<AlignRight className="size-4"/>}</button>)}
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 text-[11px] font-medium text-neutral-500">Color
              <input aria-label="Equation color" type="color" value={/^#[0-9a-f]{6}$/i.test(String(inspectorMathAttrs.color??""))?String(inspectorMathAttrs.color):theme==="light"?"#25231f":"#d4d4d8"} onChange={event=>liveInspectorEditor.chain().focus().updateAttributes("mathExpression",{color:event.target.value}).run()} className="h-8 w-12 rounded border border-white/10 bg-transparent p-0.5"/>
            </label>
            <label className="flex items-center justify-between gap-3 text-[11px] font-medium text-neutral-500">Size
              <CustomSizeInput title="Equation size — type any positive value" ariaLabel="Inspector equation size" value={customSizeOr(inspectorMathAttrs.fontSize,24,1)} recommended={[12,16,20,24,32,48,64,96,144,220]} minimum={1} onCommit={fontSize=>liveInspectorEditor.chain().focus().updateAttributes("mathExpression",{fontSize,autoFit:false}).run()} className="w-28"/>
            </label>
            <div className="space-y-1.5">
              <button type="button" className="flex h-9 w-full items-center justify-between rounded-lg bg-violet-600 px-3 text-xs font-semibold text-white hover:bg-violet-500" onMouseDown={event=>event.preventDefault()} onClick={()=>triggerSelectedMathAction("Solve")}><span className="flex items-center gap-2"><Sigma className="size-3.5"/>Solve</span><ChevronRight className="size-3.5"/></button>
              <button type="button" className="flex h-9 w-full items-center justify-between rounded-lg border border-white/8 px-3 text-xs text-neutral-300 hover:bg-white/5 hover:text-white" onMouseDown={event=>event.preventDefault()} onClick={()=>triggerSelectedMathAction("Steps")}><span className="flex items-center gap-2"><ListOrdered className="size-3.5"/>Steps</span><ChevronRight className="size-3.5"/></button>
              <button type="button" className="flex h-9 w-full items-center justify-between rounded-lg border border-white/8 px-3 text-xs text-neutral-300 hover:bg-white/5 hover:text-white" onMouseDown={event=>event.preventDefault()} onClick={()=>triggerSelectedMathAction("Graph")}><span className="flex items-center gap-2"><ArrowUpRight className="size-3.5"/>Graph</span><ChevronRight className="size-3.5"/></button>
            </div>
          </section> : null}

          {inspectorImageSelected && liveInspectorEditor ? <section className="inspector-card space-y-3 rounded-xl border border-white/8 bg-white/[.025] p-3">
            <div className="flex items-center gap-2 font-semibold text-neutral-100"><ImagePlus className="size-4 text-violet-300"/>Image</div>
            <label className="flex items-center justify-between gap-3 text-[11px] font-medium text-neutral-500">Width
              <CustomSizeInput title="Image width — type any positive value" ariaLabel="Inspector image width" value={customSizeOr(inspectorImageAttrs.imageWidth,520,1)} recommended={[260,420,520,720,900,1200,1400]} minimum={1} onCommit={width=>setSelectedImageWidth(liveInspectorEditor,width)} className="w-28"/>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant="outline" onClick={()=>rotateSelectedImage(liveInspectorEditor,-90)}><RotateCcw className="size-3.5"/>Left</Button>
              <Button size="sm" variant="outline" onClick={()=>rotateSelectedImage(liveInspectorEditor,90)}><RotateCw className="size-3.5"/>Right</Button>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {(["left","center","right"] as const).map(align=><button key={align} type="button" className="grid h-8 place-items-center rounded-lg border border-white/8 text-neutral-500 hover:bg-white/8 hover:text-white" onClick={()=>setSelectedImageAlign(liveInspectorEditor,align)}>{align==="left"?<AlignLeft className="size-4"/>:align==="center"?<AlignCenter className="size-4"/>:<AlignRight className="size-4"/>}</button>)}
            </div>
            <Button className="w-full" size="sm" variant="ghost" onClick={()=>editImageAltText(liveInspectorEditor)}>Edit alt text</Button>
          </section> : null}

          {!inspectorMathSelected && !inspectorImageSelected && selectedShape ? <section className="inspector-card space-y-3 rounded-xl border border-white/8 bg-white/[.025] p-3">
            <div className="flex items-center gap-2 font-semibold capitalize text-neutral-100"><Square className="size-4 text-violet-300"/>{selectedShape.kind}</div>
            <label className="flex items-center justify-between text-[11px] font-medium text-neutral-500">Stroke
              <input aria-label="Shape stroke color" type="color" value={selectedShape.stroke} onChange={event=>{const ids=new Set(selectedShapeIds);mutateShapes(items=>items.map(item=>ids.has(item.id)?{...item,stroke:event.target.value}:item));}} className="h-8 w-12 rounded border border-white/10 bg-transparent p-0.5"/>
            </label>
            {(selectedShape.kind==="rectangle"||selectedShape.kind==="ellipse")?<label className="flex items-center justify-between text-[11px] font-medium text-neutral-500">Fill
              <input aria-label="Shape fill color" type="color" value={selectedShape.fill==="transparent"?"#8b5cf6":selectedShape.fill} onChange={event=>{setShapeFillColor(event.target.value);const ids=new Set(selectedShapeIds);mutateShapes(items=>items.map(item=>ids.has(item.id)?{...item,fill:event.target.value}:item));}} className="h-8 w-12 rounded border border-white/10 bg-transparent p-0.5"/>
            </label>:null}
            <label className="flex items-center justify-between gap-3 text-[11px] font-medium text-neutral-500">Line width
              <CustomSizeInput title="Shape line width — type any positive value" ariaLabel="Inspector shape line width" value={selectedShape.strokeWidth} recommended={[1,1.5,2,3,5,8,12]} onCommit={strokeWidth=>{const ids=new Set(selectedShapeIds);mutateShapes(items=>items.map(item=>ids.has(item.id)?{...item,strokeWidth}:item));}} className="w-28"/>
            </label>
          </section> : null}

          {!inspectorMathSelected && !inspectorImageSelected && selectedStroke ? <section className="inspector-card space-y-3 rounded-xl border border-white/8 bg-white/[.025] p-3">
            <div className="flex items-center gap-2 font-semibold capitalize text-neutral-100"><PenLine className="size-4 text-violet-300"/>{selectedStroke.tool} ink</div>
            <label className="flex items-center justify-between text-[11px] font-medium text-neutral-500">Color
              <input aria-label="Ink color" type="color" value={selectedStroke.color} onChange={event=>{const ids=new Set(selectedInkIds);mutateInk(items=>items.map(item=>ids.has(item.id)?{...item,color:event.target.value}:item));}} className="h-8 w-12 rounded border border-white/10 bg-transparent p-0.5"/>
            </label>
            <label className="flex items-center justify-between gap-3 text-[11px] font-medium text-neutral-500">Width
              <CustomSizeInput title="Ink width — type any positive value" ariaLabel="Inspector ink width" value={selectedStroke.width} recommended={selectedStroke.tool==="highlighter"?[10,14,18,24,32,36]:[1,1.5,2.5,4,6,9,12]} onCommit={width=>{const ids=new Set(selectedInkIds);mutateInk(items=>items.map(item=>ids.has(item.id)?{...item,width}:item));}} className="w-28"/>
            </label>
          </section> : null}

          {!inspectorMathSelected && !inspectorImageSelected && selectedNote ? <section className="inspector-card space-y-3 rounded-xl border border-white/8 bg-white/[.025] p-3">
            <div className="flex items-center gap-2 font-semibold text-neutral-100"><FileText className="size-4 text-violet-300"/>Note container</div>
            <label className="flex items-center justify-between gap-3 text-[11px] font-medium text-neutral-500">Width
              <CustomSizeInput title="Note width — type any value above the editing minimum" ariaLabel="Note width" value={selectedNote.width} recommended={[180,260,360,520,720,900,1200,1400]} minimum={MIN_WIDTH} onCommit={width=>mutate(items=>items.map(item=>selectedIds.has(item.id)?{...item,width}:item))} className="w-28"/>
            </label>
            <div className="grid grid-cols-2 gap-2"><Button size="sm" variant="outline" onClick={()=>layerSelected(true)}>Bring front</Button><Button size="sm" variant="outline" onClick={()=>layerSelected(false)}>Send back</Button></div>
            <div className="grid grid-cols-2 gap-2"><Button size="sm" variant="ghost" onClick={()=>duplicateContainer(selectedNote)}><Copy className="size-3.5"/>Duplicate</Button><Button size="sm" variant="ghost" onClick={()=>deleteContainer(selectedNote.id)}><Trash2 className="size-3.5"/>Delete</Button></div>
          </section> : null}

          {!selectionCount && !inspectorMathSelected && !inspectorImageSelected ? <div className="rounded-xl border border-dashed border-white/10 px-3 py-5 text-center text-xs leading-5 text-neutral-600">Select a note, equation, image, shape, or handwriting to edit its properties here.</div> : null}

          <section className="inspector-card space-y-3 rounded-xl border border-white/8 bg-white/[.025] p-3">
            <div className="flex items-center gap-2 font-semibold text-neutral-100"><Layers className="size-4 text-violet-300"/>Canvas</div>
            <label className="block text-[11px] font-medium text-neutral-500">Paper style
              <select value={background.pattern} onChange={event=>updateBackground({...background,pattern:event.target.value as CanvasBackground["pattern"]})} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-[#25252a] px-2 text-xs text-neutral-300"><option value="plain">Plain</option><option value="ruled">Ruled</option><option value="grid">Grid</option></select>
            </label>
            <label className="flex items-center justify-between text-[11px] font-medium text-neutral-500">Page color
              <input aria-label="Page color" type="color" value={themeAwareCanvasColor(background.color,theme)} onChange={event=>updateBackground({...background,color:event.target.value})} className="h-8 w-12 rounded border border-white/10 bg-transparent p-0.5"/>
            </label>
            {background.pattern!=="plain"?<label className="flex items-center justify-between gap-3 text-[11px] font-medium text-neutral-500">Spacing<CustomSizeInput title="Page ruling spacing — type any positive value" ariaLabel="Page ruling spacing" value={background.spacing} recommended={[8,12,16,20,24,32,48,64]} minimum={1} onCommit={spacing=>updateBackground({...background,spacing})} className="w-28"/></label>:null}
          </section>
        </div>
      </aside> : null}
    </div>
    <footer className="editor-status-bar no-print flex h-12 shrink-0 items-center border-t border-white/8 bg-[#17191f] px-3 text-xs text-neutral-500">
      <div className="flex min-w-52 items-center gap-4"><SaveIndicator state={saveState}/><span>{selectionCount ? `${selectionCount} item${selectionCount===1?"":"s"} selected` : "Ready"}</span></div>
      <div className="mx-auto flex items-center gap-3"><ChevronLeft className="size-4 opacity-40"/><span>Page 1 of 1</span><ChevronRight className="size-4 opacity-40"/></div>
      <div className="flex min-w-52 items-center justify-end gap-1">
        <button type="button" className={cn("grid size-8 place-items-center rounded-lg hover:bg-white/8 hover:text-white",inspectorOpen&&"bg-violet-500/15 text-violet-200")} title="Toggle inspector" onClick={()=>setInspectorOpen(value=>!value)}><SlidersHorizontal className="size-4"/></button>
        <span className="mx-2 h-5 w-px bg-white/8"/>
        <button type="button" className="grid size-8 place-items-center rounded-lg hover:bg-white/8 hover:text-white" title="Zoom out" onClick={()=>zoomAt(.9,undefined,undefined,true)}><ZoomOut className="size-4"/></button>
        <span ref={statusZoomRef} className="w-12 text-center tabular-nums">{Math.round(viewport.zoom*100)}%</span>
        <button type="button" className="grid size-8 place-items-center rounded-lg hover:bg-white/8 hover:text-white" title="Zoom in" onClick={()=>zoomAt(1.1,undefined,undefined,true)}><ZoomIn className="size-4"/></button>
        <button type="button" className="grid size-8 place-items-center rounded-lg hover:bg-white/8 hover:text-white" title="Fit all page content" onClick={fitCanvas}><Focus className="size-4"/></button>
        <button type="button" className="grid size-8 place-items-center rounded-lg hover:bg-white/8 hover:text-white" title="Enter Focus Mode" onClick={onToggleFocusMode}><Maximize2 className="size-4"/></button>
      </div>
    </footer>
  </main>;
}
