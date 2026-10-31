"""Export last quarter's records to Excel: create, poll until ready, download the bytes.

    COINVELLO_API_KEY=cv_test_x COINVELLO_BASE_URL=http://localhost:4242/v1 python examples/export_records.py
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from coinvello import CoinVello, CoinVelloError  # noqa: E402

cv = CoinVello(
    os.environ.get("COINVELLO_API_KEY", "cv_test_example"),
    base_url=os.environ.get("COINVELLO_BASE_URL", "https://api.coinvello.com/v1"),
)

try:
    exp = cv.exports.create(
        dataset="records",
        format="xlsx",
        period={"start": "2026-07-01", "end": "2026-10-01"},  # end is exclusive
        include_simulated=True,  # test keys: also rows from /test/simulate_*
        idempotency_key="records-2026-q3",
    )
    while exp["status"] in ("queued", "processing"):
        time.sleep(2)
        exp = cv.exports.retrieve(exp["id"])
    if exp["status"] != "ready":
        sys.exit(f"export {exp['id']} ended {exp['status']}: {exp.get('failure_reason')}")

    name = exp["file"]["name"]
    with open(name, "wb") as f:
        f.write(cv.exports.download(exp["id"]))
    print(f"wrote {name} ({exp['rows']} rows)")
except CoinVelloError as e:
    print(f"CoinVello error: {e}", file=sys.stderr)
    sys.exit(1)
