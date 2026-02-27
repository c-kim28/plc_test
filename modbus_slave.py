#!/usr/bin/env python3
"""
Modbus TCP 슬레이브(서버). iolist.csv 주소 순서대로 Coils(경고/알람) + Holding Registers(데이터) 매핑.
기본값: Boolean 0/1, Word/Dword 유의미 더미, String "hello" 2바이트씩 분할.
"""
import csv
import os
import random
import sys
import threading
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
IOLIST_PATH = SCRIPT_DIR / "iolist.csv"

# 기본 포트 (502는 권한 필요; 테스트 시 5020 사용 가능). 환경변수 PORT 또는 인자로 변경 가능.
def _get_port():
    if os.environ.get("PORT"):
        return int(os.environ["PORT"])
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        return int(sys.argv[1])
    return 5020

HOST = os.environ.get("MODBUS_HOST", "0.0.0.0")
PORT = _get_port()

# Word/Dword 기본값 (iolist 주소 라벨 → 값). Dword는 32비트, 레지스터에는 상위/하위 워드로 저장.
REG_DEFAULTS = {
    "D140": 42,
    "D711": 3505,
    "D713": 550,
    "D510": 43,
    "D511": 3510,
    "D513": 548,
    "D100": 180,
    "D104": 125,
    "D126": 120,
    "D340": 350,
    "D341": 348,
    "D342": 352,
    "D343": 345,
    "D330": 340,
    "D331": 342,
    "D20": 20,
    "D21": 3,
    "D22": 50,
    "D23": 50,
    "D1820": 125000,
    "D1821": 125000,
    "D1810": 10000,
    "D1811": 10000,
    "D1812": 8500,
    "D1813": 8500,
    "D1814": (-1500) & 0xFFFFFFFF,  # 과부족수량 (각 행이 Dword 1개 = 2레지스터)
    "D1815": (-1500) & 0xFFFFFFFF,
    "D1816": 5000,
    "D1817": 5000,
    "D1818": 0,
    "D1819": 0,
    "D1912": 3200,
    "D1913": 3200,
    "D1914": 480,
}


