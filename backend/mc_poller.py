"""
MC 프로토콜(3E) 폴링. 웹 대시보드에서 폴링 시작 시 plc_mcprotocol.py(pymcprotocol)로
host:port(plc_tcp_fake_response 또는 실제 PLC)에 3E 요청을 보내고, 가짜 응답 서버가
응답한 패킷을 pymcprotocol이 파싱해 값을 받아 대시보드·InfluxDB에 전달합니다.
100개씩 청크로 나누어 스레드 2개로 병렬 폴링.
"""
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

from mc_mapping import get_mc_entries
from plc_mcprotocol import read_mc_variables

POLL_INTERVAL_SEC = 1.0
# 폴링할 변수 개수. 0이면 제한 없음(전체). 환경변수 MC_POLL_ENTRY_LIMIT 으로 변경 가능.
POLL_ENTRY_LIMIT = int(os.environ.get("MC_POLL_ENTRY_LIMIT", "0") or "0")
# 청크당 변수 개수, 동시에 돌릴 스레드 수 (100개씩 2스레드 병렬)
CHUNK_SIZE = 100
MAX_WORKERS = 2


def _poll_chunk(host, port, chunk):
    """한 청크(최대 CHUNK_SIZE개)에 대해 read_mc_variables 호출."""
    return read_mc_variables(host, port, chunk)


def run_poller(host, port, on_parsed, on_error, stop_event):
    """
    폴링 스레드: host:port에 3E 요청 → 수신값을 대시보드 + InfluxDB에 전달.
    100개씩 나누어 스레드 2개로 병렬 읽기 후 결과 병합.
    """
    _first_poll_done = [False]

    def do_poll():
        try:
            entries = get_mc_entries()
            if not entries:
                print("[MC] mc_fake_values.json 항목 없음", flush=True)
                return
            if POLL_ENTRY_LIMIT > 0:
                entries = entries[:POLL_ENTRY_LIMIT]
            chunks = [entries[i : i + CHUNK_SIZE] for i in range(0, len(entries), CHUNK_SIZE)]
            if not _first_poll_done[0]:
                print("[MC] 폴링 시작 (%d개 변수, %d청크, %d 스레드) → 수신 후 InfluxDB 기록"
                      % (len(entries), len(chunks), min(MAX_WORKERS, len(chunks))), flush=True)
            merged = {}
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                futures = {executor.submit(_poll_chunk, host, port, c): c for c in chunks}
                for future in as_completed(futures):
                    try:
                        parsed = future.result()
                        if parsed:
                            merged.update(parsed)
                    except Exception as e:
                        on_error(str(e))
            if merged:
                if not _first_poll_done[0]:
                    non_dash = sum(1 for v in merged.values() if v != "-")
                    print("[MC] 첫 수신 완료 (유효값 %d건) → InfluxDB 기록" % non_dash, flush=True)
                    _first_poll_done[0] = True
                on_parsed(merged)
        except Exception as e:
            on_error(str(e))

    try:
        do_poll()
    except Exception as e:
        on_error(str(e))

    while not stop_event.is_set():
        if stop_event.wait(POLL_INTERVAL_SEC):
            break
        try:
            do_poll()
        except Exception as e:
            on_error(str(e))
