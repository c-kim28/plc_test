"""
MC 프로토콜(3E) 폴링. 웹 대시보드에서 폴링 시작 시 host:port(가짜/실제 PLC)에 3E 요청을 보내
수신값을 대시보드·InfluxDB에 전달합니다.
주기별 4개 스레드: 50ms / 1s / 1min / 1h. 같은 주기 내에서는 100개씩 청크·2스레드 병렬 읽기.
"""
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from mc_mapping import get_mc_entries_by_poll_interval
from plc_mcprotocol import read_mc_variables

# 폴링할 변수 개수 제한. 0이면 제한 없음. 적용 시 50ms 그룹만 제한 (나머지 그룹은 고정 개수).
POLL_ENTRY_LIMIT = int(os.environ.get("MC_POLL_ENTRY_LIMIT", "0") or "0")
CHUNK_SIZE = 100
MAX_WORKERS = 2

INTERVAL_50MS = 0.05
INTERVAL_1S = 1.0
INTERVAL_1MIN = 60.0
INTERVAL_1H = 3600.0
MIN_INTERVAL_SEC = 0.05
MAX_INTERVAL_SEC = 12 * 3600.0

_interval_lock = threading.Lock()
_interval_by_key = {
    "50ms": INTERVAL_50MS,
    "1s": INTERVAL_1S,
    "1min": INTERVAL_1MIN,
    "1h": INTERVAL_1H,
}


def _poll_chunk(host, port, chunk):
    """한 청크에 대해 read_mc_variables 호출."""
    return read_mc_variables(host, port, chunk)


def _do_poll_entries(host, port, entries, on_parsed, on_error, interval_key=None):
    """엔트리 리스트를 청크로 나누어 병렬 폴링 후 on_parsed(merged, interval_key) 호출."""
    if not entries:
        return
    chunks = [entries[i : i + CHUNK_SIZE] for i in range(0, len(entries), CHUNK_SIZE)]
    merged = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(_poll_chunk, host, port, c) for c in chunks]
        for future in as_completed(futures):
            try:
                parsed = future.result()
                if parsed:
                    merged.update(parsed)
            except Exception as e:
                on_error(str(e))
    if merged:
        on_parsed(merged, interval_key)


def get_interval_seconds(key):
    with _interval_lock:
        return _interval_by_key.get(key)


def normalize_poll_intervals(interval_map_sec):
    """
    입력값 검증/정규화 후 {key: sec(float)} 반환. (메모리 변경 없음)
    """
    valid_keys = ("50ms", "1s", "1min", "1h")
    normalized = {}
    for key in valid_keys:
        if key not in interval_map_sec:
            continue
        value = float(interval_map_sec[key])
        if value < MIN_INTERVAL_SEC or value > MAX_INTERVAL_SEC:
            raise ValueError("폴링레이트는 50ms 이상 12시간 이하로 설정해야 합니다.")
        normalized[key] = value
    return normalized


def set_poll_intervals(interval_map_sec):
    """
    interval_map_sec: {"50ms": sec, "1s": sec, "1min": sec, "1h": sec}
    """
    normalized = normalize_poll_intervals(interval_map_sec)
    with _interval_lock:
        for key, value in normalized.items():
            _interval_by_key[key] = value


def get_poll_intervals():
    with _interval_lock:
        return dict(_interval_by_key)


def get_poll_thread_entries():
    e_50ms, e_1s, e_1min, e_1h = get_mc_entries_by_poll_interval()
    if POLL_ENTRY_LIMIT > 0 and len(e_50ms) > POLL_ENTRY_LIMIT:
        e_50ms = e_50ms[:POLL_ENTRY_LIMIT]
    return {
        "50ms": e_50ms,
        "1s": e_1s,
        "1min": e_1min,
        "1h": e_1h,
    }


def _run_interval_loop(host, port, entries, interval_key, on_parsed, on_error, stop_event, label):
    """한 주기 스레드: 첫 폴링 1회 후, interval_sec마다 폴링."""
    if not entries:
        return
    try:
        _do_poll_entries(host, port, entries, on_parsed, on_error, interval_key=interval_key)
    except Exception as e:
        on_error(str(e))
    while not stop_event.is_set():
        interval_sec = get_interval_seconds(interval_key) or MIN_INTERVAL_SEC
        if stop_event.wait(interval_sec):
            break
        try:
            _do_poll_entries(host, port, entries, on_parsed, on_error, interval_key=interval_key)
        except Exception as e:
            on_error(str(e))


def run_poller(host, port, on_parsed, on_error, stop_event):
    """
    주기별 4스레드로 폴링 실행.
    - 50ms: 나머지 전부 (온도·압력·각종 Word/Dword 등)
    - 1s: Boolean 전체 + 토탈카운터, 현재생산량, 과부족수량, 카운트수량, 금일가동수량, 금일 가동시간
    - 1min: C.P.M, S.P.M
    - 1h: 현재/다음 금형번호·금형이름·다이하이트·바란스에어, 생산계획량, 목표 타발수
    """
    grouped = get_poll_thread_entries()
    e_50ms = grouped["50ms"]
    e_1s = grouped["1s"]
    e_1min = grouped["1min"]
    e_1h = grouped["1h"]
    total = len(e_50ms) + len(e_1s) + len(e_1min) + len(e_1h)
    if total == 0:
        print("[MC] mc_fake_values.json 항목 없음", flush=True)
        return
    print("[MC] 폴링 시작 (총 %d개) 50ms=%d, 1s=%d, 1min=%d, 1h=%d"
          % (total, len(e_50ms), len(e_1s), len(e_1min), len(e_1h)), flush=True)

    threads = []
    for entries, interval_key, label in [
        (e_50ms, "50ms", "50ms"),
        (e_1s, "1s", "1s"),
        (e_1min, "1min", "1min"),
        (e_1h, "1h", "1h"),
    ]:
        if not entries:
            continue
        t = threading.Thread(
            target=_run_interval_loop,
            args=(host, port, entries, interval_key, on_parsed, on_error, stop_event, label),
            name="mc_poll_%s" % label,
            daemon=True,
        )
        t.start()
        threads.append(t)
    for t in threads:
        t.join()
