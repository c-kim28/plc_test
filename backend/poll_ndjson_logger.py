"""
폴링 주기별·날짜별 NDJSON 수집.
매 폴링마다 한 줄(JSON 객체)만 append. 읽기/쓰기 효율적.
경로: {POLL_LOGS_DIR}/{interval_key}/{YYYY-MM-DD}.ndjson
한 줄 형식: {"t": "KST 시각 문자열", "data": { "변수명": 값, ... }}
"""
import json
import os
import threading
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))

_DEFAULT_BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "poll_logs")
_LOCK = threading.Lock()


def _get_base_dir():
    return os.environ.get("POLL_LOGS_DIR", "").strip() or _DEFAULT_BASE


def _serialize_value(v):
    """JSON 직렬화 가능하도록 (str/number/None)."""
    if v is None:
        return None
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)


def append_parsed_to_ndjson(parsed: dict, interval_key: str, timestamp: float) -> None:
    """
    parsed: { variable_name: value, ... }
    interval_key: "50ms" | "1s" | "1min" | "1h"
    해당 날짜 .ndjson 파일에 한 줄(JSON) append. 기존 파일 읽지 않음.
    """
    if not parsed or not interval_key:
        return
    base = _get_base_dir()
    date_str = datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
    dir_path = os.path.join(base, interval_key)
    try:
        os.makedirs(dir_path, exist_ok=True)
    except OSError:
        return
    file_path = os.path.join(dir_path, date_str + ".ndjson")
    data = {k: _serialize_value(v) for k, v in parsed.items()}
    dt_utc = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    t_kst = dt_utc.astimezone(KST).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "+09:00"
    record = {"t": t_kst, "data": data}
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with _LOCK:
        try:
            with open(file_path, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass
