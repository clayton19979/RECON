"""Just enough JavaScript scanning to reason about the front-end's modules.

Not a parser. It answers two questions the module split made worth asking:
which byte offsets are *code* (rather than string, comment or regex text), and
which identifiers a file declares. That's the basis for
`test_js_modules.py`'s check that every cross-module reference is imported --
the thing no runtime test can catch, because the DOM harness concatenates the
modules into one scope where imports are irrelevant.

The template-literal handling is the whole reason this exists rather than a
handful of regexes: `${...}` interpolations are code inside a string, they
nest arbitrarily (a template inside an interpolation inside a template), and
the front-end's render functions are built almost entirely out of them. A
scanner that gives up on nesting silently reports interpolated identifiers as
string text -- which is exactly how a missing import got shipped once.
"""

from __future__ import annotations

import re

_IDENT = re.compile(r"[A-Za-z_$][\w$]*")
_DECL = re.compile(r"\b(?:async\s+)?(function|const|let|var|class)\s+\*?\s*([A-Za-z_$][\w$]*)")
_EXPORT_DECL = re.compile(
    r"^export\s+(?:async\s+)?(function|const|let|var|class)\s+\*?\s*([A-Za-z_$][\w$]*)", re.MULTILINE
)
# Identifiers that are declared by syntax other than a declaration keyword:
# function parameters, catch bindings, for-of/in bindings, destructuring.
_PARAM_LIKE = re.compile(r"(?:function\s*\*?\s*[\w$]*\s*\(|catch\s*\(|=>\s*|\(\s*)([^)]*)\)?")


def code_spans(src: str) -> list[tuple[int, int]]:
    """The (start, end) ranges of `src` that are executable code.

    Comments, string bodies and regex literals are excluded; the code inside
    a template literal's `${...}` is included, at any nesting depth.
    """
    spans: list[tuple[int, int]] = []
    n = len(src)
    i = 0
    run_start = 0
    # Each entry is either ("code", brace_depth) or ("tmpl", None). The base
    # frame is the file itself; a `${` pushes code, its matching `}` pops.
    stack: list[list] = [["code", 0]]

    def close_run(at: int) -> None:
        if at > run_start:
            spans.append((run_start, at))

    def prev_significant(at: int) -> str:
        j = at - 1
        while j >= 0 and src[j] in " \t\r\n":
            j -= 1
        return src[j] if j >= 0 else ""

    while i < n:
        frame = stack[-1]
        c = src[i]

        if frame[0] == "tmpl":
            if c == "\\":
                i += 2
                continue
            if c == "`":
                stack.pop()
                i += 1
                run_start = i
                continue
            if c == "$" and src[i + 1 : i + 2] == "{":
                stack.append(["code", 0])
                i += 2
                run_start = i
                continue
            i += 1
            continue

        # --- code frame ---
        if c == "/" and src[i + 1 : i + 2] == "/":
            close_run(i)
            j = src.find("\n", i)
            i = n if j == -1 else j
            run_start = i
            continue
        if c == "/" and src[i + 1 : i + 2] == "*":
            close_run(i)
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
            run_start = i
            continue
        if c in "'\"":
            close_run(i)
            quote = c
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            run_start = i
            continue
        if c == "`":
            close_run(i)
            stack.append(["tmpl", None])
            i += 1
            continue
        if c == "/" and not (prev_significant(i).isalnum() or prev_significant(i) in "_$)]"):
            # A regex literal, not division.
            close_run(i)
            i += 1
            in_class = False
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "[":
                    in_class = True
                elif src[i] == "]":
                    in_class = False
                elif src[i] == "/" and not in_class:
                    i += 1
                    break
                i += 1
            while i < n and src[i].isalpha():
                i += 1
            run_start = i
            continue
        if c == "{":
            frame[1] += 1
        elif c == "}":
            if frame[1] == 0 and len(stack) > 1:
                # Closes a `${`; back to template text.
                close_run(i)
                stack.pop()
                i += 1
                continue
            frame[1] -= 1
        i += 1

    close_run(n)
    return spans


def code_only(src: str) -> str:
    """`src` with comments, string bodies and regex literals blanked out.

    Offsets are preserved (blanked runs become spaces), so line numbers still
    line up with the original file.
    """
    chars = [" "] * len(src)
    for start, end in code_spans(src):
        for k in range(start, end):
            chars[k] = "\n" if src[k] == "\n" else src[k]
    # Newlines survive everywhere, so reported line numbers stay honest.
    for k, ch in enumerate(src):
        if ch == "\n":
            chars[k] = "\n"
    return "".join(chars)


def referenced_identifiers(src: str) -> set[str]:
    """Every identifier the code reads, minus property names after a dot."""
    code = code_only(src)
    names = set()
    for m in _IDENT.finditer(code):
        start = m.start()
        # `foo.bar` -- bar is a property, not a binding this file resolves.
        if start > 0 and code[start - 1] == ".":
            continue
        names.add(m.group(0))
    return names


def declared_identifiers(src: str, *, top_level_only: bool = False) -> set[str]:
    """Names this file binds.

    With top_level_only, just the module-scope declarations (what another
    module could import). Otherwise every binding anywhere in the file,
    including parameters and destructuring -- the conservative set to
    subtract when deciding whether a reference must come from an import.
    """
    code = code_only(src)
    if top_level_only:
        # Depth of every match position, so only module-scope declarations count.
        depth = 0
        depth_at = []
        for ch in code:
            if ch in ")}]":
                depth -= 1
            depth_at.append(depth)
            if ch in "({[":
                depth += 1
        return {m.group(2) for m in _DECL.finditer(code) if depth_at[m.start()] == 0}

    names = {m.group(2) for m in _DECL.finditer(code)}
    # Destructuring and parameter lists: take every identifier inside the
    # binding position. Over-broad on purpose -- a name this file might bind
    # is a name we don't demand an import for.
    for m in re.finditer(r"(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])\s*=", code):
        names.update(_IDENT.findall(m.group(1)))
    for m in _PARAM_LIKE.finditer(code):
        names.update(_IDENT.findall(m.group(1)))
    for m in re.finditer(r"for\s*\(\s*(?:const|let|var)\s+([\w$]+)", code):
        names.add(m.group(1))
    return names


def imports_by_source(src: str) -> dict[str, set[str]]:
    """{module specifier: names imported from it} for one module's header."""
    found: dict[str, set[str]] = {}
    for m in re.finditer(r'^import\s*\{([^}]*)\}\s*from\s*"\./([^"]+)"', src, re.MULTILINE):
        names = {p.split(" as ")[-1].strip() for p in m.group(1).split(",") if p.strip()}
        found.setdefault(m.group(2), set()).update(names)
    return found


def imported_identifiers(src: str) -> set[str]:
    """The names an ES module's static imports bring into scope."""
    return {name for names in imports_by_source(src).values() for name in names}


def exported_identifiers(src: str) -> set[str]:
    """The names a module actually exports (declaration form only, which is
    the only form this codebase uses)."""
    return {m.group(2) for m in re.finditer(_EXPORT_DECL, code_only(src))}
