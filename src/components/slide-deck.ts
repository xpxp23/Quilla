import { EditorView } from "@codemirror/view";
import katex from "katex";
import mermaid from "mermaid";
import { renderMarkdownDocumentToHtml } from "../editor/markdown-ast-renderer";
import { themeLoader } from "../themes/theme-loader";

export type SlideSplitStrategy = "hr-or-heading" | "heading-only";
export type SlideAspectRatio = "16:9" | "4:3" | "fluid";

export interface SlideItem {
  index: number;
  title: string;
  markdown: string;
  speakerNotes: string[];
  isCover: boolean;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 将当前 Markdown 文档按 `---` 分割线（自动跳过 YAML Frontmatter 与围栏代码块）
 * 或按 `# H1` / `## H2` 章节切分为幻灯片序列，并提取演讲者备注 (`<!-- note: ... -->` 或 `> [!NOTE] 演讲备注`)。
 */
export function parseMarkdownIntoSlides(
  rawDoc: string,
  strategy: SlideSplitStrategy = "hr-or-heading",
  fallbackTitle: string = "羽墨演示文稿"
): SlideItem[] {
  const normalized = rawDoc.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let startLine = 0;
  let frontmatterTitle = "";
  let frontmatterAuthor = "";

  // 解析顶部 YAML Frontmatter
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < Math.min(lines.length, 40); i++) {
      if (lines[i].trim() === "---" || lines[i].trim() === "...") {
        for (let j = 1; j < i; j++) {
          const tMatch = lines[j].match(/^title\s*:\s*(.+)$/i);
          if (tMatch) frontmatterTitle = tMatch[1].trim().replace(/^['"]|['"]$/g, "");
          const aMatch = lines[j].match(/^author\s*:\s*(.+)$/i);
          if (aMatch) frontmatterAuthor = aMatch[1].trim().replace(/^['"]|['"]$/g, "");
        }
        startLine = i + 1;
        break;
      }
    }
  }

  // 检测正文是否包含显式 `---` 水平分割线
  let hasExplicitHr = false;
  let scanFence = false;
  for (let i = startLine; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(l)) {
      scanFence = !scanFence;
      continue;
    }
    if (!scanFence && /^\s*(?:-\s*){3,}\s*$/.test(l)) {
      const prevLine = i > startLine ? lines[i - 1] : "";
      if (!prevLine.includes("|")) {
        hasExplicitHr = true;
        break;
      }
    }
  }

  const rawChunks: string[][] = [];
  let curChunk: string[] = [];
  let inFence = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      curChunk.push(line);
      continue;
    }

    if (!inFence) {
      const isHr =
        /^\s*(?:-\s*){3,}\s*$/.test(line) &&
        !(i > startLine && lines[i - 1].includes("|"));
      const isMajorHeading = /^#{1,2}\s+.+/.test(line);

      if (strategy === "hr-or-heading" && hasExplicitHr && isHr) {
        if (curChunk.some((l) => l.trim().length > 0)) {
          rawChunks.push(curChunk);
        }
        curChunk = [];
        continue;
      } else if ((!hasExplicitHr || strategy === "heading-only") && isMajorHeading) {
        if (curChunk.some((l) => l.trim().length > 0)) {
          rawChunks.push(curChunk);
        }
        curChunk = [line];
        continue;
      }
    }

    curChunk.push(line);
  }
  if (curChunk.some((l) => l.trim().length > 0)) {
    rawChunks.push(curChunk);
  }

  if (rawChunks.length === 0) {
    rawChunks.push([`# ${frontmatterTitle || fallbackTitle}`, frontmatterAuthor ? `\n> ${frontmatterAuthor}` : ""]);
  }

