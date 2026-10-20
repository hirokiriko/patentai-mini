// Fictional instruction data only. Tests run this exact fragment through the
// production source schema/domain decoder; it never supplies application facts.
export const SOURCE_WORKED_PARTS = [
  "補助ヒータを備える。前記分岐器から出た気体を、前記冷却器を経ること無く前記蓄積器に流すための第２の開閉弁と、前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、前記送出器から吐出された気体を前記加熱器に流し、",
  "前記分岐器から前記バイパス配管を通って前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モードと、別経路を実行する第２の運転モードを切り換える。第１の運転モードでは、温度が五度を下回ると補助ヒータを発熱させる。",
];
const q=(quote:string,occurrence=0)=>({quote,occurrence});
const neutral={selection:null,extent:null,polarity:null,guard:null,context:null};
export const SOURCE_WORKED_FACTS = [{
  claimNo:1,basis:{firstPart:0,lastPart:1},
  meaning:{subject:[q("第１の運転モード")],context:"operation",guardRelation:"unconditional",guardConditions:[],
    polarity:"positive",kind:"path",origin:[q("送出器")],destination:[q("送出器",1)],
    via:[[q("加熱器")],[q("分岐器",1)],[q("バイパス配管")],[q("蓄積器",1)]],bypass:[[q("冷却器")]],extent:"whole",relation:"route"},
  operators:null,routeFrame:0,
},{
  claimNo:1,basis:{firstPart:1,lastPart:1},
  meaning:{subject:[q("第１の運転モード",1)],context:"operation",guardRelation:"when",guardConditions:[[q("温度が五度を下回る")]],
    polarity:"positive",kind:"relation",predicate:"generates_heat",objects:[[q("補助ヒータ")]]},
  operators:{...neutral,guard:q("温度が五度を下回る")},routeFrame:null,
}];
export const SOURCE_ACTION_TEXT="制御器は非通電状態を記録し、前記制御器は、前記通電状態で温度が七度を超える場合、赤色弁を開き、青色弁を閉じる。";
export const SOURCE_ACTION_FACTS=["opens","closes"].map((predicate,i)=>({
  claimNo:1,basis:{firstPart:0,lastPart:0},
    meaning:{subject:[q("制御器",1)],context:"operation",guardRelation:"when",
      guardConditions:[[q("通電状態",1)],[q("温度が七度を超える場合")]],
    polarity:"positive",kind:"relation",predicate,objects:[[q(i===0?"赤色弁":"青色弁")]]},
  operators:{...neutral,guard:q("前記通電状態で温度が七度を超える場合")},routeFrame:null,
}));
export const SOURCE_WORKED_GUIDE=
  `Fictional examples, not answers. Loop claim1 parts=${JSON.stringify(SOURCE_WORKED_PARTS)}; first fact=${JSON.stringify(SOURCE_WORKED_FACTS[0])}.
Action claim1 part0=${JSON.stringify(SOURCE_ACTION_TEXT)}; opening fact=${JSON.stringify(SOURCE_ACTION_FACTS[0])}.
Separate positive closes fact: 青色弁, same guard. 通電状態 inside 非通電状態 counts as 0; this guard uses 1. Numeric routeFrame=ONLY catalog whole path, never controls. Sets/relations: routeFrame:null.`;
