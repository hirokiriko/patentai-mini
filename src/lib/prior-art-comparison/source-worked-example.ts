// Fictional instruction data only. Tests run this exact fragment through the
// production source schema/domain decoder; it never supplies application facts.
export const SOURCE_WORKED_PARTS = [
  "補助ヒータを備える。前記分岐器から出た気体を、前記冷却器を経ること無く前記蓄積器に流すための第２の開閉弁と、前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、前記送出器から吐出された気体を前記加熱器に流し、",
  "前記分岐器から前記バイパス配管を通って前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モードと、別経路を実行する第２の運転モードを切り換える。第１の運転モードでは、温度が五度を下回ると補助ヒータを発熱させる。",
];
export const SOURCE_WORKED_CLAIM = {
  cn:1,rr:[{
    bb:{fp:0,lp:1},
    ll:[{q:"第１の運転モード",o:0},{q:"送出器",o:0},{q:"送出器",o:1},
      {q:"加熱器",o:0},{q:"分岐器",o:1},{q:"バイパス配管",o:0},{q:"蓄積器",o:1},{q:"冷却器",o:0}],
    mm:{su:[0],cx:"operation",gr:"unconditional",gc:[],po:"positive",ki:"path",
      or:[1],de:[2],vi:[[3],[4],[5],[6]],by:[[7]],ex:"whole",re:"route"},
    op:{se:null,ex:null,po:null,gu:null,cx:null},rf:0,
  }],ff:[{
    bb:{fp:1,lp:1},
    ll:[{q:"第１の運転モード",o:1},{q:"温度が五度を下回る",o:0},{q:"補助ヒータ",o:0}],
    mm:{su:[0],cx:"operation",gr:"when",gc:[[1]],po:"positive",ki:"relation",pr:"generates_heat",ob:[[2]]},
    op:{se:null,ex:null,po:null,gu:1,cx:null},rf:null,
  }],
};
export const SOURCE_WORKED_GUIDE =
  `Fictional fragment, not answer data/exhaustive reading. Claim1 parts=${
    JSON.stringify(SOURCE_WORKED_PARTS.map((text,id)=>({id,text})))
  }; catalog id0 covers parts0..1. Output=${JSON.stringify(SOURCE_WORKED_CLAIM)}.
Loop return o1 differs from inlet o0; pipe is via, cooler by. Heat uses part1: mode o1 selects its action clause, heater o0 ignores the earlier occurrence outside bb. No unused ll.`;
