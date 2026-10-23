/** These printed passive states have no faithful active-action equivalent.
 * Keep their literal phrase; no synonym, inverse or causal inference is used. */
export function isLiteralSourceState(text:string):boolean{
  return /^(?:[^、，。]*?(?:に|へ|が|は))?(?:電源が供給され(?:る)?|非通電とされ(?:る)?|接続された|全閉となり|閉じた状態に復帰する|開いた状態に復帰する)(?:続け(?:る)?|ている)?$/u.test(text)&&
    !/(?:電源(?:供給)?が絶たれ|停止|終了|維持|閉じる|開く|ない|なかった|なく|ず|ません|場合|とき|なら)/u.test(text);
}

export const SOURCE_STATE_PATTERN=/(?:電源が供給され(?:る)?|非通電とされ(?:る)?|接続された|全閉となり|閉じた状態に復帰する|開いた状態に復帰する)(?:続け(?:る)?|ている)?/gu;
