// Fictional SDK plumbing only. This inverse starts with hand-authored spans;
// it must never repair an actual model answer or stand for semantic quality QA.
// Deliberately independent of the production cell/coverage/compact codecs.
export function fixtureGridText(claim) {
  const rows = new Map();
  for (const row of claim.grid) {
    const [ids, ...cells] = row.split("|");
    if (!cells.length || cells.length > 10) throw Error("fictional_grid_invalid");
    const text = cells.map(cell => /^\\u\{[0-9a-f]+\}$/.test(cell)
      ? String.fromCodePoint(parseInt(cell.slice(3, -1), 16)) : cell).join("");
    for (const id of ids.split(",").map(Number)) {
      if (!Number.isSafeInteger(id) || id < 0 || rows.has(id)) throw Error("fictional_grid_invalid");
      rows.set(id,text);
    }
  }
  return Array.from({length:rows.size},(_,i) => {
    if (!rows.has(i)) throw Error("fictional_grid_invalid"); return rows.get(i);
  }).join("");
}
const kinds = ["set", "path", "relation"], contexts = ["capability", "operation", "unresolved"];
const guards = ["unconditional", "when", "only_when", "unresolved"], polarities = ["positive", "negative", "reserved"];
const selections = ["required", "one", "nonempty", "all", "unspecified"];
const extents = ["closed", "partial", "segment", "whole", "unresolved"];
const predicates = ["has", "upstream", "downstream", "inside", "opens", "closes", "fully_closes",
  "generates_heat", "absorbs_heat", "releases_heat", "maintains", "at_least", "at_most", "greater_than", "less_than",
  "opens_one", "opens_together", "executes", "stops", "power_ends"];
const ordinal = (values, value) => { const n = values.indexOf(value); if (n < 0) throw Error("fictional_enum_invalid"); return n; };
export function fixtureGridWire(value, input) {
  return { v: 14, s: value.sources.map((s, si) => {
    const source = (input.sources.find(x => x.sourceDigest === s.sourceDigest) ?? input.sources[si]).source;
    if (s.facts.some(f => !source.claims.some(c => c.claimNo === f.claimNo))) throw Error("fictional_locator_invalid");
    const answer = { d: s.sourceDigest }, reading = [];
    for (const c of source.claims) {
      const text = fixtureGridText(c), points = [0];
      for (const char of text) points.push(points.at(-1) + char.length);
      const span = range => {
        if (!Array.isArray(range) || range.length !== 2 || range.some(n => !Number.isSafeInteger(n)) ||
            range[0] < 0 || range[1] <= range[0] || range[1] > text.length ||
            !points.includes(range[0]) || !points.includes(range[1])) throw Error("fictional_locator_invalid");
        return range;
      };
      const ref = range => {
        const [a, b] = span(range), first = points.indexOf(a), last = points.indexOf(b) - 1;
        return [Math.floor(first / 10), first % 10, Math.floor(last / 10), last % 10];
      };
      let start = 0;
      const clauses = c.clauseEnds.map(([row, col]) => {
        const end = points[row * 10 + col + 1], range = span([start, end]); start = end; return range;
      });
      if (start !== text.length) throw Error("fictional_grid_invalid");
      const own = s.facts.filter(f => f.claimNo === c.claimNo), witnesses = [];
      answer[`c${c.claimNo}`] = own.length ? own.map(f => {
        if (f.basis.length !== 1) throw Error("fictional_basis_requires_single_range");
        const basis = span(f.basis[0]);
        if (basis[0] !== 0 || basis[1] !== text.length) throw Error("fictional_basis_not_part_range");
        const used = new Set(), evidence = [];
        const locate = range => {
          span(range);
          if (range[0] < basis[0] || range[1] > basis[1]) throw Error("fictional_locator_outside_basis");
          evidence.push(range); return ref(range);
        };
        if (new Set(f.bindings.map(b => b.term)).size !== f.bindings.length) throw Error("fictional_binding_duplicate");
        const term = value => {
          const binding = f.bindings.find(b => b.term === value);
          if (!binding) throw Error("fictional_binding_missing");
          const refs = binding.spans.map(locate);
          if (binding.spans.map(r => text.slice(...r)).join("") !== value) throw Error("fictional_binding_changed");
          used.add(value); return refs;
        };
        const m = f.meaning, common = { u: m.subject === null ? null : term(m.subject), x: ordinal(contexts, m.context),
          g: ordinal(guards, m.guard.relation), G: m.guard.conditions.map(term), p: ordinal(polarities, m.polarity), k: ordinal(kinds, m.kind) };
        const meaning = m.kind === "set" ? { ...common, S: ordinal(selections, m.selection), e: ordinal(extents, m.extent), M: m.members.map(term) }
          : m.kind === "path" ? { ...common, i: m.origin === null ? null : term(m.origin), j: m.destination === null ? null : term(m.destination),
            V: m.via.map(term), B: m.bypass.map(term), e: ordinal(extents, m.extent), r: ordinal(["route", "precedes"], m.relation) }
          : { ...common, P: ordinal(predicates, m.predicate), J: m.objects.map(term) };
        if (used.size !== f.bindings.length) throw Error("fictional_binding_unused");
        const proof = r => {
          if (r === null) return null;
          span(r); return r[0] === 0 && r[1] === text.length ? [] : locate(r);
        };
        const operators = ["selection", "extent", "polarity", "guard", "context"].map(k => proof(f.operators[k]));
        const frame = f.routeFrame === null ? null : { E: proof(f.routeFrame.entry), X: proof(f.routeFrame.exit), T: proof(f.routeFrame.route),
          C: f.routeFrame.exclusions.map(proof), D: f.routeFrame.controls.map(proof) };
        const selected = clauses.filter(([a,b]) => evidence.some(([x,y]) => x < b && y > a));
        if (!selected.length) throw Error("fictional_evidence_missing");
        witnesses.push(selected);
        return { m: meaning, O: operators.every(x => x === null) ? null : operators, F: frame, W: selected.map(ref) };
      }) : { K: ref([0,text.length]), N: "Fictional fixture supplies no expressible additional fact." };
      for (const [a,b] of clauses) {
        const addresses = witnesses.flatMap((ranges,i) => ranges.some(([x,y]) => x === a && y === b) ? [`c${c.claimNo}:${i}`] : []);
        reading.push(addresses.length ? addresses : ["?fixture"]);
      }
    }
    return { ...answer, Y: reading };
  }) };
}
