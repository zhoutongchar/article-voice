"""JSON-lines progress for the native Chrome setup window."""
import json
import sys
import time
from companion import DIRECTORY, ensure_engine, write_json

last = 0


def report(**value):
    global last
    now = time.monotonic()
    if now - last < .15 and value.get("completed") != value.get("total"):
        return
    last = now
    write_json(DIRECTORY / "setup-progress.json", value)
    print(json.dumps(value), flush=True)


if __name__ == "__main__":
    try:
        ensure_engine(report, verify_models="--verify" in sys.argv)
        report(stage="ready", message="Your voices are ready", completed=1, total=1)
    except Exception as error:
        report(stage="error", message=str(error) if isinstance(error, ValueError) else "Setup paused. Check your connection and click Resume.")
        sys.exit(1)
