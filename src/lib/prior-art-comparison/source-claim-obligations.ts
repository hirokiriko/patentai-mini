import type { SourceReadingClaim } from "./source-clause-coverage";
import { sourceReadingTasks, type SourceReadingTask } from "./source-reading-tasks";

// Accept only an assertion boundary or a printed postposed subject. Matching
// a prefix such as 特徴とする must not consume its subsequent negation/condition.
function assertedEnding(tail: string): boolean {
  const rest = tail.replace(/^ことを特徴とする/u, "");
  return /^(?:[、，。]|$|と共に[、，])/u.test(rest) ||
    /^(?:請求項[^。]{1,100}に記載の)?[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９ー]{0,80}(?:装置|機|器|方法|システム|回路)(?:[、，。]|$|において[、，]|であって[、，])/u.test(rest);
}

function assertedModeAfter(tail: string): string | null {
  const mode = /^[^。]*?(?:運転)?モード/u.exec(tail)?.[0];
  if (!mode) return null;
  const ending = tail.slice(mode.length);
  const predicate = /^(?:を(?:切り換えて)?実行する|である)/u.exec(ending)?.[0];
  return /^(?:と[、，]|のうち|であり[、，])/u.test(ending) ||
    !!predicate && assertedEnding(ending.slice(predicate.length)) ? mode : null;
}

/** Positions of printed actions, never completed meanings. Required response
 * keys make each occurrence accountable to an actual generated fact; actors,
 * objects, context and guards are still extracted and independently checked. */
export function sourceClaimObligations(c: SourceReadingClaim): SourceReadingTask[] {
  const tasks = sourceReadingTasks(c, true, true).filter(t => t.kind !== "path");
  const text = c.grid.text;
  const add = (start: number, end: number, kind: string) => {
    const clause = c.clauses.findIndex(([a, b]) => a <= start && b >= end);
    if (clause < 0) throw new Error("comparison_source_obligation_invalid");
    if (!tasks.some(t => t.span[0] === start && t.span[1] === end && t.kind === kind))
      tasks.push({ clause, kind, span: [start, end], polarity: "positive" });
  };
  // A completed reduction inside an explicitly printed mode route remains an
  // action even when followed by 後. A generic conditional/premise is not an
  // assertion: do not extend the legacy action cues to arbitrary past forms.
  for (const m of text.matchAll(/減圧した後[、，]/gu)) {
    const tail = text.slice(m.index + m[0].length);
    const mode = assertedModeAfter(tail);
    if (mode &&
        /(?:流し|流す|吸い込ませ|吸熱させ|放熱させ)/u.test(mode) &&
        !/(?:場合|とき|なら|のであれば|必要|禁止|ない|なかった|ことなく)/u.test(mode))
      add(m.index, m.index + "減圧した".length, "executes");
  }
  // An asserted mode's causative heat/flow action is distinct from its heat
  // component or route. Require its own generated relation, never synthesize
  // an actor or an action from a path. Restrict this to printed active endings;
  // definitions, premises and negations remain subject to full original QA.
  for (const m of text.matchAll(/(?:吸熱させ|放熱させ|発熱させ|流し|流す|吸い込ませる)/gu)) {
    const tail = text.slice(m.index + m[0].length);
    if (!/^(?:[、，]|る?[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９ーの]*モード)/u.test(tail)) continue;
    const mode = assertedModeAfter(tail);
    const clause = c.clauses.find(([a, b]) => a <= m.index && b >= m.index + m[0].length);
    const prefix = clause ? text.slice(clause[0], m.index) : "";
    if (mode && !/(?:場合|とき|際|なら|のであれば|必要|禁止|ない|なかった|なく|無く|ません|ず|ための)/u.test(prefix + m[0] + mode))
      add(m.index, m.index + m[0].length, "executes");
  }
  // These literals are asserted active endings only. Conditional and negated
  // uses stay with the existing full original QA; no positive fact is forced.
  for (const [kind, pattern] of [["executes", /切り換えて実行する/gu], ["maintains", /維持する/gu]] as const)
    for (const m of text.matchAll(pattern)) {
      const tail = text.slice(m.index + m[0].length);
      if (assertedEnding(tail))
        add(m.index, m.index + m[0].length, kind);
    }
  return tasks.sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);
}
