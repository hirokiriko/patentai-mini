import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRevalidationBridge } from "./prior-art-revalidation-bridge";
import { REVALIDATION_PLAN as PLAN, revalidationHash } from "./prior-art-revalidation-guard";

const binding = { executionId: "11111111-1111-4111-8111-111111111111", head: "a".repeat(40),
  policyHash: "b".repeat(64), materialsHash: "c".repeat(64), measurementHash: "d".repeat(64),
  approvalHash: "e".repeat(64), publicReadbackHash: "f".repeat(64), endpoint: "https://example.invalid/responses", deployment: "patentai-gpt54" };
const decision = { status: "OWNER_APPROVED" as const, planId: PLAN.id, maximumNewSends: 5,
  maximumReservationYen: 734, maximumAi: 398300000, maximumTotal: 538300000, expiresAt: PLAN.approvedExpiresAt };
const packet = { system: "Fictional", prompt: JSON.stringify({ task: "read_sources" }), schema: { type: "object" } };
const body = JSON.stringify({ model: binding.deployment, input: [{ role: "developer", content: packet.system },
  { role: "user", content: [{ type: "input_text", text: packet.prompt }] }], max_output_tokens: 8192,
  text: { format: { type: "json_schema", name: "response", strict: true, schema: packet.schema } }, reasoning: { effort: "low" }, service_tier: "default" });
