import { expect, it } from "vitest";
import { coversReferenceScope, propositionScope, type PropositionScope } from "./proposition-references";
import { compareProposition, meaningKey, type Meaning, type SourceProposition } from "./propositions";

it("preserves many alternatives as a DAG without enumerating or converting them to AND",()=>{
  const claims=Array.from({length:11},(_,i)=>({claimNo:i+1,dependsOn:Array.from({length:i},(_,j)=>j+1),
    text:i===0?"赤色弁を備える架空装置。":i===1?"請求項1に記載の架空装置。":`請求項1から${i}のいずれかに記載の架空装置。`}));
  const scope=propositionScope({publicationNumber:"FICTIONAL",version:"v1",claims},11,"base:11");
  expect(scope.nodes).toHaveLength(11);
  expect(coversReferenceScope(scope,[1])).toBe(true);
  expect(coversReferenceScope(scope,[10])).toBe(false);
  expect(coversReferenceScope(scope,[11])).toBe(true);
});
it("requires all alternatives, but an independent proof in an ALL parent suffices",()=>{
  const scope:PropositionScope={id:"base:3",selected:3,nodes:[
    {claimNo:1,refs:[],relation:"none",guaranteed:[1]}, {claimNo:2,refs:[],relation:"none",guaranteed:[2]},
    {claimNo:3,refs:[1,2],relation:"any_of",guaranteed:[3]}]};
  expect(coversReferenceScope(scope,[1])).toBe(false);
  expect(coversReferenceScope(scope,[1,2])).toBe(true);
  scope.nodes[2].relation="all_of";
  expect(coversReferenceScope(scope,[1])).toBe(true);
  expect(coversReferenceScope(scope,[99])).toBe(false);
});
it("does not erase a conditional descendant's different literal constraint",()=>{
  const meaning=(members:string[]):Meaning=>({kind:"set",subject:"装置",context:"capability",guard:{relation:"unconditional",conditions:[]},
    polarity:"positive",selection:"nonempty",extent:"closed",members});
  const fact=(id:string,claimNo:number,members:string[]):SourceProposition=>({id,claimNo,scope:"base:4",basis:[[0,10]],authority:"literal",meaning:meaning(members)});
  expect(compareProposition({id:"t",targetId:"t",span:[0,20],sourceIds:["a"],scope:"base:4",claimNo:1,inheritedClaimNos:[1,4],meaning:meaning(["赤","青"])},
    [fact("a",1,["赤","青"]),fact("b",2,["赤"])]).relation).toBe("unresolved");
});
it("canonicalizes unordered conditions and sets while retaining route order",()=>{
  const m:Meaning={kind:"path",subject:"流路",context:"operation",guard:{relation:"when",conditions:["低温","起動"]},polarity:"positive",
    origin:"入口",destination:"出口",via:["赤槽","青槽"],bypass:["黄槽","白槽"],extent:"whole",relation:"route"};
  expect(meaningKey(m)).toBe(meaningKey({...m,guard:{...m.guard,conditions:["起動","低温"]},bypass:["白槽","黄槽"]}));
  expect(meaningKey(m)).not.toBe(meaningKey({...m,via:["青槽","赤槽"]}));
  expect(meaningKey(m)).toBe(meaningKey(Object.fromEntries(Object.entries(m).reverse()) as Meaning));
});
