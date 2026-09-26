interface BatchProduct {
  productId: string;
  retiredAt?: string;
  draft: { name: string; surveyId: string; releaseId: string; layerId?: string; mode?: string; coverageRole?: string; dataOrigin?: string; sourceTier?: string; scanDefaults?: { allowedSuffixes?: string; maxOrder?: number; raColumn?: string; decColumn?: string; healpixColumn?: string; healpixOrderColumn?: string; healpixOrder?: number } };
}
interface BatchView {
  name: string;
  sourceConnector?: string;
  sourcePaths?: string[];
  status?: { phase?: string; reason?: string; message?: string; summary?: { rules?: Array<{ name?: string; expectedPartitions?: number; completedPartitions?: number; failedPartitions?: number; runningPartitions?: number; files?: number; coverage?: number; availableOrders?: number[] }> }; scope?: { rules?: Array<{ name?: string; scopeId?: string; scopeSnapshotSha256?: string; expectedPartitionCount?: number }> } };
}
interface Dependencies {
  api<T>(path: string, init?: RequestInit): Promise<T>;
  products(): BatchProduct[];
  connectors(): Array<{ name: string; type: string }>;
}

/** Small form for a shared source and product rules; Warehouse owns all partition discovery. */
export function mountScanBatches(root: HTMLElement, deps: Dependencies) {
  root.innerHTML = `<div class="section-heading"><div><h4>多规则扫描批次</h4><p>一个连接，按产品规则扫描子目录。结果仅代表本次冻结范围。</p></div><button type="button" class="admin-primary" data-batch-create>创建批次</button></div><p data-batch-status role="status"></p><div data-batch-list class="resource-list"></div>`;
  const dialog = document.createElement('dialog');
  dialog.id = 'scan-batch-dialog';
  dialog.className = 'admin-dialog';
  dialog.innerHTML = `<form class="admin-form"><h4>共享来源 · 多规则扫描</h4>
    <label><span>批次名称</span><input name="name" required maxlength="63" pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?" placeholder="euclid-q1-mer-batch" /></label>
    <label><span>Source Connector</span><select name="sourceConnector" required></select></label>
    <label><span>扫描根目录</span><input name="sourcePath" required placeholder="oss://bucket/q1/MER/" /></label>
    <p>系统发现并冻结根目录下的直接子目录（例如 Tile），每条规则在每个子目录内执行。规则可区分 VIS、NISP H/J/Y；不需要分别创建连接。</p>
    <label><span>范围标识 <small>同一图层绑定一个固定范围，不会自动替换已存在的单任务索引</small></span><input name="scopeId" required maxlength="96" pattern="[a-z0-9][a-z0-9-]*" placeholder="euclid-q1-mer" /></label>
    <div class="form-row"><label><span>子目录数量上限</span><input name="maxPartitions" type="number" min="1" max="2048" value="256" required /></label><label><span>同时运行任务数</span><input name="maxConcurrent" type="number" min="1" max="64" value="2" required /></label></div>
    <p>超过子目录上限时发现失败，不会按截断清单开始扫描。完成批次不表示完整 Q1 或整个巡天。</p>
    <div data-batch-rules></div><button type="button" class="admin-quiet" data-batch-add>添加产品规则</button>
    <p data-batch-message class="form-message" role="status"></p>
    <div class="form-row"><button type="button" class="admin-quiet" data-batch-cancel>取消</button><button type="submit" class="admin-primary">提交批次</button></div>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form')!;
  const rules = dialog.querySelector<HTMLElement>('[data-batch-rules]')!;
  const message = dialog.querySelector<HTMLElement>('[data-batch-message]')!;
  const add = dialog.querySelector<HTMLButtonElement>('[data-batch-add]')!;
  let sequence = 0;
  let loading = false;
  const executable = () => deps.products().filter(product => !product.retiredAt && product.draft.layerId && product.draft.coverageRole && product.draft.dataOrigin && product.draft.sourceTier);
  const value = (element: HTMLFormElement | HTMLFieldSetElement, name: string) => (element.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value.trim();
  function addRule() {
    if (rules.children.length >= 32) return;
    const row = document.createElement('fieldset');
    row.className = 'scan-batch-rule';
    row.innerHTML = `<legend>产品规则</legend><label><span>规则名称</span><input name="ruleName" required maxlength="63" pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?" /></label><label><span>产品</span><select name="productId" required></select></label><p data-recipe></p><label><span>扫描解析方式 <small>独立于原有覆盖资料 recipe</small></span><select name="scanMode" required><option value="">选择解析方式</option><option value="fits-wcs">FITS 影像 WCS</option><option value="fits-header-position">FITS 表头位置</option><option value="catalog-radec">星表 RA/Dec 坐标</option><option value="nested-healpix">星表 NESTED HEALPix</option></select></label><div data-rule-radec hidden><div class="form-row"><label><span>RA 列</span><input name="raColumn" disabled /></label><label><span>Dec 列</span><input name="decColumn" disabled /></label></div><div class="form-row"><label><span>FITS 表扩展名 <small>例如 FIBERMAP；与 HDU 编号二选一</small></span><input name="hduName" placeholder="FIBERMAP" disabled /></label><label><span>FITS HDU 编号 <small>从 0 开始</small></span><input name="hduIndex" type="number" min="0" disabled /></label></div><label><span>输入坐标系 <small>FITS 目标表必须显式声明</small></span><select name="coordinateFrame" disabled><option value="">文本星表沿用现有约定</option><option value="ICRS">ICRS</option></select></label></div><div data-rule-healpix hidden><label><span>HEALPix 列</span><input name="healpixColumn" disabled /></label><div class="form-row"><label><span>order 列（与固定 order 二选一）</span><input name="healpixOrderColumn" disabled /></label><label><span>固定 order</span><input name="healpixOrder" type="number" min="1" max="29" disabled /></label></div></div><label><span>Tile 内相对目录 <small>留空表示 Tile 根目录</small></span><input name="relativePrefix" placeholder="VIS/ 或 NIR/" /></label><label><span>文件名匹配 <small>glob，留空匹配所有名称</small></span><input name="includePattern" placeholder="EUC_MER_BGSUB-MOSAIC-VIS_*.fits" maxlength="256" /></label><div class="form-row"><label><span>允许后缀</span><input name="allowedSuffixes" placeholder=".fits" /></label><label><span>输出 order</span><input name="maxOrder" type="number" min="1" max="12" value="8" /></label></div><button type="button" class="admin-quiet" data-rule-remove>移除规则</button>`;
    (row.elements.namedItem('ruleName') as HTMLInputElement).value = `rule-${++sequence}`;
    const select = row.elements.namedItem('productId') as HTMLSelectElement;
    select.replaceChildren(new Option('选择产品', ''), ...executable().map(product => new Option(`${product.draft.surveyId} · ${product.draft.releaseId} · ${product.draft.name}`, product.productId)));
    const scanMode = row.elements.namedItem('scanMode') as HTMLSelectElement;
    const updateMode = () => {
      for (const [selector, enabled] of [['[data-rule-radec]', scanMode.value === 'catalog-radec'], ['[data-rule-healpix]', scanMode.value === 'nested-healpix']] as const) {
        const group = row.querySelector<HTMLElement>(selector)!;
        group.hidden = !enabled;
        group.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach(input => { input.disabled = !enabled; input.required = enabled && ['raColumn', 'decColumn', 'healpixColumn'].includes(input.name); });
      }
      (row.elements.namedItem('maxOrder') as HTMLInputElement).disabled = scanMode.value === 'nested-healpix';
    };
    const requireFitsFrame = () => {
      (row.elements.namedItem('coordinateFrame') as HTMLSelectElement).required = scanMode.value === 'catalog-radec' && Boolean(value(row, 'hduName') || value(row, 'hduIndex'));
    };
    for (const key of ['hduName', 'hduIndex']) row.elements.namedItem(key)!.addEventListener('input', requireFitsFrame);
    scanMode.addEventListener('change', () => { updateMode(); requireFitsFrame(); });
    select.addEventListener('change', () => {
      const product = executable().find(item => item.productId === select.value);
      const defaults = product?.draft.scanDefaults;
      for (const name of ['allowedSuffixes', 'maxOrder', 'raColumn', 'decColumn', 'healpixColumn', 'healpixOrderColumn', 'healpixOrder'] as const) {
        (row.elements.namedItem(name) as HTMLInputElement).value = String(defaults?.[name] ?? (name === 'maxOrder' ? 8 : ''));
      }
      scanMode.value = ['fits-wcs', 'fits-header-position', 'catalog-radec', 'nested-healpix'].includes(product?.draft.mode ?? '') ? product!.draft.mode! : '';
      updateMode();
      row.querySelector('[data-recipe]')!.textContent = product ? `原有覆盖 recipe：${product.draft.mode ?? '未指定'}。请选择本次科学文件的解析方式；光谱目标分布不能用文件表头中心点代替。` : '';
    });
    row.querySelector('[data-rule-remove]')!.addEventListener('click', () => { row.remove(); add.disabled = false; });
    rules.append(row);
    add.disabled = rules.children.length >= 32;
  }
  root.querySelector('[data-batch-create]')!.addEventListener('click', () => {
    const select = form.elements.namedItem('sourceConnector') as HTMLSelectElement;
    const previous = select.value;
    select.replaceChildren(new Option('选择连接', ''), ...deps.connectors().filter(item => ['oss', 's3', 'local'].includes(item.type)).map(item => new Option(item.name, item.name)));
    select.value = previous;
    if (!rules.children.length) addRule();
    dialog.showModal();
  });
  add.addEventListener('click', addRule);
  dialog.querySelector('[data-batch-cancel]')!.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (loading) return;
    message.textContent = '';
    if (!rules.children.length) { message.textContent = '请至少添加一条产品规则。'; return; }
    const input = {
      name: value(form, 'name'), sourceConnector: value(form, 'sourceConnector'), sourcePaths: [value(form, 'sourcePath')],
      partitioning: { mode: 'direct-child-prefixes', scopeId: value(form, 'scopeId'), maxPartitions: Number(value(form, 'maxPartitions')) },
      maxConcurrent: Number(value(form, 'maxConcurrent')),
      rules: [...rules.querySelectorAll('fieldset')].map(row => ({
        name: value(row, 'ruleName'), productId: value(row, 'productId'), scanMode: value(row, 'scanMode'), relativePrefix: value(row, 'relativePrefix'),
        ...Object.fromEntries(['raColumn', 'decColumn', 'healpixColumn', 'healpixOrderColumn', 'healpixOrder', 'hduName', 'hduIndex', 'coordinateFrame'].filter(name => !(row.elements.namedItem(name) as HTMLInputElement).disabled && value(row, name)).map(name => [name, ['healpixOrder', 'hduIndex'].includes(name) ? Number(value(row, name)) : value(row, name)])),
        includePattern: value(row, 'includePattern') || undefined, allowedSuffixes: value(row, 'allowedSuffixes') || undefined,
        ...((row.elements.namedItem('maxOrder') as HTMLInputElement).disabled ? {} : { maxOrder: Number(value(row, 'maxOrder')) }),
      })),
    };
    loading = true;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.disabled = true;
    message.textContent = '正在提交批次…';
    try {
      const { batch } = await deps.api<{ batch: BatchView }>('/api/v1/admin/scan-batches', { method: 'POST', body: JSON.stringify(input) });
      message.textContent = `已提交 ${batch.name}。系统将先冻结扫描范围，再执行任务。`;
      form.reset(); rules.replaceChildren(); add.disabled = false;
      dialog.close();
      await refresh();
    } catch (error) { message.textContent = error instanceof Error ? error.message : '批次提交失败'; }
    finally { loading = false; submit.disabled = false; }
  });
  async function refresh() {
    const status = root.querySelector<HTMLElement>('[data-batch-status]')!;
    try {
      const { batches } = await deps.api<{ batches: BatchView[] }>('/api/v1/admin/scan-batches');
      const list = root.querySelector<HTMLElement>('[data-batch-list]')!;
      const nodes = batches.map(batch => {
        const row = document.createElement('article'); row.className = 'resource-row scan-batch-row';
        const title = document.createElement('strong'); title.textContent = `${batch.name} · ${batch.status?.phase ?? 'PENDING'}`;
        const source = document.createElement('p'); source.textContent = `${batch.sourceConnector ?? ''} · ${batch.sourcePaths?.[0] ?? ''}`;
        const reason = document.createElement('p'); reason.textContent = batch.status?.message ?? batch.status?.reason ?? '';
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = '规则进度与冻结范围';
        const content = document.createElement('div');
        for (const rule of batch.status?.summary?.rules ?? []) {
          const progress = document.createElement('p');
          progress.textContent = `${rule.name ?? '规则'}：完成 ${rule.completedPartitions ?? 0}/${rule.expectedPartitions ?? '?'}，运行 ${rule.runningPartitions ?? 0}，失败 ${rule.failedPartitions ?? 0}；${rule.files ?? 0} 个文件，${rule.coverage ?? 0} 条覆盖关系；实际 order：${rule.availableOrders?.join(', ') || '暂无'}`;
          content.append(progress);
        }
        for (const scope of batch.status?.scope?.rules ?? []) {
          const line = document.createElement('p');
          line.textContent = `${scope.name ?? '规则'} · 范围 ${scope.scopeId ?? '待冻结'} · ${scope.expectedPartitionCount ?? '?'} 个分区`;
          const hash = document.createElement('code'); hash.textContent = scope.scopeSnapshotSha256 ?? '';
          line.append(document.createElement('br'), hash); content.append(line);
        }
        if (!content.children.length) content.textContent = '等待系统冻结范围并生成进度。';
        details.append(summary, content); row.append(title, source, reason, details); return row;
      });
      list.replaceChildren(...nodes);
      status.textContent = batches.length ? `${batches.length} 个批次；完成状态仅针对各自冻结的范围。` : '尚未提交多规则扫描批次。';
    } catch (error) { status.textContent = `批次状态暂不可获取，保留已显示记录：${error instanceof Error ? error.message : '请求失败'}`; }
  }
  return { refresh };
}
