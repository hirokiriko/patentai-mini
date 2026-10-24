import type {SourceReadingClaim}from"./source-clause-coverage";
const invalid=()=>new Error("comparison_source_scope_projection_invalid");
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
/** New wire semantics only: expand scopes explicitly selected by raw rows.
 * No actor, scope boundary, missing assertion or conditional is inferred. */
export function projectClaimScopeLanes(answer:Record<string,unknown>,claimNo:number,c:SourceReadingClaim){
 const own=answer[`c${claimNo}`],groups=c.clauses.map((_,i)=>`f${i}`);
 if(!Array.isArray(answer.scopes)||!exact(own,[...groups,"possessions","sets","T"])||!Array.isArray(own.T))throw invalid();
 const scopes=new Map<string,Record<string,unknown>>(),used=new Set<string>(),duplicates=new Set<string>();
 for(const scope of answer.scopes){
  if(!exact(scope,["id","g","G","proof"])||typeof scope.id!=="string"||!/^s(?:0|[1-9]\d{0,3})$/.test(scope.id)||!['when','only_when'].includes(String(scope.g))||!Array.isArray(scope.G)||!scope.G.length||scope.proof===null||scopes.has(scope.id))throw invalid();
  const key=JSON.stringify([scope.g,scope.G,scope.proof]);if(duplicates.has(key))throw invalid();duplicates.add(key);scopes.set(scope.id,scope);
 }
 const expand=(row:unknown,withR:boolean):Record<string,unknown>=>{
  if(!record(row)||!record(row.m)||Object.hasOwn(row.m,"g")||Object.hasOwn(row.m,"G")||!Object.hasOwn(row,"s")||!Array.isArray(row.O)||row.O.length!==4)throw invalid();
  const {s,...rest}=row;let g:unknown="unconditional",G:unknown[]=[],proof:unknown=null;
  if(s!==null){if(typeof s!=="string"||!scopes.has(s))throw invalid();const scope=scopes.get(s)!;used.add(s);g=scope.g;G=scope.G as unknown[];proof=scope.proof;}
  if(withR&&(!Number.isInteger(rest.R)||Number(rest.R)<0||Number(rest.R)>=groups.length))throw invalid();
  return {...rest,m:{...row.m,g,G},O:[row.O[0],row.O[1],row.O[2],proof,row.O[3]]};
 };
 const lane=(value:unknown,kind:'possession'|'set')=>{if(!Array.isArray(value))throw invalid();let previous=-1;return value.map(row=>{
  if(!exact(row,["m","O","F","R","s"])||!record(row.m)||(kind==='possession'?row.m.k!=="relation"||row.m.P!=="has":row.m.k!=="set"))throw invalid();
  const expanded=expand(row,true);if(Number(expanded.R)<previous)throw invalid();previous=Number(expanded.R);return expanded;
 });};
 const possessions=lane(own.possessions,'possession'),sets=lane(own.sets,'set'),facts:Record<string,unknown>[]=[],bindingMap:number[]=[];
 for(let R=0;R<groups.length;R++){
  facts.push(...possessions.filter(f=>f.R===R),...sets.filter(f=>f.R===R));const rows=own[groups[R]];if(!Array.isArray(rows))throw invalid();
  for(const row of rows){if(!exact(row,["m","O","F","s"])||!record(row.m)||row.m.k==='set'||row.m.P==='has')throw invalid();bindingMap.push(facts.length);facts.push({...expand(row,false),R});}
 }
 const bindings=own.T.map(at=>{if(!Number.isInteger(at)||Number(at)<0||Number(at)>=bindingMap.length)throw invalid();return bindingMap[Number(at)];});
 const loops=Object.fromEntries(Object.entries(answer).filter(([k])=>k.startsWith('loop')).map(([k,row])=>[k,expand(row,false)]));
 if(used.size!==scopes.size)throw invalid();
 return {facts,loops,bindings};
}
