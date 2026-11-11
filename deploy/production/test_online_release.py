"""Isolated control-plane tests; no real systemd, Nginx, provider or production state."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("online_release", Path(__file__).with_name("online-release.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA = "a" * 40


class FakeHost:
    def __init__(self, root):
        self.base = root
        self.nginx = root / "news.conf"
        self.nginx.write_text("legacy config")
        self.events = []
        self.dead = set()
        self.config = "original"
        self.failure = None

    def config_id(self, override=None): return self.config
    def verify_revision(self, release, expected):
        if expected != SHA: raise m.Incomplete("revision mismatch")
    def snapshot(self, active): return {role: {"unit": f"old-{role}", "pid": n, "start": "original", "cwd": "/old"} for n, role in enumerate(m.ROLES, 1)}
    def prepare(self, *args): self.events.append("prepare")
    def capacity(self, old): return {"observed": True}
    def install(self, r): self.events.append("start-candidate")
    def suppress_restart(self, r): self.events.append("suppress-restart")
    def unit_stopped(self, p): return p["pid"] in self.dead
    def candidate_ready(self, r, state):
        self.events.append(f"ready-{state}")
        if self.failure == "candidate": raise m.Incomplete("candidate unhealthy")
    def drain(self, r, role):
        self.events.append(f"drain-{role}")
        if self.failure == f"drain-{role}": raise m.Incomplete("still draining")
        if role == "api": self.dead.add(9)
    def activate(self, r):
        assert "drain-worker" in self.events
        self.events.append("activate-all-queues")
    def alive(self, p): return p["pid"] not in self.dead
    def stop_old(self, r, role):
        if role == "web": assert "drain-api" in self.events and 9 in self.dead
        if role == "api": assert r["old"]["web"]["pid"] in self.dead
        self.events.append(f"stop-{role}")
        self.dead.add(r["old"][role]["pid"])
    def nginx_workers(self): return [{"pid": 9, "start": "nginx-old"}]
    def switch(self, r):
        self.events.append("switch")
        if self.failure == "switch": raise m.Incomplete("nginx -t failed")
    def origin_ready(self, r): self.events.append("origin-ready")
    def rollback(self, r): self.events.append("rollback-verified")
    def finish(self, r): self.events.append("finish")
    def stop_candidate(self, r): self.events.append("stop-candidate")


class OnlineReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="aihot-release-")
        self.root = Path(self.tmp.name)
        self.host = FakeHost(self.root)
        self.manager = m.Releases(self.host)
        # Failure injection must terminate promptly; the real runner retains a bounded wait.
        self.manager.wait = lambda check, seconds=20: check()
    def tearDown(self): self.tmp.cleanup()
    def new(self): return self.manager.new(self.root / "candidate", SHA)

    def test_stage_has_semantic_preview_without_legacy_drain_or_cutover(self):
        r = self.new()
        self.manager.resume(r, SHA, stage=True)
        self.assertEqual(r["phase"], "candidate")
        self.assertEqual(r["cleanup"], "pending")
        self.assertNotIn("drain-worker", self.host.events)
        self.assertNotIn("switch", self.host.events)

    def test_resume_transfers_serial_queues_then_drains_http_in_dependency_order(self):
        r = self.new(); self.manager.resume(r, SHA, stage=True)
        self.manager.resume(r, SHA)
        self.assertEqual(r["status"], "installed")
        self.assertEqual(r["cleanup"], "complete")
        order = ["drain-worker", "stop-worker", "activate-all-queues", "switch", "drain-api", "stop-web", "stop-api", "finish"]
        self.assertEqual(sorted(order, key=self.host.events.index), order)
        before = list(self.host.events)
        self.manager.resume(r, SHA)
        self.assertEqual(before, self.host.events, "completed resume is idempotent")

    def test_failed_candidate_preserves_all_old_services(self):
        r = self.new(); self.host.failure = "candidate"
        with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
        self.assertEqual(r["status"], "blocked")
        self.assertEqual(self.host.dead, set())
        self.assertNotIn("drain-worker", self.host.events)

    def test_worker_timeout_does_not_activate_full_worker_or_switch_http(self):
        r = self.new(); self.host.failure = "drain-worker"
        with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
        self.assertEqual(r["phase"], "worker-drain")
        self.assertNotIn("activate-all-queues", self.host.events)
        self.assertNotIn("switch", self.host.events)
        self.host.failure = None; self.manager.resume(r, SHA)
        self.assertEqual(self.host.events.count("start-candidate"), 1)
        self.assertEqual(r["cleanup"], "complete")

    def test_nginx_failure_keeps_old_http_and_resumes_same_identity(self):
        r = self.new(); self.host.failure = "switch"
        with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
        self.assertEqual(r["phase"], "switch")
        self.assertNotIn("stop-web", self.host.events)
        self.assertNotIn("stop-api", self.host.events)
        self.host.failure = None; self.manager.resume(r, SHA)
        self.assertEqual(self.manager.load(r["id"])["id"], r["id"])

    def test_http_drain_failure_retains_old_web_api_and_cleanup(self):
        r = self.new(); self.host.failure = "drain-api"
        with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
        self.assertEqual(r["phase"], "http-drain")
        self.assertNotIn("stop-web", self.host.events)
        self.assertEqual(r["cleanup"], "pending")

    def test_pending_release_refuses_new_identity(self):
        r = self.new()
        with self.assertRaises(m.Incomplete): self.new()
        self.assertEqual(self.manager.latest(), r["id"])

    def test_wrong_revision_and_changed_config_fail_before_mutation(self):
        r = self.new()
        with self.assertRaises(m.Incomplete): self.manager.resume(r, "b" * 40)
        self.host.config = "changed"
        with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
        self.assertEqual(self.host.events, [])

    def test_status_missing_does_not_create_state(self):
        self.assertIsNone(self.manager.load())
        self.assertFalse(self.manager.state.exists())
        with self.assertRaises(FileNotFoundError): self.manager.load("f" * 8 + "-" + "f" * 27)

    def test_concurrent_operations_cannot_enter_same_target(self):
        with self.manager.lock():
            with self.assertRaises(m.Incomplete):
                with self.manager.lock(): self.fail("entered concurrent deployment")

    def test_slot_alternates_after_completed_cleanup(self):
        r = self.new(); self.manager.resume(r, SHA)
        second = self.new()
        self.assertEqual((r["slot"], second["slot"]), ("blue", "green"))

    def test_abandon_is_identity_bound_and_preserves_previous_active_slot(self):
        active = self.new(); self.manager.resume(active, SHA)
        candidate = self.new(); self.manager.resume(candidate, SHA, stage=True)
        with self.assertRaises(m.Incomplete): self.manager.abandon(candidate, "b" * 40, "failed acceptance")
        self.manager.abandon(candidate, SHA, "failed acceptance")
        self.assertEqual(candidate["status"], "abandoned")
        with self.assertRaises(m.Incomplete): self.manager.resume(candidate, SHA)
        replacement = self.new()
        self.assertEqual(replacement["slot"], candidate["slot"])
        self.assertEqual(replacement["previous_slot"], active["slot"])

    def test_abandon_rejects_after_business_handover(self):
        r = self.new(); self.host.failure = "drain-worker"
        with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
        with self.assertRaises(m.Incomplete): self.manager.abandon(r, SHA, "cancel")
        self.assertNotIn("stop-candidate", self.host.events)

    def test_private_semantic_override_is_bound_and_rejects_other_credentials(self):
        host = m.Host(self.root)
        shared = self.root / "shared"; shared.mkdir()
        for name in ("app.env", "web.env"): (shared / name).write_text("SAFE=fixture\n")
        override = shared / "semantic.env"; override.write_text("RESEARCH_SEMANTIC_MODEL=fixture\n"); override.chmod(0o600)
        first = host.config_id(str(override))
        override.write_text("RESEARCH_SEMANTIC_MODEL=changed\n")
        self.assertNotEqual(first, host.config_id(str(override)))
        override.write_text("API_KEY=must-not-be-accepted\n")
        with self.assertRaises(m.Incomplete): host.config_id(str(override))
        override.write_text("RESEARCH_SEMANTIC_MODEL=fixture\n"); override.chmod(0o644)
        with self.assertRaises(m.Incomplete): host.config_id(str(override))

    def test_prepared_marker_does_not_bypass_schema_compatibility(self):
        host = m.Host(self.root)
        candidate = self.root / "releases/new"; candidate.mkdir(parents=True)
        old = self.root / "releases/old"; old.mkdir()
        for folder in (candidate, old): (folder / "database/migrations").mkdir(parents=True)
        (candidate / "REVISION").write_text(SHA)
        (candidate / "package-lock.json").write_text("{}")
        (candidate / ".online-prepared.json").write_text(json.dumps({"revision": SHA, "lock": m.sha(candidate / "package-lock.json")}))
        (candidate / "database/migrations/new.sql").write_text("SELECT 1;")
        with self.assertRaises(m.Incomplete): host.prepare(candidate, SHA, {"api": {"cwd": str(old)}, "web": {"cwd": str(old / "apps/web")}})

    def test_nginx_validation_failure_restores_disk_config_without_reload(self):
        host = m.Host(self.root); host.nginx = self.host.nginx
        release = self.root / "release"; (release / "deploy/production").mkdir(parents=True)
        (release / "deploy/production/news.conf").write_text("proxy_pass http://127.0.0.1:3000;")
        folder = self.root / "record"; folder.mkdir(); (folder / "previous-nginx.conf").write_text("old"); host.nginx.write_text("old")
        calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            if args == ("sudo", "nginx", "-t"): raise m.Incomplete("invalid nginx")
            return ""
        with patch.object(m, "run", fake):
            with self.assertRaises(m.Incomplete): host.switch({"path": str(release), "folder": str(folder), "slot": "blue"})
        self.assertFalse(any("reload" in x for x in calls))
        self.assertEqual(calls[-1][-2:], (folder / "previous-nginx.conf", host.nginx))

    def test_missing_old_pid_still_requires_stopping_its_unit(self):
        host = m.Host(self.root)
        r = self.new()
        calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            return "no" if "Restart" in args else ""
        with patch.object(host, "process", return_value=None), patch.object(host, "alive", return_value=False), patch.object(m, "run", fake):
            host.stop_old(r, "worker")
        self.assertTrue(any("stop" in args and "old-worker" in args for args in calls))

    def test_unit_terminal_state_is_required_before_candidate_activation(self):
        r = self.new()
        self.host.unit_stopped = lambda p: False
        def wait(check, seconds=20):
            if check() is False: raise m.Incomplete("unit has not stopped")
        self.manager.wait = wait
        with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
        self.assertIn("suppress-restart", self.host.events)
        self.assertNotIn("activate-all-queues", self.host.events)

    def test_active_index_write_failure_stays_resumable(self):
        r = self.new()
        original = m.atomic
        def fail_active(path, value):
            if path == self.manager.state / "active": raise OSError("injected active index failure")
            return original(path, value)
        with patch.object(m, "atomic", fail_active):
            with self.assertRaises(OSError): self.manager.resume(r, SHA)
        saved = self.manager.load(r["id"])
        self.assertEqual(saved["phase"], "finish")
        self.assertEqual(saved["cleanup"], "pending")
        self.manager.resume(saved, SHA)
        self.assertEqual((self.manager.state / "active").read_text(), r["id"])
        self.assertEqual(saved["status"], "installed")

    def test_origin_failure_restores_old_route_and_recaptures_workers_on_resume(self):
        r = self.new()
        original = self.host.origin_ready
        self.host.origin_ready = lambda r: (_ for _ in ()).throw(m.Incomplete("candidate origin unhealthy"))
        with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
        self.assertIn("rollback-verified", self.host.events)
        self.assertNotIn("stop-web", self.host.events)
        self.host.origin_ready = original
        self.host.nginx_workers = lambda: [{"pid": 10, "start": "after-rollback"}]
        self.host.dead.add(10)
        self.manager.resume(r, SHA)
        self.assertEqual(r["nginxWorkers"], [{"pid": 10, "start": "after-rollback"}])

    def test_unit_state_rejects_restart_wait_pending_jobs_and_replacement_pid(self):
        host = m.Host(self.root)
        cases = [("inactive", "dead", "0", "", True), ("failed", "failed", "0", "0", True),
                 ("activating", "auto-restart", "0", "", False), ("inactive", "dead", "0", "42", False),
                 ("active", "running", "42", "", False), ("inactive", "dead", "0", None, False)]
        for active, sub, pid, job, expected in cases:
            with self.subTest(active=active, sub=sub, pid=pid, job=job):
                response = f"MainPID={pid}\nActiveState={active}\nSubState={sub}\n" + (f"Job={job}\n" if job is not None else "")
                with patch.object(m, "run", return_value=response):
                    self.assertEqual(host.unit_stopped({"unit": "old-worker"}), expected)

    def test_restart_guard_checks_identity_and_removes_only_its_own_dropin(self):
        host = m.Host(self.root); r = self.new(); old = r["old"]["worker"]
        target = self.root / "guard.conf"; calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("sudo", "install"): Path(args[-1]).write_bytes(Path(args[-2]).read_bytes())
            if args[:2] == ("sudo", "rm"): Path(args[-1]).unlink()
            return "no" if "Restart" in args else ""
        with patch.object(host, "restart_guard", return_value=target), patch.object(m, "run", fake), patch.object(host, "unit_stopped", return_value=True):
            with patch.object(host, "process", side_effect=[old, {**old, "pid": 999}]):
                with self.assertRaises(m.Incomplete): host.suppress_restart(r)
            with patch.object(host, "process", return_value=old): host.suppress_restart(r)
            self.assertIn(r["id"], target.read_text())
            host.release_restart_guard(r)
            self.assertFalse(target.exists())
            target.write_text("another release")
            with self.assertRaises(m.Incomplete): host.release_restart_guard(r)
            self.assertTrue(target.exists())

    def test_completed_drain_can_resume_after_exit_but_not_with_replacement_pid(self):
        host = m.Host(self.root); r = self.new(); old = r["old"]["worker"]
        target = self.root / "guard.conf"; target.write_text(f"# AIHOT release {r['id']}\n[Service]\nRestart=no\n")
        marker = Path(r["folder"]) / "drain-worker.json"
        marker.write_text(json.dumps({"id": r["id"], "pid": old["pid"], "start": old["start"], "status": "drained"}))
        with patch.object(host, "restart_guard", return_value=target), patch.object(m, "run", return_value="no"):
            with patch.object(host, "process", return_value=None): host.suppress_restart(r)
            with patch.object(host, "process", return_value={**old, "pid": 999}):
                with self.assertRaises(m.Incomplete): host.suppress_restart(r)
            marker.write_text(json.dumps({"id": "other", "status": "drained"}))
            with patch.object(host, "process", return_value=None):
                with self.assertRaises(m.Incomplete): host.suppress_restart(r)

    def test_real_rollback_restores_reloads_and_checks_old_origin_identity(self):
        host = m.Host(self.root); host.nginx = self.host.nginx; r = self.new(); calls = []
        config = Path(r["path"]) / "deploy/production/news.conf"
        config.parent.mkdir(parents=True); config.write_text("proxy_pass http://127.0.0.1:3000;")
        def fake(*args, **kwargs):
            calls.append(args)
            return json.dumps({"db": "ok", "release": "old-revision"}) if args[0] == "curl" else ""
        with patch.object(m, "run", fake), patch.object(host, "process", side_effect=lambda unit: next(p for p in r["old"].values() if p["unit"] == unit)):
            host.rollback(r)
        actions = [args[:3] for args in calls]
        self.assertLess(actions.index(("sudo", "install", "-m")), actions.index(("sudo", "nginx", "-t")))
        self.assertLess(actions.index(("sudo", "nginx", "-t")), actions.index(("sudo", "systemctl", "reload")))
        self.assertIn("--resolve", calls[-1])
        def wrong_origin(*args, **kwargs):
            if args[0] != "curl": return ""
            return json.dumps({"db": "ok", "release": "candidate" if "--resolve" in args else "old-revision"})
        with patch.object(m, "run", wrong_origin), patch.object(host, "process", side_effect=lambda unit: next(p for p in r["old"].values() if p["unit"] == unit)), patch.object(m.time, "monotonic", side_effect=[0, 11]):
            with self.assertRaises(m.Incomplete): host.rollback(r)

    def test_external_nginx_config_survives_switch_failure_and_pending_resume(self):
        r = self.new(); r["phase"] = "switch"
        config = Path(r["path"]) / "deploy/production/news.conf"
        config.parent.mkdir(parents=True); config.write_text("proxy_pass http://127.0.0.1:3000;")
        host = m.Host(self.root); host.nginx = self.host.nginx
        self.host.switch = host.switch; self.host.rollback = host.rollback
        self.host.nginx.write_text("external operator config")
        calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            if args[0] == "curl": return json.dumps({"db": "ok", "release": "old"})
            if args[:2] == ("sudo", "install"): Path(args[-1]).write_text(Path(args[-2]).read_text())
            return ""
        with patch.object(m, "run", fake), patch.object(host, "process", side_effect=lambda unit: next(p for p in r["old"].values() if p["unit"] == unit)):
            for _ in range(2):
                with self.assertRaises(m.Incomplete): self.manager.resume(r, SHA)
                self.assertEqual(self.host.nginx.read_text(), "external operator config")
                self.assertFalse(any("reload" in args or "install" in args for args in calls))


if __name__ == "__main__": unittest.main()
