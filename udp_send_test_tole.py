#!/usr/bin/env python3
"""
TOLE(True Order Little-Endian) UDP 테스트 송신기.

리틀엔디안 전용: TOBE와 다른 바이트 순서로 전송. 파싱 탭에서 '리틀엔디안' 선택 시 해석.
- Dword: 워드스왑 (하위워드 먼저, 상위워드 나중). 각 워드는 빅엔디안.
  예: 값 0x01234567 → BE에서는 01 23 45 67, LE에서는 45 67 01 23 로 전송.
- Word(16bit): 리틀엔디안 바이트. String: 16비트 워드 단위 바이트 스왑.
수신: PLC UDP Monitor (포트 5212).
"""
import json
import socket
import time
from pathlib import Path

# 설정
HOST = "127.0.0.1"
PORT = 5212
INTERVAL_SEC = 1.0

SCRIPT_DIR = Path(__file__).resolve().parent
IO_VARIABLES_PATH = SCRIPT_DIR / "io_variables.json"

# 칼럼 ID/설명에 맞춘 유의미한 더미값 (TOBE와 동일, Word는 16bit, Dword는 base별 32bit → 16bit씩 하위/상위 분할)
MEANINGFUL_WORD = {
    "currentDieNumber_D140": 42,
    "nextDieNumber_D510": 43,
    "currentDieHeight_D711": 3505,   # 350.5 mm
    "nextDieHeight_D511": 3510,
    "currentBalanceAirPressure_D713": 550,   # 55.0
    "nextBalanceAirPressure_D513": 548,
    "pressAngle_D100": 180,           # 0~360
    "cPMCyclePerMinute_D104": 125,   # 12.5 타발/분
    "strokePerMinute_D126": 120,     # 12.0 타발/분
    "crankShaftTempRightFront_D340": 350,   # 35.0°C
    "crankShaftTempLeftFront_D341": 348,
    "crankShaftTempRightRear_D342": 352,
    "crankShaftTempLeftRear_D343": 345,
    "conrodTempLeft_D330": 340,
    "conrodTempRight_D331": 342,
    "oilSupplyCountSlide_D20": 20,
    "oilSupplyCountBalanceCylinder_D21": 3,
    "oilSupplyCountCrownLeft_D22": 50,
    "oilSupplyCountCrownRight_D23": 50,
    "todayRunningTime_D1914": 480,    # 금일 기동시간(분) 8h
}
# Dword: 논리별 32bit 값. 16bit 레지스터일 때 짝수 D=하위 16비트, 홀수 D=상위 16비트 (LE 순서로 하위워드→상위워드)
MEANINGFUL_DWORD = {
    "totalCounter": 125000,           # 프레스의 총 타발수
    "productionCounter": 10000,       # 목표 타발수(ex: 주생산량)
    "currentProduction": 8500,       # 현재까지 타발된 수
    "defficiencyQuantity": (-1500) & 0xFFFFFFFF,  # 생산계획량-현재생산량
    "presetCounter": 5000,            # 목표 타발수(ex: 일생산량)
    "production": 12345,              # 생산
    "todayStrokeCount": 3200,         # 금일 기준 슬라이드 행정 수
}


def load_variables():
    """io_variables.json을 순서대로 로드. 반환: [(name, length_bits, data_type, scale, description), ...]"""
    with open(IO_VARIABLES_PATH, "r", encoding="utf-8") as f:
        obj = json.load(f)
    out = []
    for name, val in obj.items():
        if isinstance(val, dict) and "length" in val:
            length = int(val["length"])
            data_type = (val.get("dataType") or "").strip().lower()
            scale = (val.get("scale") or "1").strip()
            description = (val.get("description") or "").strip()
        else:
            length = int(val) if isinstance(val, (int, float)) else 0
            data_type = ""
            scale = "1"
            description = ""
        out.append((name, length, data_type, scale, description))
    return out


def build_string_groups(variables):
    """연속된 String 변수를 같은 base로 묶음. 반환: { base: [(name, length_bits), ...] }"""
    groups = {}
    for name, length_bits, data_type, *_ in variables:
        if data_type != "string":
            continue
        base = name.rsplit("_", 1)[0] if "_" in name else name
        groups.setdefault(base, []).append((name, length_bits))
    return groups


def _dword_base_and_index(name):
    """xxx_D1820 → ('xxx', 1820). 짝수 D=하위 16비트, 홀수 D=상위 16비트."""
    if "_D" not in name:
        return None, None
    parts = name.rsplit("_D", 1)
    if len(parts) != 2 or not parts[1].isdigit():
        return None, None
    return parts[0], int(parts[1], 10)


def get_meaningful_value(name, length_bits, data_type, scale, description):
    """Boolean: 0/1, Word/Dword: 칼럼에 맞는 값(Dword 16bit일 때 하위/상위 분할), String: None(별도 처리)."""
    if data_type == "string":
        return None
    if data_type == "boolean":
        if "운전준비" in description or "준비" in description or "Green" in name:
            return 1
        if "비상" in description or "알람" in description or "에러" in description or "오류" in description:
            return 0
        return 1 if "해제" in description or "진입" in description else 0
    if data_type == "word" and length_bits == 16:
        return MEANINGFUL_WORD.get(name, 0)
    if data_type == "dword":
        base, num = _dword_base_and_index(name)
        full = MEANINGFUL_DWORD.get(base, 0) if base else 0
        if length_bits == 16:
            # 짝수 D = 하위 16비트, 홀수 D = 상위 16비트 (LE에서도 동일: 하위워드 먼저, 상위워드 나중)
            return (full & 0xFFFF) if (num is not None and (num & 1) == 0) else ((full >> 16) & 0xFFFF)
        if length_bits == 32:
            return full
    return 0


