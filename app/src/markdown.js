// Rendering delle note: Markdown + [[link]], ![[incorporati]] e #tag.
import MarkdownIt from "markdown-it";
import YAML from "yaml";

const FM_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

export function splitFrontmatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text, raw: "" };
  let data = {};
  try {
    data = YAML.parse(m[1]) || {};
    if (typeof data !== "object" || Array.isArray(data)) data = {};
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length), raw: m[0] };
}

/** Riscrive il frontmatter di una nota mantenendo il resto del testo. */
export function withFrontmatter(text, data) {
  const { body } = splitFrontmatter(text);
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) =>
    v !== undefined && !(Array.isArray(v) && v.length === 0)));
  if (!Object.keys(clean).length) return body.replace(/^\n+/, "");
  const yaml = YAML.stringify(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith("\n") ? body : "\n" + body}`;
}

export function linkTarget(raw) {
  return raw.split("|")[0].split("#")[0].trim();
}

function wikilinkRule(state, silent) {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21; /* ! */
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || inner.includes("\n") || inner.includes("[[")) return false;
  if (!silent) {
    const target = linkTarget(inner);
    const alias = inner.includes("|") ? inner.split("|").slice(1).join("|").trim() : null;
    const heading = inner.split("|")[0].includes("#") ? inner.split("|")[0].split("#").slice(1).join("#") : null;
    const tok = state.push(embed ? "wiki_embed" : "wiki_link", "", 0);
    tok.meta = { target, alias, heading };
  }
  state.pos = end + 2;
  return true;
}

const TAG_RE = /^#([\p{L}_][\p{L}\p{N}_/-]*|\p{N}+[\p{L}_][\p{L}\p{N}_/-]*)/u;

function tagRule(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x23) return false;
  const prev = state.pos > 0 ? state.src[state.pos - 1] : " ";
  if (!/\s|[([]/.test(prev)) return false;
  const m = TAG_RE.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) {
    const tok = state.push("hashtag", "", 0);
    tok.meta = { tag: m[1].replace(/\/$/, "").toLowerCase(), text: m[0] };
  }
  state.pos += m[0].length;
  return true;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createRenderer(resolve) {
  // resolve(target) -> { id, kind, name } | null
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });
  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.after("wikilink", "hashtag", tagRule);
  md.renderer.rules.wiki_link = (tokens, i) => {
    const { target, alias, heading } = tokens[i].meta;
    const r = resolve(target);
    const label = alias || (heading ? `${target} › ${heading}` : target.replace(/^\//, "").split("/").pop());
    return `<a href="#" class="wikilink${r ? "" : " unresolved"}" data-target="${esc(target)}"${r ? ` data-id="${esc(r.id)}"` : ""}>${esc(label)}</a>`;
  };
  md.renderer.rules.wiki_embed = (tokens, i) => {
    const { target, alias } = tokens[i].meta;
    const r = resolve(target);
    return `<span class="embed" data-target="${esc(target)}"${r ? ` data-id="${esc(r.id)}" data-kind="${esc(r.kind)}"` : ""}${alias ? ` data-alias="${esc(alias)}"` : ""}></span>`;
  };
  md.renderer.rules.hashtag = (tokens, i) =>
    `<a href="#" class="hashtag" data-tag="${esc(tokens[i].meta.tag)}">${esc(tokens[i].meta.text)}</a>`;
  const defaultLink = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    tokens[i].attrSet("target", "_blank");
    tokens[i].attrSet("rel", "noopener");
    return defaultLink(tokens, i, opts, env, self);
  };
  return (text) => {
    const { body } = splitFrontmatter(text);
    return md.render(body);
  };
}

/** Caselle [ ] / [x] negli elenchi. */
export function enhanceTasks(root) {
  root.querySelectorAll("li").forEach((li) => {
    const first = li.firstChild?.nodeType === 3 ? li.firstChild
      : li.firstElementChild?.tagName === "P" ? li.firstElementChild.firstChild : null;
    if (!first || first.nodeType !== 3) return;
    const m = /^\[( |x|X)\]\s/.exec(first.textContent);
    if (!m) return;
    first.textContent = first.textContent.slice(m[0].length);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = m[1].toLowerCase() === "x";
    box.disabled = true;
    li.classList.add("task");
    first.parentNode.insertBefore(box, first);
  });
}
