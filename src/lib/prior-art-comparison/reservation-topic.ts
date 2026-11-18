/** The existing restricted reservation grammar. A factual clause must still
 * be reviewed as an assertion; uncertainty cannot hide an unchecked claim. */
export function isNominalReservationTopic(topic:string):boolean {
  const nominal=topic.startsWith("相違する")?topic.slice("相違する".length):topic;
  if(nominal!==topic&&!/^[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９]/u.test(nominal))return false;
  return nominal.split("、").every(member=>member.split("又は").every(alternative=>/[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９]/u.test(alternative)&&
    /^(?:[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９・／/\s-]|の|と|および|または|における|への|での|からの|までの|など)+$/u.test(alternative)));
}

/** New generations must express uncertainty without an embedded assertion.
 * This is an early local check, not provider-enforced grammar or a retry. */
export function isNominalReservationText(text:string):boolean {
  const sentences=text.split("。").map(s=>s.trim());
  if(sentences.at(-1)==="")sentences.pop();
  return sentences.length>0&&sentences.every(sentence=>{
    const match=/^(?:未確認事項[：:])?\s*(.+?)(?:は|については|までは|について)?(?:未確認|未検証|未評価|要確認|不明)(?:である|です)?$/u.exec(sentence);
    return !!match&&isNominalReservationTopic(match[1]);
  });
}
