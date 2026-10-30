import type { SourceReadingClaim } from "./source-clause-coverage";
import { assertedModeAfter } from "./source-claim-obligations";
import type { Span } from "./propositions";

type Endpoint = { whole: Span; name: Span };
export type SourceTerminalRoute = { clause: number; span: Span; origin: Endpoint; destination: Endpoint; mode: Span };
const label = "[\\p{Script=Han}\\p{Script=Katakana}A-Za-zＡ-Ｚａ-ｚ0-9０-９ー]{1,80}";
const terminal = new RegExp(`^((?:前記|当該|該)?)(${label})から((?:前記|当該|該)?)(${label})に吸い込ませる`, "u");
const modeName = /^(?:第[0-9０-９一二三四五六七八九十]+(?:の)?)?[\p{Script=Han}\p{Script=Katakana}A-Za-zＡ-Ｚａ-ｚ0-9０-９ー]+モード/u;

/** Literal terminal route occurrences in an asserted operating mode. These
 * are rejection checks, never generated paths, endpoints or inferred actors.
 * Definitions, premises and ambiguous syntax remain full original-source QA. */
export function sourceTerminalRoutes(c: SourceReadingClaim): SourceTerminalRoute[] {
  const routes: SourceTerminalRoute[] = [];
  c.clauses.forEach((span, clause) => {
    const text = c.grid.text.slice(...span), match = terminal.exec(text);
    if (!match) return;
    const tail = c.grid.text.slice(span[0] + match[0].length), mode = modeName.exec(tail)?.[0];
    if (!mode || assertedModeAfter(tail) !== mode) return;
    // Do not turn quoted examples or a preceding conditional premise into an
    // affirmative path merely because the inner text has an asserted ending.
    const sentence = c.grid.text.slice(c.grid.text.lastIndexOf("。", span[0] - 1) + 1, span[0]);
    if (/[「」『』“”"?？]/u.test(sentence) || /(?:場合|とき|際|なら|のであれば)/u.test(sentence)) return;
    const fromStart = span[0], fromEnd = fromStart + match[1].length + match[2].length;
    const toStart = fromEnd + "から".length, toEnd = toStart + match[3].length + match[4].length;
    routes.push({ clause, span: [span[0], span[0] + match[0].length],
      origin: { whole: [fromStart, fromEnd], name: [fromStart + match[1].length, fromEnd] },
      destination: { whole: [toStart, toEnd], name: [toStart + match[3].length, toEnd] },
      mode: [span[0] + match[0].length, span[0] + match[0].length + mode.length] });
  });
  return routes;
}

const same = (a: Span, b: Span) => a[0] === b[0] && a[1] === b[1];
const endpoint = (term: readonly Span[], expected: Endpoint) => term.length === 1 &&
  (same(term[0], expected.whole) || same(term[0], expected.name));

/** Both endpoints must be the final ordered edge of one explicit positive
 * path under the printed mode. A controller's executes relation, an earlier
 * same-name occurrence or two disconnected paths cannot supply that edge. */
export function matchesSourceTerminalRoute(route: SourceTerminalRoute, fact: {
  kind: unknown; relation: unknown; polarity: unknown; context: unknown;
  subject: Span[]; origin: Span[]; via: Span[][]; destination: Span[];
}): boolean {
  return fact.kind === "path" && fact.relation === "route" && fact.polarity === "positive" &&
    fact.context === "operation" && fact.subject.length === 1 && same(fact.subject[0], route.mode) &&
    endpoint(fact.via.at(-1) ?? fact.origin, route.origin) && endpoint(fact.destination, route.destination);
}
