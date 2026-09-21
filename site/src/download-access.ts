let unlockedUntil=0;
let pending:Promise<boolean>|undefined;
/** Password/API Key stays in the transient form; only an HttpOnly session is retained. */
export function ensureDownloadAccess():Promise<boolean> {
  if(Date.now()<unlockedUntil)return Promise.resolve(true);
  if(pending)return pending;
  pending=new Promise<boolean>(resolve=>{
    const dialog=document.createElement("dialog");dialog.className="download-unlock-dialog";
    dialog.innerHTML=`<form><h2>解锁科学数据下载</h2><p>查询区域内的数据单元和下载计划需要授权。可使用下载密码或具有区域查询权限的 API Key。公开覆盖 MOC 与资源包无需解锁。</p><label>下载密码或 API Key <input name="password" type="password" required autocomplete="off" placeholder="输入下载密码或 asa_live_ 开头的 API Key"></label><p role="status"></p><div><button type="button" data-cancel>取消</button><button type="submit">解锁</button></div></form>`;
    const finish=(ok:boolean)=>{dialog.close();dialog.remove();pending=undefined;resolve(ok);};
    dialog.addEventListener("cancel",event=>{event.preventDefault();finish(false);});
    dialog.querySelector("[data-cancel]")!.addEventListener("click",()=>finish(false));
    dialog.querySelector("form")!.addEventListener("submit",async event=>{
      event.preventDefault();const input=dialog.querySelector("input")!,button=dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;button.disabled=true;
      try {
        const credential=input.value.trim(); const isKey=credential.startsWith("asa_live_");
        dialog.querySelector('[role="status"]')!.textContent="正在验证…";
        const response=await fetch("/api/v1/access/unlock",{method:"POST",headers:{"Content-Type":"application/json",...(isKey?{"X-Assets-API-Key":credential}:{})},body:JSON.stringify(isKey?{}:{password:credential})});
        input.value="";const result=await response.json();
        if(!response.ok)throw new Error(result.error??"解锁失败");
        unlockedUntil=Date.parse(result.expiresAt);finish(true);
      }catch(error){dialog.querySelector('[role="status"]')!.textContent=error instanceof Error?error.message:"解锁失败";button.disabled=false;}
    });
    document.body.append(dialog);dialog.showModal();dialog.querySelector("input")!.focus();
  });return pending;
}
export function resetDownloadAccess():void {unlockedUntil=0;}
