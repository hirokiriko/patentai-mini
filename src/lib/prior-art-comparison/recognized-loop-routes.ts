import { compileLiteralStructure } from "./literal-structure";
import { propositionKey, type Meaning, type Span } from "./propositions";
import { ComparisonError } from "./source";

type Claims = {claims:readonly {claimNo:number;text:string;dependsOn:readonly number[]}[]};
export type RecognizedLoopRoute = {claimNo:number;mode:Span;route:Span;entry:Span;exit:Span;definition:Span;control:Span};
const number="[0-9０-９一二三四五六七八九十]+", mode=`第${number}(?:の)?運転モード`, valve=`第${number}(?:の)?開閉弁`;
const label="[\\p{Script=Han}\\p{Script=Katakana}A-Za-zＡ-Ｚａ-ｚ0-9０-９ー]{1,80}";
const coordinates=(start:number,text:string):Span=>[start,start+text.length];

/** A coverage obligation, NOT a derived path or an unconditional assertion.
 * Recognize only a closed/open valve clause already tied to an unambiguous
 * bypass definition by the existing grammar, with an explicit complete loop.
 * All other route syntax remains for extraction and independent semantic QA. */
export function recognizedLoopRoutes(source:Claims):RecognizedLoopRoute[] {
  const result:RecognizedLoopRoute[]=[];
  for(const [claimNo,,,,,definition,control] of compileLiteralStructure(source).bypass){
    const text=source.claims.find(c=>c.claimNo===claimNo)!.text;
    const clause=new RegExp(`^(?:前記)?${valve}を閉じ[、,](?:前記)?${valve}を開くことで[、,]([^。]*?)(${mode})(?=と[、,]|を切り換え)`,"u").exec(text.slice(control[0]));
    if(!clause)continue;
    const routeText=clause[1],routeStart=control[0]+clause[0].indexOf(routeText);
    const entries=[...routeText.matchAll(new RegExp(`(?:前記|当該|該)(${label})から吐出された`,"gu"))];
    const exits=[...routeText.matchAll(new RegExp(`(?:前記|当該|該)(${label})に吸い込ませる`,"gu"))];
    if(entries.length!==1||exits.length!==1||exits[0].index!<=entries[0].index!||
      propositionKey(entries[0][1])!==propositionKey(exits[0][1])||/[「」『』“”"?？]/u.test(routeText))continue;
    const position=(m:RegExpMatchArray)=>coordinates(routeStart+m.index!+m[0].indexOf(m[1]),m[1]);
    result.push({claimNo,mode:coordinates(control[0]+clause[0].lastIndexOf(clause[2]),clause[2]),
      route:coordinates(routeStart,routeText),entry:position(entries[0]),exit:position(exits[0]),
      definition:[...definition],control:[control[0],routeStart]});
  }
  return [...new Map(result.map(r=>[JSON.stringify(r),r])).values()];
}

type Candidate={claimNo:number;meaning:Meaning;routeFrame:{entry:Span;exit:Span;route:Span;exclusions:Span[];controls:Span[]}|null};
export function assertRecognizedLoopCoverage(source:Claims,facts:readonly Candidate[]):void {
  const contains=(outer:Span,inner:Span)=>outer[0]<=inner[0]&&outer[1]>=inner[1];
  for(const r of recognizedLoopRoutes(source)){
    const text=source.claims.find(c=>c.claimNo===r.claimNo)!.text,same=(value:string|null,range:Span)=>
      value!==null&&propositionKey(value)===propositionKey(text.slice(...range));
    if(!facts.some(f=>{
      const m=f.meaning,frame=f.routeFrame;
      return f.claimNo===r.claimNo&&m.kind==="path"&&m.extent==="whole"&&m.relation==="route"&&
        same(m.subject,r.mode)&&same(m.origin,r.entry)&&same(m.destination,r.exit)&&frame&&
        contains(frame.route,r.route)&&contains(frame.entry,r.entry)&&contains(frame.exit,r.exit)&&
        contains(r.route,frame.entry)&&contains(r.route,frame.exit)&&frame.entry[1]<=frame.exit[0]&&
        frame.exclusions.some(s=>contains(s,r.definition))&&frame.controls.some(s=>contains(s,r.control));
    }))throw new ComparisonError("ai_incomplete");
  }
}