  return rawChunks.map((chunkLines, idx) => {
    const speakerNotes: string[] = [];
    const slideLines: string[] = [];
    let slideTitle = "";

    let inHtmlNote = false;
    let htmlNoteBuf: string[] = [];

    for (const line of chunkLines) {
      // 提取单行或多行 <!-- note: ... --> 演讲者备注
      const singleNote = line.match(/^\s*<!--\s*notes?\s*:\s*([\s\S]*?)-->\s*$/i);
      if (singleNote) {
        speakerNotes.push(singleNote[1].trim());
        continue;
      }
      const openNote = line.match(/^\s*<!--\s*notes?\s*:\s*(.*)$/i);
      if (openNote && !line.includes("-->")) {
        inHtmlNote = true;
        if (openNote[1].trim()) htmlNoteBuf.push(openNote[1].trim());
        continue;
      }
      if (inHtmlNote) {
        const closeIdx = line.indexOf("-->");
        if (closeIdx !== -1) {
          const before = line.slice(0, closeIdx).trim();
          if (before) htmlNoteBuf.push(before);
          speakerNotes.push(htmlNoteBuf.join("\n"));
          htmlNoteBuf = [];
          inHtmlNote = false;
        } else {
          htmlNoteBuf.push(line);
        }
        continue;
      }

      if (!slideTitle) {
        const hMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
        if (hMatch) {
          slideTitle = hMatch[1].trim();
        }
      }
      slideLines.push(line);
    }

    if (!slideTitle) {
      slideTitle =
        idx === 0 && frontmatterTitle
          ? frontmatterTitle
          : `第 ${idx + 1} 页`;
    }

    return {
      index: idx,
      title: slideTitle,
      markdown: slideLines.join("\n").trim(),
      speakerNotes,
      isCover: idx === 0 && /^#\s+/.test(slideLines.find((l) => l.trim().length > 0) || ""),
    };
  });
}

let slideDeckOverlayEl: HTMLElement | null = null;
let slideDeckAbort: AbortController | null = null;
let laserAnimId: number | null = null;
let timerIntervalId: any = null;

