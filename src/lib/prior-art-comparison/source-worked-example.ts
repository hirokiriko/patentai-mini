import { compactSourceWire } from "./source-wire-compact";
// Fictional instruction data only. Tests run this exact fragment through the
// production source schema/domain decoder; it never supplies application facts.
export const SOURCE_WORKED_PARTS = [
  "補助ヒータを備える。前記分岐器から出た気体を、前記冷却器を経ること無く前記蓄積器に流すための第２の開閉弁と、前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、前記送出器から吐出された気体を前記加熱器に流し、",
  "前記分岐器から前記バイパス配管を通って前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モードと、別経路を実行する第２の運転モードを切り換える。第１の運転モードでは、温度が五度を下回ると補助ヒータを発熱させる。",
];
const q=(quote:string,context:string|null=null)=>{
  const at=context?.indexOf(quote)??0;
  return {quote,before:context?.slice(0,at)??"",after:context?.slice(at+quote.length)??"",edge:"none" as const};
};
const neutral={selection:null,extent:null,polarity:null,guard:null,context:null};
export const SOURCE_WORKED_FACTS = [{
  claimNo:1,basis:{firstPart:0,lastPart:1},
  meaning:{subject:[q("第１の運転モード","吸い込ませる第１の運転モードと")],context:"operation",guardRelation:"unconditional",guardConditions:[],
    polarity:"positive",kind:"path",origin:[q("送出器","前記送出器から吐出")],destination:[q("送出器","前記送出器に吸い込ませる")],
    via:[[q("加熱器")],[q("分岐器","前記分岐器から前記バイパス配管")],[q("バイパス配管")],[q("蓄積器","前記蓄積器に流し、")]],bypass:[[q("冷却器")]],extent:"whole",relation:"route"},
  operators:null,routeFrame:0,
},{
  meaning:{subject:[q("第１の運転モード","第１の運転モードでは")],context:"operation",guardRelation:"when",guardConditions:[[q("温度が五度を下回る")]],
    polarity:"positive",kind:"relation",predicate:"generates_heat",objects:[[q("補助ヒータ","補助ヒータを発熱させる")]]},
  operators:{...neutral,guard:q("温度が五度を下回る")},routeFrame:null,
}];
export const SOURCE_ACTION_TEXT="制御器は非通電状態を記録し、前記制御器は、前記通電状態で温度が七度を超える場合、赤色弁を開き、青色弁を閉じる。";
export const SOURCE_ACTION_FACTS=["opens","closes"].map((predicate,i)=>({
    meaning:{subject:[q("制御器","前記制御器は")],context:"operation",guardRelation:"when",
      guardConditions:[[q("通電状態","前記通電状態で温度が七度を超える場合")],[q("温度が七度を超える場合")]],
    polarity:"positive",kind:"relation",predicate,objects:[[q(i===0?"赤色弁":"青色弁")]]},
  operators:{...neutral,guard:q("前記通電状態で温度が七度を超える場合")},routeFrame:null,
}));
export const SOURCE_WORKED_GUIDE=
  `Fictional. Claim1 parts=${JSON.stringify(SOURCE_WORKED_PARTS)}; loop0=${JSON.stringify(compactSourceWire(SOURCE_WORKED_FACTS[0]))}.
c1=[${JSON.stringify(compactSourceWire(SOURCE_WORKED_FACTS[1]))}], not loop0. Quote the heat action, not the heater definition.
'青弁は非通電状態で閉じ、赤弁は通電状態で開く': 通電状態 with before赤弁は/afterで開く belongs to 赤弁. Keep 非; location is not meaning proof.`;
