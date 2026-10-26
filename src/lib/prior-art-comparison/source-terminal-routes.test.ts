import { expect, it } from "vitest";
import { sourceReadingClaim } from "./source-clause-coverage";
import { matchesSourceTerminalRoute, sourceTerminalRoutes } from "./source-terminal-routes";
import type { Span } from "./propositions";

const body = "該白槽から前記黒槽に吸い込ませる";
const mode = "第２の運転モード";
it.each([`${mode}と、別のモードを切り換えて実行する装置。`, `${mode}である。`,
  `${mode}を実行する装置。`, `${mode}のうち一方を実行する装置。`])("recognizes literal endpoints and mode in an asserted terminal route: %s", ending => {
  const text = body + ending, routes = sourceTerminalRoutes(sourceReadingClaim(1, text));
  expect(routes).toHaveLength(1);
  const route = routes[0];
  expect(text.slice(...route.origin.name)).toBe("白槽");
  expect(text.slice(...route.destination.name)).toBe("黒槽");
  expect(text.slice(...route.mode)).toBe(mode);
});

it.each([
  body.replace("吸い込ませる", "吸い込ませない") + mode + "である。",
  body.replace("吸い込ませる", "吸い込ませなかった") + mode + "である。",
  body.replace("吸い込ませる", "吸い込ませません") + mode + "である。",
  body.replace("吸い込ませる", "吸い込ませず") + mode + "である。",
  body + "ことなく" + mode + "である。",
  ...["場合", "とき", "なら", "ための"].map(suffix => body + suffix + mode + "である。"),
  ...["を実行しない。", "を実行する必要がない。", "を実行する場合。", "であるか？"].map(suffix => body + mode + suffix),
  "例えば「制御器により、" + body + mode + "である」と記載する。",
  "停止した場合、" + body + mode + "である。",
  "停止したとき、" + body + mode + "である。",
  "停止した場合、制御器により、" + body + mode + "である。",
])("does not require a positive path from a definition, premise, negation or quote: %s", text => {
  expect(sourceTerminalRoutes(sourceReadingClaim(1, text))).toEqual([]);
});

function fixture() {
  const text = "白槽と黒槽を備え、" + body + mode + "である。";
  const route = sourceTerminalRoutes(sourceReadingClaim(1, text))[0];
  const fact = { kind: "path", relation: "route", polarity: "positive", context: "operation",
    subject: [route.mode], origin: [route.origin.name], via: [] as Span[][], destination: [route.destination.name] };
  return { route, fact };
}
it("accepts a segment or the final edge of one complete route, preserving optional printed prefixes", () => {
  const { route, fact } = fixture();
  expect(matchesSourceTerminalRoute(route, fact)).toBe(true);
  expect(matchesSourceTerminalRoute(route, { ...fact, origin: [route.origin.whole], destination: [route.destination.whole] })).toBe(true);
  expect(matchesSourceTerminalRoute(route, { ...fact, origin: [[0, 2]], via: [fact.origin] })).toBe(true);
});
it("requires the terminal occurrence even when an upstream path reaches the same named junction", () => {
  const text = "前記青槽から前記白槽に流し、" + body + mode + "である。";
  const route = sourceTerminalRoutes(sourceReadingClaim(1, text))[0];
  const earlierJunction: Span = [text.indexOf("白槽"), text.indexOf("白槽") + 2];
  const upstream: Span = [text.indexOf("青槽"), text.indexOf("青槽") + 2];
  const combined = { kind: "path", relation: "route", polarity: "positive", context: "operation",
    subject: [route.mode], origin: [upstream], via: [[earlierJunction]], destination: [route.destination.name] };
  expect(text.slice(...earlierJunction)).toBe(text.slice(...route.origin.name));
  const before = JSON.stringify(combined);
  expect(matchesSourceTerminalRoute(route, combined)).toBe(false);
  expect(JSON.stringify(combined)).toBe(before);
  expect(matchesSourceTerminalRoute(route, { ...combined, origin: [route.origin.name], via: [] })).toBe(true);
});
it.each(["executes", "negative", "capability", "wrong_mode", "earlier_names", "reverse", "only_origin", "only_destination", "disconnected", "long_quote"])("rejects terminal route substitution: %s", mutation => {
  const { route, fact } = fixture();
  if (mutation === "executes") fact.kind = "relation";
  if (mutation === "negative") fact.polarity = "negative";
  if (mutation === "capability") fact.context = "capability";
  if (mutation === "wrong_mode") fact.subject = [[0, 2]];
  if (mutation === "earlier_names") { fact.origin = [[0, 2]]; fact.destination = [[3, 5]]; }
  if (mutation === "reverse") [fact.origin, fact.destination] = [fact.destination, fact.origin];
  if (mutation === "only_origin") fact.destination = [];
  if (mutation === "only_destination") fact.origin = [];
  if (mutation === "disconnected") fact.via = [[[3, 5]]];
  if (mutation === "long_quote") fact.origin = [route.span];
  expect(matchesSourceTerminalRoute(route, fact)).toBe(false);
});
