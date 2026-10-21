import { jsonSchema, type JSONSchema7, type Schema } from "ai";

// Source v13 is a lossless spelling only. No term, occurrence, guard, actor,
// fact, order or evidence is inferred here. Saved comparison v1 is unrelated.
const names: Record<string, string> = {
  locatorVersion:"v", sources:"s", sourceDigest:"d", claims:"c", claimNo:"n",
  requiredLoops:"R", facts:"f", basis:"b", firstPart:"a", lastPart:"z",
  locators:"l", quote:"q", occurrence:"o", meaning:"m", operators:"O",
  routeFrame:"F", subject:"u", context:"x", guardRelation:"g", guardConditions:"G",
  polarity:"p", kind:"k", selection:"S", extent:"e", members:"M", origin:"i",
  destination:"j", via:"V", bypass:"B", relation:"r", predicate:"P", objects:"J",
  guard:"h", entry:"E", exit:"X", route:"T", exclusions:"C", controls:"D",
  part:"t", before:"A", after:"Z", edge:"H", reason:"N", cells:"K",
};
const enums: Record<string, readonly string[]> = {
  context:["capability","operation","unresolved"],
  guardRelation:["unconditional","when","only_when","unresolved"],
  polarity:["positive","negative","reserved"],kind:["set","path","relation"],
  selection:["required","one","nonempty","all","unspecified"],
  extent:["closed","partial","segment","whole","unresolved"],relation:["route","precedes"],
  predicate:["has","upstream","downstream","inside","opens","closes","fully_closes",
    "generates_heat","absorbs_heat","releases_heat","maintains","at_least","at_most","greater_than","less_than",
    "opens_one","opens_together","executes","stops","power_ends"],
};
const operatorKeys=["selection","extent","polarity","guard","context"];
const reverse=new Map(Object.entries(names).map(([full,short])=>[short,full]));
const dynamic=(name:string)=>/^(?:c[1-9]\d*|loop(?:0|[1-9]\d*))$/.test(name);
const invalid=()=>new Error("comparison_source_wire_invalid");
function spelling(name:string){const short=names[name];if(short)return short;if(dynamic(name))return name;throw invalid();}
function keysAre(value:Record<string,unknown>,keys:readonly string[]){
  return Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
}
function enumNumber(key:string,value:unknown){
  const index=enums[key]?.indexOf(value as string);if(index===undefined||index<0)throw invalid();return index;
}
function enumValue(key:string,value:unknown){
  if(!Number.isSafeInteger(value)||(value as number)<0||(value as number)>=enums[key].length)throw invalid();
  return enums[key][value as number];
}
function schemaSpelling(value:unknown,key?:string):unknown {
  if(Array.isArray(value))return value.map(v=>schemaSpelling(v,key));
  if(!value||typeof value!=="object")return value;
  const schema=value as Record<string,unknown>,properties=schema.properties as Record<string,unknown>|undefined;
  if(properties&&keysAre(properties,["part","quote"]))return {type:"string",description:"p<part>:<exact unique quote>; claim-local input part, first colon separates it."};
  if(properties&&keysAre(properties,["quote","before","after","edge"]))return {
    type:"array",items:{type:["string","null"]},description:'Exactly ["q",quote,before,after,edge]. Edge=none/start/end/both. Nonempty exact quote; only ["q",null,"","","both"] is whole-claim proof.'};
  if(properties&&keysAre(properties,operatorKeys))return {
    type:"array",items:schemaSpelling(properties.selection),description:"Five nullable proofs: [selection,extent,polarity,guard,context]."};
  return Object.fromEntries(Object.entries(schema).map(([field,child])=>{
    if(field==="properties")return [field,Object.fromEntries(Object.entries(child as Record<string,unknown>)
      .map(([name,definition])=>[spelling(name),schemaSpelling(definition,name)]))];
    if(field==="required")return [field,(child as string[]).map(spelling)];
    if(field==="enum"&&key==="locatorVersion")return [field,[13]];
    if(field==="enum"&&key&&enums[key])return [field,(child as unknown[]).map(v=>enumNumber(key,v))];
    if(field==="type"&&key&&enums[key]&&schema.enum)return [field,"integer"];
    return [field,schemaSpelling(child,key)];
  }));
}
export function compactSourceWire(value:unknown,key?:string):unknown {
  if(value===null)return null;
  if(key==="locatorVersion"){if(value!==12)throw invalid();return 13;}
  if(typeof value!=="object")return key&&enums[key]?enumNumber(key,value):value;
  if(Array.isArray(value))return value.map(v=>compactSourceWire(v));
  const record=value as Record<string,unknown>;
  if(keysAre(record,["part","quote"])){
    if(!Number.isSafeInteger(record.part)||(record.part as number)<0||typeof record.quote!=="string"||!record.quote)throw invalid();
    return `p${record.part}:${record.quote}`;
  }
  if(keysAre(record,["quote","before","after","edge"]))return ["q",record.quote,record.before,record.after,record.edge];
  if(key==="operators"){
    if(!keysAre(record,operatorKeys))throw invalid();
    return operatorKeys.map(k=>compactSourceWire(record[k]));
  }
  return Object.fromEntries(Object.entries(record).map(([k,v])=>[spelling(k),compactSourceWire(v,k)]));
}
export function expandSourceWire(value:unknown,key?:string):unknown {
  if(value===null)return null;
  if(key==="locatorVersion"){if(value!==13)throw invalid();return 12;}
  if(key==="operators"){
    if(!Array.isArray(value)||value.length!==5)throw invalid();
    return Object.fromEntries(operatorKeys.map((k,i)=>[k,expandSourceWire(value[i])]));
  }
  if(Array.isArray(value)){
    if(value[0]==="q"){
      if(value.length!==5||!(value[1]===null||typeof value[1]==="string")||value.slice(2).some(v=>typeof v!=="string"))throw invalid();
      return {quote:value[1],before:value[2],after:value[3],edge:value[4]};
    }
    return value.map(v=>expandSourceWire(v));
  }
  if(typeof value==="string"&&(!key||["entry","exit","route","guard","context","selection","extent","polarity"].includes(key))){
    const match=/^p(0|[1-9]\d*):([\s\S]+)$/.exec(value);
    if(!match||!Number.isSafeInteger(Number(match[1])))throw invalid();
    return {part:Number(match[1]),quote:match[2]};
  }
  if(typeof value!=="object")return key&&enums[key]?enumValue(key,value):value;
  const record=value as Record<string,unknown>;
  return Object.fromEntries(Object.entries(record).map(([k,v])=>{
    const full=reverse.get(k)??(dynamic(k)?k:undefined);if(!full)throw invalid();
    return [full,expandSourceWire(v,full)];
  }));
}
const enumGuide=Object.entries(enums).map(([k,v])=>`${k}(${v.map((s,i)=>`${i}:${s}`).join(",")})`).join("; ");
export const SOURCE_COMPACT_KEY_GUIDE=`Semantic names denote these wire keys: ${Object.entries(names).map(([a,b])=>`${a}=${b}`).join(",")}. cN/loopN unchanged. Enums are numeric: ${enumGuide}.`;
const cellUnused=new Set(["claims","requiredLoops","facts","locators","quote","occurrence","part","before","after","edge"]);
export const SOURCE_CELL_KEY_GUIDE=`Keys: ${Object.entries(names).filter(([k])=>!cellUnused.has(k)).map(([a,b])=>`${a}=${b}`).join(",")}. Numeric enums: ${enumGuide}.`;
export const SOURCE_WIRE_GUIDE=`Output v13 only. ${SOURCE_COMPACT_KEY_GUIDE}
Quote {part,quote} is the string p<part>:<quote>, e.g. "p3:赤弁". Context {quote,before,after,edge} is ["q",quote,before,after,edge]. operators is null OR exactly [selection,extent,polarity,guard,context] proofs. No implicit defaults or inherited roles. Other arrays keep order. Exact original text is never coded as an enum.`;
export function sourceWireSchema<T>(base:Schema<T>):Schema<T>{
  return jsonSchema<T>(schemaSpelling(base.jsonSchema) as JSONSchema7,{validate:async value=>{
    try{
      if(Buffer.byteLength(JSON.stringify(value),"utf8")>32_000||!base.validate)throw invalid();
      const expanded=expandSourceWire(value);
      if(JSON.stringify(compactSourceWire(expanded))!==JSON.stringify(value))throw invalid();
      return await base.validate(expanded);
    }catch{return {success:false,error:invalid()};}
  }});
}
