#!/usr/bin/env python3
"""Single-host online release coordinator. See production.md, service-release/v1 mapped contract."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

TARGET = "aihot/tencent-news"
BASE = Path("/home/ubuntu/aihot")
ROLES = ("api", "web", "worker")
PORTS = {"blue": (3101, 3100), "green": (3201, 3200)}


class Incomplete(RuntimeError):
    pass


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".next")
    with tmp.open("w") as f:
        os.chmod(tmp, 0o600)
        f.write(value if isinstance(value, str) else json.dumps(value, indent=2))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*args, timeout=30, check=True):
    # Never include child output in an exception: providers/env loaders can print credentials.
    p = subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=timeout)
    if check and p.returncode:
        raise Incomplete(f"{Path(str(args[0])).name} failed (exit {p.returncode}); inspect service state locally")
    return p.stdout.strip()


class Host:
    def __init__(self, base=BASE):
        self.base = base
        self.nginx = Path("/etc/nginx/sites-available/news.conf")

    def config_id(self, override=None):
        files = [self.base / "shared" / f for f in ("app.env", "web.env")]
        if override:
            path = Path(override).resolve(strict=True)
            if not path.is_relative_to((self.base / "shared").resolve()) or path.stat().st_mode & 0o077:
                raise Incomplete("Candidate override must be a private file under shared/ (mode 0600 or stricter)")
            allowed = {"TOKEN_SHA256", "MODEL", "DIMS", "PROFILE", "PROVIDER", "ROUTE", "ACTUAL_MODEL", "REGISTRY_REVISION"}
            for line in path.read_text().splitlines():
                if not line.strip() or line.lstrip().startswith("#"): continue
                key, separator, _ = line.partition("=")
                if not separator or key.strip() not in {"RESEARCH_SEMANTIC_" + x for x in allowed}:
                    raise Incomplete("Candidate override contains an unsupported key or multiline value")
            files.append(path)
        return hashlib.sha256(json.dumps({str(f): sha(f) for f in files}, sort_keys=True).encode()).hexdigest()

    def process(self, unit):
        pid = int(run("systemctl", "show", unit, "-p", "MainPID", "--value") or 0)
        if not pid:
            return None
        proc = Path(f"/proc/{pid}")
        start = (proc / "stat").read_text().split(") ")[1].split()[19]
        cwd = str((proc / "cwd").resolve(strict=True))
        return {"unit": unit, "pid": pid, "start": start, "cwd": cwd}

    def alive(self, p):
        try:
            return Path(f"/proc/{p['pid']}/stat").read_text().split(") ")[1].split()[19] == p["start"]
        except FileNotFoundError:
            return False

    def snapshot(self, active):
        result = {}
        for role in ROLES:
            unit = f"aihot-{role}-{active['slot']}.service" if active else f"aihot-{role}.service"
            p = self.process(unit)
            if not p:
                raise Incomplete(f"Expected live {role} ({unit}); no online upgrade attempted")
            result[role] = p
        return result

    def capacity(self, old):
        memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        available = int(memory["MemAvailable"].split()[0]) * 1024
        rss = 0
        for proc in old.values():
            lines = dict(line.split(":", 1) for line in Path(f"/proc/{proc['pid']}/status").read_text().splitlines() if ":" in line)
            rss += int(lines["VmRSS"].split()[0]) * 1024
        roots = {Path(proc["cwd"]).parents[1] if role == "web" else Path(proc["cwd"]) for role, proc in old.items()}
        release_bytes = max(int(run("du", "-sb", path, timeout=60).split()[0]) for path in roots)
        free = shutil.disk_usage(self.base).free
        # This is measured headroom for another current-sized instance/release, not a peak-memory SLA.
        if available < rss or free < release_bytes:
            raise Incomplete("Insufficient measured headroom for another current-sized release/instance; old services retained")
        return {"availableMemoryBytes": available, "currentRssBytes": rss, "freeDiskBytes": free, "currentReleaseBytes": release_bytes}

    def runtime(self, r):
        slots = [r["slot"]] if r else []
        units = [f"aihot-{role}-{slot}.service" for slot in slots for role in ROLES] if slots else [f"aihot-{role}.service" for role in ROLES]
        if r and r["cleanup"] != "complete": units += [p["unit"] for p in r["old"].values()]
        return [{"unit": unit, "process": self.process(unit)} for unit in dict.fromkeys(units)]

    def verify_revision(self, release, expected):
        if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", expected or ""):
            raise Incomplete("--expect requires a complete immutable Git revision")
        if not release.is_relative_to((self.base / "releases").resolve()):
            raise Incomplete("Release must be a fixed directory under releases/, not current")
        if (release / ".git").exists():
            actual = run("git", "-C", release, "rev-parse", "HEAD")
            if run("git", "-C", release, "status", "--porcelain"):
                raise Incomplete("Release worktree is dirty")
        else:
            actual = (release / "REVISION").read_text().strip()
        if actual != expected:
            raise Incomplete("Fixed release revision mismatch")

    def prepare(self, release, expected, old):
        self.verify_revision(release, expected)
        if old:
            previous = Path(old["api"]["cwd"]) / "database/migrations"
            current = release / "database/migrations"
            fingerprints = lambda folder: {str(f.relative_to(folder)): sha(f) for f in folder.rglob("*.sql")}
            if fingerprints(previous) != fingerprints(current):
                raise Incomplete("Database migrations differ from the serving API; prepare a separately reviewed compatible migration")
        prepared = release / ".online-prepared.json"
        metadata = json.loads(prepared.read_text()) if prepared.exists() else {}
        built = metadata.get("revision") == expected and metadata.get("lock") == sha(release / "package-lock.json") and (release / "apps/web/build/server/index.js").is_file()
        previous_web = old["web"]["cwd"] if old else None
        if built and (not old or previous_web == str(release / "apps/web") or metadata.get("assetsFrom") == previous_web):
            return  # Reuse is read-only, including an online same-version restart.
        for proc in Path("/proc").glob("[0-9]*/cwd"):
            try:
                cwd = proc.resolve(strict=True)
                if (cwd == release or cwd.is_relative_to(release)) and proc.parent.name not in (str(os.getpid()), str(os.getppid())):
                    raise Incomplete("A running process still uses this release; build a new directory")
            except (FileNotFoundError, PermissionError):
                pass
        if not built:
            run("npm", "ci", "--prefix", release, "--no-audit", "--no-fund", timeout=600)
            p = subprocess.run(["npm", "run", "build", "-w", "@aihot/web"], cwd=release, capture_output=True, timeout=600)
            if p.returncode: raise Incomplete("Web build failed; old release is still serving")
        assets = release / "apps/web/build/client/assets"
        if previous_web:
            previous = Path(previous_web) / "build/client/assets"
            if previous.exists():
                for src in previous.rglob("*"):
                    if src.is_file():
                        dest = assets / src.relative_to(previous)
                        if not dest.exists():
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(src, dest)
        atomic(prepared, {"revision": expected, "lock": sha(release / "package-lock.json"), "assetsFrom": previous_web})

    def install(self, r):
        release, folder = Path(r["path"]), Path(r["folder"])
        api, web = PORTS[r["slot"]]
        for role in ROLES:
            existing = self.process(f"aihot-{role}-{r['slot']}.service")
            expected_cwd = str(release / "apps/web" if role == "web" else release)
            if existing and existing["cwd"] != expected_cwd:
                raise Incomplete("Candidate slot still belongs to another release; finish its cleanup first")
        for role in ROLES:
            unit = f"aihot-{role}-{r['slot']}.service"
            cwd = release / "apps/web" if role == "web" else release
            env = "web.env" if role == "web" else "app.env"
            command = "server.ts" if role == "web" else f"apps/{role}/src/main.ts"
            extra = f"Environment=AIHOT_RELEASE={r['revision']}\n"
            if role == "api": extra += f"Environment=API_PORT={api}\nEnvironment=API_HOST=127.0.0.1\n"
            if role == "web": extra += f"Environment=WEB_PORT={web}\nEnvironment=WEB_HOST=127.0.0.1\nEnvironment=API_BASE_URL=http://127.0.0.1:{api}\n"
            if role == "worker": extra += f"Environment=AIHOT_WORKER_READY_FILE={folder}/worker.json\nEnvironment=AIHOT_WORKER_GATE_FILE={folder}/activate\n"
            # Merely specifying an inspector port does not open it; each drain closes its listener.
            debug = {"api": 9231, "web": 9233, "worker": 9232}[role]
            override = f" --env-file={r['override']}" if r.get("override") and role != "web" else ""
            text = f"[Unit]\nDescription=AI Radar {role} ({r['slot']})\nAfter=network.target postgresql.service\n[Service]\nType=simple\nUser=ubuntu\nWorkingDirectory={cwd}\n{extra}ExecStart=/usr/local/bin/node --inspect-port=127.0.0.1:{debug} --env-file={self.base}/shared/{env}{override} {command}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=infinity\nSendSIGKILL=no\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n"
            file = folder / unit
            atomic(file, text)
            run("sudo", "install", "-m", "0644", file, f"/etc/systemd/system/{unit}")
        run("sudo", "systemctl", "daemon-reload")
        run("sudo", "systemctl", "start", *(f"aihot-{role}-{r['slot']}.service" for role in ROLES))

    def candidate_ready(self, r, worker_state):
        api, web = PORTS[r["slot"]]
        for port in (api, web):
            response = json.loads(run("curl", "-fsS", "--max-time", "5", f"http://127.0.0.1:{port}/api/health"))
            if response.get("release") != r["revision"] or response.get("db") != "ok":
                raise Incomplete("Candidate API/Web release or database health mismatch")
        run("curl", "-fsS", "--max-time", "10", f"http://127.0.0.1:{web}/")
        status = json.loads((Path(r["folder"]) / "worker.json").read_text())
        p = self.process(f"aihot-worker-{r['slot']}.service")
        if not p or status.get("pid") != p["pid"] or status.get("release") != r["revision"] or status.get("state") != worker_state:
            raise Incomplete("Candidate worker is not ready in the expected phase")

    def drain(self, r, role):
        p = r["old"][role]
        current = self.process(p["unit"])
        if current and current != p:
            raise Incomplete("Old service has restarted; inspect its identity before proceeding")
        if not self.alive(p):
            # Process disappearance is not proof that its work settled.
            marker = Path(r["folder"]) / f"drain-{role}.json"
            if marker.exists() and json.loads(marker.read_text()).get("status") == "drained": return
            raise Incomplete(f"Old {role} identity disappeared before drain was verified")
        port = (9232 if role == "worker" else 9231) if "-blue." in p["unit"] or "-green." in p["unit"] else 9229
        argv = ["/usr/local/bin/node", str(Path(r["path"]) / "deploy/production/drain-inspector.mjs"), "--kind", "worker" if role == "worker" else "http", "--pid", str(p["pid"]), "--start", p["start"], "--cwd", p["cwd"], "--port", str(port), "--id", r["id"], "--state", str(Path(r["folder"]) / f"drain-{role}.json"), "--wait-seconds", "45"]
        if role == "api": argv += ["--api-port", str(PORTS[r["previous_slot"]][0] if r.get("previous_slot") else 3001)]
        run(*argv, timeout=55)

    def restart_guard(self, r):
        unit = r["old"]["worker"]["unit"]
        return Path(f"/etc/systemd/system/{unit}.d/online-restart-{r['id']}.conf")

    def suppress_restart(self, r):
        p = r["old"]["worker"]
        target = self.restart_guard(r)
        text = f"# AIHOT release {r['id']}\n[Service]\nRestart=no\n"
        current = self.process(p["unit"])
        # Do not let a completed drain receipt authorize a newly restarted process.
        if current is None and target.exists() and target.read_text() == text:
            marker = Path(r["folder"]) / "drain-worker.json"
            done = json.loads(marker.read_text()) if marker.exists() else {}
            if all(done.get(k) == v for k, v in {"id": r["id"], "pid": p["pid"], "start": p["start"], "status": "drained"}.items()) and run("systemctl", "show", p["unit"], "-p", "Restart", "--value") == "no":
                return  # Verified completed work; stop_old still cancels the unit and checks its terminal state.
        if current != p:
            raise Incomplete("Old worker identity changed before restart suppression; inspect its work before proceeding")
        if target.exists() and target.read_text() != text:
            raise Incomplete("Restart guard belongs to another operation")
        file = Path(r["folder"]) / "worker-restart-guard.conf"
        atomic(file, text)
        run("sudo", "mkdir", "-p", target.parent)
        run("sudo", "install", "-m", "0644", file, target)
        run("sudo", "systemctl", "daemon-reload")
        if self.process(p["unit"]) != p or run("systemctl", "show", p["unit"], "-p", "Restart", "--value") != "no":
            raise Incomplete("Worker identity or restart suppression could not be confirmed; candidate remains gated")

    def unit_stopped(self, p):
        data = run("systemctl", "show", p["unit"], "-p", "MainPID", "-p", "ActiveState", "-p", "SubState", "-p", "Job")
        state = dict(line.split("=", 1) for line in data.splitlines() if "=" in line)
        return state.get("MainPID") == "0" and state.get("ActiveState") in ("inactive", "failed") and state.get("SubState") in ("dead", "failed") and state.get("Job") in ("", "0")

    def release_restart_guard(self, r):
        target = self.restart_guard(r)
        if target.exists():
            expected = f"# AIHOT release {r['id']}\n[Service]\nRestart=no\n"
            if target.read_text() != expected:
                raise Incomplete("Restart guard ownership changed; cleanup refused")
            run("sudo", "rm", "--", target)
            run("sudo", "systemctl", "daemon-reload")
        if not self.unit_stopped(r["old"]["worker"]):
            raise Incomplete("Old worker unit is not stopped after guard cleanup")

    def activate(self, r):
        atomic(Path(r["folder"]) / "activate", r["revision"])

    def nginx_workers(self):
        master = int(Path("/run/nginx.pid").read_text())
        pids = run("pgrep", "-P", str(master)).splitlines()
        workers = [{"pid": int(pid), "start": Path(f"/proc/{pid}/stat").read_text().split(") ")[1].split()[19]} for pid in pids if Path(f"/proc/{pid}/cmdline").read_bytes().startswith(b"nginx: worker process")]
        if not workers: raise Incomplete("No Nginx worker identity could be captured")
        return workers

    def nginx_source(self, r):
        api, web = PORTS[r["slot"]]
        return (Path(r["path"]) / "deploy/production/news.conf").read_text().replace("127.0.0.1:3001", f"127.0.0.1:{api}").replace("127.0.0.1:3000", f"127.0.0.1:{web}")

    def check_nginx_owner(self, r):
        previous = (Path(r["folder"]) / "previous-nginx.conf").read_text()
        if self.nginx.read_text() not in (previous, self.nginx_source(r)):
            raise Incomplete("Nginx news configuration changed outside this release; refusing to overwrite it")

    def switch(self, r):
        source = self.nginx_source(r)
        candidate = Path(r["folder"]) / "news.conf"
        self.check_nginx_owner(r)
        atomic(candidate, source)
        run("sudo", "install", "-m", "0644", candidate, str(self.nginx) + ".next")
        run("sudo", "mv", str(self.nginx) + ".next", self.nginx)
        try:
            run("sudo", "nginx", "-t")
            run("sudo", "systemctl", "reload", "nginx")
        except Exception:
            self.check_nginx_owner(r)
            run("sudo", "install", "-m", "0644", Path(r["folder"]) / "previous-nginx.conf", self.nginx)
            raise

    def origin_ready(self, r):
        data = json.loads(run("curl", "-fsS", "--max-time", "5", "--resolve", "news.aiplanet.live:443:127.0.0.1", "https://news.aiplanet.live/api/health"))
        if data.get("release") != r["revision"] or data.get("db") != "ok":
            raise Incomplete("Origin has not confirmed the candidate revision; both versions retained")

    def rollback(self, r):
        # Old HTTP instances remain live until successful cutover and request drainage.
        self.check_nginx_owner(r)
        for role in ("api", "web"):
            if self.process(r["old"][role]["unit"]) != r["old"][role]:
                raise Incomplete("Old HTTP identity changed; rollback cannot be verified")
        api = PORTS[r["previous_slot"]][0] if r.get("previous_slot") else 3001
        old = json.loads(run("curl", "-fsS", "--max-time", "5", f"http://127.0.0.1:{api}/api/health"))
        if old.get("db") != "ok" or not old.get("release"):
            raise Incomplete("Old API readiness is unknown; rollback retained for inspection")
        self.check_nginx_owner(r)
        run("sudo", "install", "-m", "0644", Path(r["folder"]) / "previous-nginx.conf", self.nginx)
        run("sudo", "nginx", "-t")
        run("sudo", "systemctl", "reload", "nginx")
        end = time.monotonic() + 10
        while True:
            try:
                restored = json.loads(run("curl", "-fsS", "--max-time", "5", "--resolve", "news.aiplanet.live:443:127.0.0.1", "https://news.aiplanet.live/api/health"))
                if restored.get("db") == "ok" and restored.get("release") == old["release"]: return
            except (Incomplete, ValueError, subprocess.TimeoutExpired):
                pass
            if time.monotonic() >= end:
                raise Incomplete("Old route restoration was not verified; keep both HTTP instances")
            time.sleep(0.5)

    def stop_old(self, r, role):
        p = r["old"][role]
        current = self.process(p["unit"])
        if current and current != p: raise Incomplete("Old service identity changed; refusing to stop its replacement")
        if role == "worker" and run("systemctl", "show", p["unit"], "-p", "Restart", "--value") != "no":
            raise Incomplete("Old worker restart guard is not effective; candidate remains gated")
        # Legacy units have unsafe short timeouts. Override only after their work is drained.
        file = Path(r["folder"]) / f"{role}-drain.conf"
        atomic(file, "[Service]\nTimeoutStopSec=infinity\nSendSIGKILL=no\n")
        run("sudo", "mkdir", "-p", f"/etc/systemd/system/{p['unit']}.d")
        run("sudo", "install", "-m", "0644", file, f"/etc/systemd/system/{p['unit']}.d/online-drain.conf")
        run("sudo", "systemctl", "daemon-reload")
        run("sudo", "systemctl", "stop", "--no-block", p["unit"])

    def stop_candidate(self, r):
        # A pre-switch candidate may have paid preview work: stop its worker gracefully, never kill.
        live = {role: self.process(f"aihot-{role}-{r['slot']}.service") for role in ROLES}
        for role, proc in live.items():
            expected = str(Path(r["path"]) / "apps/web" if role == "web" else Path(r["path"]))
            if proc and proc["cwd"] != expected: raise Incomplete("Candidate ownership changed; abandon refused")
        if live["api"]:
            self.drain({**r, "old": {"api": live["api"]}, "previous_slot": r["slot"]}, "api")
        for role in ("worker", "web", "api"):
            proc = live[role]
            if not proc: continue
            run("sudo", "systemctl", "stop", "--no-block", proc["unit"])
            end = time.monotonic() + 20
            while self.alive(proc):
                if time.monotonic() > end: raise Incomplete("Candidate still draining; repeat abandon with this ID")
                time.sleep(0.5)

    def finish(self, r):
        current = self.base / "current.next"
        current.unlink(missing_ok=True)
        current.symlink_to(r["path"])
        os.replace(current, self.base / "current")
        run("sudo", "systemctl", "enable", *(f"aihot-{role}-{r['slot']}.service" for role in ROLES))
        run("sudo", "systemctl", "disable", *(r["old"][role]["unit"] for role in ROLES))
        self.release_restart_guard(r)


class Releases:
    def __init__(self, host, state=None):
        self.host = host
        self.state = state or host.base / "shared/online-releases"

    @contextlib.contextmanager
    def lock(self):
        self.state.mkdir(parents=True, exist_ok=True)
        with (self.state / "lock").open("a") as f:
            try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise Incomplete("Another release operation is active; query status and resume its ID")
            yield

    def latest(self):
        path = self.state / "latest"
        return path.read_text().strip() if path.exists() else None

    def load(self, ident=None):
        ident = ident or self.latest()
        if ident is None: return None
        if not re.fullmatch(r"[0-9a-f-]{36}", ident): raise Incomplete("Invalid release ID")
        return json.loads((self.state / ident / "release.json").read_text())

    def save(self, r):
        r["updatedAt"] = time.time()
        atomic(Path(r["folder"]) / "release.json", r)

    def new(self, release, expected, override=None):
        prior = self.load()
        if prior and prior["cleanup"] != "complete": raise Incomplete(f"Release {prior['id']} is incomplete; resume it")
        self.host.verify_revision(release, expected)
        active_file = self.state / "active"
        active = self.load(active_file.read_text().strip()) if active_file.exists() else prior if prior and prior["status"] == "installed" else None
        ident = str(uuid.uuid4())
        r = {"id": ident, "revision": expected, "path": str(release), "folder": str(self.state / ident), "slot": "green" if active and active["slot"] == "blue" else "blue", "previous_slot": active["slot"] if active else None, "status": "running", "cleanup": "pending", "phase": "prepare", "config": self.host.config_id(override), "override": override, "old": self.host.snapshot(active), "nodes": [{"id": "tencent", "status": "pending"}]}
        self.save(r)
        atomic(Path(r["folder"]) / "previous-nginx.conf", self.host.nginx.read_text())
        atomic(self.state / "latest", ident)
        return r

    def abandon(self, r, expected, reason):
        if r["revision"] != expected or not reason or not reason.strip(): raise Incomplete("abandon requires matching --expect and nonempty --reason")
        if r["status"] == "abandoned": return r
        if r["phase"] not in ("prepare", "start", "candidate", "abandon"):
            raise Incomplete("Business handover has started; resume this release instead of abandoning it")
        r.update(status="abandoning", phase="abandon", reason=reason); self.save(r)
        self.host.stop_candidate(r)
        r.update(status="abandoned", cleanup="complete"); self.save(r)
        return r

    def wait(self, check, seconds=20):
        end = time.monotonic() + seconds
        while True:
            try:
                if check() is not False: return
            except (Incomplete, FileNotFoundError, json.JSONDecodeError):
                pass
            if time.monotonic() >= end: raise Incomplete("Release wait incomplete; existing instances retained, resume the same ID")
            time.sleep(0.5)

    def resume(self, r, expected, stage=False):
        if r["status"] in ("abandoning", "abandoned"): raise Incomplete("An abandoned release cannot be resumed")
        if r["revision"] != expected: raise Incomplete("Resume revision does not match this release")
        if self.host.config_id(r.get("override")) != r["config"]: raise Incomplete("Shared configuration changed; original release retained")
        if r["cleanup"] == "complete": return r
        try:
            if r["phase"] == "prepare":
                r["capacity"] = self.host.capacity(r["old"]); self.save(r)
                self.host.prepare(Path(r["path"]), expected, r["old"])
                r["phase"] = "start"; self.save(r)
            if r["phase"] == "start":
                self.host.install(r)
                r["phase"] = "candidate"; self.save(r)
            if r["phase"] == "candidate":
                self.wait(lambda: self.host.candidate_ready(r, "standby"))
                if stage:
                    r["status"] = "blocked"; r["reason"] = "Candidate ready for acceptance; resume this release to transfer existing business queues and HTTP"; self.save(r); return r
                r["phase"] = "worker-drain"; self.save(r)
            if r["phase"] == "worker-drain":
                self.host.suppress_restart(r)
                self.host.drain(r, "worker")
                r["phase"] = "activate"; self.save(r)
            if r["phase"] == "activate":
                self.host.stop_old(r, "worker")
                self.wait(lambda: self.host.unit_stopped(r["old"]["worker"]))
                self.host.activate(r)
                self.wait(lambda: self.host.candidate_ready(r, "ready"))
                r["phase"] = "switch"; self.save(r)
            if r["phase"] == "switch":
                if r.get("rollback") == "pending":
                    self.host.rollback(r)
                    r["rollback"] = "verified"; self.save(r)
                # Every retry may follow a verified rollback with a different worker generation.
                r["nginxWorkers"] = self.host.nginx_workers(); self.save(r)
                try:
                    self.host.switch(r)
                    self.wait(lambda: self.host.origin_ready(r))
                except Exception:
                    r["rollback"] = "pending"; self.save(r)
                    self.host.rollback(r)
                    r["rollback"] = "verified"; self.save(r)
                    raise
                r["rollback"] = None
                r["phase"] = "http-drain"; self.save(r)
            if r["phase"] == "http-drain":
                self.host.drain(r, "api")
                self.wait(lambda: all(not self.host.alive(p) for p in r["nginxWorkers"]), 45)
                self.host.stop_old(r, "web")
                self.wait(lambda: self.host.unit_stopped(r["old"]["web"]))
                self.host.stop_old(r, "api")
                self.wait(lambda: self.host.unit_stopped(r["old"]["api"]))
                r["phase"] = "finish"; self.save(r)
            if r["phase"] == "finish":
                self.host.origin_ready(r)
                self.host.candidate_ready(r, "ready")
                self.host.finish(r)
                atomic(self.state / "active", r["id"])
                r.update(status="installed", cleanup="complete", phase="complete", reason=None)
                r["nodes"][0]["status"] = "installed"; self.save(r)
        except Exception as error:
            r["status"] = "blocked"; r["reason"] = str(error); self.save(r)
            raise
        return r


def main():
    p = argparse.ArgumentParser(description="AI Radar online deployment; preserves in-flight work and fixes one release ID/revision")
    p.add_argument("action", choices=["install", "start", "restart", "stage", "resume", "abandon", "status", "prepare", "stop", "uninstall"])
    p.add_argument("--expect")
    p.add_argument("--id")
    p.add_argument("--reason")
    p.add_argument("--override-env", help="Private candidate-only semantic configuration under shared/")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    host = Host(); releases = Releases(host)
    r = None
    try:
        if a.action in ("stop", "uninstall"):
            raise Incomplete("This instance requires continuous availability. stop/uninstall are disabled; an explicitly approved maintenance/retirement procedure is required")
        if a.action == "status": r = releases.load(a.id)
        else:
            with releases.lock():
                if a.action in ("resume", "abandon"):
                    if not a.id: raise Incomplete("resume/abandon require --id and --expect")
                    r = releases.load(a.id)
                    if a.id != releases.latest(): raise Incomplete("Only the current release may be resumed")
                else:
                    release = Path(__file__).resolve().parents[2]
                    if a.action == "prepare":
                        host.prepare(release, a.expect, None)
                        print("Release built without migrations, seed, service restart or traffic switch")
                        return 0
                    r = releases.new(release, a.expect, a.override_env)
                if a.action == "abandon": releases.abandon(r, a.expect, a.reason)
                else: releases.resume(r, a.expect, stage=a.action == "stage")
        runtime = host.runtime(r) if a.action == "status" else None
        result = {"runtime": runtime, "contract": "service-release/v1", "target": TARGET, "release": {k: v for k, v in r.items() if k not in ("config", "old")} if r else None}
        if a.json: print(json.dumps(result))
        elif r:
            api, web = PORTS[r["slot"]]
            print(f"AI Radar {r['status']}: release {r['id']} / {r['revision']}\nPhase: {r['phase']}; cleanup: {r['cleanup']}; candidate API/Web: 127.0.0.1:{api}/{web}\n{r.get('reason') or 'Installed; public consumer continuity must also be verified during this release.'}")
        else: print("No managed online release record. Legacy process health is not inferred from this result.")
        if runtime is not None and not a.json:
            for item in runtime:
                proc = item["process"]
                print(f"{item['unit']}: " + (f"PID {proc['pid']}, cwd {proc['cwd']} (process observed; consumer health not inferred)" if proc else "no running process"))
        return 0 if a.action == "status" or r and r["cleanup"] == "complete" or a.action == "stage" and r["phase"] == "candidate" else 4
    except (Incomplete, FileNotFoundError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"AI Radar release incomplete: {error}. Existing progress is retained; use status then resume --id ID --expect SHA.", file=sys.stderr)
        if r:
            print(json.dumps({"id": r["id"], "phase": r["phase"], "status": r["status"]}), file=sys.stderr)
            if a.json: print(json.dumps({"contract": "service-release/v1", "target": TARGET, "release": {k: v for k, v in r.items() if k not in ("config", "old")}}))
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
