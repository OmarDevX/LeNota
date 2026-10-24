interface ParsedScript {
  marker:"_"|"^";
  value:string;
}

function readBraced(source:string,open:number):{value:string;end:number}|null {
  if(source[open]!=="{")return null;
  let depth=0;
  for(let index=open;index<source.length;index+=1){
    if(source[index]==="{")depth+=1;
    else if(source[index]==="}"){
      depth-=1;
      if(depth===0)return {value:source.slice(open+1,index),end:index+1};
    }
  }
  return null;
}

/**
 * Vision recognition sometimes emits a valid lower+upper pair followed by another
 * subscript/superscript. KaTeX rejects that as "Double subscript". Preserve
 * the first explicit lower and upper values and discard only later duplicates.
 * If OCR emitted two scripts of the same kind and no opposite kind, interpret
 * its documented reading order as upper then lower.
 */
export function repairDuplicateLargeOperatorScripts(source:string):{latex:string;repaired:boolean} {
  // `_` is a JavaScript "word" character, so `\b` does not match between
  // `\sum` and its subscript. Guard only against additional command letters.
  const operator=/\\(?:int|iint|iiint|oint|sum|prod)(?![A-Za-z])/g;
  let output="",cursor=0,repaired=false;
  for(let match=operator.exec(source);match;match=operator.exec(source)){
    output+=source.slice(cursor,match.index)+match[0];
    let position=operator.lastIndex;
    const scriptStart=position;
    const scripts:ParsedScript[]=[];
    while(position<source.length){
      let markerPosition=position;
      while(/\s/.test(source[markerPosition]??""))markerPosition+=1;
      const marker=source[markerPosition];
      if(marker!=="_"&&marker!=="^")break;
      position=markerPosition;
      let open=position+1;
      while(/\s/.test(source[open]??""))open+=1;
      const group=readBraced(source,open);
      if(!group)break;
      scripts.push({marker,value:group.value});
      position=group.end;
    }

    const lowers=scripts.filter(script=>script.marker==="_");
    const uppers=scripts.filter(script=>script.marker==="^");
    const duplicated=lowers.length>1||uppers.length>1;
    if(!duplicated){
      output+=source.slice(scriptStart,position);
    }else{
      repaired=true;
      let lower=lowers[0]?.value??"",upper=uppers[0]?.value??"";
      if(!upper&&lowers.length>=2){upper=lowers[0].value;lower=lowers[1].value;}
      else if(!lower&&uppers.length>=2){upper=uppers[0].value;lower=uppers[1].value;}
      output+=`${lower?`_{${lower}}`:""}${upper?`^{${upper}}`:""}`;
    }
    cursor=position;
    operator.lastIndex=position;
  }
  output+=source.slice(cursor);
  return {latex:output,repaired};
}

/**
 * OCR occasionally ends while macro groups are still open. Only repair the
 * safe form: every closing brace has an opener, all missing closers belong at
 * the end, and the imbalance is small. Escaped literal braces are ignored.
 */
export function repairUnclosedLatexGroups(source:string):{latex:string;repaired:boolean} {
  let depth=0;
  for(let index=0;index<source.length;index+=1){
    const character=source[index];
    if(character!=="{"&&character!=="}")continue;
    let slashes=0;
    for(let cursor=index-1;cursor>=0&&source[cursor]==="\\";cursor-=1)slashes+=1;
    if(slashes%2===1)continue;
    if(character==="{")depth+=1;
    else {
      if(depth===0)return {latex:source,repaired:false};
      depth-=1;
    }
  }
  if(depth===0||depth>6)return {latex:source,repaired:false};
  return {latex:`${source}${"}".repeat(depth)}`,repaired:true};
}


/**
 * JSON strings have single-character escapes such as \r, \t, \b and \f.
 * A model can accidentally emit a LaTeX command with only one JSON slash,
 * turning e.g. `\\right` into a carriage-return character plus `ight` after
 * JSON decoding. Restore those impossible-in-math control characters at the
 * app boundary. Newline needs a narrower heuristic because genuine line breaks
 * are also valid whitespace in TeX source.
 */
export function repairJsonEscapedLatexControls(source:string):{latex:string;repaired:boolean} {
  let output="",repaired=false;
  const newlineCommandSuffix=/^(?:abla|eq|e\b|not|u\b|eg\b|exists\b|in\b|ewline\b)/;
  for(let index=0;index<source.length;index+=1){
    const character=source[index];
    if(character==="\b"){output+="\\b";repaired=true;continue;}
    if(character==="\f"){output+="\\f";repaired=true;continue;}
    if(character==="\r"){output+="\\r";repaired=true;continue;}
    if(character==="\t"){output+="\\t";repaired=true;continue;}
    if(character==="\n"){
      const tail=source.slice(index+1);
      if(newlineCommandSuffix.test(tail)){output+="\\n";repaired=true;}
      else output+=" ";
      continue;
    }
    output+=character;
  }
  return {latex:output,repaired};
}

/**
 * KaTeX requires every \\left to have a matching \\right. When generated
 * output is truncated, preserve the expression by closing any unmatched left
 * delimiter invisibly. An unmatched right is safely downgraded to its ordinary
 * delimiter by removing only the `\\right` sizing command.
 */
export function repairUnmatchedLeftRight(source:string):{latex:string;repaired:boolean} {
  const token=/\\(left|right)\b/g;
  let depth=0,cursor=0,output="",repaired=false;
  for(let match=token.exec(source);match;match=token.exec(source)){
    output+=source.slice(cursor,match.index);
    if(match[1]==="left"){
      depth+=1;output+=match[0];
    }else if(depth>0){
      depth-=1;output+=match[0];
    }else{
      // Keep the actual delimiter that follows, only drop the unmatched
      // sizing directive which is what makes KaTeX reject the expression.
      repaired=true;
    }
    cursor=match.index+match[0].length;
  }
  output+=source.slice(cursor);
  if(depth>0){output+=String.raw`\right.`.repeat(depth);repaired=true;}
  return {latex:output,repaired};
}

/** Apply only conservative, structure-preserving repairs to generated LaTeX. */
export function repairGeneratedLatexSource(source:string):{latex:string;repaired:boolean} {
  let latex=source.trim(),repaired=false;
  const controls=repairJsonEscapedLatexControls(latex);
  latex=controls.latex;repaired ||= controls.repaired;
  const groups=repairUnclosedLatexGroups(latex);
  latex=groups.latex;repaired ||= groups.repaired;
  const delimiters=repairUnmatchedLeftRight(latex);
  latex=delimiters.latex;repaired ||= delimiters.repaired;
  return {latex:latex.replace(/\s+/g," ").trim(),repaired};
}
