import { afterEach, expect, it, vi } from "vitest";
import { executeComparison } from "./execute";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { propositionPlanSizes } from "./proposition-plan";
import { fictionalPropositionGeneration, fictionalPropositionSource, fictionalPropositionTarget } from "./proposition-fixtures.test-support";
import { parseComparisonSource } from "./source";
import { propositionSourceInput, propositionSourceTransport } from "./proposition-extraction";

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it.each([false,true])("connects source extraction, full generation, computed target comparison and save-v1 through the actual SDK (all unique: %s)",async unique=>{
  for(const [key,value] of Object.entries({AI_PROVIDER:"azure",AZURE_OPENAI_BASE_URL:"https://example.invalid/openai",AZURE_API_KEY:"fictional",
    AZURE_OPENAI_DEPLOYMENT_NAME:"patentai-gpt54",AZURE_OPENAI_API_VERSION:"v1"}))vi.stubEnv(key,value);
  vi.spyOn(console,"info").mockImplementation(()=>undefined);
  const phases:string[]=[];
  const {inputs,selection}=fictionalInputs();
  if(unique){
    const body=(d:number)=>"【請求項1】"+Array.from({length:60},(_,i)=>`架空の${String.fromCharCode(0x4e00+d*70+i)}温度制御装置は、各区域の測定値を保持する。`).join("")+
      `末尾条件${String.fromCharCode(0x5200+d)}は温度が七度を${d===2?"下回ると青色弁を開く":"超えると青色弁を閉じる"}ことである。`;
    inputs.draft=parseComparisonSource(body(0),inputs.draft.id,inputs.draft.label);
    inputs.documents=inputs.documents.map((s,i)=>parseComparisonSource(body(i+1),s.id,s.label));
    const source=propositionSourceInput(makePlan(inputs,selection)),wire=propositionSourceTransport(source);
    expect(wire.textParts.length).toBe(wire.sources.flatMap(s=>s.source.claims.flatMap(c=>c.parts)).length);
    for(const [i,s] of wire.sources.entries())for(const [j,c] of s.source.claims.entries())
      expect(c.parts.map(k=>wire.textParts[k]).join("")).toBe(source.sources[i].source.claims[j].segments.map(p=>p.text).join(""));
  }
  const sizes=propositionPlanSizes(makePlan(inputs,selection));
  vi.stubGlobal("fetch",vi.fn<typeof fetch>().mockImplementation(async(url,init)=>{
    expect(new URL(String(url)).origin).toBe("https://example.invalid");
    const body=JSON.parse(String(init?.body)),input=JSON.parse(body.input[1].content[0].text);phases.push(input.task);
    const bytes=Buffer.byteLength(String(init?.body),"utf8");
    if(input.task==="extract_source_propositions")expect(bytes+8192).toBeLessThanOrEqual(sizes.sourceBytes);
    if(input.task==="review")expect(bytes+8192).toBeLessThanOrEqual(sizes.targetBytes);
    const value=input.task==="extract_source_propositions"?fictionalPropositionSource(input):input.task==="compare"?fictionalPropositionGeneration(input):fictionalPropositionTarget(input);
    return Response.json({id:"resp_fixture",created_at:0,model:"fictional",status:"completed",service_tier:"default",
      output:[{type:"message",id:"msg_fixture",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(value),annotations:[]}]}],
      usage:{input_tokens:100,output_tokens:100}});
  }));
  expect(propositionPlanSizes(makePlan(inputs,selection))).toMatchObject({targetBytes:expect.any(Number)});
  expect(propositionPlanSizes(makePlan(inputs,selection)).targetBytes).toBeLessThanOrEqual(90000);
  const saved=await executeComparison(inputs,selection);
  expect(phases).toEqual(["extract_source_propositions","compare","review"]);
  expect(saved.version).toBe(1);expect(saved.pairs).toHaveLength(2);
  expect(saved.pairs[1].differences).toContain("下回る");
  expect(saved.pairs[1].differences).toContain("超える");
});
