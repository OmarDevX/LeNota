import { compileLatexRelation } from "./equation-solver";

export interface MathGraphSpec {
  relationLatex: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  title?: string;
}

export interface MathGraphGeometry {
  path: string;
  supported: boolean;
  xAxisY: number | null;
  yAxisX: number | null;
}

const finiteRange=(min:number,max:number,fallback:[number,number]):[number,number]=>
  Number.isFinite(min)&&Number.isFinite(max)&&max-min>1e-8&&Math.abs(min)<=1e6&&Math.abs(max)<=1e6?[min,max]:fallback;

export function normalizeMathGraphSpec(input: Partial<MathGraphSpec> & { relationLatex:string }): MathGraphSpec {
  const [xMin,xMax]=finiteRange(Number(input.xMin),Number(input.xMax),[-10,10]);
  const [yMin,yMax]=finiteRange(Number(input.yMin),Number(input.yMax),[-10,10]);
  return {relationLatex:String(input.relationLatex||"").trim().slice(0,12000),xMin,xMax,yMin,yMax,title:String(input.title||"").slice(0,180)};
}

/**
 * Samples F(x,y)=0 with marching squares. The evaluator is the same safe local
 * parser used by Solve, so a graph never executes generated JavaScript.
 */
export function buildMathGraphGeometry(specInput:MathGraphSpec,width=520,height=280,columns=96,rows=64):MathGraphGeometry{
  const spec=normalizeMathGraphSpec(specInput);
  const evaluate=compileLatexRelation(spec.relationLatex);
  const xAxisY=spec.yMin<=0&&spec.yMax>=0?height-(0-spec.yMin)/(spec.yMax-spec.yMin)*height:null;
  const yAxisX=spec.xMin<=0&&spec.xMax>=0?(0-spec.xMin)/(spec.xMax-spec.xMin)*width:null;
  if(!evaluate)return{path:"",supported:false,xAxisY,yAxisX};
  const cols=Math.max(24,Math.min(180,Math.round(columns))),rs=Math.max(18,Math.min(140,Math.round(rows)));
  const values:Array<Array<number|null>>=Array.from({length:rs+1},()=>Array<number|null>(cols+1).fill(null));
  let finiteCount=0;
  for(let row=0;row<=rs;row++){
    const y=spec.yMax-(row/rs)*(spec.yMax-spec.yMin);
    for(let col=0;col<=cols;col++){
      const x=spec.xMin+(col/cols)*(spec.xMax-spec.xMin);
      const value=evaluate({x,y});
      values[row][col]=value;
      if(value!==null&&Number.isFinite(value))finiteCount++;
    }
  }
  if(finiteCount<Math.max(12,(cols+1)*(rs+1)*.03))return{path:"",supported:false,xAxisY,yAxisX};
  const parts:string[]=[];
  const sx=(x:number)=>(x-spec.xMin)/(spec.xMax-spec.xMin)*width;
  const sy=(y:number)=>height-(y-spec.yMin)/(spec.yMax-spec.yMin)*height;
  for(let row=0;row<rs;row++)for(let col=0;col<cols;col++){
    const v0=values[row][col],v1=values[row][col+1],v2=values[row+1][col+1],v3=values[row+1][col];
    if(v0===null||v1===null||v2===null||v3===null)continue;
    const x0=spec.xMin+(col/cols)*(spec.xMax-spec.xMin),x1=spec.xMin+((col+1)/cols)*(spec.xMax-spec.xMin);
    const y1=spec.yMax-(row/rs)*(spec.yMax-spec.yMin),y0=spec.yMax-((row+1)/rs)*(spec.yMax-spec.yMin);
    const hits:Array<[number,number]>=[];
    const add=(edge:number,a:number,b:number)=>{
      if(a*b>0&&Math.abs(a)>1e-12&&Math.abs(b)>1e-12)return;
      let wx=0,wy=0;
      const denom=a-b,t=Math.abs(denom)<1e-14?.5:Math.max(0,Math.min(1,a/denom));
      if(edge===0){wx=x0+(x1-x0)*t;wy=y1;}
      else if(edge===1){wx=x1;wy=y1+(y0-y1)*t;}
      else if(edge===2){wx=x1+(x0-x1)*t;wy=y0;}
      else {wx=x0;wy=y0+(y1-y0)*t;}
      if(Number.isFinite(wx)&&Number.isFinite(wy))hits.push([sx(wx),sy(wy)]);
    };
    add(0,v0,v1);add(1,v1,v2);add(2,v2,v3);add(3,v3,v0);
    const unique=hits.filter((point,index,list)=>list.findIndex(other=>Math.hypot(other[0]-point[0],other[1]-point[1])<.25)===index);
    if(unique.length===2)parts.push(`M${unique[0][0].toFixed(2)},${unique[0][1].toFixed(2)}L${unique[1][0].toFixed(2)},${unique[1][1].toFixed(2)}`);
    else if(unique.length===4){
      parts.push(`M${unique[0][0].toFixed(2)},${unique[0][1].toFixed(2)}L${unique[1][0].toFixed(2)},${unique[1][1].toFixed(2)}`);
      parts.push(`M${unique[2][0].toFixed(2)},${unique[2][1].toFixed(2)}L${unique[3][0].toFixed(2)},${unique[3][1].toFixed(2)}`);
    }
  }
  return{path:parts.join(""),supported:parts.length>0,xAxisY,yAxisX};
}
