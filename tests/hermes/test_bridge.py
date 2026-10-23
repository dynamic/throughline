"""Tests for hooks/post/hermes.py against the real hooks/*.sh scripts."""
import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BRIDGE = REPO / "hooks" / "post" / "hermes.py"

needs_tools = pytest.mark.skipif(
    not (shutil.which("jq") and shutil.which("git")), reason="jq and git required"
)


def load_bridge():
    spec = importlib.util.spec_from_file_location("hermes_bridge_under_test", BRIDGE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StubCtx:
    def __init__(self, cwd):
        self.cwd = cwd
        self.hooks = {}
        self.skills = {}

    def session_cwd(self):
        return str(self.cwd)

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_skill(self, name, path, **_kw):
        self.skills[name] = path


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    monkeypatch.delenv("THROUGHLINE_DISABLE", raising=False)
    monkeypatch.delenv("THROUGHLINE_DATA_DIR", raising=False)
    return load_bridge()


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    (root / ".gitignore").write_text(".claude/throughline/\n")
    return root


def buffer_text(root):
    bufs = list((root / ".claude" / "throughline" / "buffer").glob("session-*.md"))
    return "".join(b.read_text() for b in bufs)


def registered(bridge, cwd):
    ctx = StubCtx(cwd)
    bridge.register(ctx)
    return ctx


@needs_tools
def test_registers_hooks_and_skills(bridge, repo):
    ctx = registered(bridge, repo)
    assert set(ctx.hooks) == {
        "on_session_start", "pre_llm_call", "post_tool_call",
        "post_compaction", "on_session_finalize", "on_session_reset",
    }
    assert "on_session_end" not in ctx.hooks
    assert set(ctx.skills) == {"handoff", "onboard", "consolidate", "consolidate-memory"}


def test_missing_jq_registers_nothing(bridge, repo, monkeypatch):
    monkeypatch.setattr(bridge.shutil, "which", lambda _name: None)
    ctx = registered(bridge, repo)
    assert ctx.hooks == {} and ctx.skills == {}


@needs_tools
def test_non_repo_is_noop(bridge, tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    ctx = registered(bridge, plain)
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1")
    ctx.hooks["on_session_finalize"](session_id="s1")
    assert ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi", is_first_turn=True) is None
    assert not (plain / ".claude").exists()


@needs_tools
def test_capture_prompt_and_tool_mapping(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="fix the login bug", is_first_turn=True)
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "make test"}, session_id="s1", status="ok")
    ctx.hooks["post_tool_call"](tool_name="write_file", args={"path": str(repo / "a.py")}, session_id="s1")
    ctx.hooks["post_tool_call"](tool_name="patch", args={"path": str(repo / "b.py")}, session_id="s1")
    ctx.hooks["post_tool_call"](tool_name="web_search", args={"query": "hermes plugins"}, session_id="s1")
    ctx.hooks["post_tool_call"](tool_name="read_file", args={"path": "x"}, session_id="s1")
    text = buffer_text(repo)
    assert "fix the login bug" in text
    assert "make test" in text
    assert "a.py" in text and "b.py" in text
    assert "hermes plugins" in text
    assert "read_file" not in text
    assert text.count("- `") + text.count("**") > 0


def test_payload_mapping(bridge):
    p = bridge.build_capture_payload("delegate_task", {"goal": "research X"}, "ok", "s")
    assert p["tool_name"] == "Task" and p["tool_input"]["description"] == "research X"
    p = bridge.build_capture_payload("web_extract", {"urls": ["https://a.test", "https://b.test"]}, "ok", "s")
    assert p["tool_name"] == "WebFetch" and p["tool_input"]["url"] == "https://a.test"
    p = bridge.build_capture_payload("execute_code", {"code": "import os\nprint(1)"}, "error", "s")
    assert p["tool_input"]["command"] == "import os" and p["tool_response"]["is_error"] is True
    assert bridge.build_capture_payload("mcp_srv_tool", {}, "ok", "s")["tool_name"] == "mcp__srv_tool"
    assert bridge.build_capture_payload("mcp__srv__tool", {}, "ok", "s")["tool_name"] == "mcp__srv__tool"
    assert bridge.build_capture_payload("read_file", {}, "ok", "s") is None


