#!/usr/bin/env python3
"""Select Feedly through the UI before running the installed template verifier."""
import importlib.util
from pathlib import Path
from urllib.parse import urljoin

verifier = Path.home() / ".claude/skills/web-ui-workflows/workflows/apply-ui-template/verify-ui.py"
spec = importlib.util.spec_from_file_location("template_verifier", verifier)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FeedlyBrowser(module.Browser):
    def call(self, *args):
        if args[0] == "open":
            super().call("open", urljoin(args[1], "/more"))
            self.ready("document.querySelector('#main [role=radio][title=Feedly]') !== null")
            super().call("click", "#main [role=radio][title=Feedly]")
            self.ready("document.documentElement.dataset.theme === 'feedly'")
        result = super().call(*args)
        if args[0] == "open":
            self.ready("document.documentElement.dataset.theme === 'feedly'")
        return result


module.Browser = FeedlyBrowser
if __name__ == "__main__":
    raise SystemExit(module.main())
