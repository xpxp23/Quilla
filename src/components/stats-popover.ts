import { EditorView } from "@codemirror/view";

export interface DetailedStats {
  charsTotal: number;
  charsNoSpaces: number;
  chineseChars: number;
  englishWords: number;
  lines: number;
  paragraphs: number;
  readingTimeMin: number;
}

export function computeDetailedStats(text: string): DetailedStats {
  const charsTotal = text.length;
  const charsNoSpaces = text.replace(/\s/g, "").length;

  // 匹配中文字符 (CJK)
  const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g);
  const chineseChars = cjkMatches ? cjkMatches.length : 0;

  // 匹配非中文单词
  const nonCjkText = text.replace(/[\u4e00-\u9fa5\u3040-\u30ff]/g, " ");
  const wordMatches = nonCjkText.trim().match(/[a-zA-Z0-9_\-]+/g);
  const englishWords = wordMatches ? wordMatches.length : 0;

  // 行数与非空自然段落数
  const lineArray = text.split("\n");
  const lines = lineArray.length;
  const paragraphs = lineArray.filter((l) => l.trim().length > 0).length;

  // 阅读时间估算：中文 350 字/分，英文 200 词/分
  const totalMinutes = chineseChars / 350 + englishWords / 200;
  const readingTimeMin = Math.max(1, Math.round(totalMinutes));

  return {
    charsTotal,
    charsNoSpaces,
    chineseChars,
    englishWords,
    lines,
    paragraphs,
    readingTimeMin,
  };
}

export function initStatsPopover(view: EditorView) {
  const popover = document.createElement("div");
  popover.className = "ty-stats-popover hidden";
  popover.innerHTML = `
    <div class="ty-stats-popover-title">
      <span>📊 文档字数与阅读统计</span>
    </div>
    <div class="ty-stats-row"><span>总字符数 (含空格)</span><span class="stats-val" id="st-chars-total">0</span></div>
    <div class="ty-stats-row"><span>字符数 (不含空格)</span><span class="stats-val" id="st-chars-no-spaces">0</span></div>
    <div class="ty-stats-row"><span>中文字符数</span><span class="stats-val" id="st-chinese-chars">0</span></div>
    <div class="ty-stats-row"><span>英文词数</span><span class="stats-val" id="st-english-words">0</span></div>
    <div class="ty-stats-row"><span>总行数</span><span class="stats-val" id="st-lines">0</span></div>
    <div class="ty-stats-row"><span>有效段落数</span><span class="stats-val" id="st-paragraphs">0</span></div>
    <div class="ty-stats-row highlight"><span>⏱️ 预计阅读时间</span><span class="stats-val" id="st-reading-time">约 1 分钟</span></div>
  `;
  document.body.appendChild(popover);

  const wordCountBtn = document.getElementById("footer-word-count");
  const charCountBtn = document.getElementById("footer-char-count");

  function togglePopover(anchorElem: HTMLElement) {
    if (!popover.classList.contains("hidden")) {
      popover.classList.add("hidden");
      return;
    }

    const text = view.state.doc.toString();
    const stats = computeDetailedStats(text);

    (popover.querySelector("#st-chars-total") as HTMLElement).textContent = String(stats.charsTotal);
    (popover.querySelector("#st-chars-no-spaces") as HTMLElement).textContent = String(stats.charsNoSpaces);
    (popover.querySelector("#st-chinese-chars") as HTMLElement).textContent = String(stats.chineseChars);
    (popover.querySelector("#st-english-words") as HTMLElement).textContent = String(stats.englishWords);
    (popover.querySelector("#st-lines") as HTMLElement).textContent = String(stats.lines);
    (popover.querySelector("#st-paragraphs") as HTMLElement).textContent = String(stats.paragraphs);
    (popover.querySelector("#st-reading-time") as HTMLElement).textContent = `约 ${stats.readingTimeMin} 分钟`;

    const rect = anchorElem.getBoundingClientRect();
    popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    popover.style.right = `${window.innerWidth - rect.right}px`;
    popover.classList.remove("hidden");
  }

  wordCountBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover(wordCountBtn);
  });

  charCountBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover(charCountBtn);
  });

  window.addEventListener("click", (e) => {
    if (!popover.contains(e.target as Node)) {
      popover.classList.add("hidden");
    }
  });
}
