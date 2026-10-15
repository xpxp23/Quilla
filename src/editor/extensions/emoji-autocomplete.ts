import { autocompletion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

export interface EmojiEntry {
  name: string;
  emoji: string;
  keywords?: string[];
}

export const EMOJI_LIST: EmojiEntry[] = [
  // 表情与情绪
  { name: "smile", emoji: "😄", keywords: ["happy", "joy", "laugh"] },
  { name: "smiley", emoji: "😃", keywords: ["happy", "joy"] },
  { name: "grinning", emoji: "😀", keywords: ["smile"] },
  { name: "blush", emoji: "😊", keywords: ["proud", "smile"] },
  { name: "wink", emoji: "😉", keywords: ["flirt"] },
  { name: "heart_eyes", emoji: "😍", keywords: ["love", "crush"] },
  { name: "kissing_heart", emoji: "😘", keywords: ["love"] },
  { name: "kissing", emoji: "😗" },
  { name: "relaxed", emoji: "☺️" },
  { name: "yum", emoji: "😋", keywords: ["tongue", "delicious"] },
  { name: "stuck_out_tongue", emoji: "😛" },
  { name: "stuck_out_tongue_winking_eye", emoji: "😜" },
  { name: "sunglasses", emoji: "😎", keywords: ["cool"] },
  { name: "smirk", emoji: "😏" },
  { name: "neutral_face", emoji: "😐" },
  { name: "expressionless", emoji: "😑" },
  { name: "unamused", emoji: "😒" },
  { name: "sweat", emoji: "😓" },
  { name: "pensive", emoji: "😔" },
  { name: "confused", emoji: "😕" },
  { name: "confounded", emoji: "😖" },
  { name: "disappointed", emoji: "😞" },
  { name: "worried", emoji: "😟" },
  { name: "angry", emoji: "😠", keywords: ["mad"] },
  { name: "rage", emoji: "😡", keywords: ["furious"] },
  { name: "cry", emoji: "😢", keywords: ["sad", "tear"] },
  { name: "sob", emoji: "😭", keywords: ["crying", "tears"] },
  { name: "joy", emoji: "😂", keywords: ["tears of joy", "lol"] },
  { name: "rofl", emoji: "🤣", keywords: ["rolling on floor laughing"] },
  { name: "scream", emoji: "😱", keywords: ["horror", "shocked"] },
  { name: "flushed", emoji: "😳" },
  { name: "sleeping", emoji: "😴", keywords: ["tired", "zzz"] },
  { name: "mask", emoji: "😷", keywords: ["sick"] },
  { name: "innocent", emoji: "😇", keywords: ["angel"] },
  { name: "thinking", emoji: "🤔", keywords: ["hmmm", "wonder"] },
  { name: "hugs", emoji: "🤗" },
  { name: "shrug", emoji: "🤷" },
  { name: "facepalm", emoji: "🤦" },
  { name: "clown_face", emoji: "🤡" },
  { name: "skull", emoji: "💀", keywords: ["dead"] },
  { name: "poop", emoji: "💩" },
  { name: "ghost", emoji: "👻" },
  { name: "alien", emoji: "👽" },
  { name: "robot", emoji: "🤖" },

  // 手势与身体
  { name: "+1", emoji: "👍", keywords: ["thumbsup", "approve", "yes", "like"] },
  { name: "thumbsup", emoji: "👍", keywords: ["approve", "yes", "like"] },
  { name: "-1", emoji: "👎", keywords: ["thumbsdown", "disapprove", "no"] },
  { name: "thumbsdown", emoji: "👎", keywords: ["disapprove", "no"] },
  { name: "ok_hand", emoji: "👌", keywords: ["fine"] },
  { name: "punch", emoji: "👊" },
  { name: "fist", emoji: "✊" },
  { name: "v", emoji: "✌️", keywords: ["peace", "victory"] },
  { name: "wave", emoji: "👋", keywords: ["hello", "bye"] },
  { name: "handshake", emoji: "🤝", keywords: ["deal"] },
  { name: "clap", emoji: "👏", keywords: ["applause", "praise"] },
  { name: "muscle", emoji: "💪", keywords: ["strong", "flex"] },
  { name: "pray", emoji: "🙏", keywords: ["please", "thank you", "hope"] },
  { name: "point_up", emoji: "☝️" },
  { name: "point_down", emoji: "👇" },
  { name: "point_left", emoji: "👈" },
  { name: "point_right", emoji: "👉" },
  { name: "eyes", emoji: "👀", keywords: ["look", "see"] },

  // 爱心与符号
  { name: "heart", emoji: "❤️", keywords: ["love"] },
  { name: "broken_heart", emoji: "💔" },
  { name: "sparkling_heart", emoji: "💖" },
  { name: "fire", emoji: "🔥", keywords: ["hot", "lit", "popular"] },
  { name: "sparkles", emoji: "✨", keywords: ["magic", "stars", "clean", "shine"] },
  { name: "star", emoji: "⭐", keywords: ["favorite"] },
  { name: "star2", emoji: "🌟" },
  { name: "dizzy", emoji: "💫" },
  { name: "boom", emoji: "💥", keywords: ["explosion"] },
  { name: "zap", emoji: "⚡", keywords: ["lightning", "thunder"] },
  { name: "sun", emoji: "☀️", keywords: ["sunny", "weather"] },
  { name: "moon", emoji: "🌙" },
  { name: "cloud", emoji: "☁️" },
  { name: "rain_cloud", emoji: "🌧️" },
  { name: "rainbow", emoji: "🌈" },

  // 效率、开发与工作工具
  { name: "rocket", emoji: "🚀", keywords: ["launch", "ship", "speed", "fast"] },
  { name: "tada", emoji: "🎉", keywords: ["celebrate", "party", "hooray"] },
  { name: "bulb", emoji: "💡", keywords: ["idea", "light"] },
  { name: "memo", emoji: "📝", keywords: ["document", "note"] },
  { name: "pencil", emoji: "✏️" },
  { name: "book", emoji: "📖" },
  { name: "books", emoji: "📚", keywords: ["library", "reading"] },
  { name: "computer", emoji: "💻", keywords: ["laptop", "code"] },
  { name: "desktop_computer", emoji: "🖥️" },
  { name: "phone", emoji: "📱" },
  { name: "keyboard", emoji: "⌨️" },
  { name: "gear", emoji: "⚙️", keywords: ["settings", "config"] },
  { name: "wrench", emoji: "🔧", keywords: ["tool", "fix"] },
  { name: "hammer", emoji: "🔨" },
  { name: "bug", emoji: "🐛", keywords: ["error", "defect", "fix"] },
  { name: "package", emoji: "📦", keywords: ["box", "cargo"] },
  { name: "lock", emoji: "🔒", keywords: ["secure", "password"] },
  { name: "unlock", emoji: "🔓" },
  { name: "key", emoji: "🔑" },
  { name: "bell", emoji: "🔔", keywords: ["notification"] },
  { name: "link", emoji: "🔗", keywords: ["url"] },
  { name: "chart_with_upwards_trend", emoji: "📈", keywords: ["analytics"] },
  { name: "calendar", emoji: "📅", keywords: ["date", "schedule"] },
  { name: "clipboard", emoji: "📋" },
  { name: "folder", emoji: "📁" },
  { name: "file_folder", emoji: "📂" },

  // 状态指示与徽标
  { name: "white_check_mark", emoji: "✅", keywords: ["check", "done", "pass", "success", "ok"] },
  { name: "check", emoji: "✓", keywords: ["done", "ok"] },
  { name: "x", emoji: "❌", keywords: ["cross", "fail", "no", "error"] },
  { name: "warning", emoji: "⚠️", keywords: ["alert", "caution"] },
  { name: "question", emoji: "❓", keywords: ["help"] },
  { name: "grey_question", emoji: "❔" },
  { name: "bangbang", emoji: "‼️" },
  { name: "exclamation", emoji: "❗" },
  { name: "info", emoji: "ℹ️", keywords: ["information"] },
  { name: "no_entry", emoji: "⛔", keywords: ["forbidden"] },
  { name: "recycle", emoji: "♻️" },
  { name: "arrow_right", emoji: "➡️" },
  { name: "arrow_left", emoji: "⬅️" },
  { name: "arrow_up", emoji: "⬆️" },
  { name: "arrow_down", emoji: "⬇️" },

  // 食物、动植物与生活
  { name: "coffee", emoji: "☕", keywords: ["cafe", "tea"] },
  { name: "tea", emoji: "🍵" },
  { name: "beer", emoji: "🍺" },
  { name: "pizza", emoji: "🍕" },
  { name: "apple", emoji: "🍎" },
  { name: "dog", emoji: "🐶", keywords: ["puppy"] },
  { name: "cat", emoji: "🐱", keywords: ["kitty"] },
  { name: "snake", emoji: "🐍", keywords: ["python"] },
  { name: "crab", emoji: "🦀", keywords: ["rust"] },
  { name: "four_leaf_clover", emoji: "🍀", keywords: ["luck"] },
  { name: "seedling", emoji: "🌱", keywords: ["new", "plant"] },
  { name: "cherry_blossom", emoji: "🌸", keywords: ["flower"] },
  { name: "art", emoji: "🎨", keywords: ["design", "paint"] },
  { name: "guitar", emoji: "🎸", keywords: ["music"] },
  { name: "trophy", emoji: "🏆", keywords: ["win", "prize"] },
  { name: "medal", emoji: "🏅" },
  { name: "moneybag", emoji: "💰" },
];

/**
 * 监听以冒号开头的简码，例如 `:sm`, `:fire`, `:+1`, 并在输入时提示候选
 */
export function emojiCompletionSource(context: CompletionContext): CompletionResult | null {
  // 匹配行内光标前紧挨着的 :shortcode (以非空白字符为界，或者行首/空格后的冒号)
  const token = context.matchBefore(/(?:^|\s):[a-zA-Z0-9_+-]*/);
  if (!token) return null;

  // 计算冒号的准确位置
  const colonIndex = token.text.indexOf(":");
  if (colonIndex === -1) return null;
  const startPos = token.from + colonIndex;
  const query = token.text.slice(colonIndex + 1).toLowerCase();

  const filtered = EMOJI_LIST.filter((entry) => {
    if (!query) return true; // 输入单个 ":" 时提供完整热门推荐
    if (entry.name.toLowerCase().includes(query)) return true;
    if (entry.keywords && entry.keywords.some((k) => k.toLowerCase().includes(query))) return true;
    return false;
  }).slice(0, 30);

  if (filtered.length === 0) return null;

  return {
    from: startPos,
    to: context.pos,
    options: filtered.map((item) => ({
      label: `:${item.name}:`,
      displayLabel: `${item.emoji}  :${item.name}:`,
      detail: item.emoji,
      apply: (view, _completion, from, to) => {
        // 直接原地替换为 Unicode 表情字符并移动光标
        view.dispatch({
          changes: { from, to, insert: item.emoji },
          selection: { anchor: from + item.emoji.length },
        });
      },
      boost: item.name.startsWith(query) ? 99 : 50,
    })),
    filter: false, // 已经自己做过严密的多关键词过滤
  };
}

/**
 * 导出即用的 Emoji 补全扩展插件
 */
export const emojiAutocompletion = autocompletion({
  override: [emojiCompletionSource],
  activateOnTyping: true,
  maxRenderedOptions: 15,
  defaultKeymap: true,
});
