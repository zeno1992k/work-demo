import { FileProcessor } from './processor.js';

const $ = (id) => document.getElementById(id);
const labels = { pending: '대기', running: '처리 중', success: '성공', failed: '실패', cancelled: '취소' };
const statusClasses = { pending: 'text-bg-secondary', running: 'text-bg-primary', success: 'text-bg-success', failed: 'text-bg-danger', cancelled: 'text-bg-secondary' };
const samples = [
  { name: 'notes.txt', type: 'text/plain' },
  { name: 'valid.json', type: 'application/json' },
  { name: 'invalid.json', type: 'application/json' },
];
let loadingSamples = false;
let previewId = null;
let dragDepth = 0;
let uiExecution = 0;
const rowNodes = new Map();
const downloadUrls = new Map();
const processor = new FileProcessor({ onChange: render });

function bytes(value) {
  if (value < 1024) return `${value} B`;
  const unit = value < 1024 ** 2 ? 'KB' : 'MB';
  return `${(value / (unit === 'KB' ? 1024 : 1024 ** 2)).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} ${unit}`;
}

function notify(message, isError = false) {
  $('notice').textContent = message;
  $('announcer').textContent = message;
  $('notice').className = `alert ${isError ? 'alert-danger' : 'alert-info'} small py-2 mb-3`;
  $('notice').hidden = !message;
}

function addFiles(files) {
  if (processor.running || loadingSamples) return;
  const { added, rejected } = processor.addFiles(files);
  const rejectedMessage = rejected.length ? `지원하지 않는 파일 ${rejected.length}개는 제외했습니다. TXT와 JSON 파일을 선택하세요.` : '';
  notify([added ? `${added}개 파일을 추가했습니다.` : '', rejectedMessage].filter(Boolean).join(' '), Boolean(rejected.length));
}

