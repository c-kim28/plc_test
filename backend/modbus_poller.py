"""
Modbus TCP 폴링: Boolean(경고등/알람 Coils) 3초 간격, 타발수 등 데이터(Holding Registers) 1초 간격.
io_variables.json 순서대로 Coil 0~106, Holding 0~N 매핑.
"""
import json
import threading
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
IO_VARIABLES_PATH = REPO_ROOT / "io_variables.json"

# 경고등/알람 구간 Boolean 개수 (Coils)
ALARM_COIL_COUNT = 107

# 폴링 간격 (초): Boolean(Coil) 3초, 데이터(레지스터) 1초
ALARM_POLL_INTERVAL = 3
DATA_POLL_INTERVAL = 1


def load_io_variables():
    """io_variables.json을 순서대로 로드. [(name, info), ...]"""
    with open(IO_VARIABLES_PATH, "r", encoding="utf-8") as f:
        obj = json.load(f)
    return list(obj.items())


def build_modbus_map():
    """
    반환: (coil_vars, reg_vars)
    - coil_vars: [ (name, info), ... ]  최대 107개 (Coil 0~106)
    - reg_vars: [ (name, info, start_reg, reg_count), ... ]  Holding 0부터 연속
    """
    entries = load_io_variables()
    coil_vars = []
    reg_vars = []
    reg_start = 0
    for name, info in entries:
        length = int(info.get("length", 0))
        data_type = (info.get("dataType") or "").strip().lower()
        if data_type == "boolean" and length == 1 and len(coil_vars) < ALARM_COIL_COUNT:
            coil_vars.append((name, info))
            continue
        # Word=1, Dword=2, String 128bit=8 regs
        if data_type == "word" and length == 16:
            reg_count = 1
        elif data_type == "dword" and length == 32:
            reg_count = 2
        elif data_type == "string" and length == 128:
            reg_count = 8
        else:
            reg_count = max(1, (length + 15) // 16)
        reg_vars.append((name, info, reg_start, reg_count))
        reg_start += reg_count
    return coil_vars, reg_vars


def registers_to_value(regs, data_type, length):
    """레지스터 리스트를 변수값으로 (숫자 또는 hex 문자열)."""
    if not regs:
        return "-"
    dt = (data_type or "").lower()
    if dt == "word" and len(regs) >= 1:
        return regs[0] & 0xFFFF
    if dt == "dword" and len(regs) >= 2:
        return ((regs[0] & 0xFFFF) << 16) | (regs[1] & 0xFFFF)
    if dt == "string":
        # 16비트 빅엔디안: 각 레지스터 = 상위바이트|하위바이트
        buf = []
        for r in regs[:8]:
            buf.append((r >> 8) & 0xFF)
            buf.append(r & 0xFF)
        return "".join(f"{b:02x}" for b in buf)
    return regs[0] if regs else "-"


def run_poller(host, port, slave_id, on_parsed, on_error, stop_event):
    """
    폴링 스레드: Coils 60초, Registers 1초. on_parsed({ name: value }) 호출.
    pymodbus 3.x 서버가 요청 후 연결을 끊는 경우가 있어, 요청마다 새 연결 후 읽고 끊는 방식 사용.
    """
    try:
        from pymodbus.client import ModbusTcpClient
    except ImportError:
        on_error("pymodbus가 설치되지 않았습니다. pip install pymodbus")
        return

    coil_vars, reg_vars = build_modbus_map()
    port = port or 502
    parsed = {}
    last_coil_time = [0]
    last_reg_time = [0]

    def connect_client():
        c = ModbusTcpClient(host=host, port=port, timeout=3)
        if not c.connect():
            return None
        return c

    def do_coils():
        client = connect_client()
        if not client:
            on_error("Modbus TCP 연결 실패")
            return
        try:
            rr = client.read_coils(0, count=len(coil_vars), device_id=slave_id)
            if rr.isError():
                return
            bits = rr.bits[: len(coil_vars)]
            for i, (name, _) in enumerate(coil_vars):
                parsed[name] = 1 if (i < len(bits) and bits[i]) else 0
        except Exception as e:
            on_error(str(e))
        finally:
            try:
                client.close()
            except Exception:
                pass

    def do_registers():
        if not reg_vars:
            return
        client = connect_client()
        if not client:
            on_error("Modbus TCP 연결 실패")
            return
        start = reg_vars[0][2]
        end = reg_vars[-1][2] + reg_vars[-1][3]
        count = end - start
        try:
            rr = client.read_holding_registers(start, count=count, device_id=slave_id)
            if rr.isError():
                return
            regs = rr.registers
            for name, info, s, n in reg_vars:
                chunk = regs[s - start : s - start + n] if (s - start + n) <= len(regs) else []
                dt = (info.get("dataType") or "").strip()
                length = int(info.get("length", 0))
                parsed[name] = registers_to_value(chunk, dt, length)
        except Exception as e:
            on_error(str(e))
        finally:
            try:
                client.close()
            except Exception:
                pass

    try:
        do_coils()
        do_registers()
        on_parsed(dict(parsed))
    except Exception as e:
        on_error(str(e))

    while not stop_event.is_set():
        now = time.monotonic()
        if now - last_coil_time[0] >= ALARM_POLL_INTERVAL:
            last_coil_time[0] = now
            do_coils()
            on_parsed(dict(parsed))
        if now - last_reg_time[0] >= DATA_POLL_INTERVAL:
            last_reg_time[0] = now
            do_registers()
            on_parsed(dict(parsed))
        time.sleep(0.2)
