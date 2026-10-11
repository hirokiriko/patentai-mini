import { TrialError } from "./policy";
/** Private pipe input must have one interpretation in Python and Node. */
export function parseTrialStrictJson(bytes:Uint8Array):unknown{
  try{
    const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes),value:unknown=JSON.parse(text);
    const stack:Array<Set<string>|null>=[];
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(c==="{"||c==="["){stack.push(c==="{"?new Set():null);if(stack.length>64)throw Error();}
      else if(c==="}"||c==="]")stack.pop();
      else if(c==='"'){
        const start=i++;for(;i<text.length;i++){if(text[i]==="\\")i++;else if(text[i]==='"')break;}
        let next=i+1;while(/\s/.test(text[next]??"")&&next<text.length)next++;
        if(text[next]===":"){
          const key:string=JSON.parse(text.slice(start,i+1)),keys=stack.at(-1);
          if(!keys||keys.has(key))throw Error();keys.add(key);
        }
      }
    }
    const finite=(v:unknown):void=>{if(typeof v==="number"&&!Number.isFinite(v))throw Error();if(v&&typeof v==="object")for(const child of Object.values(v))finite(child);};
    finite(value);return value;
  }catch{throw new TrialError("trial_json_invalid");}
}
