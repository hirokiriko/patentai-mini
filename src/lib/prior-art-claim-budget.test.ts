import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {AiOperationBudget,boundedAzureFetch,withAiOperationBudget,withPriorArtComparisonBudget,withPriorArtClaimComparisonBudget,withManagedWatchBudget} from "./ai-operation-budget";
const url="https://fictional.invalid/openai/v1/responses";
const request=(task="extract_source_propositions")=>({method:"POST",body:JSON.stringify({model:"patentai-gpt54",input:[{role:"user",content:JSON.stringify({task})}],reasoning:{effort:"low"},max_output_tokens:64,text:{format:{type:"json_schema",schema:{type:"object",properties:{}}}}})});
const response=(usage:unknown={input_tokens:10,output_tokens:5})=>Response.json({usage});
describe("finite per-claim comparison scope (fictional transport only)",()=>{
 beforeEach(()=>{vi.useFakeTimers();vi.spyOn(AbortSignal,"timeout").mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});});
 afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllTimers();vi.useRealTimers();});
 it.each([false,true])("admits exactly19source plus fixed later stages, diagnostic=%s",async diagnostic=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response());vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(19,async()=>{const send=boundedAzureFetch("normal");for(let n=0;n<19;n++)await send(url,request());if(!diagnostic)await send(url,request("compare"));await send(url,request("review"));await expect(send(url,request("review"))).rejects.toThrow("ai_operation_stopped");},diagnostic);
  expect(transport).toHaveBeenCalledTimes(diagnostic?20:21);expect(AbortSignal.timeout).toHaveBeenNthCalledWith(1,19*270000+(diagnostic?1:2)*210000+30000+(diagnostic?900000:0));
 });
 it.each([0,-1,26,1.5])("rejects invalid claim count%s before transport",n=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal("fetch",transport);expect(()=>withPriorArtClaimComparisonBudget(n,async()=>undefined)).toThrow("ai_operation_stopped");expect(transport).not.toHaveBeenCalled();
 });
 it.each([false,true])("admits25 partition requests without extending the existing phase deadline, diagnostic=%s",async diagnostic=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response());vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(25,async deadline=>{
   const send=boundedAzureFetch("normal");for(let n=0;n<25;n++)await send(url,request());
   await vi.advanceTimersByTimeAsync(diagnostic?6_270_000:5_580_000);
   expect(deadline.aborted).toBe(true);
   await expect(send(url,request(diagnostic?"review":"compare"))).rejects.toThrow("ai_operation_stopped");
  },diagnostic);
  expect(transport).toHaveBeenCalledTimes(25);
  expect(AbortSignal.timeout).toHaveBeenNthCalledWith(1,diagnostic?6_270_000:5_580_000);
 });
 it.each(["compare","review"])("rejects premature%s and all later sends",async task=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response());vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(19,async()=>{const send=boundedAzureFetch("normal");await expect(send(url,request(task))).rejects.toThrow("ai_operation_stopped");await expect(send(url,request())).rejects.toThrow("ai_operation_stopped");});expect(transport).not.toHaveBeenCalled();
 });
 it.each([false,true])("rejects wrong post-source stage diagnostic=%s without that dispatch",async diagnostic=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response());vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(1,async()=>{const send=boundedAzureFetch("normal");await send(url,request());await expect(send(url,request(diagnostic?"compare":"review"))).rejects.toThrow("ai_operation_stopped");await expect(send(url,request(diagnostic?"review":"compare"))).rejects.toThrow("ai_operation_stopped");},diagnostic);expect(transport).toHaveBeenCalledTimes(1);
 });
 it.each(["http","usage_unknown"])("stops permanently after%s",async kind=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>kind==="http"?new Response("fictional fail",{status:400}):response(null));vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(19,async()=>{const send=boundedAzureFetch("normal");await expect(send(url,request())).rejects.toThrow("ai_operation_stopped");await expect(send(url,request())).rejects.toThrow("ai_operation_stopped");});expect(transport).toHaveBeenCalledTimes(1);
 });
 it("keeps generic maximum12 and the old comparison1|3 scopes",async()=>{
  expect(()=>new AiOperationBudget({normal:13,fast:0})).toThrow("ai_operation_stopped");const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response());vi.stubGlobal("fetch",transport);
  await withAiOperationBudget({normal:12,fast:0},async()=>{const send=boundedAzureFetch("normal");for(let i=0;i<12;i++)await send(url,request());await expect(send(url,request())).rejects.toThrow("ai_operation_stopped");});expect(transport).toHaveBeenCalledTimes(12);
  for(const count of [1,3]as const){transport.mockClear();await withPriorArtComparisonBudget(async()=>{const send=boundedAzureFetch("normal");for(let i=0;i<count;i++)await send(url,request());await expect(send(url,request())).rejects.toThrow("ai_operation_stopped");},count);expect(transport).toHaveBeenCalledTimes(count);}
  expect(()=>withPriorArtComparisonBudget(async()=>undefined,4 as 3)).toThrow("ai_operation_stopped");
 });
 it("cannot nest to reset the claim scope",async()=>{
  await withPriorArtClaimComparisonBudget(1,async()=>{expect(()=>withPriorArtClaimComparisonBudget(19,async()=>undefined)).toThrow("ai_operation_stopped");expect(()=>withPriorArtComparisonBudget(async()=>undefined)).toThrow("ai_operation_stopped");});
 });
 it("blocks the next stage while the prior source response is still unconfirmed",async()=>{
  let finish!:(r:Response)=>void;const transport=vi.fn<typeof fetch>().mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(1,async()=>{const send=boundedAzureFetch("normal"),first=send(url,request());const firstResult=first.catch(()=>undefined);await expect(send(url,request("compare"))).rejects.toThrow("ai_operation_stopped");finish(response());await firstResult;});expect(transport).toHaveBeenCalledTimes(1);
 });
 it("allows the fixed diagnostic QA wait, but never dispatches unused review after its absolute deadline",async()=>{
  for(const expired of [false,true]){
   const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response());vi.stubGlobal("fetch",transport);
   await withPriorArtClaimComparisonBudget(19,async deadline=>{
    const send=boundedAzureFetch("normal");for(let n=0;n<19;n++)await send(url,request());
    await vi.advanceTimersByTimeAsync(expired?6_270_000:900_000);
    expect(deadline.aborted).toBe(expired);
    if(expired){await expect(send(url,request("review"))).rejects.toThrow("ai_operation_stopped");await expect(send(url,request("review"))).rejects.toThrow("ai_operation_stopped");}
    else await send(url,request("review"));
   },true);
   expect(transport).toHaveBeenCalledTimes(expired?19:20);
  }
 });

});


