"""Tests for hooks/post/hermes.py against the real hooks/*.sh scripts."""
import importlib.util
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BRIDGE = REPO / "hooks" / "post" / "hermes.py"

_HAVE_TOOLS = bool(shutil.which("jq") and shutil.which("git"))
# On CI a missing jq/git must fail the run, not silently skip most of the suite.
needs_tools = pytest.mark.skipif(
    not _HAVE_TOOLS and not os.environ.get("CI"), reason="jq and git required"
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
    assert "HANDOFF.md" in bridge._load()["pending"]["s1"]["text"]
    # Precomputed text wins over a recompute: drop the handoff, the stored text still injects.
    (repo / ".claude" / "throughline" / "HANDOFF.md").unlink()
    first = ctx.hooks["pre_llm_call"](session_id="s1", user_message="hello", is_first_turn=True)
    assert first and "HANDOFF.md" in first["context"]
    assert "s1" not in bridge._load()["pending"]
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
    assert "echo before" in again["context"]
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
def test_sessions_are_keyed_independently(bridge, repo):
    ctx = registered(bridge, repo)
    for sid in ("A", "B"):
        ctx.hooks["on_session_start"](session_id=sid)
    ctx.hooks["post_compaction"](session_id="A2", old_session_id="A", kind="auto")
    state = bridge._load()
    assert state["alias"] == {"A2": "A"}
    assert set(state["pending"]) == {"B", "A"}
    assert ctx.hooks["pre_llm_call"](session_id="B", user_message="b1", is_first_turn=True)
    assert ctx.hooks["pre_llm_call"](session_id="B", user_message="b2", is_first_turn=False) is None
    ctx.hooks["on_session_finalize"](session_id="A2")
    state = bridge._load()
    assert "A2" not in state["alias"] and "A" not in state["pending"]
    assert ctx.hooks["pre_llm_call"](session_id="A3", user_message="x", is_first_turn=False) is None


@needs_tools
@pytest.mark.parametrize("hook", ["on_session_finalize", "on_session_reset"])
def test_end_clears_session_state(bridge, repo, hook):
    ctx = registered(bridge, repo)
    ctx.hooks["on_session_start"](session_id="s1")
    ctx.hooks["post_compaction"](session_id="s2", old_session_id="s1", kind="auto")
    ctx.hooks[hook](session_id="s2")
    ctx.hooks[hook](session_id="s1")
    state = bridge._load()
    assert state == {"pending": {}, "alias": {}, "root": {}}


@needs_tools
def test_all_mapped_tools_reach_the_buffer(bridge, repo):
    ctx = registered(bridge, repo)
    calls = [
        ("execute_code", {"code": "print('tok-exec')\nsecond"}),
        ("delegate_task", {"goal": "tok-goal research"}),
        ("web_extract", {"urls": ["https://tok-url.test/page"]}),
        ("mcp_srv_search", {"q": "x"}),
    ]
    for name, args in calls:
        ctx.hooks["post_tool_call"](tool_name=name, args=args, session_id="s1", status="ok")
    text = buffer_text(repo)
    for token in ("tok-exec", "tok-goal", "tok-url.test", "mcp__srv_search"):
        assert token in text


@needs_tools
def test_error_status_is_recorded(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "false-cmd"}, session_id="s1", status="error")
    assert "false-cmd" in buffer_text(repo)
    assert bridge.build_capture_payload("terminal", {"command": "x"}, "error", "s")["tool_response"]["is_error"] is True


@needs_tools
def test_state_lives_in_hermes_home_not_plugin_root(bridge, repo, tmp_path):
    ctx = registered(bridge, repo)
    ctx.hooks["on_session_start"](session_id="s1")
    state_file = bridge._state_file()
    assert state_file.exists()
    assert (tmp_path / "hermes-home" / "plugin-data" / "throughline") in state_file.parents
    assert bridge.PLUGIN_ROOT not in state_file.parents