def test_multimodal_user_message(bridge):
    parts = [{"type": "text", "text": "look"}, {"type": "image_url", "image_url": {}}, {"type": "text", "text": "here"}]
    assert bridge._text(parts) == "look\nhere"
    assert bridge._text("plain") == "plain"


@needs_tools
def test_first_turn_injection_only_once(bridge, repo):
    (repo / ".claude" / "throughline").mkdir(parents=True)
    (repo / ".claude" / "throughline" / "HANDOFF.md").write_text("# handoff\n")
    ctx = registered(bridge, repo)
    first = ctx.hooks["pre_llm_call"](session_id="s1", user_message="hello", is_first_turn=True)
    assert first and "throughline" in first["context"]
    second = ctx.hooks["pre_llm_call"](session_id="s1", user_message="again", is_first_turn=False)
    assert second is None


@needs_tools
def test_session_start_precompute_is_consumed_once(bridge, repo):
    (repo / ".claude" / "throughline").mkdir(parents=True)
    (repo / ".claude" / "throughline" / "HANDOFF.md").write_text("# handoff\n")
    ctx = registered(bridge, repo)
    ctx.hooks["on_session_start"](session_id="s1")
    first = ctx.hooks["pre_llm_call"](session_id="s1", user_message="hello", is_first_turn=True)
    assert first and "throughline" in first["context"]
    assert ctx.hooks["pre_llm_call"](session_id="s1", user_message="more", is_first_turn=False) is None


@needs_tools
def test_compaction_stamps_boundary_and_reinjects_with_alias(bridge, repo):
    (repo / ".claude" / "throughline").mkdir(parents=True)
    (repo / ".claude" / "throughline" / "HANDOFF.md").write_text("# handoff\n")
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="old", user_message="start", is_first_turn=True)
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "echo before"}, session_id="old")
    ctx.hooks["post_compaction"](session_id="new", old_session_id="old", kind="auto", reason="context_full")
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "echo after"}, session_id="new")
    bufs = list((repo / ".claude" / "throughline" / "buffer").glob("session-*.md"))
    assert [b.name for b in bufs] == ["session-old.md"]
    text = bufs[0].read_text()
    assert "compaction-boundary" in text
    assert text.index("echo before") < text.index("compaction-boundary") < text.index("echo after")
    again = ctx.hooks["pre_llm_call"](session_id="new", user_message="continue", is_first_turn=False)
    assert again and "compacted" in again["context"]
    assert ctx.hooks["pre_llm_call"](session_id="new", user_message="and on", is_first_turn=False) is None


@needs_tools
@pytest.mark.parametrize("hook", ["on_session_finalize", "on_session_reset"])
def test_end_marker_once(bridge, repo, hook):
    ctx = registered(bridge, repo)
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "echo hi"}, session_id="s1")
    ctx.hooks[hook](session_id="s1")
    ctx.hooks[hook](session_id="s1")
    assert buffer_text(repo).count("<!-- session-ended") == 1


@needs_tools
def test_per_turn_calls_do_not_end_session(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="turn one", is_first_turn=True)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="turn two", is_first_turn=False)
    assert "session-ended" not in buffer_text(repo)


@needs_tools
def test_context_is_capped(bridge):
    assert len(bridge._cap("x" * 50000)) < 10000


@needs_tools
def test_nothing_written_into_plugin_root(bridge, repo):
    before = {p for p in REPO.rglob("*") if ".git" not in p.parts and "__pycache__" not in p.parts}
    ctx = registered(bridge, repo)
    ctx.hooks["on_session_start"](session_id="s1")
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1")
    ctx.hooks["post_compaction"](session_id="s2", old_session_id="s1", kind="auto")
    ctx.hooks["on_session_finalize"](session_id="s2")
    after = {p for p in REPO.rglob("*") if ".git" not in p.parts and "__pycache__" not in p.parts}
    assert after == before
