"""throughline - Hermes Agent bridge.

Hermes plugin callbacks are in-process Python, not subprocess hooks like Claude
Code's hooks.json. Mirroring the OMP shim (throughline.ts), each callback builds
the Claude Code JSON the existing hooks/*.sh scripts already parse and runs the
real script, so capture and redaction logic is never reimplemented here.

Scope: only sessions whose workspace (ctx.session_cwd()) is inside a git repo.
Anything else is a silent no-op. Callbacks never raise into the gateway.
"""
import json
import logging
import os
import shutil
import subprocess
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

HOOKS_DIR = Path(__file__).resolve().parent.parent
PLUGIN_ROOT = HOOKS_DIR.parent
SKILL_NAMES = ("handoff", "onboard", "consolidate", "consolidate-memory")

SCRIPT_TIMEOUT = 10
GIT_TIMEOUT = 3
# Hermes caps a pre_llm_call injection at 10,000 chars and spills the rest to disk.
CONTEXT_CAP = 9500

_lock = threading.Lock()


def _state_file():
    try:
        from plugins.plugin_storage import plugin_data_dir
        base = Path(plugin_data_dir("throughline"))
    except Exception:
        home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
        base = Path(home) / "plugin-data" / "throughline"
    base.mkdir(parents=True, exist_ok=True)
    return base / "state.json"


def _load():
    try:
        data = json.loads(_state_file().read_text())
        return {"pending": dict(data.get("pending", {})), "alias": dict(data.get("alias", {}))}
    except Exception:
        return {"pending": {}, "alias": {}}


def _save(state):
    try:
        _state_file().write_text(json.dumps(state))
    except Exception:
        logger.debug("throughline: state save failed", exc_info=True)


def _canon(state, sid):
    """Follow compaction session-id rotation back to the id the buffer was opened under."""
    seen = set()
    while sid in state["alias"] and sid not in seen:
        seen.add(sid)
        sid = state["alias"][sid]
    return sid


def _project(ctx):
    """Git root of the calling session's workspace, or None (hooks then no-op)."""
    try:
        cwd = ctx.session_cwd()
        if not cwd or not os.path.isdir(cwd):
            return None
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd, capture_output=True, text=True, timeout=GIT_TIMEOUT,
        )
        root = out.stdout.strip()
        return root if out.returncode == 0 and root else None
    except Exception:
        return None


def _run(script, payload, root):
    try:
        env = dict(os.environ)
        env["CLAUDE_PLUGIN_ROOT"] = str(PLUGIN_ROOT)
        env["CLAUDE_PROJECT_DIR"] = root
        done = subprocess.run(
            ["sh", str(HOOKS_DIR / script)],
            input=json.dumps(payload), cwd=root, env=env,
            capture_output=True, text=True, timeout=SCRIPT_TIMEOUT,
        )
        return done.stdout or ""
    except Exception:
        return ""


def _text(message):
    """user_message is a str, or a list of content parts on multimodal turns."""
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        parts = []
        for part in message:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and part.get("type") in (None, "text"):
                parts.append(str(part.get("text", "")))
        return "\n".join(p for p in parts if p)
    return ""


def _first(value):
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else ""
    return str(value or "")


def build_capture_payload(tool_name, args, status, sid):
    """Translate a Hermes tool call into the Claude-Code-shaped capture payload, or None."""
    args = args if isinstance(args, dict) else {}
    base = {"session_id": sid, "tool_response": {"is_error": status == "error"}}
    name = str(tool_name or "")
    if name == "terminal":
        return {**base, "tool_name": "Bash", "tool_input": {"command": str(args.get("command", "")), "description": ""}}
    if name == "execute_code":
        code = str(args.get("code", "")).strip().splitlines()
        return {**base, "tool_name": "Bash", "tool_input": {"command": code[0] if code else "", "description": "execute_code"}}
    if name == "write_file":
        return {**base, "tool_name": "Write", "tool_input": {"file_path": str(args.get("path", ""))}}
    if name == "patch":
        return {**base, "tool_name": "Edit", "tool_input": {"file_path": str(args.get("path", ""))}}
    if name == "delegate_task":
        return {**base, "tool_name": "Task", "tool_input": {"subagent_type": "", "description": str(args.get("goal", ""))}}
    if name == "web_search":
        return {**base, "tool_name": "WebSearch", "tool_input": {"query": str(args.get("query", ""))}}
    if name == "web_extract":
        return {**base, "tool_name": "WebFetch", "tool_input": {"url": _first(args.get("urls"))}}
    if name.startswith("mcp__"):
        return {**base, "tool_name": name, "tool_input": {}}
    if name.startswith("mcp_"):
        return {**base, "tool_name": "mcp__" + name[4:], "tool_input": {}}
    return None


