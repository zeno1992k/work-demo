const defaultReadFile = (file) => file.text();
const supportedExtension = /\.(txt|json)$/i;

/** Read a real file and produce a new downloadable result without changing it. */
export async function processFile(file, readFile = defaultReadFile) {
  const match = typeof file?.name === "string" && file.name.match(supportedExtension);
  if (!match) {
    throw new TypeError("텍스트(.txt) 또는 JSON(.json) 파일만 처리할 수 있습니다.");
  }

  const content = await readFile(file);
  if (typeof content !== "string") {
    throw new TypeError("파일을 읽은 결과가 문자열이 아닙니다.");
  }

  const extension = match[1].toLowerCase();
  const baseName = file.name.slice(0, -match[0].length);
  if (extension === "json") {
    const parsed = JSON.parse(content);
    return {
      filename: `${baseName}.processed.json`,
      mimeType: "application/json;charset=utf-8",
      content: `${JSON.stringify(parsed, null, 2)}\n`,
      summary: "JSON 문법 검증 완료",
    };
  }

  // Normalize line endings only for counting; the output retains the original text.
  const countedContent = content.replace(/\r\n?/g, "\n");
  const characterCount = [...countedContent].length;
  const lineCount = countedContent === ""
    ? 0
    : countedContent.split("\n").length - Number(countedContent.endsWith("\n"));
  return {
    filename: `${baseName}.processed.txt`,
    mimeType: "text/plain;charset=utf-8",
    content: `파일: ${file.name}\n문자 수: ${characterCount}\n줄 수: ${lineCount}\n\n${content}`,
    summary: `문자 ${characterCount}개 · ${lineCount}줄`,
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const amount = bytes / (1024 ** exponent);
  return `${exponent === 0 ? Math.round(amount) : Number(amount.toFixed(1))} ${units[exponent]}`;
}

const emptyProgress = () => ({ total: 0, completed: 0, succeeded: 0, failed: 0, cancelled: 0 });
const copyItem = (item) => ({ ...item, result: item.result ? { ...item.result } : null });

/** Sequential queue with generation guards for reads that cannot be aborted. */
export class FileProcessor {
  #items = [];
  #running = false;
  #progress = emptyProgress();
  #generation = 0;
  #nextId = 1;
  #activeRun = null;
  #onChange;
  #readFile;

  constructor({ onChange = () => {}, readFile = defaultReadFile } = {}) {
    if (typeof onChange !== "function" || typeof readFile !== "function") {
      throw new TypeError("onChange와 readFile은 함수여야 합니다.");
    }
    this.#onChange = onChange;
    this.#readFile = readFile;
  }

  // Rows and results are copies, so an observer cannot change queue bookkeeping.
  get items() { return this.#items.map(copyItem); }
  get running() { return this.#running; }
  get progress() { return { ...this.#progress }; }
  get state() {
    return { items: this.items, running: this.running, progress: this.progress };
  }

  addFiles(files) {
    const rejected = [];
    let added = 0;
    for (const file of files) {
      const name = typeof file?.name === "string" ? file.name : "이름 없는 파일";
      if (!supportedExtension.test(name)) {
        rejected.push(name);
        continue;
      }
      this.#items.push({
        id: `file-${this.#nextId++}`,
        file,
        selected: true,
        status: "pending",
        result: null,
        error: null,
      });
      added += 1;
    }
    if (added > 0) this.#emit();
    return { added, rejected };
  }

  setSelected(id, selected) {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item || item.selected === Boolean(selected)) return false;
    item.selected = Boolean(selected);
    this.#emit();
    return true;
  }

  selectAll(selected) {
    const value = Boolean(selected);
    let changed = false;
    for (const item of this.#items) {
      if (item.selected !== value) {
        item.selected = value;
        changed = true;
      }
    }
    if (changed) this.#emit();
    return changed;
  }

  async start() {
    if (this.#running) return false;
    return this.#run(this.#items.filter((item) => item.selected));
  }

  async retryFailed() {
    if (this.#running) return false;
    return this.#run(this.#items.filter((item) => item.status === "failed"));
  }

  cancel() {
    const wasRunning = this.#running;
    this.#invalidate();
    if (wasRunning) this.#emit();
    return wasRunning;
  }

  reset() {
    this.#invalidate();
    this.#items = [];
    this.#progress = emptyProgress();
    this.#emit();
  }

  #emit() {
    this.#onChange(this.state);
  }

  #updateProgress(targets) {
    const progress = { ...emptyProgress(), total: targets.length };
    for (const item of targets) {
      if (item.status === "success") progress.succeeded += 1;
      if (item.status === "failed") progress.failed += 1;
      if (item.status === "cancelled") progress.cancelled += 1;
    }
    progress.completed = progress.succeeded + progress.failed;
    this.#progress = progress;
  }

  #invalidate() {
    this.#generation += 1;
    if (this.#activeRun) {
      for (const item of this.#activeRun.targets) {
        if (item.status === "pending" || item.status === "running") {
          item.status = "cancelled";
          item.result = null;
          item.error = null;
        }
      }
      this.#updateProgress(this.#activeRun.targets);
    }
    this.#running = false;
    this.#activeRun = null;
  }

  #isCurrent(run) {
    return this.#activeRun === run && this.#generation === run.generation;
  }

  async #run(targets) {
    if (targets.length === 0) return false;
    const run = { generation: ++this.#generation, targets };
    this.#activeRun = run;
    this.#running = true;
    for (const item of targets) {
      item.status = "pending";
      item.result = null;
      item.error = null;
    }
    this.#updateProgress(targets);
    this.#emit();

    try {
      for (const item of targets) {
        if (!this.#isCurrent(run)) break;
        item.status = "running";
        this.#emit();
        if (!this.#isCurrent(run)) break;
        try {
          const result = await processFile(item.file, this.#readFile);
          if (!this.#isCurrent(run)) break;
          item.result = result;
          item.status = "success";
        } catch (error) {
          if (!this.#isCurrent(run)) break;
          item.status = "failed";
          item.error = error instanceof Error ? error.message : String(error);
        }
        this.#updateProgress(targets);
        this.#emit();
      }
    } finally {
      // An old promise must never unlock or publish state for a newer run.
      if (this.#isCurrent(run)) {
        this.#running = false;
        this.#activeRun = null;
        this.#emit();
      }
    }
    return true;
  }
}
