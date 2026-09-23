import { z } from "zod";
import { db } from "../../db";
import { ManagedWatchRepository } from "../../repositories/managed-watch";
import { ManagedDeliveryRepository } from "../../repositories/managed-delivery";
import { ManagedWatchError } from "./managed-types";
import { managedDate, ManagedPeriodError, validateManagedPeriod } from "./managed-period";
export const managedWatchRepository = () => new ManagedWatchRepository(db);
export const managedDeliveryRepository = () => new ManagedDeliveryRepository(db);
/** Use only for untrusted request input, never for stored rows or provider responses. */
export function managedRequestInput<T>(parse:()=>T):T {
  try{return parse();}catch(error){
    if(error instanceof z.ZodError || (error instanceof ManagedPeriodError && error.code!=="calendar_unconfirmed"))throw new ManagedWatchError("invalid_setting");
    throw error;
  }
}
export const managedCaseId = (value:string) => managedRequestInput(()=>z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).pipe(z.number().int().max(2147483647)).parse(value));
export const managedRequestId = (value:string) => managedRequestInput(()=>z.uuidv4().parse(value));
export const managedRequestDate = z.string().superRefine((value,ctx)=>{try{managedDate(value);}catch{ctx.addIssue({code:"custom",message:"invalid_date"});}});
export const managedRequestPeriod = z.object({from:managedRequestDate,to:managedRequestDate}).strict().superRefine((value,ctx)=>{try{validateManagedPeriod(value);}catch{ctx.addIssue({code:"custom",message:"invalid_period"});}});
export async function managedJson(request:Request,limit=5*1024**2):Promise<unknown>{
  if(!request.headers.get("content-type")?.startsWith("application/json"))throw new ManagedWatchError("invalid_setting");
  const reader=request.body?.getReader();if(!reader)throw new ManagedWatchError("invalid_setting");
  let length=0;const chunks:Uint8Array[]=[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ManagedWatchError("unavailable")),10_000);});
  try{for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;length+=value.length;if(length>limit)throw new ManagedWatchError("limit");chunks.push(value);}
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
  }catch{void reader.cancel().catch(()=>undefined);throw new ManagedWatchError("invalid_setting");}
  finally{clearTimeout(timer);reader.releaseLock();}
}
export function managedApiError(error:unknown){
  const code=error instanceof ManagedWatchError?error.code:"unavailable";
  return Response.json({error:code},{status:code==="not_found"?404:code==="in_progress"||code==="conflict"?409:code==="invalid_setting"?400:503});
}
