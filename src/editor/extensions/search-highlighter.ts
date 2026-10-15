import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export interface SearchMatchRange {
  from: number;
  to: number;
}

export interface SearchMatchesState {
  matches: SearchMatchRange[];
  currentIndex: number;
}

export const setSearchMatchesEffect = StateEffect.define<SearchMatchesState | null>();
export const setSearchHighlightEffect = StateEffect.define<SearchMatchRange | null>();

const searchMatchMark = Decoration.mark({
  class: "cm-search-match",
});

const searchCurrentMatchMark = Decoration.mark({
  class: "cm-search-match cm-search-match-selected",
});

const searchPulseMark = Decoration.mark({
  class: "cm-search-match-pulse",
});

export const searchHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchMatchesEffect)) {
        if (!e.value || e.value.matches.length === 0) {
          return Decoration.none;
        }
        const { matches, currentIndex } = e.value;
        const docLen = tr.state.doc.length;

        // CodeMirror Decoration.set 要求 ranges 按 from 升序且无重叠
        const validMatches = matches
          .map((m, idx) => ({ from: m.from, to: m.to, isCurrent: idx === currentIndex }))
          .filter((m) => m.from >= 0 && m.from < m.to && m.to <= docLen)
          .sort((a, b) => a.from - b.from);

        if (validMatches.length === 0) {
          return Decoration.none;
        }

        const ranges = validMatches.map((m) =>
          (m.isCurrent ? searchCurrentMatchMark : searchMatchMark).range(m.from, m.to)
        );
        return Decoration.set(ranges, true);
      }
      if (e.is(setSearchHighlightEffect)) {
        if (!e.value) {
          return Decoration.none;
        }
        if (e.value.from < e.value.to && e.value.to <= tr.state.doc.length) {
          return Decoration.set([searchPulseMark.range(e.value.from, e.value.to)]);
        }
        return Decoration.none;
      }
    }
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * 在指定编辑器中定位关键词并播放脉冲高亮动效
 */
export function pulseSearchMatch(view: EditorView, lineNum: number, keyword: string) {
  try {
    const doc = view.state.doc;
    if (lineNum < 1 || lineNum > doc.lines) return;

    const line = doc.line(lineNum);
    const lineText = line.text;
    const idx = lineText.toLowerCase().indexOf(keyword.toLowerCase());

    const from = idx !== -1 ? line.from + idx : line.from;
    const to = idx !== -1 ? from + keyword.length : line.to;

    // 选中匹配词 + 视口平滑居中滚动
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: [
        setSearchHighlightEffect.of({ from, to }),
        EditorView.scrollIntoView(from, { y: "center" }),
      ],
    });

    view.focus();

    // 1.8 秒后淡出高亮
    setTimeout(() => {
      view.dispatch({
        effects: [setSearchHighlightEffect.of(null)],
      });
    }, 1800);
  } catch (err) {
    console.error("定位搜索高亮失败:", err);
  }
}
