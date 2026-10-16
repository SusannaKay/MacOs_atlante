"""Lettura delle note Markdown: frontmatter, [[link]], ![[embed]] e #tag."""
import datetime as dt
import re

import yaml

FM_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.S)
FENCE_RE = re.compile(r"```.*?```|~~~.*?~~~", re.S)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
WIKI_RE = re.compile(r"(!?)\[\[([^\[\]\n]+?)\]\]")
TAG_RE = re.compile(r"(?<![\w/#&])#([^\W\d][\w/\-]*|\d+[^\W\d][\w/\-]*)", re.U)
YEAR_KEYS = ("anno", "year")
DATE_KEYS = ("data", "date", "created", "creato", "creata")


def split_frontmatter(text: str):
    m = FM_RE.match(text)
    if not m:
        return {}, text
    try:
        fm = yaml.safe_load(m.group(1)) or {}
        if not isinstance(fm, dict):
            fm = {}
    except yaml.YAMLError:
        fm = {}
    return fm, text[m.end():]


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if x is not None]
    return [s.strip() for s in re.split(r"[,\s]+", str(v)) if s.strip()]


def link_target(raw: str) -> str:
    """'Nota#titolo|alias' -> 'Nota'"""
    return raw.split("|", 1)[0].split("#", 1)[0].strip()


def year_from_value(v):
    if isinstance(v, int) and 1900 <= v <= 2200:
        return v
    if isinstance(v, (dt.date, dt.datetime)):
        return v.year
    m = re.search(r"\b(19\d\d|20\d\d|21\d\d)\b", str(v or ""))
    return int(m.group(1)) if m else None


def parse(text: str):
    fm, body = split_frontmatter(text)
    clean = INLINE_CODE_RE.sub(" ", FENCE_RE.sub(" ", body))

    tags = set()
    for t in _as_list(fm.get("tags") or fm.get("tag")):
        t = t.lstrip("#").strip()
        if t:
            tags.add(t.lower())
    for m in TAG_RE.finditer(clean):
        tags.add(m.group(1).lower().rstrip("/"))

    links = []
    for m in WIKI_RE.finditer(clean):
        target = link_target(m.group(2))
        if target:
            links.append((target, "embed" if m.group(1) else "link"))

    props = {}
    year = None
    for k, v in fm.items():
        lk = str(k).lower()
        if lk in ("tags", "tag"):
            continue
        if isinstance(v, (list, tuple)):
            sv = ", ".join(str(x) for x in v)
        elif isinstance(v, (dt.date, dt.datetime)):
            sv = v.isoformat()
        else:
            sv = "" if v is None else str(v)
        props[str(k)] = sv
        if lk in YEAR_KEYS and year is None:
            year = year_from_value(v)
    if year is None:
        for k, v in fm.items():
            if str(k).lower() in DATE_KEYS:
                year = year_from_value(v)
                if year:
                    break

    return {"tags": sorted(tags), "links": links, "props": props, "year": year, "body": body}


def rewrite_links(text: str, old_targets, new_target: str) -> str:
    """Sostituisce [[old]] con [[new]] mantenendo #titolo, |alias ed eventuale '!'."""
    olds = {o.lower() for o in old_targets}

    def repl(m):
        raw = m.group(2)
        target = link_target(raw)
        if target.lower() not in olds:
            return m.group(0)
        rest = raw[len(raw.split("|", 1)[0].split("#", 1)[0]):]
        return "%s[[%s%s]]" % (m.group(1), new_target, rest)

    return WIKI_RE.sub(repl, text)
