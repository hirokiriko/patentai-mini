import type { Span } from "./propositions";
import type { SourceReadingClaim } from "./source-clause-coverage";
import { assertedModeAfter } from "./source-claim-obligations";

type Cause = { controls: Span[]; effect: Span };
const contains = ([a, b]: Span, [x, y]: Span) => a <= x && b >= y;
const overlaps = ([a, b]: Span, [x, y]: Span) => a < y && b > x;

/** Only the printed coordinated valve actions ending ことで in an asserted
 * mode. These spans are rejection checks, never generated guards or repaired
 * meanings. Ambiguous syntax still requires the complete original-source QA. */
export function sourceCausalModeGuards(c: SourceReadingClaim): Cause[] {
  const text = c.grid.text, causes: Cause[] = [];
  const component = "[\\p{Script=Han}\\p{Script=Katakana}A-Za-z0-9０-９Ａ-Ｚａ-ｚーの]{1,80}弁";
  const ending = new RegExp(`^${component}を(?:開く|閉じる)ことで[、，]$`, "u");
  const preceding = new RegExp(`^${component}を(?:開き|閉じ)[、，]$`, "u");
  for (let id = 1; id < c.clauses.length; id++) {
    const clause = c.clauses[id];
    if (!ending.test(text.slice(...clause))) continue;
    const controls: Span[] = [[clause[0], clause[1] - 1]];
    for (let previous = id - 1; previous >= 0; previous--) {
      const span = c.clauses[previous];
      if (!preceding.test(text.slice(...span))) break;
      controls.unshift([span[0], span[1] - 1]);
    }
    if (controls.length < 2) continue;
    const mode = assertedModeAfter(text.slice(clause[1]));
    if (!mode) continue;
    const name = /(?:第[0-9０-９一二三四五六七八九十]+の)?[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９ー]+モード$/u.exec(mode)?.[0];
    if (!name) continue;
    const effect: Span = [clause[1], clause[1] + mode.length - name.length];
    const body = text.slice(...effect);
    // Do not propagate through a new printed subject, another cause, a
    // definition or a conditional/negative statement. No boundary is guessed.
    if (!body || /(?:[。；;\n]|は[、，]|が[、，]|により[、，]|ことで|場合|とき|際|なら|必要|禁止|ための|ない|なかった|なく|無く|ません|ず)/u.test(body) ||
        /(?:^|[、，])[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９ーの]{1,80}(?:は|が)/u.test(body)) continue;
    causes.push({ controls, effect });
  }
  return causes;
}

export function assertSourceCausalModeGuards(causes: readonly Cause[], fact: {
  kind: string; action: Span | null; route: Span[]; guard: Span[][];
}) {
  for (const cause of causes) {
    // A long action quote can also describe an overall apparatus switch after
    // the mode. Cross-boundary assertions remain full original-QA work; this
    // narrow check must not assign a causal scope to them from overlap alone.
    const applies = fact.kind === "path" ? fact.route.some(span => overlaps(span, cause.effect)) :
      fact.kind === "relation" && fact.action !== null && contains(cause.effect, fact.action);
    if (!applies) continue;
    if (!cause.controls.every(control => fact.guard.some(term => {
      if (term.some((span, index) => index > 0 && span[0] < term[index - 1][0])) return false;
      let end = control[0];
      for (const span of term) {
        if (span[0] > end) break;
        if (contains(span, control)) return true;
        end = Math.max(end, span[1]);
        if (end >= control[1]) return true;
      }
      return false;
    })))
      throw new Error("comparison_source_causal_guard_incomplete");
  }
}
