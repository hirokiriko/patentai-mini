import { expect,it } from "vitest";
import { isNominalReservationText,isNominalReservationTopic } from "./reservation-topic";

it.each([
  "装置全体の作用と図面は未確認。",
  "候補側の起動時の制御は未確認。弁の対応関係は要確認。",
  "未確認事項：制御、図面、部材の対応は未検証。",
  "相違する制御条件は不明です。",
])("accepts nominal uncertainties with their actual scope: %s",text=>{
  expect(isNominalReservationText(text)).toBe(true);
});
it.each([
  "第１の運転モードから圧縮機を起動する際の候補側の制御は未確認。",
  "弁がいずれに対応するかは未確認。",
  "青弁を開く。制御は未確認。",
  "制御、、図面は未確認。",
  "未確認。", "制御は未確認。。図面は未確認。",
])("does not hide assertions inside uncertainty: %s",text=>{
  expect(isNominalReservationText(text)).toBe(false);
});
it("preserves the existing topic grammar including noun enumeration",()=>{
  for(const topic of ["制御、図面","相違する制御","基準からの変更","圧縮機の制御"])
    expect(isNominalReservationTopic(topic)).toBe(true);
  for(const topic of ["制御、、図面","制御、弁を開く","相違するの制御","弁が閉じる"])
    expect(isNominalReservationTopic(topic)).toBe(false);
});

it.each(["熱交換器と放熱器又は吸熱器の対応関係は未確認。", "青弁又は赤弁の配置は要確認。"])("accepts internal nominal alternatives: %s",text=>{
 expect(isNominalReservationText(text)).toBe(true);
});
it.each(["又は青弁は未確認。", "青弁又はは未確認。", "青弁又は又は赤弁は未確認。", "青弁又は赤弁を開くことは未確認。", "青弁を開く又は赤弁を閉じる条件は未確認。", "圧力が低下した場合の青弁又は赤弁の制御は未確認。"])("rejects incomplete alternatives and embedded assertions: %s",text=>{
 expect(isNominalReservationText(text)).toBe(false);
});
