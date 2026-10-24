import type { ReactNode } from "react";
import { Eraser, Focus, Hand, Highlighter, Minimize2, PenLine, Redo2, SlidersHorizontal, Undo2 } from "lucide-react";

type QuickTool = "pen" | "highlighter" | "eraser";

export function MobileDrawingToolbar(props: {
  activeTool: string;
  panning: boolean;
  color: string;
  width: number;
  canUndo: boolean;
  canRedo: boolean;
  focusMode: boolean;
  toolsOpen: boolean;
  onTool: (tool: QuickTool) => void;
  onPan: () => void;
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onFit: () => void;
  onTools: () => void;
  saveIndicator: ReactNode;
}) {
  const tools = [{ id: "pen", label: "Pen", Icon: PenLine }, { id: "highlighter", label: "Marker", Icon: Highlighter }, { id: "eraser", label: "Eraser", Icon: Eraser }] as const;
  const widths = props.activeTool === "highlighter" ? [10, 14, 18, 24, 32] : [1, 1.5, 2.5, 4, 6, 9];
  const choices = [...new Set([...widths, props.width])].sort((a, b) => a - b);
  return <div className="mobile-drawing-dock no-print" aria-label="Drawing controls">
    <div className="mobile-drawing-tools" role="toolbar" aria-label="Drawing tools">
      {tools.map(({ id, label, Icon }) => <button key={id} type="button" aria-label={label} aria-pressed={!props.panning && props.activeTool === id} onClick={() => props.onTool(id)}><Icon/><span>{label}</span></button>)}
      <button type="button" aria-label="Pan" aria-pressed={props.panning} onClick={props.onPan}><Hand/><span>Pan</span></button>
      <button type="button" aria-label="More drawing tools" aria-expanded={props.toolsOpen} onClick={props.onTools}><SlidersHorizontal/><span>Tools</span></button>
    </div>
    <div className="mobile-drawing-properties" role="toolbar" aria-label="Drawing properties">
      <button type="button" aria-label="Undo canvas change" title="Undo" disabled={!props.canUndo} onClick={props.onUndo}><Undo2/></button>
      <button type="button" aria-label="Redo canvas change" title="Redo" disabled={!props.canRedo} onClick={props.onRedo}><Redo2/></button>
      <button type="button" aria-label={props.focusMode ? "Exit Focus Mode" : "Fit page"} title={props.focusMode ? "Exit Focus Mode" : "Fit page"} onClick={props.onFit}>{props.focusMode ? <Minimize2/> : <Focus/>}</button>
      <label className="mobile-ink-color" title="Ink color"><span style={{ background: props.color }}/><input type="color" aria-label="Drawing color" value={props.color} onChange={event => props.onColor(event.target.value)}/></label>
      <select aria-label="Stroke width" title="Stroke width" value={props.width} onChange={event => props.onWidth(Number(event.target.value))}>{choices.map(width => <option key={width} value={width}>{width} px</option>)}</select>
      <span className="mobile-drawing-save" aria-live="polite">{props.saveIndicator}</span>
    </div>
  </div>;
}
