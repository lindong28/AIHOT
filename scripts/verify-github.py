#!/usr/bin/env python3
"""Select the GitHub style before running the installed template verifier.

The reader's choice lives in localStorage (aihot-theme), so each isolated browser first opens a
lightweight same-origin page, stores the choice and then opens the case. Admin pages have no switch,
which is why this goes through storage rather than the /more control (verify-feedly.py clicks it).
"""
import importlib.util
from pathlib import Path
from urllib.parse import urljoin

verifier = Path.home() / ".claude/skills/web-ui-workflows/workflows/apply-ui-template/verify-ui.py"
spec = importlib.util.spec_from_file_location("template_verifier", verifier)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GitHubBrowser(module.Browser):
    def call(self, *args):
        if args[0] == "open":
            super().call("open", urljoin(args[1], "/terms"))
            self.ready("document.readyState === 'complete'")
            super().call("eval", "localStorage.setItem('aihot-theme', 'github')")
        result = super().call(*args)
        if args[0] == "open":
            self.ready("document.documentElement.dataset.theme === 'github'")
        return result


module.Browser = GitHubBrowser
if __name__ == "__main__":
    raise SystemExit(module.main())
