import {describe,expect,it} from "vitest";
import {parseTrialStrictJson} from "./strict-json";
const parse=(s:string)=>parseTrialStrictJson(Buffer.from(s));
describe("private protocol JSON",()=>{
  it("rejects duplicate and escape-equivalent keys at every depth",()=>{
    for(const value of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"v":[{"x":1,"x":2}]}'])
      expect(()=>parse(value)).toThrow("trial_json_invalid");
  });
  it("rejects malformed UTF-8, excessive nesting, non-finite numbers and trailing data",()=>{
    expect(()=>parseTrialStrictJson(Uint8Array.from([34,0xc3,34]))).toThrow();
    for(const value of ['{"x":1e400}','[NaN]','{}{}','['.repeat(65)+'0'+']'.repeat(65)])expect(()=>parse(value)).toThrow();
  });
  it("allows the same key in separate objects and escaped punctuation in strings",()=>{
    const value={rows:[{x:1},{x:2}],text:'a\\" { [ : x'};
    expect(parse(JSON.stringify(value))).toEqual(value);
  });
});