@needs_tools
def test_non_repo_writes_nothing_anywhere(bridge, tmp_path, monkeypatch):
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    plain = tmp_path / "plain"
    plain.mkdir()
    ctx = registered(bridge, plain)
    ctx.hooks["on_session_start"](session_id="s1")
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi", is_first_turn=True)
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1")
    ctx.hooks["post_compaction"](session_id="s2", old_session_id="s1", kind="auto")
    ctx.hooks["on_session_finalize"](session_id="s2")
    ctx.hooks["on_session_reset"](session_id="s2")
    assert not (plain / ".claude").exists()
    assert not (tmp_path / "hermes-home").exists()


@needs_tools
@pytest.mark.parametrize("cwd_value", [None, "", "/nonexistent/path/xyz"])
def test_unusable_session_cwd_is_noop(bridge, repo, cwd_value):
    ctx = registered(bridge, repo)
    ctx.session_cwd = lambda: cwd_value
    for hook, kw in (
        ("pre_llm_call", {"user_message": "hi", "is_first_turn": True}),
        ("post_tool_call", {"tool_name": "terminal", "args": {"command": "ls"}}),
        ("on_session_finalize", {}),
    ):
        assert ctx.hooks[hook](session_id="s1", **kw) is None
    assert not (repo / ".claude" / "throughline" / "buffer").exists()


@needs_tools
def test_raising_session_cwd_never_propagates(bridge, repo):
    ctx = registered(bridge, repo)

    def boom():
        raise RuntimeError("no session")

    ctx.session_cwd = boom
    assert ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi", is_first_turn=True) is None


@needs_tools
def test_script_timeout_is_contained(bridge, repo, tmp_path, monkeypatch):
    slow = tmp_path / "hooks"
    slow.mkdir()
    (slow / "session-capture.sh").write_text("sleep 5\n")
    monkeypatch.setattr(bridge, "HOOKS_DIR", slow)
    monkeypatch.setattr(bridge, "SCRIPT_TIMEOUT", 0.3)
    ctx = registered(bridge, repo)
    assert ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1") is None


@needs_tools
def test_corrupt_state_is_moved_aside(bridge, repo):
    ctx = registered(bridge, repo)
    bridge._state_file(create=True).write_text("{not json")
    first = ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi", is_first_turn=True)
    assert first and "throughline" in first["context"]
    assert bridge._state_file().with_name("state.json.corrupt").exists()


@pytest.mark.parametrize("missing", ["jq", "git"])
def test_missing_dependency_registers_nothing(bridge, repo, monkeypatch, missing):
    real = shutil.which
    monkeypatch.setattr(bridge.shutil, "which", lambda name: None if name == missing else real(name) or "/usr/bin/" + name)
    ctx = registered(bridge, repo)
    assert ctx.hooks == {} and ctx.skills == {}


@needs_tools
def test_root_shim_and_manifest_agree(repo):
    spec = importlib.util.spec_from_file_location("throughline_root_shim", REPO / "__init__.py")
    shim = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shim)
    ctx = StubCtx(repo)
    shim.register(ctx)
    manifest = (REPO / "plugin.yaml").read_text()
    listed = [l.strip()[2:] for l in manifest.split("provides_hooks:")[1].splitlines() if l.strip().startswith("- ")]
    assert sorted(listed) == sorted(ctx.hooks)


def test_user_message_empty_or_none(bridge):
    assert bridge._text(None) == ""
    assert bridge._text([]) == ""


@needs_tools
@pytest.mark.parametrize("surface,env,expected", [
    ("cli", None, True), ("tui", None, True), ("telegram", None, False), ("cron", None, False),
    ("telegram", "all", True), ("telegram", "cli,telegram", True), ("cli", "telegram", False),
])
def test_surface_gate(bridge, repo, monkeypatch, surface, env, expected):
    if env is not None:
        monkeypatch.setenv("THROUGHLINE_HERMES_SURFACES", env)
    ctx = registered(bridge, repo)
    ctx.session_surface = lambda: surface
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "echo gate"}, session_id="s1")
    assert ("echo gate" in buffer_text(repo)) is expected


@needs_tools
@pytest.mark.parametrize("hook", ["on_session_finalize", "on_session_reset"])
def test_end_marker_when_finalize_is_unscoped(bridge, repo, hook):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi", is_first_turn=True)
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "echo hi"}, session_id="s1")
    # Hermes fires finalize from reaper threads with no session scope.
    ctx.session_cwd = lambda: ""
    ctx.session_surface = lambda: ""
    ctx.hooks[hook](session_id="s1")
    assert buffer_text(repo).count("<!-- session-ended") == 1
    assert bridge._load()["root"] == {}


