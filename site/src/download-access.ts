let unlockedUntil=0;
let pending:Promise<boolean>|undefined;
/** The API Key stays in the transient form; only an HttpOnly session is retained. */
export function ensureDownloadAccess():Promise<boolean> {
  if(Date.now()<unlockedUntil)return Promise.resolve(true);
  if(pending)return pending;
  pending=new Promise<boolean>(resolve=>{
    const dialog=document.createElement("dialog");
    dialog.className="download-unlock-dialog";
    dialog.innerHTML=`
<form>
  <div class="unlock-header">
    <span class="unlock-kicker">REGION ACCESS · QUERY KEY REQUIRED</span>
    <strong class="unlock-title">访问完整空间分块清单</strong>
  </div>
  <p class="unlock-desc">继续分页查看完整空间分块和文件反查结果，或导出清单，需要具有 region:query 权限的 API Key。Assets 提供来源地址和清单，不代替用户下载科学数据。公开覆盖 MOC、预览结果与资源包无需解锁。</p>
  <div class="unlock-field">
    <label class="unlock-label" for="unlock-api-key">API KEY</label>
    <input id="unlock-api-key" name="apiKey" type="password" required autocomplete="off" placeholder="asa_live_…" class="unlock-input">
  </div>
  <p class="unlock-status" role="status" aria-live="polite"></p>
  <div class="unlock-actions">
    <button type="button" class="unlock-btn unlock-btn-cancel" data-cancel>取消</button>
    <button type="submit" class="unlock-btn unlock-btn-submit"><i class="unlock-submit-icon" aria-hidden="true"></i>解锁查询</button>
  </div>
  <div class="unlock-scan" aria-hidden="true"></div>
</form>`;
    const finish=(ok:boolean)=>{dialog.close();dialog.remove();pending=undefined;resolve(ok);};
    dialog.addEventListener("cancel",event=>{event.preventDefault();finish(false);});
    dialog.querySelector("[data-cancel]")!.addEventListener("click",()=>finish(false));
    const form=dialog.querySelector("form")!;
    form.addEventListener("submit",async event=>{
      event.preventDefault();
      const input=dialog.querySelector<HTMLInputElement>("#unlock-api-key")!;
      const button=dialog.querySelector<HTMLButtonElement>(".unlock-btn-submit")!;
      const status=dialog.querySelector<HTMLElement>(".unlock-status")!;
      button.disabled=true;
      status.textContent="正在验证…";
      status.className="unlock-status is-pending";
      try {
        const credential=input.value.trim();
        const response=await fetch("/api/v1/access/unlock",{method:"POST",headers:{"Content-Type":"application/json","X-Assets-API-Key":credential},body:"{}"});
        input.value="";const result=await response.json();
        if(!response.ok)throw new Error(result.error??"解锁失败");
        status.textContent="已解锁";status.className="unlock-status is-ok";
        unlockedUntil=Date.parse(result.expiresAt);
        setTimeout(()=>finish(true),320);
      }catch(error){
        status.textContent=error instanceof Error?error.message:"解锁失败";
        status.className="unlock-status is-error";
        button.disabled=false;
      }
    });
    document.body.append(dialog);dialog.showModal();dialog.querySelector("input")!.focus();
  });return pending;
}
export function resetDownloadAccess():void {unlockedUntil=0;}
export function hasDownloadAccess():boolean {return Date.now()<unlockedUntil;}
