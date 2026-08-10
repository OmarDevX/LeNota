export interface MixedMathBounds {
  left:number;
  top:number;
  right:number;
  bottom:number;
}

export interface MixedMathPart {
  id:string;
  latex:string;
  bounds:MixedMathBounds;
  source:"ink"|"text"|"math";
}

export interface MixedMathComposition {
  latex:string;
  operatorId:string|null;
  upperIds:string[];
  lowerIds:string[];
  bodyIds:string[];
}

const SIMPLE_ALIASES:Record<string,string>={
  sum:"\\sum",sigma:"\\sum",integral:"\\int",int:"\\int",
  product:"\\prod",prod:"\\prod",root:"\\sqrt",sqrt:"\\sqrt",
  limit:"\\lim",lim:"\\lim",infinity:"\\infty",inf:"\\infty",
  pi:"\\pi",theta:"\\theta",alpha:"\\alpha",beta:"\\beta",
};

function stripMathDelimiters(value:string):string {
  let text=value.trim();
  if(text.startsWith("$$")&&text.endsWith("$$")&&text.length>4)text=text.slice(2,-2).trim();
  else if(text.startsWith("$")&&text.endsWith("$")&&text.length>2)text=text.slice(1,-1).trim();
  else if(text.startsWith("\\[")&&text.endsWith("\\]")&&text.length>4)text=text.slice(2,-2).trim();
  return text;
}

/** Convert intentionally typed, math-like text without asking an OCR/LLM model. */
export function typedMathToLatex(value:string):string {
  let text=stripMathDelimiters(value.replace(/\r?\n+/g," ").trim());
  if(!text)return "";
  const alias=SIMPLE_ALIASES[text.toLocaleLowerCase()];
  if(alias)return alias;

  text=text
    .replace(/∑/g,"\\sum ")
    .replace(/∏/g,"\\prod ")
    .replace(/∮/g,"\\oint ")
    .replace(/∫/g,"\\int ")
    .replace(/√/g,"\\sqrt ")
    .replace(/∞/g,"\\infty ")
    .replace(/π/g,"\\pi ")
    .replace(/θ/g,"\\theta ")
    .replace(/α/g,"\\alpha ")
    .replace(/β/g,"\\beta ")
    .replace(/≤/g,"\\le ")
    .replace(/≥/g,"\\ge ")
    .replace(/≠/g,"\\ne ")
    .replace(/≈/g,"\\approx ")
    .replace(/→/g,"\\to ")
    .replace(/×/g,"\\times ")
    .replace(/÷/g,"\\div ");

  text=text
    .replace(/<=/g,"\\le ")
    .replace(/>=/g,"\\ge ")
    .replace(/!=/g,"\\ne ")
    .replace(/->/g,"\\to ")
    .replace(/\b(sin|cos|tan|sec|csc|cot|log|ln|exp)\b/gi,match=>`\\${match.toLocaleLowerCase()}`)
    .replace(/\b(pi|theta|alpha|beta|gamma|delta|lambda|mu|sigma|omega)\b/gi,match=>`\\${match.toLocaleLowerCase()}`)
    .replace(/\binfinity\b|\binf\b/gi,"\\infty")
    .replace(/\*/g," \\cdot ");

  // Friendly function syntax: sqrt(x+1), sin(x), log(10). Keep this bounded
  // to a single non-nested argument; users can still type raw LaTeX for more.
  text=text.replace(/(?:\\sqrt|\bsqrt)\s*\(([^()]*)\)/gi,"\\sqrt{$1}");
  text=text.replace(/\\(sin|cos|tan|sec|csc|cot|log|ln|exp)\s*\(([^()]*)\)/g,"\\$1\\left($2\\right)");
  return text.replace(/\s+/g," ").trim();
}

