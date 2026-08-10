const wordEnd=/[\p{L}\p{N})\]}]/u;
const wordStart=/[\p{L}\p{N}([{]/u;

/** Add only the word-boundary spaces needed when handwriting lands inside an
 * existing text line. */
export function textForInlineHandwriting(text:string,before:string,after:string):string {
  const normalized=text.replace(/\s+/g," ").trim();
  if(!normalized)return "";
  const previous=before.at(-1)??"",next=after.at(0)??"";
  const leading=wordEnd.test(previous)&&wordStart.test(normalized.at(0)??"")?" ":"";
  const trailing=wordEnd.test(normalized.at(-1)??"")&&wordStart.test(next)?" ":"";
  return `${leading}${normalized}${trailing}`;
}

/** A coordinate hit can snap to the nearest paragraph even when the ink was
 * drawn below it. Only treat the hit as inline when its vertical center is on
 * the caret's rendered line. */
export function isOnRenderedTextLine(centerY:number,caretTop:number,caretBottom:number):boolean {
  const lineHeight=Math.max(1,caretBottom-caretTop);
  return centerY>=caretTop-lineHeight*.65&&centerY<=caretBottom+lineHeight*.65;
}
