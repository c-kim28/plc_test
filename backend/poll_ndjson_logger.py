"""
폴링 스레드별·날짜별 NDJSON 수집.
매 폴링마다 한 줄(JSON 객체)만 append. 읽기/쓰기 효율적.
경로: {POLL_LOGS_DIR}/{thread_name}/{YYYYMMDD}.ndjson
한 줄 형식: {"t": "KST 시각 문자열", "data": { "변수명": 값, ... }}
"""
import json
import os
import shutil
import threading
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))

_DEFAULT_BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "poll_logs")
_LOCK = threading.Lock()
_THREAD_FOLDER_BY_INTERVAL = {
    "50ms": "실시간_공정값",
    "1s": "경고_부저_입출력",
    "1min": "SPM／CPM_요약",
    "1h": "금형_셋업",
}


def _get_base_dir():
    return os.environ.get("POLL_LOGS_DIR", "").strip() or _DEFAULT_BASE


def _serialize_value(v):
    """JSON 직렬화 가능하도록 (str/number/None)."""
    if v is None:
        return None
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)


def _resolve_thread_folder(interval_key: str) -> str:
    """interval_key를 스레드 고정 폴더명으로 변환."""
    return _THREAD_FOLDER_BY_INTERVAL.get(str(interval_key or "").strip(), "실시간_공정값")


def _normalize_legacy_file_name(name: str) -> str:
    """레거시 파일명(YYYY-MM-DD.ndjson)을 새 포맷(YYYYMMDD.ndjson)으로 변환."""
    if not name.endswith(".ndjson"):
        return name
    stem = name[:-7]
    if len(stem) == 10 and stem.count("-") == 2:
        y, m, d = stem.split("-")
        if len(y) == 4 and len(m) == 2 and len(d) == 2 and y.isdigit() and m.isdigit() and d.isdigit():
            return f"{y}{m}{d}.ndjson"
    return name


def _migrate_legacy_interval_dirs(base_dir: str) -> None:
    """
    poll_logs/<interval_key> 레거시 폴더가 있으면
    poll_logs/<thread_name> 로 파일 이동 후 정리.
    """
    for interval_key, thread_folder in _THREAD_FOLDER_BY_INTERVAL.items():
        legacy_dir = os.path.join(base_dir, interval_key)
        if not os.path.isdir(legacy_dir):
            continue
        target_dir = os.path.join(base_dir, thread_folder)
        try:
            os.makedirs(target_dir, exist_ok=True)
        except OSError:
            continue
        try:
            file_names = [n for n in os.listdir(legacy_dir) if n.endswith(".ndjson")]
        except OSError:
            continue
        for name in file_names:
            src = os.path.join(legacy_dir, name)
            dst_name = _normalize_legacy_file_name(name)
            dst = os.path.join(target_dir, dst_name)
            try:
                if os.path.exists(dst):
                    with open(src, "r", encoding="utf-8") as rf, open(dst, "a", encoding="utf-8") as wf:
                        shutil.copyfileobj(rf, wf)
                    os.remove(src)
                else:
                    os.replace(src, dst)
            except OSError:
                continue
        try:
            os.rmdir(legacy_dir)
        except OSError:
            # 다른 파일이 남아있거나 사용 중이면 유지
            pass


def append_parsed_to_ndjson(parsed: dict, interval_key: str, timestamp: float) -> None:
    """
    parsed: { variable_name: value, ... }
    interval_key: "50ms" | "1s" | "1min" | "1h"
    해당 날짜 .ndjson 파일에 한 줄(JSON) append. 기존 파일 읽지 않음.
    """
    if not parsed or not interval_key:
        return
    base = _get_base_dir()
    date_str = datetime.fromtimestamp(timestamp).strftime("%Y%m%d")
    thread_folder = _resolve_thread_folder(interval_key)
    dir_path = os.path.join(base, thread_folder)
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
            _migrate_legacy_interval_dirs(base)
            with open(file_path, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass
