"""
MC 프로토콜(3E) 폴링. 웹 대시보드에서 폴링 시작 시 plc_mcprotocol.py(pymcprotocol)로
host:port(plc_tcp_fake_response 또는 실제 PLC)에 3E 요청을 보내고, 가짜 응답 서버가
응답한 패킷을 pymcprotocol이 파싱해 값을 받아 대시보드에 표시합니다.
"""
import json
import time
from pathlib import Path

from mc_mapping import get_mc_entries
from plc_mcprotocol import read_mc_variables

SCRIPT_DIR = Path(__file__).resolve().parent
INTERVALS_FILE = SCRIPT_DIR / "mc_poll_intervals.json"

# 기본 폴링 간격 1초
DEFAULT_INTERVALS = {"boolean_ms": 1000, "data_ms": 1000, "string_ms": 1000}
MIN_INTERVAL_MS = 200
MAX_INTERVAL_MS = 1800000


def _load_intervals():
    if not INTERVALS_FILE.exists():
        return None
    try:
        with open(INTERVALS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {
                "boolean_ms": int(data.get("boolean_ms", DEFAULT_INTERVALS["boolean_ms"])),
                "data_ms": int(data.get("data_ms", DEFAULT_INTERVALS["data_ms"])),
                "string_ms": int(data.get("string_ms", DEFAULT_INTERVALS["string_ms"])),
            }
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass
    return None


def _save_intervals():
    try:
        with open(INTERVALS_FILE, "w", encoding="utf-8") as f:
            json.dump(poll_intervals, f, indent=2)
    except OSError:
        pass


poll_intervals = dict(DEFAULT_INTERVALS)
_loaded = _load_intervals()
if _loaded:
    poll_intervals.update(_loaded)


def get_poll_intervals():
    return dict(poll_intervals)


def _parse_ms(val):
    if val is None:
        return None
    try:
        v = int(float(val))
        return v if MIN_INTERVAL_MS <= v <= MAX_INTERVAL_MS else None
    except (TypeError, ValueError):
        return None


def set_poll_intervals(boolean_ms=None, data_ms=None, string_ms=None):
    global poll_intervals
    v = _parse_ms(boolean_ms)
    if v is not None:
        poll_intervals["boolean_ms"] = v
    v = _parse_ms(data_ms)
    if v is not None:
        poll_intervals["data_ms"] = v
    v = _parse_ms(string_ms)
    if v is not None:
        poll_intervals["string_ms"] = v
    _save_intervals()


def run_poller(host, port, on_parsed, on_error, stop_event):
    """
    폴링 스레드: plc_mcprotocol.read_mc_variables로 host:port에 3E 요청.
    가짜 응답 서버(plc_tcp_fake_response)가 응답하면 그 값을 대시보드에 전달.
    """
    last_bool = last_data = last_str = time.monotonic()

    def do_poll():
        try:
            # mc_fake_values.json 수정분(Y14C 등)을 재시작 없이 반영
            entries = get_mc_entries()
            if not entries:
                return
            parsed = read_mc_variables(host, port, entries)
            if parsed:
                on_parsed(parsed)
        except Exception as e:
            on_error(str(e))

    try:
        do_poll()
    except Exception as e:
        on_error(str(e))

    while not stop_event.is_set():
        now = time.monotonic()
        iv = get_poll_intervals()
        i_bool = (iv.get("boolean_ms") or 1000) / 1000.0
        i_data = (iv.get("data_ms") or 1000) / 1000.0
        i_str = (iv.get("string_ms") or 1000) / 1000.0
        if now - last_bool >= i_bool or now - last_data >= i_data or now - last_str >= i_str:
            last_bool = now
            last_data = now
            last_str = now
            try:
                do_poll()
            except Exception as e:
                on_error(str(e))
        time.sleep(0.2)