@needs_tools
def test_compaction_uses_stored_root_when_unscoped(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi", is_first_turn=True)
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "echo before"}, session_id="s1")
    ctx.session_cwd = lambda: "/"
    ctx.session_surface = lambda: ""
    # In-place compaction: old_session_id is empty and the worker thread has no workspace.
    ctx.hooks["post_compaction"](session_id="s1", old_session_id="", kind="summarize", reason="manual")
    assert "compaction-boundary" in buffer_text(repo)
    ctx.session_cwd = lambda: str(repo)
    ctx.session_surface = lambda: "cli"
    again = ctx.hooks["pre_llm_call"](session_id="s1", user_message="more", is_first_turn=False)
    assert again and "compacted" in again["context"]


@needs_tools
def test_synthetic_delegation_message_not_captured_as_prompt(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="real prompt", is_first_turn=True)
    ctx.hooks["pre_llm_call"](
        session_id="s1", is_first_turn=False,
        user_message="[ASYNC DELEGATION BATCH COMPLETE - deleg_1] A background fan-out unit has finished",
    )
    text = buffer_text(repo)
    assert "real prompt" in text and "ASYNC DELEGATION" not in text


@needs_tools
def test_child_session_leaves_no_pending_state(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="parent", user_message="go", is_first_turn=True)
    ctx.hooks["on_session_start"](session_id="child")
    ctx.hooks["pre_llm_call"](session_id="child", user_message="goal", is_first_turn=True, parent_session_id="parent")
    state = bridge._load()
    assert "child" not in state["pending"] and "child" not in state["root"]


@needs_tools
def test_startup_block_not_reinjected_mid_session(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="turn one", is_first_turn=True)
    # Hermes rebuilds the prompt mid-session (model switch) and fires on_session_start again.
    ctx.hooks["on_session_start"](session_id="s1")
    assert ctx.hooks["pre_llm_call"](session_id="s1", user_message="turn twelve", is_first_turn=False) is None
    assert "s1" not in bridge._load()["pending"]


@needs_tools
def test_delegate_child_folds_into_parent(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="parent", user_message="go", is_first_turn=True)
    child = ctx.hooks["pre_llm_call"](
        session_id="child", user_message="subtask goal", is_first_turn=True, parent_session_id="parent",
    )
    assert child is None
    ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "echo from-child"}, session_id="child")
    bufs = list((repo / ".claude" / "throughline" / "buffer").glob("session-*.md"))
    assert [b.name for b in bufs] == ["session-parent.md"]
    assert "echo from-child" in bufs[0].read_text()
    assert "subtask goal" not in bufs[0].read_text()


@needs_tools
def test_ending_parent_drops_child_aliases(bridge, repo):
    ctx = registered(bridge, repo)
    ctx.hooks["pre_llm_call"](session_id="parent", user_message="go", is_first_turn=True)
    ctx.hooks["pre_llm_call"](session_id="child", user_message="g", is_first_turn=True, parent_session_id="parent")
    assert bridge._load()["alias"] == {"child": "parent"}
    ctx.hooks["on_session_finalize"](session_id="parent")
    assert bridge._load() == {"pending": {}, "alias": {}, "root": {}}


@needs_tools
def test_session_start_precompute_records_no_warning_state(bridge, repo):
    """The precomputed startup block can be discarded (prompt rebuild, delegate child), so
    computing it must not mark unconsumed buffers as reported (issue #191)."""
    buf = repo / ".claude" / "throughline" / "buffer"
    buf.mkdir(parents=True)
    (buf / "session-old.md").write_text(
        "- `t` **bash** a - `x`\n- `t` **bash** b - `x`\n- `t` **bash** c - `x`\n"
        "<!-- session-ended 2024-01-01 00:00:00 (end) -->\n")
    ctx = registered(bridge, repo)
    ctx.hooks["on_session_start"](session_id="s1")
    assert "unconsumed session buffer" in bridge._load()["pending"]["s1"]["text"]
    assert not (buf / ".unconsumed-reported").exists()