export function openSlideDeckMode(options: {
  view: EditorView | null;
  activeTitle: string;
}) {
  if (slideDeckAbort) {
    slideDeckAbort.abort();
    slideDeckAbort = null;
  }
  if (laserAnimId !== null) {
    cancelAnimationFrame(laserAnimId);
    laserAnimId = null;
  }
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }

  slideDeckAbort = new AbortController();
  const signal = slideDeckAbort.signal;

  if (!slideDeckOverlayEl) {
    slideDeckOverlayEl = document.createElement("div");
    slideDeckOverlayEl.id = "quilla-slide-deck-overlay";
    slideDeckOverlayEl.className = "slide-deck-overlay";
    document.body.appendChild(slideDeckOverlayEl);
  }

  const rawDoc = options.view?.state.doc.toString() || "";
  let splitStrategy: SlideSplitStrategy = "hr-or-heading";
  let aspectRatio: SlideAspectRatio = "16:9";
  let slides = parseMarkdownIntoSlides(rawDoc, splitStrategy, options.activeTitle);
  let currentIndex = 0;
  let isNotesOpen = false;
  let isGridOpen = false;
  let isLaserActive = false;
  let elapsedSeconds = 0;

  // 若光标位于某章节，自动定位到对应幻灯片页
  if (options.view) {
    const cursorLine = options.view.state.doc.lineAt(
      options.view.state.selection.main.head
    ).number;
    const prefixText = options.view.state.doc
      .sliceString(0, options.view.state.doc.line(cursorLine).to);
    const prefixSlides = parseMarkdownIntoSlides(prefixText, splitStrategy, options.activeTitle);
    currentIndex = Math.max(0, Math.min(slides.length - 1, prefixSlides.length - 1));
  }

  slideDeckOverlayEl.classList.remove("hidden");

  const formatTimer = (sec: number): string => {
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${m}:${s}`;
  };

  const renderSlideHtmlWithMathAndMermaid = async (container: HTMLElement, md: string) => {
    container.innerHTML = await renderMarkdownDocumentToHtml(md);

    // 渲染行内与块级 KaTeX 公式
    container.querySelectorAll(".math-inline, .math-block").forEach((el) => {
      const tex = el.textContent || "";
      const displayMode = el.classList.contains("math-block");
      try {
        katex.render(tex, el as HTMLElement, {
          displayMode,
          throwOnError: false,
        });
      } catch {
        // ignore
      }
    });

    // 渲染 Mermaid 图表
    const mermaidPres = container.querySelectorAll("pre.md-mermaid-source");
    for (let i = 0; i < mermaidPres.length; i++) {
      const pre = mermaidPres[i] as HTMLElement;
      const code = pre.textContent || "";
      if (!code.trim()) continue;
      try {
        const id = `slide-mermaid-${Date.now()}-${i}`;
        const { svg } = await mermaid.render(id, code);
        const card = document.createElement("div");
        card.className = "md-mermaid-card";
        card.innerHTML = svg;
        pre.replaceWith(card);
      } catch {
        // ignore
      }
    }
  };

  // 朱砂红激光笔轨迹点
  const laserTrail: Array<{ x: number; y: number; alpha: number }> = [];
  let laserHead: { x: number; y: number } | null = null;

  const startLaserLoop = () => {
    const canvas = slideDeckOverlayEl?.querySelector(
      "#slide-laser-canvas"
    ) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resizeCanvas();

    const tick = () => {
      if (!isLaserActive) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 绘制渐变尾迹
      for (let i = laserTrail.length - 1; i >= 0; i--) {
        const pt = laserTrail[i];
        pt.alpha -= 0.045;
        if (pt.alpha <= 0) {
          laserTrail.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4.5 * pt.alpha, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(195, 68, 53, ${pt.alpha * 0.55})`;
        ctx.fill();
      }

      if (laserHead) {
        ctx.beginPath();
        ctx.arc(laserHead.x, laserHead.y, 11, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(195, 68, 53, 0.24)";
        ctx.fill();

        ctx.beginPath();
        ctx.arc(laserHead.x, laserHead.y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = "#e03e2d";
        ctx.shadowColor = "#c34435";
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      laserAnimId = requestAnimationFrame(tick);
    };
    laserAnimId = requestAnimationFrame(tick);
  };

  const closeSlideDeck = () => {
    isLaserActive = false;
    if (laserAnimId !== null) {
      cancelAnimationFrame(laserAnimId);
      laserAnimId = null;
    }
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    slideDeckOverlayEl?.classList.add("hidden");
    slideDeckAbort?.abort();
  };

  const renderDeck = () => {
    if (!slideDeckOverlayEl) return;
    const curSlide = slides[currentIndex] || slides[0];
    const nextSlide = slides[currentIndex + 1] || null;
    const progressPct =
      slides.length > 1 ? Math.round(((currentIndex + 1) / slides.length) * 100) : 100;
    const curTheme = themeLoader.getTheme();

    slideDeckOverlayEl.innerHTML = `
      <div class="slide-deck-shell aspect-${aspectRatio.replace(":", "-")}">
        <!-- 顶部进度细线 -->
        <div class="slide-progress-track">
          <div class="slide-progress-fill" style="width: ${progressPct}%"></div>
        </div>

        <!-- 顶部演示控制栏 -->
        <header class="slide-deck-topbar">
          <div class="slide-deck-brand">
            <span class="slide-deck-seal">羽墨演示</span>
            <span class="slide-deck-doc-title">${escapeHtml(options.activeTitle)}</span>
            <span class="slide-deck-chapter-pill">${escapeHtml(curSlide.title)}</span>
          </div>

          <div class="slide-deck-controls">
            <div class="slide-seg-group" title="切换幻灯片切分方式">
              <button type="button" class="slide-ctrl-btn ${splitStrategy === "hr-or-heading" ? "active" : ""}" data-split="hr-or-heading">按 --- 分页</button>
              <button type="button" class="slide-ctrl-btn ${splitStrategy === "heading-only" ? "active" : ""}" data-split="heading-only">按章节分页</button>
            </div>

            <div class="slide-seg-group" title="画幅比例">
              <button type="button" class="slide-ctrl-btn ${aspectRatio === "16:9" ? "active" : ""}" data-aspect="16:9">16:9</button>
              <button type="button" class="slide-ctrl-btn ${aspectRatio === "4:3" ? "active" : ""}" data-aspect="4:3">4:3</button>
              <button type="button" class="slide-ctrl-btn ${aspectRatio === "fluid" ? "active" : ""}" data-aspect="fluid">全宽</button>
            </div>

            <div class="slide-seg-group" title="墨观演示主题秒切">
              <button type="button" class="slide-ctrl-btn ${curTheme === "paper" ? "active" : ""}" data-theme="paper">宣纸</button>
              <button type="button" class="slide-ctrl-btn ${curTheme === "ink" ? "active" : ""}" data-theme="ink">玄墨</button>
              <button type="button" class="slide-ctrl-btn ${curTheme === "celadon" ? "active" : ""}" data-theme="celadon">青瓷</button>
              <button type="button" class="slide-ctrl-btn ${curTheme === "sea" ? "active" : ""}" data-theme="sea">沧海</button>
            </div>

            <button type="button" class="slide-ctrl-btn ${isLaserActive ? "active laser-on" : ""}" id="slide-laser-btn" title="朱砂激光笔 (快捷键 L)">● 激光笔 (L)</button>
            <button type="button" class="slide-ctrl-btn ${isNotesOpen ? "active" : ""}" id="slide-notes-btn" title="演讲者备注与计时器 (快捷键 N)">演讲备注 (N)</button>
            <button type="button" class="slide-ctrl-btn ${isGridOpen ? "active" : ""}" id="slide-grid-btn" title="幻灯片总览网格 (快捷键 G)">总览 (${slides.length})</button>
            <button type="button" class="slide-ctrl-btn" id="slide-fullscreen-btn" title="切换系统全屏 (快捷键 F)">全屏 (F)</button>
            <button type="button" class="slide-close-btn" id="slide-exit-btn" title="退出演示 (Esc)">退出 Esc</button>
          </div>
        </header>

        <!-- 主舞台与演讲者侧栏 -->
        <div class="slide-deck-stage-wrap">
          <div class="slide-stage-Viewport" id="slide-stage-viewport">
            <article class="slide-card-frame ${curSlide.isCover ? "is-cover-slide" : ""}" id="slide-card-frame">
              <div class="slide-card-inner" id="slide-card-inner"></div>
              <footer class="slide-card-footer">
                <span class="slide-footer-brand">Quilla · 羽墨</span>
                <span class="slide-footer-page">${currentIndex + 1} / ${slides.length}</span>
              </footer>
            </article>
          </div>

          ${
            isNotesOpen
              ? `<aside class="slide-speaker-drawer">
                  <div class="speaker-timer-card">
                    <span class="speaker-timer-label">演讲计时</span>
                    <strong class="speaker-timer-clock" id="speaker-timer-clock">${formatTimer(elapsedSeconds)}</strong>
                    <button type="button" class="sync-mini-btn" id="speaker-timer-reset-btn">重置</button>
                  </div>
                  <div class="speaker-notes-section">
                    <div class="speaker-section-title">当前页演讲备注</div>
                    <div class="speaker-notes-body">
                      ${
                        curSlide.speakerNotes.length > 0
                          ? curSlide.speakerNotes
                              .map((n) => `<p>${escapeHtml(n)}</p>`)
                              .join("")
                          : `<p class="speaker-empty-hint">在文档中写入 <code>&lt;!-- note: 演讲要点 --&gt;</code> 即可在此处仅对演讲者展示提词备注。</p>`
                      }
                    </div>
                  </div>
                  <div class="speaker-next-section">
                    <div class="speaker-section-title">下一页预告</div>
                    <div class="speaker-next-preview">
                      ${
                        nextSlide
                          ? `<strong>${escapeHtml(nextSlide.title)}</strong><p>${escapeHtml(nextSlide.markdown.slice(0, 140))}</p>`
                          : `<span>已是最后一页幻灯片</span>`
                      }
                    </div>
                  </div>
                </aside>`
              : ""
          }
        </div>

        <!-- 底部翻页导航条 -->
        <footer class="slide-deck-bottombar">
          <button type="button" class="slide-nav-btn" id="slide-prev-btn" ${currentIndex === 0 ? "disabled" : ""}>← 上一页 (PgUp)</button>
          <div class="slide-dots-strip">
            ${slides
              .map(
                (s, idx) =>
                  `<button type="button" class="slide-dot-indicator ${idx === currentIndex ? "active" : ""}" data-slide-idx="${idx}" title="${idx + 1}. ${escapeHtml(s.title)}"></button>`
              )
              .join("")}
          </div>
          <button type="button" class="slide-nav-btn" id="slide-next-btn" ${currentIndex >= slides.length - 1 ? "disabled" : ""}>下一页 (Space / →) →</button>
        </footer>

        <!-- 幻灯片缩略总览网格 (G) -->
        ${
          isGridOpen
            ? `<div class="slide-overview-grid-modal" id="slide-overview-grid-modal">
                <div class="slide-overview-grid">
                  ${slides
                    .map(
                      (s, idx) => `
                    <div class="slide-overview-card ${idx === currentIndex ? "active" : ""}" data-jump-idx="${idx}">
                      <div class="slide-overview-num">P${idx + 1}</div>
                      <div class="slide-overview-title">${escapeHtml(s.title)}</div>
                      <div class="slide-overview-excerpt">${escapeHtml(s.markdown.replace(/^[#\s>-]+/gm, "").slice(0, 110))}</div>
                    </div>`
                    )
                    .join("")}
                </div>
              </div>`
            : ""
        }

        <!-- 激光笔全屏透明绘制层 -->
        <canvas id="slide-laser-canvas" class="slide-laser-canvas ${isLaserActive ? "active" : ""}"></canvas>
      </div>
    `;

    const slideInner = slideDeckOverlayEl.querySelector("#slide-card-inner") as HTMLElement | null;
    if (slideInner) {
      renderSlideHtmlWithMathAndMermaid(slideInner, curSlide.markdown);
    }

    bindDeckControls();
    if (isLaserActive) {
      startLaserLoop();
    }
  };

  const goPrev = () => {
    if (currentIndex > 0) {
      currentIndex--;
      renderDeck();
    }
  };

  const goNext = () => {
    if (currentIndex < slides.length - 1) {
      currentIndex++;
      renderDeck();
    }
  };

  const bindDeckControls = () => {
    if (!slideDeckOverlayEl) return;

    slideDeckOverlayEl.querySelector("#slide-prev-btn")?.addEventListener("click", goPrev);
    slideDeckOverlayEl.querySelector("#slide-next-btn")?.addEventListener("click", goNext);
    slideDeckOverlayEl.querySelector("#slide-exit-btn")?.addEventListener("click", closeSlideDeck);

    slideDeckOverlayEl.querySelectorAll("[data-slide-idx]").forEach((dot) => {
      dot.addEventListener("click", () => {
        currentIndex = Number((dot as HTMLElement).dataset.slideIdx || "0");
        renderDeck();
      });
    });

    slideDeckOverlayEl.querySelectorAll("[data-jump-idx]").forEach((card) => {
      card.addEventListener("click", () => {
        currentIndex = Number((card as HTMLElement).dataset.jumpIdx || "0");
        isGridOpen = false;
        renderDeck();
      });
    });

    slideDeckOverlayEl.querySelectorAll("[data-split]").forEach((btn) => {
      btn.addEventListener("click", () => {
        splitStrategy = (btn as HTMLElement).dataset.split as SlideSplitStrategy;
        slides = parseMarkdownIntoSlides(rawDoc, splitStrategy, options.activeTitle);
        currentIndex = Math.min(currentIndex, Math.max(0, slides.length - 1));
        renderDeck();
      });
    });

    slideDeckOverlayEl.querySelectorAll("[data-aspect]").forEach((btn) => {
      btn.addEventListener("click", () => {
        aspectRatio = (btn as HTMLElement).dataset.aspect as SlideAspectRatio;
        renderDeck();
      });
    });

    slideDeckOverlayEl.querySelectorAll("[data-theme]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = (btn as HTMLElement).dataset.theme;
        if (t) {
          themeLoader.setTheme(t);
          renderDeck();
        }
      });
    });

    slideDeckOverlayEl.querySelector("#slide-laser-btn")?.addEventListener("click", () => {
      isLaserActive = !isLaserActive;
      renderDeck();
    });

    slideDeckOverlayEl.querySelector("#slide-notes-btn")?.addEventListener("click", () => {
      isNotesOpen = !isNotesOpen;
      renderDeck();
    });

    slideDeckOverlayEl.querySelector("#slide-grid-btn")?.addEventListener("click", () => {
      isGridOpen = !isGridOpen;
      renderDeck();
    });

    slideDeckOverlayEl.querySelector("#slide-fullscreen-btn")?.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        slideDeckOverlayEl?.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    slideDeckOverlayEl.querySelector("#speaker-timer-reset-btn")?.addEventListener("click", () => {
      elapsedSeconds = 0;
      const clock = slideDeckOverlayEl?.querySelector("#speaker-timer-clock");
      if (clock) clock.textContent = "00:00";
    });
  };

  // 启动计时器
  timerIntervalId = setInterval(() => {
    elapsedSeconds++;
    const clock = slideDeckOverlayEl?.querySelector("#speaker-timer-clock");
    if (clock) {
      clock.textContent = formatTimer(elapsedSeconds);
    }
  }, 1000);

  // 全局鼠标激光笔追踪与键盘快捷键
  window.addEventListener(
    "mousemove",
    (e) => {
      if (!isLaserActive) return;
      laserHead = { x: e.clientX, y: e.clientY };
      laserTrail.push({ x: e.clientX, y: e.clientY, alpha: 1 });
      if (laserTrail.length > 28) laserTrail.shift();
    },
    { signal }
  );

  window.addEventListener(
    "keydown",
    (e) => {
      if (slideDeckOverlayEl?.classList.contains("hidden")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (isGridOpen) {
          isGridOpen = false;
          renderDeck();
        } else {
          closeSlideDeck();
        }
      } else if (
        e.key === "ArrowRight" ||
        e.key === "PageDown" ||
        (e.key === " " && !e.shiftKey)
      ) {
        e.preventDefault();
        goNext();
      } else if (
        e.key === "ArrowLeft" ||
        e.key === "PageUp" ||
        (e.key === " " && e.shiftKey)
      ) {
        e.preventDefault();
        goPrev();
      } else if (e.key === "Home") {
        e.preventDefault();
        currentIndex = 0;
        renderDeck();
      } else if (e.key === "End") {
        e.preventDefault();
        currentIndex = slides.length - 1;
        renderDeck();
      } else if (e.key.toLowerCase() === "l" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        isLaserActive = !isLaserActive;
        renderDeck();
      } else if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        isNotesOpen = !isNotesOpen;
        renderDeck();
      } else if (e.key.toLowerCase() === "g" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        isGridOpen = !isGridOpen;
        renderDeck();
      } else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (!document.fullscreenElement) {
          slideDeckOverlayEl?.requestFullscreen?.().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      }
    },
    { signal }
  );

  renderDeck();
}
