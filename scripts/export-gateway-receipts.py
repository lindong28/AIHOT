#!/usr/bin/env python3
"""Join AIHOT's --snapshot JSON with the personal Gateway ledger, read-only.

stdout is machine JSON; stderr summarizes scope. No provider responses or secrets are exported.
"""
import argparse
import datetime
import json
import pathlib
import sqlite3
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--ledger", required=True)
    args = parser.parse_args()
    snapshot = json.loads(pathlib.Path(args.snapshot).read_text())
    if snapshot.get("version") != 1 or not isinstance(snapshot.get("receipts"), list):
        raise ValueError("expected AIHOT receipt snapshot version 1")
    ledger = pathlib.Path(args.ledger).resolve()
    with sqlite3.connect(ledger.as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")  # requests and all attempts come from the same SQLite snapshot
        entries = []
        for receipt in snapshot["receipts"]:
            requests = []
            for row in db.execute(
                "SELECT id, canonical_project_id, logical_model, request_outcome, "
                "request_reject_reason, active_attempt_id FROM logical_requests WHERE logical_request_id=?",
                (receipt["requestId"],),
            ):
                attempts = [dict(id=a["attempt_id"], outcome=a["outcome"], dispatchBoundary=a["dispatch_boundary"])
                            for a in db.execute("SELECT attempt_id, outcome, dispatch_boundary FROM attempts WHERE logical_request_fk=? ORDER BY id", (row["id"],))]
                requests.append(dict(project=row["canonical_project_id"], model=row["logical_model"],
                                     outcome=row["request_outcome"], rejectReason=row["request_reject_reason"],
                                     activeAttemptId=row["active_attempt_id"], attempts=attempts))
            entries.append(dict(receiptId=receipt["receiptId"], requestId=receipt["requestId"], requests=requests))
    print(json.dumps(dict(version=1, capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), entries=entries)))
    print(f"已只读核对 {len(entries)} 条回执；未更改 AIHOT 或 Gateway。将输出交给 reconcile-gateway-receipts.ts 预览。", file=sys.stderr)


if __name__ == "__main__":
    main()
