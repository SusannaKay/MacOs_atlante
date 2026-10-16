// Editor delle note (CodeMirror 6) con completamento di [[link]] e #tag.
import { EditorState } from "@codemirror/state";
import {
  EditorView, keymap, drawSelection, highlightActiveLine, placeholder,
  ViewPlugin, Decoration, MatchDecorator, dropCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { api } from "./api.js";
import { displayName, linkFor } from "./util.js";

const style = HighlightStyle.define([
  { tag: t.heading1, class: "cm-h1" },
  { tag: t.heading2, class: "cm-h2" },
  { tag: t.heading3, class: "cm-h3" },
  { tag: [t.heading4, t.heading5, t.heading6], class: "cm-h4" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, class: "cm-mdlink" },
  { tag: t.url, class: "cm-url" },
  { tag: t.monospace, class: "cm-code" },
  { tag: t.quote, class: "cm-quote" },
  { tag: [t.processingInstruction, t.meta], class: "cm-meta" },
  { tag: t.list, class: "cm-listmark" },
]);

const wikiMatcher = new MatchDecorator({
  regexp: /!?\[\[[^\[\]\n]+\]\]/g,
  decoration: (m) => Decoration.mark({ class: m[0].startsWith("!") ? "cm-wikilink cm-embedlink" : "cm-wikilink" }),
});
const tagMatcher = new MatchDecorator({
  regexp: /(?<=^|\s)#[\p{L}_][\p{L}\p{N}_/-]*/gu,
  decoration: Decoration.mark({ class: "cm-hashtag" }),
});
const decoPlugin = (matcher) => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = matcher.createDeco(view); }
  update(u) { this.decorations = matcher.updateDeco(u, this.decorations); }
}, { decorations: (v) => v.decorations });

let tagCache = null;
async function knownTags() {
  if (!tagCache) {
    tagCache = api("/tags").catch(() => []);
    setTimeout(() => { tagCache = null; }, 60_000);
  }
  return tagCache;
}

async function linkCompletion(ctx) {
  const before = ctx.matchBefore(/!?\[\[[^\[\]\n]*$/);
  if (before) {
    const start = before.from + before.text.indexOf("[[") + 2;
    const q = ctx.state.sliceDoc(start, ctx.pos);
    const items = await api("/quick", { params: { q, limit: 25 } }).catch(() => []);
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    return {
      from: start,
      filter: false,
      options: items.filter((i) => !i.is_dir).map((i) => ({
        label: displayName(i),
        detail: i.src === "s" ? "server · " + i.rel.split("/").slice(0, -1).join("/") : (i.rel.includes("/") ? i.rel.split("/").slice(0, -1).join("/") : ""),
        type: i.kind === "note" ? "text" : "variable",
        apply: (view, _c, from, to) => {
          const link = linkFor(i);
          const end = after === "]]" ? to + 2 : to;
          view.dispatch({ changes: { from, to: end, insert: link + "]]" }, selection: { anchor: from + link.length + 2 } });
        },
      })),
    };
  }
  const tag = ctx.matchBefore(/(?<=^|\s)#[\p{L}\p{N}_/-]*$/u);
  if (tag && tag.text.length > 1) {
    const all = await knownTags();
    return {
      from: tag.from + 1,
      options: all.map((x) => ({ label: x.tag, detail: String(x.count), type: "keyword" })),
    };
  }
  return null;
}

/** Trova il [[link]] sotto la posizione `pos`. */
function linkAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const re = /!?\[\[([^\[\]\n]+)\]\]/g;
  let m;
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return m[1];
  }
  return null;
}

export function createEditor(parent, { text, onChange, onFollowLink, onSaveNow }) {
  const theme = EditorView.theme({
    "&": { height: "100%" },
    ".cm-scroller": { fontFamily: "var(--font-note)", lineHeight: "1.7" },
    ".cm-content": { maxWidth: "46rem", margin: "0 auto", padding: "2.5rem 2rem 40vh", caretColor: "var(--accent)" },
  });
  const state = EditorState.create({
    doc: text,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(style),
      decoPlugin(wikiMatcher),
      decoPlugin(tagMatcher),
      autocompletion({ override: [linkCompletion], icons: false }),
      placeholder("Scrivi qui. [[ per collegare una nota o un file del server, # per un tag."),
      keymap.of([
        { key: "Mod-s", run: () => { onSaveNow?.(); return true; } },
        ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString()); }),
      EditorView.domEventHandlers({
        mousedown(e, view) {
          if (!(e.metaKey || e.ctrlKey)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          const raw = linkAt(view.state, pos);
          if (!raw) return false;
          e.preventDefault();
          onFollowLink(raw);
          return true;
        },
      }),
      theme,
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(next) {
      const cur = view.state.doc.toString();
      if (cur === next) return;
      view.dispatch({ changes: { from: 0, to: cur.length, insert: next } });
    },
    insertAtCursor(s) {
      const r = view.state.selection.main;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: s }, selection: { anchor: r.from + s.length } });
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
