import { memo, useMemo } from "react";
import { pressureStrokePath, smoothInkPath, type InkStroke } from "./pen-input";
import { themeAwareInkColor, type InkAppearanceTheme } from "./ink-output-color";

const CommittedInkStroke = memo(function CommittedInkStroke({ stroke, selected, theme }: {
  stroke:InkStroke; selected:boolean; theme:InkAppearanceTheme;
}) {
  const pressure = stroke.tool==="pen" && Boolean(stroke.pressureEnabled);
  const centerline = useMemo(()=>!pressure||selected?smoothInkPath(stroke.points,stroke.smoothing??.7):"",
    [stroke.points,stroke.smoothing,pressure,selected]);
  const outline = useMemo(()=>pressure?pressureStrokePath(stroke):"",
    [stroke.points,stroke.width,stroke.smoothing,stroke.minPressureScale,stroke.maxPressureScale,pressure]);
  return <g>
    {selected&&<path d={centerline} fill="none" stroke="#a78bfa" strokeWidth={stroke.width+7} strokeLinecap="round" strokeLinejoin="round" opacity=".28"/>}
    {pressure
      ?<path d={outline} fill={themeAwareInkColor(stroke.color,theme)} stroke="none" opacity={stroke.opacity??1}/>
      :<path d={centerline} fill="none" stroke={themeAwareInkColor(stroke.color,theme)} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" opacity={stroke.opacity??(stroke.tool==="highlighter"?.32:1)} style={{mixBlendMode:stroke.tool==="highlighter"?"multiply":"normal"}}/>}
  </g>;
});

export const CommittedInkLayer = memo(function CommittedInkLayer({ ink, selectedIds, theme, liveStrokeId }: {
  ink:InkStroke[]; selectedIds:Set<string>; theme:InkAppearanceTheme; liveStrokeId?:string;
}) {
  return <>{ink.map(stroke=>stroke.id===liveStrokeId?null:<CommittedInkStroke key={stroke.id}
    stroke={stroke} selected={selectedIds.has(stroke.id)} theme={theme}/>)}</>;
});

