import { fixtureGridWire } from "./prior-art-grid-fixture.mjs";

const declaredReadings = new WeakMap();
// Deliberate, test-only declaration by a specific hand-authored mock. Keeping
// it out of the answer prevents transport metadata from becoming domain facts.
export function fixtureDeclareClauseReading(value,input) {
  if(!input?.citationClauses)throw Error("fictional_clause_input_required");
  for(const [i,s]of value.sources.entries())for(const fact of s.facts){
    const claim=input.sources[i]?.source.claims.find(c=>c.claimNo===fact.claimNo);
    if(!claim||!claim.clauses.length||claim.clauses.length>12)throw Error("fictional_clause_reading_limit");
    declaredReadings.set(fact,claim.clauses.map(c=>c[0]));
  }
  return value;
}

// Fictional SDK plumbing ONLY. Starts from hand-authored semantic facts and
// spans, never an actual model response. Does not invent uncovered meanings.
export function fixtureClauseWire(value,input,version=input?.citationClauses?.version===2?17:16) {
  const readings = input.sources.map(s=>s.source.claims.map(c=>{
    let at=0;
    const clauses=c.clauses.map(([id,text],i)=>{
      if(id!==i)throw Error("fictional_clause_invalid");
      const a=at;at+=text.length;return [a,at];
    });
    const text=c.clauses.map(c=>c[1]).join(""), chars=[...text], points=[0];
    for(const char of chars)points.push(points.at(-1)+char.length);
    const ref=([a,b])=>{const x=points.indexOf(a),y=points.indexOf(b)-1;
      if(x<0||y<x)throw Error("fictional_clause_invalid");
      return [Math.floor(x/10),x%10,Math.floor(y/10),y%10];};
    const grid=Array.from({length:Math.ceil(chars.length/10)},(_,i)=>`${i}|`+chars.slice(i*10,i*10+10)
      .map(ch=>/[|\s\\]/u.test(ch)?`\\u{${ch.codePointAt(0).toString(16)}}`:ch).join("|"));
    return {c,text,clauses,points,grid,ref};
  }));
  const gridInput={...input,sources:input.sources.map((s,i)=>({...s,source:{...s.source,
    claims:readings[i].map(r=>({...r.c,grid:r.grid,clauseRefs:r.clauses.map(r.ref)}))}}))};
  const gridWire=fixtureGridWire(value,gridInput);
  return {v:version,s:gridWire.s.map((s,i)=>{
    const out={d:s.d};
    for(const r of readings[i]){
      const key=`c${r.c.claimNo}`,facts=s[key];
      if(!Array.isArray(facts))throw Error("fictional_unrepresented_claim");
      const span=ref=>{if(!Array.isArray(ref)||ref.length!==4)throw Error("fictional_clause_invalid");
        return [r.points[ref[0]*10+ref[1]],r.points[ref[2]*10+ref[3]+1]];};
      const ids=([a,b])=>r.clauses.flatMap(([x,y],id)=>x<b&&y>a?[id]:[]);
      const quote=ref=>{
        const [a,b]=span(ref);
        if(version>=16){
          const q=r.text.slice(a,b);
          if(r.text.indexOf(q)===r.text.lastIndexOf(q))return [q];
          // Fictional known spans need only enough scalar-aligned context to
          // retain their occurrence, not another copy of the entire claim.
          const left=[...r.text.slice(0,a)],right=[...r.text.slice(b)];
          for(let n=1;n<=Math.max(left.length,right.length);n++){
            const before=left.slice(Math.max(0,left.length-n)).join(""),after=right.slice(0,n).join(""),context=before+q+after;
            if(r.text.indexOf(context)===r.text.lastIndexOf(context))return [[q,before,after]];
          }
          throw Error("fictional_clause_ambiguous");
        }
        return ids([a,b]).map(id=>{
          const [x,y]=r.clauses[id],lo=Math.max(a,x),hi=Math.min(b,y),q=r.text.slice(lo,hi),whole=r.text.slice(x,y);
          if(whole.indexOf(q)===whole.lastIndexOf(q))return `${id}:${q}`;
          return [String(id),q,r.text.slice(x,lo),r.text.slice(hi,y)];
        });
      };
      const own=value.sources[i].facts.filter(f=>f.claimNo===r.c.claimNo);
      out[key]=facts.map((f,factIndex)=>{
        const declared=declaredReadings.get(own[factIndex]);
        if(declared!==undefined&&(!Array.isArray(declared)||!declared.length||
          declared.some(id=>!Number.isSafeInteger(id)||id<0||id>=r.clauses.length)||new Set(declared).size!==declared.length))
          throw Error("fictional_clause_invalid");
        // Explicit fictional reading declarations belong to the hand-authored
        // fixture, never a generic completion rule or an actual AI answer.
        const W=new Set(declared??f.W.flatMap(v=>ids(span(v)))),term=v=>v.flatMap(quote);
        const proof=v=>{
          const [a,b]=v.length?span(v):[0,r.text.length];
          if(version===15&&a===0&&b===r.text.length)return [];
          const selected=ids([a,b]);selected.forEach(id=>W.add(id));
          const first=selected[0],last=selected.at(-1),[x]=r.clauses[first],[,y]=r.clauses[last];
          // Whole clauses already preserve the original proof exactly. A
          // partial cross-clause proof keeps its exact text and own context.
          if(a===x&&b===y)return selected;
          if(version>=16||first===last)return quote(v)[0];
          return [String(first),String(last),r.text.slice(a,b),r.text.slice(x,a),r.text.slice(b,y)];
        };
        const m={...f.m};
        for(const k of ["u","i","j"])if(Object.hasOwn(m,k)&&m[k]!==null)m[k]=term(m[k]);
        for(const k of ["G","M","V","B","J"])if(Object.hasOwn(m,k))m[k]=m[k].map(term);
        const O=f.O===null?(version>=16?[null,null,null,null,null]:null):f.O.map(v=>v===null?null:proof(v));
        const F=f.F===null?null:{E:proof(f.F.E),X:proof(f.F.X),T:proof(f.F.T),C:f.F.C.map(proof),D:f.F.D.map(proof)};
        if(version===17){
          const cq=q=>typeof q==="string"?q:Array.isArray(q)&&q.length===3&&q.every(x=>typeof x==="string")?
            {quote:q[0],before:q[1],after:q[2]}:(()=>{throw Error("fictional_context_invalid")})();
          const cp=p=>p===null?p:Array.isArray(p)&&p.every(x=>typeof x==="number")?p:cq(p);
          for(const k of ["u","i","j"])if(Object.hasOwn(m,k)&&m[k]!==null)m[k]=m[k].map(cq);
          for(const k of ["G","M","V","B","J"])if(Object.hasOwn(m,k))m[k]=m[k].map(t=>t.map(cq));
          const enums={x:["capability","operation","unresolved"],g:["unconditional","when","only_when","unresolved"],
            p:["positive","negative","reserved"],k:["set","path","relation"],S:["required","one","nonempty","all","unspecified"],
            e:["closed","partial","segment","whole","unresolved"],r:["route","precedes"],
            P:["has","upstream","downstream","inside","opens","closes","fully_closes","generates_heat","absorbs_heat","releases_heat","maintains","at_least","at_most","greater_than","less_than","opens_one","opens_together","executes","stops","power_ends"]};
          for(const k of Object.keys(enums))if(Object.hasOwn(m,k))m[k]=enums[k][m[k]];
          if(m.k==="relation"){
            // Only hand-authored fictional meanings/spans enter this adapter.
            // Find an exact printed action in their explicitly declared W;
            // this is never used to repair or accept an acquired AI answer.
            const patterns={closes:/閉じ(?:ない|ず|る|て|た|(?=[、，]))/gu,fully_closes:/全閉(?:にする|とする|にし|とし|する)/gu,
              generates_heat:/発熱(?:させ|する|し)/gu,absorbs_heat:/吸熱(?:させ|する|し)/gu,releases_heat:/放熱(?:させ|する|し)/gu,
              stops:/(?:停止|終了|中止)(?:する|した|し)?/gu};
            const match=patterns[m.P]?[...r.text.matchAll(patterns[m.P])].find(x=>ids([x.index,x.index+x[0].length]).every(id=>W.has(id))):undefined;
            const action=match?[match.index,match.index+match[0].length]:r.clauses[[...W][0]];
            m.a=cq(quote(r.ref(action))[0]);
          }
          const named=Object.fromEntries(["selection","extent","polarity","guard","context"].map((k,i)=>[k,cp(O[i])]));
          const frame=F===null?null:{E:cp(F.E),X:cp(F.X),T:cp(F.T),C:F.C.map(cp),D:F.D.map(cp)};
          return {...f,m,O:named,F:frame,W:[...W].sort((a,b)=>a-b)};
        }
        return {...f,m,O,F,W:[...W].sort((a,b)=>a-b)};
      });
    }
    return out;
  })};
}