async function loadSamples() {
  if (processor.running || loadingSamples) return;
  loadingSamples = true;
  notify('샘플 파일을 불러오는 중입니다.');
  render(processor.state);
  try {
    const files = await Promise.all(samples.map(async ({ name, type }) => {
      const response = await fetch(new URL(`./samples/${name}`, import.meta.url));
      if (!response.ok) throw new Error(`샘플을 불러오지 못했습니다 (${response.status}).`);
      return new File([await response.blob()], name, { type });
    }));
    processor.addFiles(files);
    notify('샘플 3개를 추가했습니다. invalid.json에는 실제 구문 오류가 있습니다.');
  } catch (error) {
    notify(`${error.message} 로컬 서버를 실행한 뒤 다시 시도해 주세요.`, true);
  } finally {
    loadingSamples = false;
    render(processor.state);
  }
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createRow(item) {
  const row = node('tr');
  row.dataset.id = item.id;
  const selectCell = node('td', 'checkbox-column');
  const checkbox = node('input', 'form-check-input');
  checkbox.type = 'checkbox';
  checkbox.setAttribute('aria-label', `${item.file.name} 처리 대상으로 선택`);
  checkbox.addEventListener('change', () => processor.setSelected(item.id, checkbox.checked));
  selectCell.append(checkbox);
  const fileCell = node('td', 'file-cell');
  const info = node('div', 'd-flex align-items-center gap-2');
  const isJson = /\.json$/i.test(item.file.name);
  const symbol = node('span', 'badge text-bg-light border', isJson ? 'JSON' : 'TXT');
  symbol.setAttribute('aria-hidden', 'true');
  const meta = node('div', 'file-meta');
  const name = node('span', 'd-block text-break', item.file.name);
  name.title = item.file.name;
  meta.append(name, node('span', 'small text-body-secondary', isJson ? '문법 검증 · 들여쓰기' : '문자 수 · 줄 수'));
  info.append(symbol, meta);
  fileCell.append(info);
  const size = node('td', 'small text-body-secondary text-nowrap', bytes(item.file.size));
  const statusCell = node('td');
  const status = node('span', 'badge');
  statusCell.append(status);
  const resultCell = node('td', 'result-cell small');
  row.append(selectCell, fileCell, size, statusCell, resultCell);
  return { row, checkbox, status, resultCell, content: undefined, error: undefined, previousStatus: undefined };
}

function renderRow(item, busy) {
  let refs = rowNodes.get(item.id);
  if (!refs) {
    refs = createRow(item);
    rowNodes.set(item.id, refs);
    $('file-rows').append(refs.row);
  }
  refs.checkbox.checked = item.selected;
  refs.checkbox.disabled = busy;
  refs.status.textContent = labels[item.status];
  refs.status.className = `badge ${statusClasses[item.status]}`;
  if (refs.content === item.result?.content && refs.error === item.error && refs.previousStatus === item.status) return;
  refs.content = item.result?.content;
  refs.error = item.error;
  refs.previousStatus = item.status;
  refs.resultCell.replaceChildren();
  if (item.result && item.status === 'success') {
    const summary = node('p', 'text-body-secondary mb-1', item.result.summary);
    const actions = node('div', 'd-flex flex-wrap gap-2');
    const preview = node('button', 'btn btn-outline-secondary btn-sm', '미리보기');
    preview.type = 'button';
    preview.setAttribute('aria-label', `${item.file.name} 결과 미리보기`);
    preview.addEventListener('click', () => showPreview(item.id));
    const download = node('button', 'btn btn-outline-secondary btn-sm', '다운로드');
    download.type = 'button';
    download.setAttribute('aria-label', `${item.file.name} 결과 다운로드`);
    download.addEventListener('click', () => downloadResult(item.id));
    actions.append(preview, download);
    refs.resultCell.append(summary, actions);
  } else if (item.status === 'failed') {
    refs.resultCell.append(node('p', 'text-danger text-break mb-0', item.error || '파일 처리에 실패했습니다.'));
  } else {
    refs.resultCell.textContent = item.status === 'running' ? '파일 내용을 읽고 처리하는 중…' : item.status === 'cancelled' ? '결과 반영을 취소했습니다.' : '처리 후 결과가 표시됩니다.';
  }
}

function render(state) {
  const { items, running, progress } = state;
  const activeControl = document.activeElement;
  const busy = running || loadingSamples;
  const selected = items.filter((item) => item.selected).length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const liveIds = new Set(items.map((item) => item.id));
  for (const [id, refs] of rowNodes) {
    if (!liveIds.has(id)) { refs.row.remove(); rowNodes.delete(id); }
  }
  items.forEach((item) => renderRow(item, busy));
  $('item-count').textContent = items.length;
  $('selection-summary').textContent = `선택 ${selected}개 · 전체 ${bytes(items.reduce((total, item) => total + item.file.size, 0))}`;
  $('empty-state').hidden = items.length > 0;
  $('select-all').checked = items.length > 0 && selected === items.length;
  $('select-all').indeterminate = selected > 0 && selected < items.length;
  $('select-all').disabled = !items.length || busy;
  $('choose-files').disabled = busy;
  $('file-input').disabled = busy;
  $('load-samples').disabled = busy;
  $('empty-samples').disabled = busy;
  $('start').disabled = !selected || busy;
  $('start').hidden = running;
  $('retry').disabled = !failed || busy;
  $('retry').textContent = failed ? `실패 ${failed}개 재시도` : '실패 재시도';
  $('cancel').hidden = !running;
  if (running && (activeControl === $('start') || activeControl === $('retry'))) $('cancel').focus();
  if (!running && activeControl === $('cancel')) $('start').focus();
  $('reset').disabled = !items.length || loadingSamples;
  $('reset').textContent = running ? '취소하고 초기화' : '목록 초기화';
  $('drop-zone').classList.toggle('is-busy', busy);
  $('workspace').setAttribute('aria-busy', String(running));
  $('completed-count').textContent = progress.completed;
  $('total-count').textContent = progress.total;
  $('success-count').textContent = progress.succeeded;
  $('failed-count').textContent = progress.failed;
  $('cancelled-count').textContent = progress.cancelled;
  // The metric number updates use a separate child so the unit survives each render.
  ['success-count', 'failed-count', 'cancelled-count'].forEach((id) => $(id).append(node('span', '', '개')));
  const percentage = progress.total ? (progress.completed / progress.total) * 100 : 0;
  $('progress-bar').style.width = `${percentage}%`;
  $('run-progress').setAttribute('aria-valuenow', String(Math.round(percentage)));
  $('run-progress').setAttribute('aria-valuetext', `${progress.total}개 중 ${progress.completed}개 완료, ${progress.cancelled}개 취소`);
  const badge = $('run-badge');
  badge.textContent = running ? '처리 중' : progress.cancelled ? '취소됨' : progress.total ? '완료' : '준비';
  badge.className = `badge ms-2 ${running ? 'text-bg-primary' : progress.total && !progress.cancelled ? 'text-bg-success' : 'text-bg-secondary'}`;
  $('progress-description').textContent = running ? '선택된 파일을 하나씩 처리하고 있습니다.' : progress.cancelled ? `완료 ${progress.completed}개 · 취소 ${progress.cancelled}개. 다시 선택해 처리할 수 있습니다.` : progress.total ? '실행이 끝났습니다. 파일별 결과를 확인하세요.' : '파일을 추가하고 처리할 항목을 선택하세요.';
  if (previewId !== null) {
    const item = items.find((item) => item.id === previewId);
    if (item?.result && item.status === 'success') updatePreview(item);
    else closePreview(false);
  }
}

function updatePreview(item) {
  $('result-title').textContent = item.result.filename;
  $('result-summary').textContent = item.result.summary;
  $('result-content').textContent = item.result.content.slice(0, 20_000);
  $('preview-limit').hidden = item.result.content.length <= 20_000;
  $('result-panel').hidden = false;
}

function showPreview(id) {
  const item = processor.items.find((entry) => entry.id === id);
  if (!item?.result || item.status !== 'success') return;
  previewId = id;
  updatePreview(item);
  $('result-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
  $('close-preview').focus({ preventScroll: true });
}

function closePreview(restoreFocus = true) {
  const oldId = previewId;
  previewId = null;
  $('result-panel').hidden = true;
  $('result-content').textContent = '';
  if (restoreFocus) rowNodes.get(oldId)?.resultCell.querySelector('button')?.focus();
}

function releaseDownloadUrls() {
  for (const [url, timer] of downloadUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
  downloadUrls.clear();
}

function downloadResult(id) {
  const item = processor.items.find((entry) => entry.id === id);
  if (!item?.result || item.status !== 'success') return;
  let url;
  try {
    url = URL.createObjectURL(new Blob([item.result.content], { type: item.result.mimeType }));
    const link = node('a');
    link.href = url;
    link.download = item.result.filename;
    document.body.append(link);
    try { link.click(); } finally { link.remove(); }
    // Let the browser take ownership of the Blob before releasing the URL.
    const timer = setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1_000);
    downloadUrls.set(url, timer);
    notify(`${item.result.filename} 다운로드를 요청했습니다.`);
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    notify(`다운로드를 요청하지 못했습니다: ${error.message}`, true);
  }
}

async function run(retry = false) {
  if (processor.running || loadingSamples) return;
  const execution = ++uiExecution;
  notify('');
  try {
    const accepted = await (retry ? processor.retryFailed() : processor.start());
    if (!accepted || execution !== uiExecution) return;
    const { progress } = processor.state;
    if (progress.total) notify(progress.cancelled ? `실행을 취소했습니다. 완료 ${progress.completed}개, 취소 ${progress.cancelled}개.` : `처리 완료: 성공 ${progress.succeeded}개, 실패 ${progress.failed}개.`, progress.failed > 0 && !progress.cancelled);
  } catch (error) {
    if (execution !== uiExecution) return;
    notify(`실행하지 못했습니다: ${error.message}`, true);
  }
}

$('choose-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => { addFiles(event.target.files); event.target.value = ''; });
$('load-samples').addEventListener('click', loadSamples);
$('empty-samples').addEventListener('click', loadSamples);
$('select-all').addEventListener('change', (event) => processor.selectAll(event.target.checked));
$('start').addEventListener('click', () => run());
$('retry').addEventListener('click', () => run(true));
$('cancel').addEventListener('click', () => { uiExecution += 1; processor.cancel(); notify('실행을 취소했습니다. 이미 완료된 결과는 유지됩니다.'); $('start').focus(); });
$('reset').addEventListener('click', () => { uiExecution += 1; processor.reset(); releaseDownloadUrls(); closePreview(false); notify('목록과 처리 결과를 초기화했습니다.'); $('choose-files').focus(); });
$('close-preview').addEventListener('click', () => closePreview());
$('preview-download').addEventListener('click', () => downloadResult(previewId));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && previewId !== null) closePreview(); });
const dropZone = $('drop-zone');
dropZone.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth += 1; if (!processor.running && !loadingSamples) dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = processor.running || loadingSamples ? 'none' : 'copy'; });
dropZone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; dropZone.classList.remove('drag-over'); addFiles(event.dataTransfer.files); });
// Prevent a dropped file outside the input area from navigating away from the demo.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
window.addEventListener('pagehide', releaseDownloadUrls);
render(processor.state);
