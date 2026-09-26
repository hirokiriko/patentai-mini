import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({spawn:vi.fn(),mkdtemp:vi.fn(),mkdir:vi.fn(),rm:vi.fn()}));
vi.mock("node:child_process",()=>({spawn:mock.spawn}));
vi.mock("node:fs/promises",async original=>({...await original<typeof import("node:fs/promises")>(),
  mkdtemp:mock.mkdtemp,mkdir:mock.mkdir,rm:mock.rm}));
import { isolatedCommand, isolatedPg16, hasUnconfirmedIsolatedProcess } from "./watch-report-local.test-support";
function child(){return Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),
  stdin:Object.assign(new EventEmitter(),{end:vi.fn()}),kill:vi.fn(()=>true)});}
afterEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();vi.useRealTimers();});
it.each(["abort","timeout"])("waits for child close after %s before allowing cleanup",async mode=>{
  vi.useFakeTimers();const process=child(),controller=new AbortController();mock.spawn.mockReturnValue(process);
  let finished=false;
  const result=isolatedCommand("fictional-command",[],"",{},100,controller.signal).catch(error=>{finished=true;throw error;});
  const rejected=expect(result).rejects.toThrow(mode==="abort"?"isolated_process_cancelled":"isolated_process_timeout");
  if(mode==="abort")controller.abort();else await vi.advanceTimersByTimeAsync(100);
  expect(process.kill).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(20);expect(finished).toBe(false);
  process.emit("close",1);await rejected;expect(finished).toBe(true);
});
it("preserves recovery state when create ACK is lost and inspect reports absence",async()=>{
  for(const name of ["DATABASE_URL","PGHOST","PGSERVICE"])vi.stubEnv(name,undefined);
  vi.stubEnv("WATCH_REPORT_LOCAL_DB_TEST","1");
  mock.mkdtemp.mockResolvedValue(join(tmpdir(),"watch-report-test-fictional"));mock.mkdir.mockResolvedValue(undefined);
  const controller=new AbortController(),calls:string[]=[];let closed=false;
  mock.spawn.mockImplementation((_file:string,args:string[])=>{
    const process=child();
    queueMicrotask(()=>{
      if(args.includes("create")){calls.push("create");controller.abort();setTimeout(()=>{closed=true;process.emit("close",1);},10);}
      else {expect(closed).toBe(true);expect(args).toContain("inspect");calls.push("inspect");process.stderr.emit("data","Error: No such object: fictional");process.emit("close",1);}
    });return process;
  });
  await expect(isolatedPg16(129,controller.signal)).rejects.toThrow("isolated_cleanup_unconfirmed");
  expect(calls).toEqual(["create","inspect"]);expect(mock.rm).not.toHaveBeenCalled();
});
it("records a missing close so the operator retains its hard watchdog",async()=>{
  vi.useFakeTimers();const process=child(),controller=new AbortController();mock.spawn.mockReturnValue(process);
  process.kill.mockImplementation(()=>{process.emit("error",Error("fictional_kill_denied"));return false;});
  const result=isolatedCommand("fictional-command",[],"",{},100,controller.signal);
  const rejected=expect(result).rejects.toThrow("isolated_process_exit_unconfirmed");
  controller.abort();await vi.advanceTimersByTimeAsync(5000);await rejected;
  expect(hasUnconfirmedIsolatedProcess()).toBe(true);
  process.emit("close",1);expect(hasUnconfirmedIsolatedProcess()).toBe(false);
});
