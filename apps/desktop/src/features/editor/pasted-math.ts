import type { JSONContent } from "@tiptap/core";
import { parseCloudInlineMath } from "./cloud-ai-content.ts";
import { repairGeneratedLatexSource } from "./latex-repair.ts";

/** Convert explicitly delimited TeX in pasted Markdown/plain text into actual,
 * editable LeNota math nodes. Unmarked prose and fenced code are untouched.
 * This runs only on paste, so existing note documents aren't reinterpreted. */
export function pastedMathToTiptap(value: string): JSONContent[] | null {
  if (!value || value.length > 250_000 || !/(?:\$|\\\(|\\\[)/.test(value)) return null;
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: JSONContent[] = [];
  let hasMath = false;
  let paragraphLines: string[] = [];
  let listKind: "bulletList" | "orderedList" | null = null;
  let listItems: JSONContent[] = [];
  const mathNode = (source: string, display: boolean): JSONContent => ({
    type: "mathExpression", attrs: { latex: repairGeneratedLatexSource(source).latex, display, fontSize: 24, autoFit: false },
  });
  const inline = (source: string): JSONContent[] => {
    const result: JSONContent[] = [];
    // Preserve simple Markdown emphasis alongside equations in pasted notes.
    for (const piece of parseCloudInlineMath(source)) {
      if (piece.kind === "math") {
        hasMath = true;
        result.push(mathNode(piece.latex, piece.display));
      } else {
        const parts = piece.text.split(/(\*\*[^*\n]+\*\*)/g);
        for (const part of parts) {
          if (!part) continue;
          if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
            result.push({ type: "text", text: part.slice(2, -2), marks: [{ type: "bold" }] });
          else result.push({ type: "text", text: part });
        }
      }
    }
    return result;
  };
  const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: inline(text) });
  const flushParagraph = () => {
    if (paragraphLines.length) {
      blocks.push(paragraph(paragraphLines.join(" ")));
      paragraphLines = [];
    }
  };
  const flushList = () => {
    if (listKind && listItems.length) blocks.push({ type: listKind, content: listItems });
    listKind = null;
    listItems = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (/^\s*(```|~~~)/.test(raw)) {
      flushParagraph(); flushList();
      const fence = raw.trim().slice(0, 3);
      const contents = [raw];
      index++;
      while (index < lines.length) {
        contents.push(lines[index]);
        if (lines[index].trim().startsWith(fence)) break;
        index++;
      }
      // Leave syntax visible rather than mistakenly turning examples in code into equations.
      blocks.push({ type: "paragraph", content: [{ type: "text", text: contents.join("\n") }] });
      continue;
    }
    const opening = raw.trim();
    if (opening === "$$" || opening === "\\[") {
      const closing = opening === "$$" ? "$$" : "\\]";
      const mathLines: string[] = [];
      let end = index + 1;
      while (end < lines.length && lines[end].trim() !== closing && end - index <= 100) {
        mathLines.push(lines[end]); end++;
      }
      if (end < lines.length && lines[end].trim() === closing && mathLines.join(" ").trim()) {
        flushParagraph(); flushList();
        hasMath = true;
        blocks.push({ type: "paragraph", content: [mathNode(mathLines.join("\n"), true)] });
        index = end;
        continue;
      }
    }
    if (!opening) { flushParagraph(); flushList(); continue; }
    const heading = /^\s*(#{1,3})\s+(.+)$/.exec(raw);
    if (heading) {
      flushParagraph(); flushList();
      blocks.push({ type: "heading", attrs: { level: heading[1].length }, content: inline(heading[2]) });
      continue;
    }
    const list = /^\s*(?:([-*+])\s+|(\d+)[.)]\s+)(.+)$/.exec(raw);
    if (list) {
      flushParagraph();
      const nextKind = list[1] ? "bulletList" : "orderedList";
      if (listKind !== nextKind) flushList();
      listKind = nextKind;
      listItems.push({ type: "listItem", content: [paragraph(list[3])] });
      continue;
    }
    flushList();
    // Preserve each line with inline math; paragraphs separated by empty lines.
    paragraphLines.push(raw);
  }
  flushParagraph(); flushList();
  return hasMath && blocks.length ? blocks : null;
}
