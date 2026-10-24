import { compactSourceWire } from "./source-wire-compact";
import { resolveSourceContextQuote, resolveSourcePartQuote } from "./source-direct-quotes";
import { sourceCitationGrid, sourceCellRef } from "./source-citation-grid";
import type { propositionSourceInput } from "./proposition-extraction";
import { sourceReadingClauses } from "./source-clause-coverage";
import type { Span } from "./propositions";

/** Encode hand-authored fixtures only. A failed provider answer must never
 * be passed here, repaired, or presented as a new model's quality result. */
export function fixtureSourceGridWire(value: unknown, input: ReturnType<typeof propositionSourceInput>) {
  const raw = value as {locatorVersion:number;sources:Record<string,unknown>[]};
  if (raw.locatorVersion !== 12 || raw.sources.length !== input.sources.length) throw Error("fictional_grid_invalid");
  const sources = raw.sources.map((s, i) => Object.fromEntries(Object.entries(s).map(([key, answer]) => {
    if (key === "sourceDigest") return [key, answer];
    const match = /^c([1-9]\d*)$/.exec(key), loop = /^loop(0|[1-9]\d*)$/.exec(key);
    const no = match ? Number(match[1]) : loop ? input.sources[i].recognizedLoopRoutes[Number(loop[1])]?.claimNo : undefined;
    const c = input.sources[i].source.claims.find(c => c.claimNo === no);
    if (!c) throw Error("fictional_grid_invalid");
    const parts = c.segments.map(s => s.text), grid = sourceCitationGrid(parts.join(""));
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (!v || typeof v !== "object") return v;
      const r = v as Record<string,unknown>;
      if (Object.hasOwn(r, "quote")) {
        if (r.quote === null && r.before === "" && r.after === "" && r.edge === "both") return [];
        const span = "part" in r ? resolveSourcePartQuote(parts, r as {part:number;quote:string}) :
          resolveSourceContextQuote(grid.text, r as {quote:string;before:string;after:string;edge:"none"|"start"|"end"|"both"});
        const ref = sourceCellRef(grid, span);
        return "reason" in r ? {cells:ref,reason:r.reason} : ref;
      }
      return Object.fromEntries(Object.entries(r).map(([k,v]) => [k,walk(v)]));
    };
    return [key,walk(answer)];
  })));
  const wire = compactSourceWire({locatorVersion:12,sources}) as Record<string,unknown>;
  wire.v = 14;
  return wire;
}

/** Caller supplies evidence explicitly. Uncovered clauses stay explicitly
 * unrepresented in this fictional plumbing; no source facts are filled in. */
export function fixtureSourceGridReading(wire:Record<string,unknown>,input:ReturnType<typeof propositionSourceInput>,
  evidenceFor:(source:number,claimNo:number,address:string,text:string,fact:Record<string,unknown>)=>Span[]) {
  const output=structuredClone(wire);
  const sources=output.s as Record<string,unknown>[];
  sources.forEach((s,si)=>{
    const coverage:string[][]=[];
    for(const c of input.sources[si].source.claims){
      const text=c.segments.map(p=>p.text).join(""),grid=sourceCitationGrid(text),own: {address:string;spans:Span[]}[]=[];
      const attach=(address:string,f:unknown)=>{
        const spans=evidenceFor(si,c.claimNo,address,text,f as Record<string,unknown>);
        (f as Record<string,unknown>).W=spans.map(span=>sourceCellRef(grid,span));own.push({address,spans});
      };
      const answer=s[`c${c.claimNo}`];
      if(Array.isArray(answer))answer.forEach((f,i)=>attach(`c${c.claimNo}:${i}`,f));
      input.sources[si].recognizedLoopRoutes.forEach((r,i)=>{if(r.claimNo===c.claimNo)attach(`loop${i}`,s[`loop${i}`]);});
      for(const[a,b]of sourceReadingClauses(text)){
        const addresses=own.filter(f=>f.spans.some(([x,y])=>x<b&&y>a)).map(f=>f.address);
        coverage.push(addresses.length?addresses:["?Not annotated in codec fixture"]);
      }
    }
    s.Y=coverage;
  });
  return output;
}
