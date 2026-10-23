/** These printed passive states have no faithful active-action equivalent.
 * Keep their literal phrase; no synonym, inverse or causal inference is used. */
const locationNoun=String.raw`[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９Ａ-Ｚａ-ｚー]+`;
// Conservative noun phrases: do not swallow a preceding action or condition.
const placementState=String.raw`${locationNoun}(?:(?:の|と|及び|並びに)${locationNoun})*に設けられ(?:た|る)`;
export function isLiteralSourceState(text:string):boolean{
  const placement=new RegExp(`^${placementState}$`,"u").test(text);
  return (placement||/^(?:[^、，。]*?(?:に|へ|が|は))?(?:電源が供給され(?:る)?|非通電とされ(?:る)?|接続された|全閉となり|閉じた状態に復帰する|開いた状態に復帰する)(?:続け(?:る)?|ている)?$/u.test(text))&&
    !/(?:電源(?:供給)?が絶たれ|停止|終了|維持|閉じる|開く|ない|なかった|なく|ず|ません|場合|とき|なら)/u.test(text);
}

export const SOURCE_STATE_PATTERN=new RegExp(String.raw`(?:電源が供給され(?:る)?|非通電とされ(?:る)?|接続された|全閉となり|閉じた状態に復帰する|開いた状態に復帰する)(?:続け(?:る)?|ている)?|${placementState}`,"gu");