def value_to_bytes(value, length_bits, data_type, big_endian=False, string_chunk=None):
    """값을 바이트로. string_chunk: String일 때 이 구간에 넣을 바이트."""
    if data_type == "string" and string_chunk is not None:
        byte_count = (length_bits + 7) // 8
        return string_chunk.ljust(byte_count, b"\x00")[:byte_count]
    if value is None:
        byte_count = (length_bits + 7) // 8
        return bytes(byte_count)
    if data_type == "boolean":
        return bytes([1 if value else 0])
    if length_bits == 16:
        v = int(value) & 0xFFFF
        if big_endian:
            return bytes([(v >> 8) & 0xFF, v & 0xFF])
        return bytes([v & 0xFF, (v >> 8) & 0xFF])
    if length_bits == 32:
        v = int(value) & 0xFFFFFFFF
        if big_endian:
            return bytes([(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF])
        return bytes([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF])
    byte_count = (length_bits + 7) // 8
    v = int(value) & ((1 << length_bits) - 1)
    b = []
    for i in range(byte_count - 1, -1, -1):
        b.append((v >> (i * 8)) & 0xFF)
    return bytes(reversed(b)) if not big_endian else bytes(b)


def bytes_to_bits_be(b: bytes):
    """바이트를 비트 리스트로 (바이트당 MSB 먼저)."""
    bits = []
    for byte in b:
        for i in range(8):
            bits.append((byte >> (7 - i)) & 1)
    return bits


def bits_to_bytes(bits: list) -> bytes:
    """비트 리스트를 바이트로 패킹 (8비트=1바이트, MSB 먼저)."""
    out = []
    for i in range(0, len(bits), 8):
        chunk = bits[i : i + 8]
        byte = sum(b << (7 - j) for j, b in enumerate(chunk))
        out.append(byte)
    return bytes(out)


def swap_16bit_word_bytes(data: bytes) -> bytes:
    """16비트 워드 단위로 바이트 스왑 (리틀엔디안으로 보이도록)."""
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        if i + 1 < n:
            out.append(data[i + 1])
            out.append(data[i])
        else:
            out.append(data[i])
        i += 2
    return bytes(out)


def main():
    variables = load_variables()
    total_bits = sum(length for _, length, *_ in variables)
    total_bytes = (total_bits + 7) // 8
    print(f"io_variables.json: 총 비트 = {total_bits}, 바이트 = {total_bytes}")

    total_var_bits = total_bits
    total_bytes = (total_var_bits + 7) // 8
    wire_bits = total_bytes * 8
    padding_bits = wire_bits - total_var_bits

    string_groups = build_string_groups(variables)
    group_full_strings = {}
    for base, items in string_groups.items():
        total_bytes = sum(length_bits // 8 for _, length_bits in items)
        group_full_strings[base] = "hello".encode("ascii").ljust(total_bytes, b"\x00")[:total_bytes]
    base_offset = {}

    bits = [0] * padding_bits
    dword_sample = []
    for name, length_bits, data_type, scale, description in variables:
        value = get_meaningful_value(name, length_bits, data_type, scale, description)
        if data_type == "dword" and length_bits == 16 and value is not None and len(dword_sample) < 6:
            dword_sample.append((name, value))
        if data_type == "string":
            base = name.rsplit("_", 1)[0] if "_" in name else name
            off = base_offset.get(base, 0)
            chunk_len = length_bits // 8
            full = group_full_strings.get(base, b"")
            chunk = full[off : off + chunk_len] if off < len(full) else bytes(chunk_len)
            base_offset[base] = off + chunk_len
            # 문자열은 워드 스왑 없이 자연 순서로 전송 (hello → 68 65 6C 6C 6F 00)
            raw = value_to_bytes(None, length_bits, data_type, big_endian=True, string_chunk=chunk)
        else:
            # Dword 16bit 절반: 워드스왑만 (하위→상위 순서), 각 워드는 빅엔디안으로 전송 → 수신측 LE 파싱과 동일값
            use_be = (data_type == "dword" and length_bits == 16)
            raw = value_to_bytes(value, length_bits, data_type, big_endian=use_be)
        if data_type == "boolean" and length_bits == 1:
            bits.append(1 if value else 0)
        else:
            bits.extend(bytes_to_bits_be(raw))
    payload = bits_to_bytes(bits)

    if dword_sample:
        print("Dword 샘플(전송값, LE 하위/상위 16bit):", " | ".join(f"{n}={v}" for n, v in dword_sample))
    print("io_variables:", IO_VARIABLES_PATH.resolve())
    print("※ 화면에서 0으로 보이면: 1) 'UDP 파싱' 탭인지 확인 2) 백엔드에서 UDP 수신 시작 후 이 스크립트 실행")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    counter = 0
    try:
        print(f"매 {INTERVAL_SEC}초마다 같은 데이터를 {HOST}:{PORT} 로 전송합니다. (Ctrl+C 종료)")
        while True:
            sock.sendto(payload, (HOST, PORT))
            counter += 1
            print(f"  전송 #{counter} ({total_bytes} bytes)", end="\r")
            time.sleep(INTERVAL_SEC)
    except KeyboardInterrupt:
        print("\n종료.")
    finally:
        sock.close()


if __name__ == "__main__":
    main()
