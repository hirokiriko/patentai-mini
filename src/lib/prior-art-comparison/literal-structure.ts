import type { ManagedClaimSet } from "../patent-watch/managed-claims";
import { reviewReferenceMentions } from "./reference-mentions";

type Span = readonly [number, number];
type ModeGroup = readonly [claim: number, subject: Span, kind: "fixed" | "choice", members: readonly Span[], declaration: Span];
type Bypass = readonly [claim: number, mode: Span | null, origin: Span, excluded: Span, destination: Span, definition: Span, control: Span];
export type LiteralStructure = { modes: ModeGroup[]; bypass: Bypass[] };
type Source = Pick<ManagedClaimSet, "claims">;
export type LiteralContradiction = {
  kind: "mandatory_choice" | "closed_choice" | "bypass";
  claimNo: number; sourceSpans: readonly Span[]; targetSpan: Span; counterexample: string[];
};
const number = "[0-9０-９一二三四五六七八九十]+";
const mode = `第${number}(?:の)?運転モード`;
const valve = `第${number}(?:の)?開閉弁`;
const nameCharacter = "[\\p{Script=Han}\\p{Script=Katakana}A-Za-zＡ-Ｚａ-ｚ0-9０-９ー]";
const label = `${nameCharacter}{1,80}`;
const key = (s: string) => s.normalize("NFKC").replace(/^(?:前記|当該|該)/, "").replace(/の(?=運転モード|開閉弁)/g, "");
const span = (start: number, text: string): Span => [start, start + text.length];
const ambiguous = /[「」『』“”"?？]|場合|ただし|但し|除く|限り|に応じ|とは限ら|ではな|でない|要確認|未確認|不明|少なくとも|例えば|例示|一部|選択肢として|含み得|という誤|と誤/;
const slice = (source: Source, claimNo: number, range: Span) => source.claims.find(c => c.claimNo === claimNo)!.text.slice(...range);

/** A deliberately small grammar, not a general patent parser. Facts retain
 * their full-claim UTF-16 coordinates. Unsupported/conditional/quoted syntax
 * contributes no fact; absence is NEVER interpreted as a negative fact.
 * Neither an AI reading nor a draft is an input to this derivation. */
export function compileLiteralStructure(source: Source): LiteralStructure {
  const modes: ModeGroup[] = [], bypass: Bypass[] = [];
  for (const { claimNo, text } of source.claims) {
    if (/[「」『』“”"]/.test(text)) continue;
    const firstCondition = /場合|とき|際|なら|限り|条件|除外|[（()）]/.exec(text)?.index ?? Infinity;
    // Postposed conditions can scope earlier coordinated predicates too. The
    // mode grammar therefore declines the entire claim if any such condition
    // occurs, rather than guessing its attachment to one of the topics.
    const topics = firstCondition < Infinity ? [] : [...text.matchAll(new RegExp(`(?<=^|[、,。])(?:前記)?(${mode})は[、,]?`, "gu"))];
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i], start = topic.index!, bodyStart = start + topic[0].length;
      // A condition preceding the topic is not a universally fixed mode.
      if (firstCondition < start) continue;
      const body = text.slice(bodyStart, topics[i + 1]?.index ?? text.length);
      if (/場合|とき|際|なら|限り|条件|除外|ない|なかった|という|とされ|[（()）]/.test(body)) continue;
      const subject = span(start + topic[0].indexOf(topic[1]), topic[1]);
      const fixed = body.match(new RegExp(`^(${label}モード)であり[、,]`, "u"));
      if (fixed) {
        modes.push([claimNo, subject, "fixed", [span(bodyStart, fixed[1])], [start, bodyStart + fixed[0].length]]);
        continue;
      }
      const end = /のうち(?:の)?(?:何れか|いずれか)[、,]?(?:又は[、,]?)?(?:それらの)?組み?合わせ[、,]?(?:若しくは[、,]?)?(?:それらの)?全てである/u.exec(body);
      if (!end) continue;
      const tail = body.slice(end.index + end[0].length);
      const referenceTail = `(?:請求項${number}(?:(?:又は|及び|から|乃至|、)(?:請求項)?${number})*に記載の)?`;
      if (!new RegExp(`^(?:[。\\s]*|ことを特徴とする${referenceTail}${label}。)$`, "u").test(tail)) continue;
      const declaration = body.slice(0, end.index + end[0].length);
      if (ambiguous.test(declaration) || /[（()）]/.test(declaration)) continue;
      const entries = [...declaration.matchAll(new RegExp(`(?<!${nameCharacter})(${label}モード)(?=と[、,]|のうち)`, "gu"))];
      const names = entries.map(e => key(e[1]));
      // Unaccounted-for mode mentions can be nested inside another member's
      // definition. Decline the group instead of flattening that inner list.
      if ([...declaration.matchAll(/モード/g)].length !== entries.length) continue;
      if (entries.length < 2 || new Set(names).size !== names.length || names.some(n => /運転モード$/.test(n))) continue;
      modes.push([claimNo, subject, "choice", entries.map(e => span(bodyStart + e.index!, e[1])), [start, bodyStart + declaration.length]]);
    }
    // Only explicit bypass definitions, bound to exactly one open valve in a
    // named mode with the other route closed. Missing path nodes prove nothing.
    const definitions = [...text.matchAll(new RegExp(`(?:前記|当該|該)(${label})から出た${label}を[、,](?:前記|当該|該)(${label})を経ること(?:無く|なく)(?:前記|当該|該)(${label})に流すための(${valve})`, "gu"))];
    const controls = [...text.matchAll(new RegExp(`(?:前記)?(${valve})を閉じ[、,](?:前記)?(${valve})を開くことで[、,]([^。]*?)(${mode})(?=と[、,]|を切り換え)`, "gu"))];
    const valveCounts = new Map<string, number>();
    for (const d of definitions) valveCounts.set(key(d[4]), (valveCounts.get(key(d[4])) ?? 0) + 1);
    for (const d of definitions) {
      if (valveCounts.get(key(d[4])) !== 1) continue;
      for (const c of controls) {
        if (firstCondition < c.index!) continue;
        const closing = new RegExp(`${mode}を切り換(?:える。|えて実行する${label}において[、,])`, "u").exec(text.slice(c.index!));
        if (!closing || firstCondition < c.index! + closing.index + closing[0].length) continue;
        if (key(c[2]) !== key(d[4]) || key(c[1]) === key(c[2]) || ambiguous.test(c[3]) || /開[きく]|閉じ|運転モード/.test(c[3])) continue;
        const start = d.index!, modeStart = c.index! + c[0].lastIndexOf(c[4]);
        // A postposed condition may govern the mode. Keep the original clause
        // locator for reading, but do not assert an unconditional mode binding.
        bypass.push([claimNo, firstCondition < Infinity ? null : span(modeStart, c[4]), span(start + d[0].indexOf(d[1]), d[1]),
          span(start + d[0].indexOf(d[2], d[0].indexOf("から出た")), d[2]),
          span(start + d[0].indexOf(d[3], d[0].indexOf("経る")), d[3]), span(start, d[0]),
          firstCondition < Infinity ? [c.index!, text.length] : span(c.index!, c[0])]);
      }
    }
  }
  // Competing definitions of the same subject are not safely interpretable.
  const unique = <T extends ModeGroup | Bypass>(facts: T[]) => {
    const counts = new Map<string, number>(), id = (g: T) => `${g[0]}:${g[1] ? key(slice(source, g[0], g[1])) : JSON.stringify(g)}`;
    for (const g of facts) counts.set(id(g), (counts.get(id(g)) ?? 0) + 1);
    return facts.filter(g => counts.get(id(g)) === 1);
  };
  return { modes: unique(modes), bypass: unique(bypass) };
}

/** Omit empty metadata. Coordinates, not repeated originals or generated
 * interpretations, are shared by source reading, generation and review. */
export function literalStructureInput(source: Source) {
  const structure = compileLiteralStructure(source);
  return structure.modes.length || structure.bypass.length ? { literalStructure: structure } : {};
}

function lists(text: string, vocabulary: string[]) {
  const result: { members: string[]; range: Span; prefix: string }[] = [];
  const suffix = /の(?:うち(?:の)?)?(?:何れか|いずれか|択一群)/gu;
  for (const marker of text.matchAll(suffix)) {
    let end = marker.index!, cursor = end;
    const members: string[] = [];
    // Exact longest names only; a suffix such as 光 must not match 蛍光.
    while (cursor > 0) {
      const before = text.slice(0, cursor);
      const name = vocabulary.find(n => before.endsWith(n + "モード") || before.endsWith(n));
      if (!name) break;
      cursor -= before.endsWith(name + "モード") ? name.length + 3 : name.length;
      members.unshift(name);
      const separator = text.slice(0, cursor).match(/(?:[・/／、,]|又は|または|若しくは|及び|および|と)$/u);
      if (!separator) break;
      cursor -= separator[0].length;
    }
    if (members.length < 2 || /[\p{L}\p{N}ー]$/u.test(text.slice(0, cursor).replace(/(?:は|を|が|=|＝|:|：)$/u, "")) && !/(?:は|を|が|=|＝|:|：)$/.test(text.slice(0, cursor))) continue;
    const prefix = text.slice(0, cursor);
    const subject = prefix.match(new RegExp(`(${mode})(?:は|を|=|＝)$`, "u"))?.[1];
    if (!subject && !/(?:^|。)(?:(?:基準|候補)側(?:は|が))?$/.test(prefix)) continue;
    // A partial/example/quoted/negated proposition is not a closed definition.
    if (ambiguous.test(text) || /を含む|も可能|対応する|の例|[（()）]/.test(text)) continue;
    end += marker[0].length;
    // Require an affirmative terminal predicate, not merely a matching list
    // embedded in a negation, question, reported error or epistemic reservation.
    if (!new RegExp(`^(?:[／/](?:組合せ|組み合わせ|全部|全て))*(?:である|として許容する|を対象とする|を対象とし${label}も備える)?[。\\s]*$`, "u").test(text.slice(end))) continue;
    result.push({ members, range: [cursor, end], prefix });
  }
  return result;
}

/** Negative results only: an empty result is not semantic approval. Source
 * must already be restricted to the intended side and reachable claim scope. */
export function compareLiteralStructure(source: Source, text: string): LiteralContradiction[] {
  if (/[「」『』“”"]/.test(text)) return []; // preserve quotation scope before splitting
  const sentences = text.split(/(?<=。)/u);
  if (sentences.length > 1) {
    let offset = 0;
    return sentences.flatMap(sentence => {
      const findings = compareLiteralStructure(source, sentence).map(f => ({ ...f, targetSpan: [f.targetSpan[0] + offset, f.targetSpan[1] + offset] as Span }));
      offset += sentence.length;
      return findings;
    });
  }
  // Explicit claim attribution narrows the context before any name matching.
  // Unknown references remain opaque; never borrow a same-named other branch.
  if (text.includes("請求項")) {
    const mentions = reviewReferenceMentions(text), refs: number[] = [];
    if (mentions.length !== 1) return []; // multiple subject bindings are opaque
    for (const mention of mentions) {
      if (!/^(?:$|の|は|では|で|に|由来|[:：、。])/.test(text.slice(mention.end))) return [];
      const phrase = text.slice(mention.start, mention.end).normalize("NFKC").replaceAll("請求項", "").replace(/[\t ]|まで/g, "");
      if (!/^[0-9]+(?:[\/・、,〜~～－-][0-9]+)*$/.test(phrase)) return [];
      const tokens = phrase.split(/([/・、,〜~～－-])/), first = Number(tokens[0]);
      if (tokens.filter((_, i) => i % 2 === 0).some(s => !Number.isSafeInteger(Number(s)) || Number(s) <= 0)) return [];
      refs.push(first);
      for (let i = 1; i < tokens.length; i += 2) {
        const before = Number(tokens[i - 1]), after = Number(tokens[i + 1]);
        if (/^[〜~～－-]$/.test(tokens[i])) {
          if (after < before || after - before > 1000) return [];
          for (let offset = 1; offset <= after - before; offset++) refs.push(before + offset);
        } else refs.push(after);
      }
    }
    const reachable = new Set<number>(), pending = [...refs];
    if (!refs.length || refs.some(no => !source.claims.some(c => c.claimNo === no))) return [];
    while (pending.length) {
      const no = pending.pop()!;
      if (reachable.has(no)) continue;
      const claim = source.claims.find(c => c.claimNo === no);
      if (!claim) return [];
      reachable.add(no); pending.push(...claim.dependsOn);
    }
    source = { claims: source.claims.filter(c => reachable.has(c.claimNo)) };
  }
  const structure = compileLiteralStructure(source), contradictions: LiteralContradiction[] = [];
  const member = (g: ModeGroup) => g[3].map(s => slice(source, g[0], s).replace(/モード$/, ""));
  const vocabulary = [...new Set(structure.modes.flatMap(member))].sort((a, b) => b.length - a.length);
  for (const list of lists(text, vocabulary)) {
    const mentioned = list.prefix.match(new RegExp(`(${mode})(?:は|を|=|＝)$`, "u"))?.[1];
    for (const group of structure.modes.filter(g => g[2] === "choice")) {
      const choices = member(group), fixed = structure.modes.filter(g => g[0] === group[0] && g[2] === "fixed");
      if (structure.modes.some(g => key(slice(source, g[0], g[1])) === key(slice(source, group[0], group[1])) &&
        (g[2] !== group[2] || JSON.stringify(member(g).sort()) !== JSON.stringify([...choices].sort())))) continue;
      const missing = choices.find(n => !list.members.includes(n));
      if (mentioned && key(mentioned) === key(slice(source, group[0], group[1])) && missing && list.members.every(n => choices.includes(n))) {
        contradictions.push({ kind: "closed_choice", claimNo: group[0], sourceSpans: [group[4]], targetSpan: list.range, counterexample: [missing] });
      }
      for (const required of fixed) {
        const name = member(required)[0], alternative = list.members.find(n => choices.includes(n));
        if (!mentioned && !choices.includes(name) && alternative && list.members.includes(name) && list.members.every(n => n === name || choices.includes(n))) {
          contradictions.push({ kind: "mandatory_choice", claimNo: group[0], sourceSpans: [required[4], group[4]], targetSpan: list.range, counterexample: [alternative] });
        }
      }
    }
  }
  if (!ambiguous.test(text) && !/とき|際|なら|条件|一方|片方|いずれ|何れ|可能|ことがある|ない|なかった|という|との|[（()）]/.test(text))
    for (const [claimNo, modeSpan, origin, excluded, destination, definition, control] of structure.bypass) {
    if (!modeSpan) continue;
    const from = slice(source, claimNo, origin), via = slice(source, claimNo, excluded), end = slice(source, claimNo, destination);
    // A bypass excludes a node only BETWEEN these endpoints. An unqualified
    // "after Y" could describe Y upstream of the bypass: that needs AI/human
    // review and must never be converted into a mechanical contradiction.
    const path = `${from}から${via}を経て${end}へ流す`, at = text.indexOf(path);
    if (at < 0) continue;
    if (!/^(?:(?:基準|候補)側は)?$/.test(text.slice(0, at))) continue;
    const tail = text.slice(at + path.length);
    const subjects = tail.match(new RegExp(`^第(${number})(?:[・及び]+第${number})*(?:の)?運転モード`, "u"));
    if (!subjects || !/^(?:を備える|を切り換える|である)[。\s]*$/u.test(tail.slice(subjects[0].length))) continue;
    const expected = key(slice(source, claimNo, modeSpan));
    const modes = [...subjects[0].matchAll(new RegExp(`第(${number})`, "gu"))].map(m => key(`第${m[1]}運転モード`));
    if (modes.includes(expected)) contradictions.push({ kind: "bypass", claimNo, sourceSpans: [definition, control],
      targetSpan: [at, at + path.length + subjects[0].length], counterexample: [expected, `from:${from}`, `bypass:${via}`, `to:${end}`] });
  }
  return contradictions;
}

/** An explicit opposite side or mixed subject makes attribution opaque. Never
 * apply one document's constraints to another document with the same names. */
export function compareAttributedStructure(source: Source, text: string, side: "base" | "candidate", implicit = false): LiteralContradiction[] {
  if (/[「」『』“”"]/.test(text)) return [];
  const sentences = text.split(/(?<=。)/u);
  if (sentences.length > 1) {
    let offset = 0;
    return sentences.flatMap(sentence => {
      const findings: LiteralContradiction[] = compareAttributedStructure(source, sentence, side, implicit)
        .map(f => ({ ...f, targetSpan: [f.targetSpan[0] + offset, f.targetSpan[1] + offset] as Span }));
      offset += sentence.length; return findings;
    });
  }
  const own = side === "base" ? /基準(?:側|請求項|文献|は|の|が)/ : /候補(?:側|請求項|文献|は|の|が)/;
  const other = side === "base" ? /候補/ : /基準/;
  if (other.test(text) || (!implicit && !own.test(text))) return [];
  return compareLiteralStructure(source, text);
}

export const LITERAL_STRUCTURE_GUIDE = "literalStructure is a partial LOCAL syntax projection, not an AI reading or complete claim model. Spans=[start,end) UTF16 in joined claim. modes=[claim,subject,fixed|choice,members,declaration]; keep subjects distinct. bypass=[claim,mode,origin,excluded,destination,definition,control]; mode=null means conditional binding unresolved: read FULL control span. Exclusion is only between endpoints, not the entire mode. Read originals; never mix fixed/choice groups, omit choices or transfer paths. Missing metadata proves nothing; full originals/all branches govern.";
