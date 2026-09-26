"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
const control="rounded border px-3 py-2 disabled:opacity-50";
class RejectedInput extends Error {}
async function post(url:string,value:unknown){
  const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value),cache:"no-store",signal:AbortSignal.timeout(110_000)});
  if(!response.ok){const body=await response.json().catch(()=>null);if(response.status===400&&body?.error==="invalid_setting")throw new RejectedInput();throw Error();}return response.json();
}
export function WatchPrepare({caseId}:{caseId:number}){
  const router=useRouter(),[busy,setBusy]=useState(false),[attempted,setAttempted]=useState(false),[message,setMessage]=useState("");
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||attempted)return;const data=new FormData(event.currentTarget);setBusy(true);setAttempted(true);
    try{await post(`/api/cases/${caseId}/managed-watch/runs`,{from:data.get("from"),to:data.get("to")});
      setMessage("対象の選別と実行準備を保存しました。実行履歴の「比較を開始」から進めてください。");
    }catch(error){if(error instanceof RejectedInput){setAttempted(false);setMessage("対象公開期間を確認して修正してください。準備は受け付けられていません。");}else setMessage("準備結果の照合が必要です。再送せず、下の実行履歴を確認してください。");}
    finally{setBusy(false);router.refresh();}
  }
  return <section className="space-y-3 rounded border p-5"><h2 className="text-xl font-semibold">比較の実行準備</h2><p>取得済み公報から対象を固定します。準備だけではAI比較は開始されません。</p>
    <form className="flex flex-wrap items-end gap-4" onSubmit={submit}><label>対象公開期間の開始<input className={`${control} block`} type="date" name="from" required disabled={busy||attempted}/></label>
      <label>締め日<input className={`${control} block`} type="date" name="to" required disabled={busy||attempted}/></label><button className={control} disabled={busy||attempted}>クラウドで準備</button></form><p role="status">{message}</p></section>;
}
export function WatchStart({ caseId, runId, reserved }: { caseId: number; runId: string; reserved: boolean }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [message, setMessage] = useState("");
  async function act(action: "start" | "reconcile") {
    if (busy || (action === "start" && sent)) return;
    setBusy(true); if (action === "start") setSent(true);
    try { const r = await post(`/api/cases/${caseId}/managed-watch/runs/${runId}`, { action });
      if (["budget_reserved", "outcome_unknown"].includes(r.status)) setSent(true);
      if (r.status === "not_started") setSent(false);
      setMessage(r.status === "completed" ? "比較が完了しました。納品版を作成してPDF・CSVを確認してください。" :
        r.status === "accepted" ? "比較を実行しています。実行履歴で確認できます。" :
        r.status === "not_started" ? "比較は未実行です。「比較を開始」から進めてください。正常0件ではありません。" :
        r.status === "budget_reserved" ? "予算予約後に処理が中断しています。比較は開始確認前です。再送せず、運用担当へこの実行の照合を依頼してください。正常0件ではありません。" :
        r.status === "outcome_unknown" ? "開始結果が不明です。再送せず、運用担当へこの実行の照合を依頼してください。正常0件ではありません。" :
        "開始・処理結果を確認中です。同じ処理の状態を確認してください。");
    } catch { setMessage("結果を確認できません。開始を再送せず、状態を確認してください。"); }
    finally { setBusy(false); router.refresh(); }
  }
  return <div className="mt-3 space-y-2"><div className="flex flex-wrap gap-3">
    {!reserved && !sent && <button className={control} disabled={busy} onClick={() => void act("start")}>比較を開始</button>}
    <button className={control} disabled={busy} onClick={() => void act("reconcile")}>比較の状態を確認</button>
  </div><p role="status">{message}</p></div>;
}
export function DeliveryCreate({caseId}:{caseId:number}){
  const router=useRouter(),[busy,setBusy]=useState(false),[attempted,setAttempted]=useState(false),[message,setMessage]=useState("");
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||attempted)return;
    const form=new FormData(event.currentTarget),id=crypto.randomUUID();let sent=false;setBusy(true);
    try{
      setMessage("公式配布一覧を確認しています。");
      const distribution=await post(`/api/cases/${caseId}/managed-watch/distribution`,{});
      sent=true;setAttempted(true);
      setMessage("クラウドで納品版を作成しています。応答待ちの間は再操作しないでください。");
      const result=await post(`/api/cases/${caseId}/managed-watch/deliveries`,{deliveryId:id,period:{from:form.get("from"),to:form.get("to")},
        distributionTableSha256:distribution.sha256,reason:form.get("reason"),deliveredOn:form.get("deliveredOn")||null});
      setMessage(result.complete?"納品版を保存しました。PDF・CSVを確認してから手動で納品してください。":"未完了の範囲を明記した版を保存しました。候補0件とは扱わず、不足を確認してください。");router.refresh();
    }catch(error){if(sent&&error instanceof RejectedInput){setAttempted(false);setMessage("対象期間・納品日を確認して修正してください。納品版の作成は受け付けられていません。");}
      else setMessage(sent?`結果の照合が必要です。作成を再送せず、一覧の保存状態を確認してください。照合番号: ${id}`:"配布一覧を確認できませんでした。納品版の作成は送信していません。再度確認できます。");router.refresh();}
    finally{setBusy(false);}
  }
  return <section className="space-y-3 rounded border p-5"><h2 className="text-xl font-semibold">納品版を作成</h2>
    <p>公報の取得・比較と確認状態の保存を済ませてから作成します。不足がある場合は未完了の版として記録します。</p>
    <form className="flex flex-wrap items-end gap-4" onSubmit={submit}>
      <label>対象公開期間の開始<input className={`${control} block`} type="date" name="from" required disabled={busy||attempted}/></label>
      <label>締め日<input className={`${control} block`} type="date" name="to" required disabled={busy||attempted}/></label>
      <label>版の理由<select className={`${control} block`} name="reason" disabled={busy||attempted}><option value="initial">初回版</option><option value="late_publication">遅延公報の補足</option><option value="correction">訂正・変更版</option><option value="review_update">確認状態の更新</option></select></label>
      <label>納品日（未納品なら空欄）<input className={`${control} block`} type="date" name="deliveredOn" disabled={busy||attempted}/></label>
      <button className={`${control} bg-blue-700 text-white`} disabled={busy||attempted} type="submit">クラウドで作成</button>
    </form><p role="status" className="whitespace-pre-wrap">{message}</p>
  </section>;
}
export function DeliveryReconcile({caseId,deliveryId}:{caseId:number;deliveryId:string}){
  const router=useRouter(),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  async function check(abandonPartial:boolean){
    if(busy)return;setBusy(true);
    try{const result=await post(`/api/cases/${caseId}/managed-watch/deliveries/${deliveryId}/reconcile`,{abandonPartial});
      setMessage(result.status==="stored"?"3つの保存物を確認しました。":result.status==="abandoned"?"この版の保存を中断として記録しました。必要なら新しい版を作成してください。":"保存は未完了です。10分以上経過後に中断を確定できます。");router.refresh();
    }catch{setMessage("照合が完了していません。作成を再送しないでください。中断の確定は作成から10分以上経過後に行えます。");}
    finally{setBusy(false);}
  }
  return <div className="mt-3 space-y-2"><div className="flex gap-3"><button className={control} disabled={busy} onClick={()=>void check(false)}>保存結果を照合</button>
    <button className={control} disabled={busy} onClick={()=>void check(true)}>10分経過後の保存中断を確定</button></div><p role="status">{message}</p></div>;
}
export function FindingReview({caseId,findingId}:{caseId:number;findingId:number}){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const [current,setCurrent]=useState<{reviewVersion:number;reviewStatus:string}|null>(null);
  async function read(){
    if(busy)return;setBusy(true);
    try{const response=await fetch(`/api/cases/${caseId}/managed-watch/findings/${findingId}`,{cache:"no-store",signal:AbortSignal.timeout(30_000)});
      if(!response.ok)throw Error();const value=await response.json();if(!Number.isInteger(value.reviewVersion)||!["reviewed","unreviewed"].includes(value.reviewStatus))throw Error();
      setCurrent(value);setMessage(`現在の状態: ${value.reviewStatus==="reviewed"?"確認済み":"未確認"}。表示中の納品版は生成時点の状態です。`);
    }catch{setCurrent(null);setMessage("現在の確認状態を取得できません。変更せず、改めて照合してください。");}finally{setBusy(false);}
  }
  async function save(reviewed:boolean){
    if(busy||!current)return;setBusy(true);const expectedVersion=current.reviewVersion;setCurrent(null);
    try{const response=await fetch(`/api/cases/${caseId}/managed-watch/findings/${findingId}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({reviewed,expectedVersion}),cache:"no-store",signal:AbortSignal.timeout(30_000)});
      if(!response.ok)throw Error();setMessage("現在の確認状態を保存しました。表示中の納品版は変更されません。反映には確認状態の更新版を作成してください。");
    }catch{setMessage("保存結果が未確定か、別の更新があります。現在の確認状態を取得して照合してください。");}finally{setBusy(false);}
  }
  return <li className="space-y-2 rounded border p-3"><span>候補 #{findingId}</span><div className="flex flex-wrap gap-3"><button className={control} disabled={busy} onClick={()=>void read()}>現在の確認状態を取得</button><button className={control} disabled={busy||!current} onClick={()=>void save(true)}>確認済みにする</button><button className={control} disabled={busy||!current} onClick={()=>void save(false)}>未確認に戻す</button></div><p role="status">{message}</p></li>;
}