function center(bounds:MixedMathBounds){
  return {x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2};
}
function dimensions(bounds:MixedMathBounds){
  return {width:Math.max(1,bounds.right-bounds.left),height:Math.max(1,bounds.bottom-bounds.top)};
}
interface MathCommandSpec {
  command:string;
  latex:string;
  hasLower:boolean;
  hasUpper:boolean;
}
function commandSpec(latex:string):MathCommandSpec|null {
  const compact=latex.replace(/\s+/g,"");
  const bare=compact.match(/^(\\(?:lim|sqrt|frac))$/);
  if(bare)return {command:bare[1],latex:bare[1],hasLower:false,hasUpper:false};
  const large=compact.match(/^(\\(?:sum|prod|int|oint|iint|iiint))((?:[_^]\{[^{}]*\})*)$/);
  if(!large)return null;
  return {command:large[1],latex:compact,hasLower:/_\{/.test(large[2]),hasUpper:/\^\{/.test(large[2])};
}
function readingOrder(parts:MixedMathPart[]):MixedMathPart[] {
  return [...parts].sort((a,b)=>{
    const ac=center(a.bounds),bc=center(b.bounds);
    const height=Math.max(dimensions(a.bounds).height,dimensions(b.bounds).height);
    return Math.abs(ac.y-bc.y)<=height*.55?a.bounds.left-b.bounds.left:ac.y-bc.y;
  });
}
function join(parts:MixedMathPart[]):string {
  return readingOrder(parts).map(part=>part.latex.trim()).filter(Boolean).join(" ").replace(/\s+/g," ").trim();
}
function groupedBody(latex:string):string {
  const value=latex.trim();
  if(!value)return "";
  if(/^\\left[([{]/.test(value)||/^[([{].*[)\]}]$/.test(value))return value;
  return /(?:\+|(?<!^)-|=|\\(?:pm|mp)\b)/.test(value)?`\\left(${value}\\right)`:value;
}

export function composeMixedMath(parts:MixedMathPart[]):MixedMathComposition {
  const usable=parts.filter(part=>part.latex.trim()&&Number.isFinite(part.bounds.left)&&Number.isFinite(part.bounds.top));
  if(!usable.length)return {latex:"",operatorId:null,upperIds:[],lowerIds:[],bodyIds:[]};

  const operatorCandidates=usable
    .map(part=>({part,spec:commandSpec(part.latex)}))
    .filter((entry):entry is {part:MixedMathPart;spec:MathCommandSpec}=>Boolean(entry.spec))
    .sort((a,b)=>a.part.bounds.left-b.part.bounds.left||dimensions(b.part.bounds).height-dimensions(a.part.bounds).height);
  const operatorEntry=operatorCandidates[0];

  if(operatorEntry){
    const operator=operatorEntry.part,{command}=operatorEntry.spec;
    const opCenter=center(operator.bounds),opSize=dimensions(operator.bounds);
    const others=usable.filter(part=>part.id!==operator.id);
    const upper:MixedMathPart[]=[],lower:MixedMathPart[]=[],body:MixedMathPart[]=[];
    const limitRight=operator.bounds.right+Math.max(opSize.width*2.2,opSize.height*1.15,80);
    for(const part of others){
      const partCenter=center(part.bounds);
      const horizontallyNear=partCenter.x>=operator.bounds.left-opSize.width*.55&&partCenter.x<=limitRight;
      if(horizontallyNear&&partCenter.y<opCenter.y-opSize.height*.22){upper.push(part);continue;}
      if(horizontallyNear&&partCenter.y>opCenter.y+opSize.height*.22){lower.push(part);continue;}
      body.push(part);
    }
    const upperLatex=join(upper),lowerLatex=join(lower),bodyLatex=join(body);

    if(command==="\\frac"){
      const latex=upperLatex&&lowerLatex?`\\frac{${upperLatex}}{${lowerLatex}}`:join(usable);
      return {latex,operatorId:operator.id,upperIds:upper.map(part=>part.id),lowerIds:lower.map(part=>part.id),bodyIds:body.map(part=>part.id)};
    }
    if(command==="\\sqrt"){
      const radicand=bodyLatex||upperLatex||lowerLatex;
      return {latex:radicand?`\\sqrt{${radicand}}`:"\\sqrt",operatorId:operator.id,upperIds:upper.map(part=>part.id),lowerIds:lower.map(part=>part.id),bodyIds:body.map(part=>part.id)};
    }
    if(command==="\\lim"){
      const condition=lowerLatex||upperLatex;
      return {latex:`\\lim${condition?`_{${condition}}`:""}${bodyLatex?` ${groupedBody(bodyLatex)}`:""}`,operatorId:operator.id,upperIds:upper.map(part=>part.id),lowerIds:lower.map(part=>part.id),bodyIds:body.map(part=>part.id)};
    }

    const scripts=`${lowerLatex&&!operatorEntry.spec.hasLower?`_{${lowerLatex}}`:""}${upperLatex&&!operatorEntry.spec.hasUpper?`^{${upperLatex}}`:""}`;
    return {
      latex:`${operatorEntry.spec.latex}${scripts}${bodyLatex?` ${groupedBody(bodyLatex)}`:""}`,
      operatorId:operator.id,
      upperIds:upper.map(part=>part.id),
      lowerIds:lower.map(part=>part.id),
      bodyIds:body.map(part=>part.id),
    };
  }

  // Generic layout supports a typed base with a separately positioned
  // exponent/subscript, while ordinary same-line selections simply concatenate.
  const base=[...usable].sort((a,b)=>dimensions(b.bounds).height-dimensions(a.bounds).height||a.bounds.left-b.bounds.left)[0];
  const ordered=readingOrder(usable.filter(part=>part.id!==base.id));
  const baseCenter=center(base.bounds),baseSize=dimensions(base.bounds);
  const superscript:MixedMathPart[]=[],subscript:MixedMathPart[]=[],body:MixedMathPart[]=[];
  for(const part of ordered){
    const partCenter=center(part.bounds);
    const toRight=part.bounds.left>=base.bounds.left+baseSize.width*.45;
    if(toRight&&partCenter.y<baseCenter.y-baseSize.height*.28){superscript.push(part);continue;}
    if(toRight&&partCenter.y>baseCenter.y+baseSize.height*.28){subscript.push(part);continue;}
    body.push(part);
  }
  const bodyLatex=join(body);
  const functionCommand=/^\\(?:sin|cos|tan|sec|csc|cot|log|ln|exp)$/.test(base.latex.trim());
  const latex=functionCommand&&bodyLatex
    ?`${base.latex.trim()}\\left(${bodyLatex}\\right)`
    :`${base.latex.trim()}${subscript.length?`_{${join(subscript)}}`:""}${superscript.length?`^{${join(superscript)}}`:""}${bodyLatex?` ${bodyLatex}`:""}`;
  return {latex,operatorId:null,upperIds:superscript.map(part=>part.id),lowerIds:subscript.map(part=>part.id),bodyIds:body.map(part=>part.id)};
}
