import test from "node:test";
import assert from "node:assert/strict";
import { FileProcessor, formatBytes, processFile } from "./processor.js";

const file = (name, content = "") => ({
  name,
  size: new TextEncoder().encode(content).length,
  text: async () => content,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => queueMicrotask(resolve));

test("text output counts Unicode code points and logical lines, and retains the original", async () => {
  const original = "안녕😀\r\n두 줄\r\n";
  const result = await processFile(file("notes.TXT", original));
  assert.equal(result.filename, "notes.processed.txt");
  assert.equal(result.mimeType, "text/plain;charset=utf-8");
  assert.equal(result.summary, "문자 8개 · 2줄");
  assert.equal(result.content, `파일: notes.TXT\n문자 수: 8\n줄 수: 2\n\n${original}`);
  assert.equal((await processFile(file("empty.txt"))).summary, "문자 0개 · 0줄");
  assert.equal((await processFile(file("one.txt", "one\n"))).summary, "문자 4개 · 1줄");
  assert.equal((await processFile(file("blank.txt", "\n\n"))).summary, "문자 2개 · 2줄");
  assert.equal((await processFile(file("cr.txt", "a\rb"))).summary, "문자 3개 · 2줄");
});

test("JSON output parses and pretty prints the real content with a terminal newline", async () => {
  const source = file("data.JSON", '{"name":"한글","nested":[1,true,null]}');
  const result = await processFile(source);
  assert.equal(result.filename, "data.processed.json");
  assert.equal(result.mimeType, "application/json;charset=utf-8");
  assert.equal(result.content, `${JSON.stringify(JSON.parse(await source.text()), null, 2)}\n`);
  assert.equal(result.summary, "JSON 문법 검증 완료");
  await assert.rejects(processFile(file("bad.json", '{"broken":}')), SyntaxError);
  await assert.rejects(processFile(file("other.csv", "a,b")), TypeError);
  await assert.rejects(processFile(file("bad-read.txt"), async () => 123), TypeError);
});

test("file filtering is case insensitive and identical names receive distinct IDs", () => {
  const engine = new FileProcessor();
  assert.deepEqual(engine.addFiles([
    file("same.txt"), file("same.txt"), file("DATA.JSON"), file("photo.png"), file("notes.txt.exe"),
  ]), { added: 3, rejected: ["photo.png", "notes.txt.exe"] });
  assert.equal(new Set(engine.items.map((item) => item.id)).size, 3);
  assert.ok(engine.items.every((item) => item.selected && item.status === "pending"));
  const lastId = engine.items.at(-1).id;
  engine.reset();
  engine.addFiles([file("same.txt")]);
  assert.notEqual(engine.items[0].id, lastId);
});

test("selected snapshot runs sequentially, excludes unselected rows, and ignores a duplicate start", async () => {
  const firstRead = deferred();
  const secondRead = deferred();
  const calls = [];
  const states = [];
  const engine = new FileProcessor({
    onChange: (state) => states.push(state),
    readFile: (source) => {
      calls.push(source.name);
      return source.name === "first.txt" ? firstRead.promise : secondRead.promise;
    },
  });
  engine.addFiles([file("first.txt"), file("excluded.txt"), file("second.txt")]);
  const [first, excluded, second] = engine.items;
  engine.setSelected(excluded.id, false);
  const running = engine.start();
  assert.deepEqual(calls, ["first.txt"]);
  assert.equal(await engine.start(), false);
  assert.equal(await engine.retryFailed(), false);
  engine.setSelected(second.id, false);
  engine.addFiles([file("added-during-run.txt")]);
  firstRead.resolve("first");
  await tick();
  await tick();
  assert.deepEqual(calls, ["first.txt", "second.txt"]);
  assert.equal(engine.running, true);
  secondRead.resolve("second");
  assert.equal(await running, true);
  assert.deepEqual(engine.items.map((item) => item.status), ["success", "pending", "success", "pending"]);
  assert.deepEqual(engine.progress, { total: 2, completed: 2, succeeded: 2, failed: 0, cancelled: 0 });
  assert.equal(engine.running, false);
  assert.ok(states.some((state) => state.items.find((item) => item.id === first.id)?.status === "running"));
  assert.equal(states.at(-1).running, false);
});

test("a real JSON syntax failure does not stop later files; retry preserves successful results", async () => {
  const sources = [file("before.txt", "before"), file("broken.json", '{"key":}'), file("after.txt", "after")];
  const calls = [];
  let fixed = false;
  const engine = new FileProcessor({ readFile: async (source) => {
    calls.push(source.name);
    return source.name === "broken.json" && fixed ? '{"key":42}' : source.text();
  } });
  engine.addFiles(sources);
  assert.equal(await engine.start(), true);
  assert.deepEqual(engine.items.map((item) => item.status), ["success", "failed", "success"]);
  assert.equal(typeof engine.items[1].error, "string");
  assert.ok(engine.items[1].error.length > 0);
  assert.equal(engine.items[1].result, null);
  assert.deepEqual(engine.progress, { total: 3, completed: 3, succeeded: 2, failed: 1, cancelled: 0 });
  const before = engine.items[0].result;
  const after = engine.items[2].result;
  engine.selectAll(false);
  fixed = true;
  assert.equal(await engine.retryFailed(), true);
  assert.deepEqual(calls, ["before.txt", "broken.json", "after.txt", "broken.json"]);
  assert.deepEqual(engine.items[0].result, before);
  assert.deepEqual(engine.items[2].result, after);
  assert.deepEqual(engine.items.map((item) => item.status), ["success", "success", "success"]);
  assert.equal(engine.items[1].error, null);
  assert.deepEqual(JSON.parse(engine.items[1].result.content), { key: 42 });
  assert.deepEqual(engine.progress, { total: 1, completed: 1, succeeded: 1, failed: 0, cancelled: 0 });
  assert.equal(await engine.retryFailed(), false);
});

test("cancel retains settled rows, cancels running and pending targets, and ignores a late success", async () => {
  const blocked = deferred();
  const calls = [];
  const engine = new FileProcessor({ readFile: (source) => {
    calls.push(source.name);
    return source.name === "blocked.txt" ? blocked.promise : source.text();
  } });
  engine.addFiles([file("settled.txt", "saved"), file("blocked.txt"), file("pending.txt")]);
  const oldRun = engine.start();
  await tick();
  await tick();
  assert.deepEqual(calls, ["settled.txt", "blocked.txt"]);
  const preservedResult = engine.items[0].result;
  assert.equal(engine.cancel(), true);
  assert.equal(engine.running, false);
  assert.deepEqual(engine.items.map((item) => item.status), ["success", "cancelled", "cancelled"]);
  assert.deepEqual(engine.progress, { total: 3, completed: 1, succeeded: 1, failed: 0, cancelled: 2 });
  blocked.resolve("late");
  await oldRun;
  assert.deepEqual(engine.items[0].result, preservedResult);
  assert.ok(engine.items.slice(1).every((item) => item.result === null));
  assert.deepEqual(calls, ["settled.txt", "blocked.txt"]);
});

test("a cancelled run cannot overwrite or unlock a restarted run before its read settles", async () => {
  const oldRead = deferred();
  const newRead = deferred();
  let reads = 0;
  const engine = new FileProcessor({ readFile: () => (++reads === 1 ? oldRead.promise : newRead.promise) });
  engine.addFiles([file("same.txt")]);
  const oldRun = engine.start();
  engine.cancel();
  const newRun = engine.start();
  assert.equal(reads, 2);
  assert.equal(engine.running, true);
  oldRead.resolve("old result");
  await oldRun;
  assert.equal(engine.running, true);
  assert.equal(engine.items[0].status, "running");
  assert.equal(engine.items[0].result, null);
  assert.equal(await engine.start(), false);
  newRead.resolve("new result");
  await newRun;
  assert.equal(engine.running, false);
  assert.equal(engine.items[0].status, "success");
  assert.ok(engine.items[0].result.content.endsWith("new result"));
});

test("reset clears references and progress and ignores a late rejection while a new run is active", async () => {
  const oldRead = deferred();
  const newRead = deferred();
  const engine = new FileProcessor({ readFile: (source) => source.name === "old.txt" ? oldRead.promise : newRead.promise });
  engine.addFiles([file("old.txt")]);
  const oldRun = engine.start();
  engine.reset();
  assert.deepEqual(engine.state, {
    items: [], running: false, progress: { total: 0, completed: 0, succeeded: 0, failed: 0, cancelled: 0 },
  });
  engine.addFiles([file("new.txt")]);
  const newRun = engine.start();
  oldRead.reject(new Error("late old failure"));
  await oldRun;
  assert.equal(engine.running, true);
  assert.equal(engine.items[0].file.name, "new.txt");
  assert.equal(engine.items[0].status, "running");
  assert.equal(engine.items[0].error, null);
  newRead.resolve("fresh");
  await newRun;
  assert.equal(engine.items[0].status, "success");
  assert.deepEqual(engine.progress, { total: 1, completed: 1, succeeded: 1, failed: 0, cancelled: 0 });
});

test("read failures remain plain error text and snapshots cannot mutate queue bookkeeping", async () => {
  const snapshots = [];
  const engine = new FileProcessor({
    onChange: (state) => snapshots.push(state),
    readFile: async () => { throw new Error("<img src=x onerror=alert(1)>"); },
  });
  engine.addFiles([file("failure.txt")]);
  const snapshot = engine.state;
  snapshot.items[0].selected = false;
  snapshot.items.push({});
  snapshot.progress.total = 900;
  assert.equal(engine.items.length, 1);
  assert.equal(engine.items[0].selected, true);
  assert.equal(engine.progress.total, 0);
  await engine.start();
  assert.equal(engine.items[0].error, "<img src=x onerror=alert(1)>");
  assert.equal(engine.items[0].status, "failed");
  assert.equal(snapshots[0].items[0].status, "pending");
  assert.equal(snapshots.at(-1).items[0].status, "failed");
});

test("empty starts are no-ops and byte formatting is bounded", async () => {
  const engine = new FileProcessor();
  assert.equal(await engine.start(), false);
  engine.addFiles([file("unselected.txt")]);
  assert.equal(engine.selectAll(false), true);
  assert.equal(engine.selectAll(false), false);
  assert.equal(engine.setSelected("missing", true), false);
  assert.equal(await engine.start(), false);
  assert.equal(engine.running, false);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(NaN), "0 B");
});