def parse_iolist():
    """iolist.csv 파싱. 반환: (coil_rows, reg_rows) - 각 (Address, DataType, Length, Description)."""
    coil_rows = []
    reg_rows = []
    with open(IOLIST_PATH, "r", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            addr = (row.get("Address") or "").strip()
            if not addr:
                continue
            length = (row.get("Length") or "0").strip()
            try:
                length = int(length)
            except ValueError:
                length = 0
            dt = (row.get("DataType") or "").strip().lower()
            desc = (row.get("Parameter(Korean)") or row.get("Description") or "").strip()
            if dt == "boolean":
                coil_rows.append((addr, dt, length, desc))
            elif dt in ("word", "dword", "string"):
                reg_rows.append((addr, dt, length, desc))
    return coil_rows, reg_rows


def build_coil_values(coil_rows):
    """Boolean 행에서 Coil 기본값 생성. 운전준비/Green=1, 비상·알람·에러=0."""
    values = []
    for _addr, _dt, _len, desc in coil_rows:
        if "운전준비" in desc or "준비" in desc or "Green" in desc or "녹" in desc:
            values.append(1)
        elif "비상" in desc or "알람" in desc or "에러" in desc or "오류" in desc or "이상" in desc:
            values.append(0)
        else:
            values.append(0)
    return values


def build_register_values(reg_rows):
    """Word/Dword/String 행에서 Holding Register 기본값 생성. 행당 Word=1, Dword=2, String=1 레지스터."""
    values = []
    # 금형 이름: 현재 8워드 = "hello", 다음 8워드 = "hello1" (각 2바이트씩 빅엔디안)
    current_name = (list("hello".encode("ascii")) + [0] * 11)[:16]
    next_name = (list("hello1".encode("ascii")) + [0] * 10)[:16]
    string_row_index = 0
    for addr, dt, length, _ in reg_rows:
        if dt == "word":
            values.append(REG_DEFAULTS.get(addr, 0) & 0xFFFF)
        elif dt == "dword":
            v = REG_DEFAULTS.get(addr, 0) & 0xFFFFFFFF
            values.append((v >> 16) & 0xFFFF)
            values.append(v & 0xFFFF)
        elif dt == "string":
            # 행당 1워드(2바이트). 첫 8행=현재 금형, 다음 8행=다음 금형
            chars = current_name if string_row_index < 8 else next_name
            off = (string_row_index % 8) * 2
            b1 = chars[off] if off < 16 else 0
            b2 = chars[off + 1] if off + 1 < 16 else 0
            values.append((b1 << 8) | b2)
            string_row_index += 1
    return values


# 시뮬레이션: 경고등 자주 랜덤 점등, 카운터/생산량/타발/가동은 전부 +1 쌓였다가 상한 넘으면 복귀
COIL_FLASH_INTERVAL = 0.6
COIL_FLASH_DURATION = 0.4
REG_PULSE_INTERVAL = 0.5
REG_PULSE_CAP = 150

# iolist 기준 바뀌어야 하는 항목 전부 (시작 인덱스, 레지스터 개수). 정적(금형번호/이름/온도 등) 제외
# 토탈카운터 D1820,D1821 / 생산계획 D1810,D1811 / 현재생산량 D1812,D1813 / 과부족 D1814,D1815 /
# 설정카운터 D1816,D1817 / 카운트수량 D1818,D1819 / 금일 가동수량 D1912,D1913 / 금일 가동시간 D1914
REG_PULSE_SPECS = [
    (35, 2), (37, 2),   # 토탈카운터
    (39, 2), (41, 2),   # 생산계획량
    (43, 2), (45, 2),   # 현재생산량
    (47, 2), (49, 2),   # 과부족수량
    (51, 2), (53, 2),   # 설정카운터
    (55, 2), (57, 2),   # 카운트수량
    (59, 2), (61, 2),   # 금일 가동수량
    (63, 1),            # 금일 가동시간
]


def _simulation_loop(co_block, hr_block, coil_base, reg_base_snapshot, stop_event):
    """코일: 랜덤 점등 후 복귀. 레지스터: 바뀌어야 하는 항목 전부 매 틱 +1, 상한 넘으면 복귀."""
    coil_vals = co_block.values
    reg_vals = hr_block.values
    last_coil_flash = 0.0
    last_reg_pulse = 0.0
    flashed_coil_idx = None
    flashed_coil_restore_at = 0.0
    n_coils = len(coil_vals)
    while not stop_event.is_set():
        now = time.monotonic()
        if flashed_coil_idx is not None and now >= flashed_coil_restore_at:
            coil_vals[flashed_coil_idx] = coil_base[flashed_coil_idx]
            flashed_coil_idx = None
        if flashed_coil_idx is None and n_coils and (now - last_coil_flash) >= COIL_FLASH_INTERVAL:
            last_coil_flash = now
            idx = random.randint(0, n_coils - 1)
            coil_vals[idx] = 1
            flashed_coil_idx = idx
            flashed_coil_restore_at = now + COIL_FLASH_DURATION
        # 바뀌어야 하는 레지스터 전부 매 틱 +1
        if (now - last_reg_pulse) >= REG_PULSE_INTERVAL:
            last_reg_pulse = now
            for start, count in REG_PULSE_SPECS:
                if start + count > len(reg_vals):
                    continue
                base_hi = reg_base_snapshot[start]
                base_lo = reg_base_snapshot[start + 1] if count == 2 else 0
                if count == 2:
                    v = (reg_vals[start] << 16) | (reg_vals[start + 1] & 0xFFFF)
                    base_v = (base_hi << 16) | (base_lo & 0xFFFF)
                    v = (v + 1) & 0xFFFFFFFF
                    if v >= base_v + REG_PULSE_CAP:
                        v = base_v
                    reg_vals[start] = (v >> 16) & 0xFFFF
                    reg_vals[start + 1] = v & 0xFFFF
                else:
                    v = (reg_vals[start] + 1) & 0xFFFF
                    if v >= (base_hi + REG_PULSE_CAP) & 0xFFFF:
                        v = base_hi
                    reg_vals[start] = v
        time.sleep(0.1)


def main():
    coil_rows, reg_rows = parse_iolist()
    coil_vals = build_coil_values(coil_rows)
    reg_vals = build_register_values(reg_rows)

    try:
        from pymodbus.datastore import (
            ModbusSequentialDataBlock,
            ModbusServerContext,
            ModbusDeviceContext,
        )
        from pymodbus.server import StartTcpServer
        try:
            from pymodbus.pdu.device import ModbusDeviceIdentification
        except ImportError:
            from pymodbus.device import ModbusDeviceIdentification
        _use_devices = True  # pymodbus 3.12+
    except ImportError:
        try:
            from pymodbus.datastore import ModbusSlaveContext as ModbusDeviceContext
            from pymodbus.datastore import ModbusSequentialDataBlock, ModbusServerContext
            from pymodbus.server import StartTcpServer
            from pymodbus.device import ModbusDeviceIdentification
            _use_devices = False  # pymodbus 3.6
        except ImportError:
            print("pymodbus가 필요합니다: pip install pymodbus")
            return

    # pymodbus 컨텍스트가 클라이언트 주소 0을 1로 변환하므로, 블록 시작 주소를 1로 해야 0번이 values[0]에 매핑됨
    di = ModbusSequentialDataBlock(1, [0] * max(1, len(coil_vals)))
    co = ModbusSequentialDataBlock(1, coil_vals)
    hr = ModbusSequentialDataBlock(1, reg_vals)
    ir = ModbusSequentialDataBlock(1, [0] * max(1, len(reg_vals)))

    # 시뮬레이션: 블록의 .values를 직접 수정 (블록이 list 복사본을 갖기 때문)
    coil_base = list(co.values)
    reg_base_snapshot = list(hr.values)
    sim_stop = threading.Event()
    sim_thread = threading.Thread(
        target=_simulation_loop,
        args=(co, hr, coil_base, reg_base_snapshot, sim_stop),
        daemon=True,
    )
    sim_thread.start()

    store = ModbusDeviceContext(di=di, co=co, hr=hr, ir=ir)
    context = ModbusServerContext(devices=store, single=True) if _use_devices else ModbusServerContext(slaves=store, single=True)

    identity = ModbusDeviceIdentification()
    identity.VendorName = "PLC Monitor"
    identity.ProductName = "Modbus Slave (iolist)"

    print(f"Coils: 0~{len(coil_vals)-1} ({len(coil_vals)}개)")
    print(f"Holding Registers: 0~{len(reg_vals)-1} ({len(reg_vals)}개)")
    print("시뮬레이션: 경고등 랜덤 점등, 타발/카운터 +1 후 복귀")
    print(f"Modbus TCP 슬레이브 {HOST}:{PORT} 에서 대기 중... (Ctrl+C 종료)")
    try:
        StartTcpServer(context=context, identity=identity, address=(HOST, PORT))
    except (OSError, RuntimeError) as e:
        err_msg = str(e).lower()
        if getattr(e, "errno", None) == 98 or "address already in use" in err_msg or "could not start listen" in err_msg:
            print(f"\n오류: 포트 {PORT}이(가) 이미 사용 중입니다.")
            print("  기존 슬레이브를 종료한 뒤 다시 실행하거나, 다른 포트를 사용하세요:")
            print(f"    PORT={PORT + 1} ./run-modbus-slave.sh")
            print(f"    또는  ./run-modbus-slave.sh {PORT + 1}")
            print("  사용 중인 프로세스 확인: ss -ltnp | grep " + str(PORT))
        else:
            raise


if __name__ == "__main__":
    main()