def _safe(fn):
    def wrapper(**kwargs):
        try:
            return fn(**kwargs)
        except Exception:
            logger.debug("throughline: callback failed", exc_info=True)
            return None
    wrapper.__name__ = getattr(fn, "__name__", "callback")
    return wrapper


def _cap(text):
    text = text.strip()
    return text if len(text) <= CONTEXT_CAP else text[:CONTEXT_CAP] + "\n...[truncated]"


def register(ctx):
    if not shutil.which("jq") or not shutil.which("git"):
        logger.warning("throughline: jq and git are required; plugin inactive")
        return

    @_safe
    def on_session_start(session_id="", **_kw):
        root = _project(ctx)
        if not root or not session_id:
            return None
        text = _run("session-onboard.sh", {"session_id": session_id, "source": "startup"}, root).strip()
        if text:
            with _lock:
                state = _load()
                state["pending"][session_id] = text
                _save(state)
        return None

    @_safe
    def pre_llm_call(session_id="", user_message="", is_first_turn=False, **_kw):
        root = _project(ctx)
        if not root or not session_id:
            return None
        with _lock:
            state = _load()
            sid = _canon(state, session_id)
            text = state["pending"].pop(session_id, None) or state["pending"].pop(sid, None)
            _save(state)
        prompt = _text(user_message)
        if prompt.strip():
            _run("session-prompt.sh", {"session_id": sid, "prompt": prompt}, root)
        if text is None and is_first_turn:
            text = _run("session-onboard.sh", {"session_id": sid, "source": "startup"}, root)
        text = (text or "").strip()
        return {"context": _cap(text)} if text else None

    @_safe
    def post_tool_call(tool_name="", args=None, session_id="", status="ok", **_kw):
        root = _project(ctx)
        if not root or not session_id:
            return None
        with _lock:
            sid = _canon(_load(), session_id)
        payload = build_capture_payload(tool_name, args, status, sid)
        if payload:
            _run("session-capture.sh", payload, root)
        return None

    @_safe
    def post_compaction(session_id="", old_session_id="", kind="", reason="", **_kw):
        root = _project(ctx)
        if not root or not session_id:
            return None
        with _lock:
            state = _load()
            if old_session_id and old_session_id != session_id:
                state["alias"][session_id] = _canon(state, old_session_id)
            sid = _canon(state, session_id)
            _save(state)
        _run("session-precompact.sh", {"session_id": sid, "trigger": kind or reason or "auto"}, root)
        text = _run("session-onboard.sh", {"session_id": sid, "source": "compact"}, root).strip()
        if text:
            with _lock:
                state = _load()
                state["pending"][sid] = text
                _save(state)
        return None

    @_safe
    def end_session(session_id="", **_kw):
        root = _project(ctx)
        if root and session_id:
            with _lock:
                sid = _canon(_load(), session_id)
            _run("session-flush.sh", {"session_id": sid, "reason": "end"}, root)
        if session_id:
            with _lock:
                state = _load()
                state["pending"].pop(session_id, None)
                state["alias"].pop(session_id, None)
                _save(state)
        return None

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("post_compaction", post_compaction)
    ctx.register_hook("on_session_finalize", end_session)
    ctx.register_hook("on_session_reset", end_session)

    skills_dir = PLUGIN_ROOT / "skills"
    for name in SKILL_NAMES:
        skill_md = skills_dir / name / "SKILL.md"
        if skill_md.is_file():
            ctx.register_skill(name, skill_md)