describe("bounded source-high wait only inside finite claim scope",()=>{
 beforeEach(()=>{vi.useFakeTimers();vi.spyOn(AbortSignal,"timeout").mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});});
 afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllTimers();vi.useRealTimers();});
 const high=(task="extract_source_propositions",model="patentai-gpt54",effort="high")=>({...request(task),body:JSON.stringify({...JSON.parse(request(task).body),model,reasoning:{effort}})});
 it.each(["patentai-gpt54","gpt-5.4","gpt-5.4-2026-03-05"])("receives a240second source response only on the identified high finite scope:%s",async model=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve(response()),240000)));vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(1,async()=>{const pending=boundedAzureFetch("normal")(url,high(undefined,model));const done=expect(pending).resolves.toHaveProperty("status",200);await vi.advanceTimersByTimeAsync(240000);await done;});expect(transport).toHaveBeenCalledTimes(1);
 });
 it.each(["low","medium","xhigh","unknown","oldscope"])("keeps the210second request boundary for%s",async mode=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve(response()),240000)));vi.stubGlobal("fetch",transport);
  const run=async()=>{const send=boundedAzureFetch("normal"),pending=send(url,high(undefined,mode==="unknown"?"custom-alias":"patentai-gpt54",["low","medium","xhigh"].includes(mode)?mode:"high"));const done=expect(pending).rejects.toThrow("ai_operation_stopped");await vi.advanceTimersByTimeAsync(210000);await done;await expect(send(url,high())).rejects.toThrow("ai_operation_stopped");};
  if(mode==="oldscope")await withPriorArtComparisonBudget(run,1);else await withPriorArtClaimComparisonBudget(1,run);expect(transport).toHaveBeenCalledTimes(1);
 });
 it("aborts source at270seconds and never retries its unknown send",async()=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(()=>new Promise(()=>{}));vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(1,async()=>{const send=boundedAzureFetch("normal"),pending=send(url,high());const done=expect(pending).rejects.toThrow("ai_operation_stopped");await vi.advanceTimersByTimeAsync(269999);expect(transport).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);await done;await expect(send(url,high())).rejects.toThrow("ai_operation_stopped");});expect(transport).toHaveBeenCalledTimes(1);
 });
 it.each(["compare","review"])("keeps generation/review210seconds even after longer source admission:%s",async task=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async(_u,init)=>JSON.parse(JSON.parse(String(init?.body)).input[0].content).task===task?new Promise(()=>{}):response());vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(1,async()=>{const send=boundedAzureFetch("normal");await send(url,high());if(task==="review")await send(url,high("compare"));const pending=send(url,high(task));const done=expect(pending).rejects.toThrow("ai_operation_stopped");await vi.advanceTimersByTimeAsync(210000);await done;});
 });
 it.each(["ordinary","managed"])("keeps the35second ordinary/watch timeout for%s",async mode=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(()=>new Promise(()=>{}));vi.stubGlobal("fetch",transport);
  const run=async()=>{const pending=boundedAzureFetch("normal")(url,high());const done=expect(pending).rejects.toThrow("ai_operation_stopped");await vi.advanceTimersByTimeAsync(35000);await done;};
  if(mode==="ordinary")await withAiOperationBudget({normal:1,fast:0},run);else await withManagedWatchBudget({consumed:0,deadlineAt:Date.now()+100000,journal:{reserve:vi.fn(async()=>undefined),reconcile:vi.fn(async()=>undefined)}},run);expect(transport).toHaveBeenCalledTimes(1);
 });
 it("does not restart its absolute finite-operation deadline at the next request",async()=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async(_u,init)=>JSON.parse(JSON.parse(String(init?.body)).input[0].content).task==="extract_source_propositions"?response():new Promise(()=>{}));vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(1,async deadline=>{const send=boundedAzureFetch("normal");await send(url,high());await vi.advanceTimersByTimeAsync(719999);expect(deadline.aborted).toBe(false);const pending=send(url,high("compare"));const done=expect(pending).rejects.toThrow("ai_operation_stopped");await vi.advanceTimersByTimeAsync(1);await done;expect(deadline.aborted).toBe(true);await expect(send(url,high("review"))).rejects.toThrow("ai_operation_stopped");});expect(transport).toHaveBeenCalledTimes(2);
 });
 it("does not renew the source wait while reading a late body",async()=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(new ReadableStream({start(c){setTimeout(()=>{c.enqueue(new TextEncoder().encode(JSON.stringify({usage:{input_tokens:10,output_tokens:5}})));c.close();},271000);}})));vi.stubGlobal("fetch",transport);
  await withPriorArtClaimComparisonBudget(1,async()=>{const pending=boundedAzureFetch("normal")(url,high());const done=expect(pending).rejects.toThrow("ai_operation_stopped");await vi.advanceTimersByTimeAsync(270000);await done;});expect(transport).toHaveBeenCalledTimes(1);
 });
});
