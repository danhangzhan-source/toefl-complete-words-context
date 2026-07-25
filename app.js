const STORAGE_KEY = "toefl-complete-words-multibook-state-v1";
const HISTORY_KEY = "toefl-complete-words-multibook-history-v1";
const LEGACY_STORAGE_KEY = "toefl-complete-words-state-v1";
const LEGACY_HISTORY_KEY = "toefl-complete-words-history-v1";
const DB_NAME = "toefl-complete-words-books";
const DB_STORE = "books";

let catalog = [];
let localBooks = [];
let words = [];
let activeBook = null;
let answerGroups = new Map();
let session = null;
let current = 0;

const els = {
  setupForm: document.querySelector("#setupForm"),
  bookSelect: document.querySelector("#bookSelect"),
  startIndex: document.querySelector("#startIndex"),
  endIndex: document.querySelector("#endIndex"),
  hintMode: document.querySelector("#hintMode"),
  wordTotal: document.querySelector("#wordTotal"),
  resumeBtn: document.querySelector("#resumeBtn"),
  finishBtn: document.querySelector("#finishBtn"),
  emptyState: document.querySelector("#emptyState"),
  quizCard: document.querySelector("#quizCard"),
  promptText: document.querySelector("#promptText"),
  hintText: document.querySelector("#hintText"),
  answerForm: document.querySelector("#answerForm"),
  answerInput: document.querySelector("#answerInput"),
  feedback: document.querySelector("#feedback"),
  prevBtn: document.querySelector("#prevBtn"),
  nextBtn: document.querySelector("#nextBtn"),
  showAnswerBtn: document.querySelector("#showAnswerBtn"),
  rangeLabel: document.querySelector("#rangeLabel"),
  progressLabel: document.querySelector("#progressLabel"),
  doneStat: document.querySelector("#doneStat"),
  correctStat: document.querySelector("#correctStat"),
  accuracyStat: document.querySelector("#accuracyStat"),
  answerGrid: document.querySelector("#answerGrid"),
  sheetSummary: document.querySelector("#sheetSummary"),
  historyList: document.querySelector("#historyList"),
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
  importBtn: document.querySelector("#importBtn"),
  bookFile: document.querySelector("#bookFile"),
  importStatus: document.querySelector("#importStatus"),
  localBookList: document.querySelector("#localBookList"),
};

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function migrateLegacyRecords() {
  const defaultBook = catalog[0];
  if (!localStorage.getItem(HISTORY_KEY)) {
    const legacyHistory = readJson(LEGACY_HISTORY_KEY, []);
    if (legacyHistory.length) {
      writeJson(
        HISTORY_KEY,
        legacyHistory.map((item) => ({
          ...item,
          bookId: defaultBook.id,
          bookTitle: defaultBook.title,
          end: item.end || item.start + item.count - 1,
        })),
      );
    }
  }
  if (!localStorage.getItem(STORAGE_KEY)) {
    const legacyState = readJson(LEGACY_STORAGE_KEY, null);
    if (legacyState?.session?.items?.length) {
      const migratedSession = {
        ...legacyState.session,
        bookId: defaultBook.id,
        bookTitle: defaultBook.title,
        end:
          legacyState.session.end ||
          legacyState.session.start + legacyState.session.count - 1,
      };
      writeJson(STORAGE_KEY, {
        session: migratedSession,
        current: legacyState.current || 0,
      });
    }
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openBookDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) {
        request.result.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbRequest(mode, operation) {
  const db = await openBookDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, mode);
    const store = transaction.objectStore(DB_STORE);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

function listLocalBooks() {
  return dbRequest("readonly", (store) => store.getAll());
}

function saveLocalBook(book) {
  return dbRequest("readwrite", (store) => store.put(book));
}

function deleteLocalBook(id) {
  return dbRequest("readwrite", (store) => store.delete(id));
}

function normalizeAnswer(value) {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

function revealCount(word) {
  const letterCount = Array.from(word).filter((character) => /[A-Za-z]/.test(character)).length;
  return Math.max(1, Math.floor(letterCount / 2));
}

function makePrompt(word) {
  const visibleLetters = revealCount(word);
  let visibleCount = 0;
  let boundary = 0;
  for (const character of word) {
    boundary += character.length;
    if (/[A-Za-z]/.test(character)) visibleCount += 1;
    if (visibleCount === visibleLetters) break;
  }
  const prefix = word.slice(0, boundary);
  const hidden = word.slice(boundary);
  const blankCount = Array.from(hidden).filter((character) => /[A-Za-z]/.test(character)).length;
  return {
    prefix,
    hidden,
    blankCount,
    key: `${normalizeAnswer(prefix)}|${visibleLetters + blankCount}`,
  };
}

function targetWord(item) {
  return item.targetForm || item.word;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildAnswerGroups() {
  answerGroups = new Map();
  words.forEach((item) => {
    const answer = targetWord(item);
    const prompt = makePrompt(answer);
    const list = answerGroups.get(prompt.key) || [];
    list.push(answer);
    answerGroups.set(prompt.key, Array.from(new Set(list)));
  });
}

function getAnswers(item) {
  const answer = targetWord(item);
  return answerGroups.get(makePrompt(answer).key) || [answer];
}

function createSession(start, end, hintMode) {
  const safeStart = Math.min(Math.max(1, start), words.length);
  const safeEnd = Math.min(Math.max(safeStart, end), words.length);
  const selected = words.slice(safeStart - 1, safeEnd);
  return {
    startedAt: new Date().toISOString(),
    bookId: activeBook.id,
    bookTitle: activeBook.title,
    start: safeStart,
    end: safeEnd,
    count: selected.length,
    hintMode,
    items: shuffle(selected).map((word) => ({
      wordId: word.id,
      answer: "",
      status: "blank",
      revealed: false,
      checkedAt: null,
    })),
  };
}

function saveSession() {
  if (session) writeJson(STORAGE_KEY, { session, current });
}

async function loadSession() {
  const saved = readJson(STORAGE_KEY, null);
  if (!saved?.session?.items?.length) return false;
  try {
    await selectBook(saved.session.bookId, false);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    els.importStatus.className = "import-status error";
    els.importStatus.textContent = "上次使用的词汇书已不存在，无法继续。";
    render();
    return false;
  }
  session = saved.session;
  current = Math.min(saved.current || 0, session.items.length - 1);
  els.bookSelect.value = session.bookId;
  els.startIndex.value = session.start;
  els.endIndex.value = session.end;
  els.hintMode.value = session.hintMode;
  render();
  return true;
}

function wordById(id) {
  return words.find((word) => String(word.id) === String(id));
}

function activeItem() {
  return session ? session.items[current] : null;
}

function activeWord() {
  const item = activeItem();
  return item ? wordById(item.wordId) : null;
}

function checkAnswer(input, word) {
  const value = normalizeAnswer(input);
  const fullAnswers = getAnswers(word).map(normalizeAnswer);
  const suffixAnswers = getAnswers(word).map((answer) => normalizeAnswer(makePrompt(answer).hidden));
  return fullAnswers.includes(value) || suffixAnswers.includes(value);
}

function answerForDisplay(answer, word) {
  const prompt = makePrompt(targetWord(word));
  const value = normalizeAnswer(answer);
  const prefix = normalizeAnswer(prompt.prefix);
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function submitAnswer() {
  const item = activeItem();
  const word = activeWord();
  if (!item || !word || !els.answerInput.value.trim()) return;
  item.answer = els.answerInput.value.trim();
  item.status = checkAnswer(item.answer, word) ? "correct" : "wrong";
  item.checkedAt = new Date().toISOString();
  item.revealed = false;
  saveSession();
  render();
}

function showAnswer() {
  const item = activeItem();
  if (!item) return;
  item.revealed = true;
  item.status = item.status === "blank" ? "revealed" : item.status;
  saveSession();
  render();
}

function readHistory() {
  return readJson(HISTORY_KEY, []);
}

function finishSession() {
  if (!session) return;
  const done = session.items.filter((item) => item.status !== "blank").length;
  const correct = session.items.filter((item) => item.status === "correct").length;
  const record = {
    finishedAt: new Date().toISOString(),
    bookId: session.bookId,
    bookTitle: session.bookTitle,
    start: session.start,
    end: session.end,
    count: session.count,
    done,
    correct,
    accuracy: done ? Math.round((correct / done) * 100) : 0,
  };
  const history = readHistory();
  history.unshift(record);
  writeJson(HISTORY_KEY, history.slice(0, 50));
  localStorage.removeItem(STORAGE_KEY);
  session = null;
  current = 0;
  renderHistory();
  render();
}

function renderHistory() {
  const history = readHistory();
  if (!history.length) {
    els.historyList.innerHTML = '<div class="history-item"><small>暂无记录</small></div>';
    return;
  }
  els.historyList.innerHTML = history
    .map((item) => {
      const date = new Date(item.finishedAt).toLocaleString("zh-CN", { hour12: false });
      return `<div class="history-item">
        <strong>${item.correct}/${item.done} 正确 · ${item.accuracy}%</strong>
        <small>${escapeHtml(item.bookTitle || "词汇书")} · 序号 ${item.start}-${item.end}</small>
        <small>${date}</small>
      </div>`;
    })
    .join("");
}

function renderPrompt(word) {
  const answer = targetWord(word);
  const prompt = makePrompt(answer);
  const item = activeItem();
  const suffix = answerForDisplay(item?.answer || "", word).slice(0, prompt.blankCount);
  const sentence = word.exampleEn || answer;
  const fallbackIndex = sentence.toLowerCase().indexOf(answer.toLowerCase());
  const targetIndex =
    Number.isInteger(word.targetIndex) && word.targetIndex >= 0 ? word.targetIndex : fallbackIndex;
  const before = targetIndex >= 0 ? sentence.slice(0, targetIndex) : "";
  const after = targetIndex >= 0 ? sentence.slice(targetIndex + answer.length) : "";

  els.promptText.textContent = "";
  els.promptText.append(document.createTextNode(before));
  const cloze = document.createElement("span");
  cloze.className = "word-cloze";
  const prefix = document.createElement("span");
  prefix.textContent = prompt.prefix;
  cloze.append(prefix);

  let slotIndex = 0;
  for (const character of prompt.hidden) {
    if (!/[A-Za-z]/.test(character)) {
      cloze.append(document.createTextNode(character));
      continue;
    }
    const letter = suffix[slotIndex] || "";
    const slot = document.createElement("span");
    slot.className = [
      "slot",
      letter ? "filled" : "",
      slotIndex === suffix.length && suffix.length < prompt.blankCount ? "active" : "",
    ]
      .filter(Boolean)
      .join(" ");
    slot.textContent = letter || "_";
    cloze.append(slot);
    slotIndex += 1;
  }
  els.promptText.append(cloze, document.createTextNode(after));
  els.answerInput.maxLength = prompt.blankCount;
}

function renderHint(word) {
  if (!session || session.hintMode === "none") {
    els.hintText.textContent = "";
    return;
  }
  const parts = [];
  if ((session.hintMode === "cn" || session.hintMode === "both") && word.cn) parts.push(word.cn);
  if ((session.hintMode === "en" || session.hintMode === "both") && word.en) parts.push(word.en);
  els.hintText.textContent = parts.join(" | ");
}

function renderFeedback(item, word) {
  els.feedback.className = "feedback";
  if (!item || item.status === "blank") {
    els.feedback.textContent = "";
    return;
  }
  const answers = getAnswers(word).join(" / ");
  if (item.revealed || item.status === "revealed") {
    els.feedback.textContent = `答案：${answers}`;
  } else if (item.status === "correct") {
    els.feedback.classList.add("good");
    els.feedback.textContent = "正确";
  } else {
    els.feedback.classList.add("bad");
    els.feedback.textContent = `未答对。正确答案：${answers}`;
  }
}

function renderAnswerGrid() {
  if (!session) {
    els.answerGrid.innerHTML = "";
    els.sheetSummary.textContent = "0 题";
    return;
  }
  els.sheetSummary.textContent = `${session.items.length} 题`;
  els.answerGrid.innerHTML = session.items
    .map((item, index) => {
      const classes = [index === current ? "current" : "", item.status].filter(Boolean).join(" ");
      return `<button type="button" class="${classes}" data-index="${index}">${index + 1}</button>`;
    })
    .join("");
}

function renderStats() {
  const items = session?.items || [];
  const done = items.filter((item) => item.status !== "blank").length;
  const correct = items.filter((item) => item.status === "correct").length;
  els.doneStat.textContent = done;
  els.correctStat.textContent = correct;
  els.accuracyStat.textContent = done ? `${Math.round((correct / done) * 100)}%` : "0%";
}

function render() {
  const hasSession = Boolean(session);
  els.emptyState.classList.toggle("hidden", hasSession);
  els.quizCard.classList.toggle("hidden", !hasSession);
  els.finishBtn.disabled = !hasSession;
  els.resumeBtn.disabled = !localStorage.getItem(STORAGE_KEY);
  renderStats();
  renderAnswerGrid();
  renderHistory();

  if (!session) {
    els.rangeLabel.textContent = activeBook
      ? `${activeBook.title} · 请选择练习范围`
      : "请选择词汇书和练习范围";
    els.progressLabel.textContent = "未开始";
    return;
  }

  const item = activeItem();
  const word = activeWord();
  if (!item || !word) {
    els.rangeLabel.textContent = "题目加载失败";
    return;
  }
  els.rangeLabel.textContent = `${session.bookTitle} · 序号 ${session.start}-${session.end} · 乱序练习`;
  els.progressLabel.textContent = `第 ${current + 1} / ${session.items.length} 题`;
  els.answerInput.value = item.answer || "";
  els.prevBtn.disabled = current === 0;
  els.nextBtn.disabled = current === session.items.length - 1;
  renderPrompt(word);
  renderHint(word);
  renderFeedback(item, word);
  window.setTimeout(() => els.answerInput.focus(), 0);
}

function bookMeta(id) {
  return [...catalog, ...localBooks].find((book) => book.id === id);
}

async function loadBook(meta) {
  if (meta.items) return meta.items;
  const response = await fetch(`./${meta.file}`);
  if (!response.ok) throw new Error(`无法读取词汇书：${meta.title}`);
  return response.json();
}

async function selectBook(id, resetRange = true) {
  const meta = bookMeta(id);
  if (!meta) throw new Error("词汇书不存在。");
  activeBook = meta;
  words = await loadBook(meta);
  buildAnswerGroups();
  els.bookSelect.value = id;
  els.wordTotal.textContent = `${words.length} 词`;
  els.startIndex.max = words.length;
  els.endIndex.max = words.length;
  if (resetRange) {
    els.startIndex.value = 1;
    els.endIndex.value = Math.min(100, words.length);
  }
  render();
}

function renderBookOptions(selectedId) {
  const options = [
    ...catalog.map(
      (book) =>
        `<option value="${escapeHtml(book.id)}">${escapeHtml(book.title)}（${book.count}词）</option>`,
    ),
    ...localBooks.map(
      (book) =>
        `<option value="${escapeHtml(book.id)}">${escapeHtml(book.title)}（本机 · ${book.count}词）</option>`,
    ),
  ];
  els.bookSelect.innerHTML = options.join("");
  if (selectedId && bookMeta(selectedId)) els.bookSelect.value = selectedId;
}

function renderLocalBooks() {
  if (!localBooks.length) {
    els.localBookList.innerHTML = "";
    return;
  }
  els.localBookList.innerHTML = localBooks
    .map(
      (book) => `<div class="local-book-item">
        <span title="${escapeHtml(book.title)}">${escapeHtml(book.title)} · ${book.count}词</span>
        <button type="button" data-delete-book="${escapeHtml(book.id)}">删除</button>
      </div>`,
    )
    .join("");
}

async function importBook(file) {
  els.importStatus.className = "import-status";
  els.importStatus.textContent = "正在读取并检查词汇书…";
  try {
    const book = await window.VocabularyBookImporter.importVocabularyBook(file);
    await saveLocalBook(book);
    localBooks = await listLocalBooks();
    renderBookOptions(book.id);
    renderLocalBooks();
    await selectBook(book.id);
    els.importStatus.className = "import-status success";
    els.importStatus.textContent = `已导入 ${book.count} 词${
      book.skipped ? `，另有 ${book.skipped} 行因例句不匹配而跳过` : ""
    }。仅保存在这台设备的浏览器中。`;
  } catch (error) {
    els.importStatus.className = "import-status error";
    els.importStatus.textContent = error.message || "导入失败，请检查文件格式。";
  } finally {
    els.bookFile.value = "";
  }
}

async function init() {
  const response = await fetch("./books.json");
  if (!response.ok) throw new Error("词汇书目录加载失败。");
  catalog = await response.json();
  migrateLegacyRecords();
  try {
    localBooks = await listLocalBooks();
  } catch {
    localBooks = [];
    els.importStatus.textContent = "当前浏览器不支持保存导入的词汇书。";
  }
  renderBookOptions();
  renderLocalBooks();
  renderHistory();
  await selectBook(catalog[0].id);
}

els.setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  session = createSession(
    Number(els.startIndex.value),
    Number(els.endIndex.value),
    els.hintMode.value,
  );
  current = 0;
  saveSession();
  render();
});

els.bookSelect.addEventListener("change", async () => {
  await selectBook(els.bookSelect.value);
});
els.startIndex.addEventListener("change", () => {
  if (Number(els.endIndex.value) < Number(els.startIndex.value)) {
    els.endIndex.value = els.startIndex.value;
  }
});
els.resumeBtn.addEventListener("click", loadSession);
els.answerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAnswer();
});
els.answerInput.addEventListener("input", () => {
  const item = activeItem();
  const word = activeWord();
  if (!item || !word) return;
  const prompt = makePrompt(targetWord(word));
  item.answer = answerForDisplay(els.answerInput.value, word).slice(0, prompt.blankCount);
  els.answerInput.value = item.answer;
  if (item.status !== "blank") {
    item.status = "blank";
    item.revealed = false;
  }
  saveSession();
  renderPrompt(word);
});
els.promptText.addEventListener("click", () => els.answerInput.focus());
els.promptText.addEventListener("keydown", (event) => {
  els.answerInput.focus();
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    els.answerInput.value += event.key;
    els.answerInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
els.prevBtn.addEventListener("click", () => {
  current = Math.max(0, current - 1);
  saveSession();
  render();
});
els.nextBtn.addEventListener("click", () => {
  current = Math.min(session.items.length - 1, current + 1);
  saveSession();
  render();
});
els.showAnswerBtn.addEventListener("click", showAnswer);
els.finishBtn.addEventListener("click", finishSession);
els.clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});
els.answerGrid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-index]");
  if (!button) return;
  current = Number(button.dataset.index);
  saveSession();
  render();
});
els.importBtn.addEventListener("click", () => els.bookFile.click());
els.bookFile.addEventListener("change", () => {
  const file = els.bookFile.files?.[0];
  if (file) importBook(file);
});
els.localBookList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-delete-book]");
  if (!button) return;
  const id = button.dataset.deleteBook;
  await deleteLocalBook(id);
  localBooks = await listLocalBooks();
  renderBookOptions();
  renderLocalBooks();
  if (activeBook?.id === id) await selectBook(catalog[0].id);
  if (readJson(STORAGE_KEY, null)?.session?.bookId === id) localStorage.removeItem(STORAGE_KEY);
  els.importStatus.className = "import-status";
  els.importStatus.textContent = "已删除本机导入的词汇书。";
});

init().catch((error) => {
  els.wordTotal.textContent = "加载失败";
  els.emptyState.innerHTML = `<h2>题库加载失败</h2><p>${escapeHtml(error.message)}</p>`;
});