const response = () => Response.json({ id: "resp_fixture", object: "response", model: "gpt-5.4", service_tier: "default", status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
function fixture(recordPrivateFailureBody?: (ordinal: number, bytes: Uint8Array) => Promise<void>) {
  const records = new Map<string, Uint8Array>(), calls: string[] = [];
  const parent = vi.fn(async (command: string) => { calls.push(command); });
  const record = vi.fn(async (name: string, bytes: Uint8Array) => { expect(records.has(name)).toBe(false); records.set(name, bytes); calls.push(name); });
  const transport = vi.fn(async () => { calls.push("transport"); return response(); });
  const validateAnswer = vi.fn(async () => { calls.push("validate"); });
  const bridge = createRevalidationBridge({ binding, decision, parent, record, transport, packet: () => packet,
    validateAnswer, recordPrivateFailureBody });
  return { bridge, records, calls, parent, record, transport, validateAnswer,
    send: (signal = new AbortController().signal) => bridge.fetch(binding.endpoint, { method: "POST", body, signal }) };
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T05:00:00Z")); });
afterEach(() => vi.restoreAllMocks());
describe("protected-parent revalidation adapter", () => {
  it("preserves complete failure bytes only in an explicit private sink and never reconciles", async () => {
    const privateSink = vi.fn(async (_ordinal: number, _bytes: Uint8Array) => {});
    const f = fixture(privateSink), raw = JSON.stringify({error:{message:"FICTIONAL_PRIVATE schema field details"}});
    f.transport.mockResolvedValue(new Response(raw,{status:400}));
    await expect(f.send()).rejects.toThrow();
    expect(privateSink).toHaveBeenCalledOnce();
    expect(privateSink.mock.calls[0][0]).toBe(44);
    expect(Buffer.from(privateSink.mock.calls[0][1]).toString()).toBe(raw);
    expect([...f.records.values()].map(v=>Buffer.from(v).toString()).join("")).not.toContain("FICTIONAL_PRIVATE");
    expect(f.parent.mock.calls.some(([command])=>command==="reconcile")).toBe(false);
    await expect(f.send()).rejects.toThrow(); expect(f.transport).toHaveBeenCalledOnce();
  });
  it("does not preserve an over-limit or interrupted error body", async () => {
    const sink = vi.fn(async (_ordinal: number, _bytes: Uint8Array) => {}), f=fixture(sink);
    f.transport.mockResolvedValue(new Response("x".repeat(16385),{status:400}));
    await expect(f.send()).rejects.toThrow(); expect(sink).not.toHaveBeenCalled();
  });
  it("keeps a failed private write unknown without exposing its error", async () => {
    const f=fixture(async()=>{throw Error("FICTIONAL_PRIVATE_WRITE_ERROR");});
    f.transport.mockResolvedValue(Response.json({error:{message:"FICTIONAL_PRIVATE"}},{status:400}));
    await expect(f.send()).rejects.toThrow("revalidation_stopped");
    expect(f.records.has("provider-failure-44.json")).toBe(false);
    expect(f.parent.mock.calls.some(([command])=>command==="reconcile")).toBe(false);
    expect([...f.records.values()].map(v=>Buffer.from(v).toString()).join("")).not.toContain("FICTIONAL_PRIVATE");
  });
  it("records exact request before reservation ACK and exact response before reconciliation", async () => {
    const f = fixture(); await f.send();
    expect(f.calls).toEqual(["admit", "claim", "request-44.json", "reserve", "transport", "provider-metadata-44.json", "provider-response-44.json", "reconcile", "validate", "answer-44.json"]);
    expect(Buffer.from(f.records.get("request-44.json")!).toString()).toBe(body);
    const event = f.parent.mock.calls.find(([command]) => command === "reconcile");
    expect(event).toBeDefined();
    expect(f.bridge.snapshot().completed).toBe(1);
  });
  it.each(["claim", "reserve", "reconcile"])("never retries an unknown %s acknowledgement", async fault => {
    const f = fixture(); f.parent.mockImplementation(async command => { if (command === fault) throw Error("fictional"); });
    await expect(f.send()).rejects.toThrow("revalidation_stopped"); await expect(f.send()).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(fault === "reconcile" ? 1 : 0);
    expect(f.records.has("answer-44.json")).toBe(false); expect(f.bridge.snapshot().stopped).toBe(true);
  });
  it("does not dispatch if the durable request record fails", async () => {
    const f = fixture(); f.record.mockRejectedValue(Error("fictional"));
    await expect(f.send()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
    expect(f.parent.mock.calls.map(([command]) => command)).toEqual(["admit", "claim", "stop"]);
  });
  it("does not reconcile if response recording fails after transport", async () => {
    const f = fixture(); f.record.mockImplementation(async name => { if (name.startsWith("provider-response-")) throw Error("fictional"); });
    await expect(f.send()).rejects.toThrow(); expect(f.transport).toHaveBeenCalledOnce();
    expect(f.parent.mock.calls.some(([command]) => command === "reconcile")).toBe(false);
  });
  it("retains reconciled usage when answer validation fails", async () => {
    const f = fixture(); f.validateAnswer.mockRejectedValue(Error("fictional"));
    await expect(f.send()).rejects.toThrow();
    expect(f.parent.mock.calls.map(([command]) => command)).toEqual(["admit", "claim", "reserve", "reconcile", "stop"]);
    expect(f.records.has("answer-44.json")).toBe(false);
  });
  it("cancels and stops without reconciliation if header metadata cannot be saved", async () => {
    const f = fixture(), cancel = vi.fn();
    f.transport.mockResolvedValue(new Response(new ReadableStream({cancel}),{status:400}));
    f.record.mockImplementation(async name => { if(name.startsWith("provider-metadata-")) throw Error("fictional"); });
    await expect(f.send()).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce(); expect(f.bridge.snapshot().stopped).toBe(true);
    expect(f.parent.mock.calls.some(([command])=>command==="reconcile")).toBe(false);
    await expect(f.send()).rejects.toThrow(); expect(f.transport).toHaveBeenCalledOnce();
  });
  it("propagates abort and rejects another concurrent request", async () => {
    const f = fixture(); let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    f.transport.mockImplementation(async () => { entered(); return new Promise<Response>(() => undefined); });
    const first = expect(f.send()).rejects.toThrow(); await started;
    await expect(f.send()).rejects.toThrow(); await first; expect(f.transport).toHaveBeenCalledOnce();
  });
  it("keeps transport response bytes identical", async () => {
    const f = fixture(), raw = await response().text(); f.transport.mockResolvedValue(new Response(raw));
    const received = await f.send(); expect(await received.text()).toBe(raw);
    expect(revalidationHash(f.records.get("provider-response-44.json")!)).toBe(revalidationHash(raw));
  });
  it("cancels the upstream body for a rejected HTTP response", async () => {
    const f = fixture(), cancel = vi.fn();
    f.transport.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 429 }));
    await expect(f.send()).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
    expect(f.records.has("provider-response-44.json")).toBe(false);
    expect(JSON.parse(Buffer.from(f.records.get("provider-metadata-44.json")!).toString())).toEqual({ status: 429, requestId: null });
  });
  it("records only safe HTTP status and validated request ID; keeps unknown stopped", async () => {
    const f = fixture();
    f.transport.mockResolvedValue(new Response("FICTIONAL_SECRET_BODY", { status: 400, headers: {
      "apim-request-id": "11111111-1111-4111-8111-111111111111", "x-request-id": "FICTIONAL_SECRET_ID", "authorization": "FICTIONAL_SECRET_HEADER",
    } }));
    await expect(f.send()).rejects.toThrow();
    expect(JSON.parse(Buffer.from(f.records.get("provider-metadata-44.json")!).toString())).toEqual({status:400,requestId:"11111111-1111-4111-8111-111111111111"});
    expect([...f.records.values()].map(v=>Buffer.from(v).toString()).join("")).not.toContain("FICTIONAL_SECRET");
    expect(f.parent.mock.calls.some(([command])=>command==="reconcile")).toBe(false);
    await expect(f.send()).rejects.toThrow(); expect(f.transport).toHaveBeenCalledOnce();
  });
  it("retains allowlisted failure fields and a body hash without accepting usage or echoing secrets", async () => {
    const f=fixture(),raw=JSON.stringify({error:{code:"invalid_json_schema",type:"invalid_request_error",param:"text.format.schema",message:"FICTIONAL_SECRET"},usage:{input_tokens:1,output_tokens:0}});
    f.transport.mockResolvedValue(new Response(raw,{status:400}));
    await expect(f.send()).rejects.toThrow();
    expect(JSON.parse(Buffer.from(f.records.get("provider-failure-44.json")!).toString())).toEqual({status:400,bodyState:"complete",bodyBytes:Buffer.byteLength(raw),bodySHA256:revalidationHash(raw),code:"invalid_json_schema",type:"invalid_request_error",param:"text.format.schema",usageKnown:false});
    expect([...f.records.values()].map(v=>Buffer.from(v).toString()).join("")).not.toContain("FICTIONAL_SECRET");
    expect(f.calls.indexOf("provider-metadata-44.json")).toBeLessThan(f.calls.indexOf("provider-failure-44.json"));
    expect(f.parent.mock.calls.some(([command])=>command==="reconcile")).toBe(false);
    expect(JSON.parse(Buffer.from(f.records.get("stop-ack-44.json")!).toString())).toMatchObject({ordinal:44,stopAckReceived:true});
    await expect(f.send()).rejects.toThrow();expect(f.transport).toHaveBeenCalledOnce();
  });
  it("redacts unknown provider fields and never writes an ACK receipt before acknowledgement", async()=>{
    const f=fixture();f.transport.mockResolvedValue(Response.json({error:{code:"FICTIONAL_SECRET_CODE",type:"FICTIONAL_SECRET_TYPE",param:"FICTIONAL_SECRET_PARAM",message:"FICTIONAL_SECRET_MESSAGE"}},{status:400}));
    f.parent.mockImplementation(async command=>{if(command==="stop")throw Error("FICTIONAL_SECRET_ACK");});
    await expect(f.send()).rejects.toThrow();
    expect(JSON.parse(Buffer.from(f.records.get("provider-failure-44.json")!).toString())).toMatchObject({code:null,type:null,param:null,usageKnown:false});
    expect(f.records.has("stop-ack-44.json")).toBe(false);
    expect([...f.records.values()].map(v=>Buffer.from(v).toString()).join("")).not.toContain("FICTIONAL_SECRET");
  });
  it("bounds failed bodies and keeps partial data out of diagnostic records",async()=>{
    const f=fixture(),cancel=vi.fn();
    f.transport.mockResolvedValue(new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("FICTIONAL_SECRET".repeat(2000)));},cancel}),{status:400}));
    await expect(f.send()).rejects.toThrow();expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.parse(Buffer.from(f.records.get("provider-failure-44.json")!).toString())).toMatchObject({bodyState:"over_limit",bodySHA256:null,code:null,usageKnown:false});
    expect(f.parent.mock.calls.some(([command])=>command==="reconcile")).toBe(false);
  });
  it("cancels failed body diagnostics on product abort without reconciling",async()=>{
    const f=fixture(),ctrl=new AbortController(),cancel=vi.fn();let entered!:()=>void;
    const started=new Promise<void>(r=>{entered=r;});
    f.transport.mockImplementation(async()=>{entered();return new Response(new ReadableStream({cancel}),{status:400});});
    const pending=expect(f.send(ctrl.signal)).rejects.toThrow();await started;ctrl.abort();await pending;
    expect(cancel).toHaveBeenCalledOnce();expect(f.bridge.snapshot().stopped).toBe(true);
    expect(f.parent.mock.calls.some(([command])=>command==="reconcile")).toBe(false);
  });
  it("drops malformed request IDs and never serializes transport exceptions", async () => {
    const f = fixture();
    f.transport.mockResolvedValue(new Response(null,{status:400,headers:{"x-request-id":"FICTIONAL_SECRET"}}));
    await expect(f.send()).rejects.toThrow();
    expect(Buffer.from(f.records.get("provider-metadata-44.json")!).toString()).not.toContain("FICTIONAL_SECRET");
    const g = fixture(); g.transport.mockRejectedValue(Error("FICTIONAL_SECRET"));
    await expect(g.send()).rejects.toThrow();
    expect(JSON.parse(Buffer.from(g.records.get("provider-transport-44.json")!).toString())).toEqual({outcome:"transport_rejected",signalAborted:false});
    expect(g.parent.mock.calls.some(([command])=>command==="reconcile")).toBe(false);
  });
  it("cancels a stalled response stream when the product aborts", async () => {
    const f = fixture(), cancel = vi.fn(), ctrl = new AbortController();
    let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
    f.transport.mockImplementation(async () => { entered(); return new Response(new ReadableStream({ cancel })); });
    const pending = expect(f.send(ctrl.signal)).rejects.toThrow(); await ready; await Promise.resolve(); ctrl.abort(); await pending;
    expect(cancel).toHaveBeenCalledOnce(); expect(f.bridge.snapshot().stopped).toBe(true);
  });
});
