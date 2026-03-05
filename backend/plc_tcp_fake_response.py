#!/usr/bin/env python3
"""
plc_tcp_send.py / plc_mcprotocol.py 가 보내는 3E 읽기 요청에 대해
mc_fake_values.json에 정의된 값으로 응답 패킷을 돌려주는 TCP 서버.

JSON에서 키(예: M300, D140)와 value를 수정하면 요청 시마다 파일을 다시 읽어
해당 값으로 응답합니다. 대시보드 폴링 시 JSON 값이 그대로 표시됩니다.

사용법:
  1) mc_fake_values.json에 디바이스+주소 키와 value 추가/수정 (예: "M300": {"dataType":"Boolean","length":1,"value":1})
  2) 이 서버 실행: python3 backend/plc_tcp_fake_response.py
  3) 클라이언트는 PLC 대신 이 PC IP + 5002 로 연결
"""
import json
import socket
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
MC_FAKE_VALUES_PATH = SCRIPT_DIR / "mc_fake_values.json"

# 3E 디바이스 코드 (plc_tcp_send / modbus_tcp_read와 동일)
DEVICE_CODE_TO_LETTER = {0xA8: "D", 0x9D: "Y", 0x90: "M"}

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 5002
RESPONSE_HEADER_LEN = 9
END_CODE_LEN = 2
END_CODE_OK = bytes([0x00, 0x00])


def word_to_le_bytes(value: int) -> bytes:
    """16비트 값을 2바이트 리틀엔디안. pymcprotocol이 LE로 해석함."""
    v = value & 0xFFFF
    return bytes([v & 0xFF, (v >> 8) & 0xFF])


def dword_to_read_data_le(value: int) -> bytes:
    """32비트 값을 4바이트 리틀엔디안. pymcprotocol randomread/batchread_wordunits 해석에 맞춤."""
    value = value & 0xFFFFFFFF
    return bytes([
        value & 0xFF,
        (value >> 8) & 0xFF,
        (value >> 16) & 0xFF,
        (value >> 24) & 0xFF,
    ])


def string_to_read_data(s: str, length: int) -> bytes:
    """문자열을 length 바이트로. 워드 단위로 보냄(현재 pymcprotocol string 해석과 맞음)."""
    b = s.encode("ascii", errors="replace")[:length]
    b = b + b"\x00" * (length - len(b))
    # 워드 단위로 빅엔디안: 각 2바이트는 [high, low]
    out = []
    for i in range(0, len(b), 2):
        if i + 1 < len(b):
            out.append(bytes([b[i], b[i + 1]]))
        else:
            out.append(bytes([b[i], 0]))
    return b"".join(out)


def build_3e_response(read_data: bytes) -> bytes:
    """3E 응답: 헤더 9바이트 + End code 2바이트 + Read data."""
    payload_len = END_CODE_LEN + len(read_data)
    subheader = b"\xD0\x00"  # 응답 서브헤더
    header = (
        subheader
        + b"\x00\xFF"
        + (0x03FF).to_bytes(2, "little")
        + b"\x00"
        + payload_len.to_bytes(2, "little")
    )
    return header + END_CODE_OK + read_data


def load_mc_fake_values() -> dict:
    """mc_fake_values.json 로드. 키로 '_' 시작하는 항목 제외."""
    if not MC_FAKE_VALUES_PATH.exists():
        return {}
    try:
        with open(MC_FAKE_VALUES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if isinstance(v, dict) and not k.startswith("_")}
    except (OSError, json.JSONDecodeError):
        return {}


def build_read_data_from_entry(entry: dict) -> bytes:
    """entry(dataType, length, value) → pymcprotocol이 기대하는 read_data 바이트."""
    t = (entry.get("dataType") or "").strip().lower()
    length = int(entry.get("length") or 1)
    val = entry.get("value")
    if t == "boolean":
        bit = 1 if val else 0
        return bytes([0x10 if bit else 0x00, 0x00])
    if t == "word":
        return word_to_le_bytes(int(val) if val is not None else 0)
    if t == "dword":
        return dword_to_read_data_le(int(val) if val is not None else 0)
    if t == "string":
        s = str(val) if val is not None else ""
        return string_to_read_data(s, length)
    return word_to_le_bytes(int(val) if val is not None else 0)


# 요청 구분: 바디 = timer(2) + cmd(2) + subcmd(2) + ...
# 0401: + addr3(3) + device(1) + points(2)  → 12바이트
# 0403: + word_size(1) + dword_size(1) + devicedata 4바이트씩
def _addr_to_config_key(letter: str, addr: int, config: dict) -> str | None:
    """(device_letter, 3E주소) → config 키. Y/M은 0x01XX(상위바이트 1, 하위 2바이트=번호) 인코딩 사용."""
    # 기본 후보: 10진/16진 표기 모두 허용 (예: Y332, Y14C)
    direct_candidates = (
        f"{letter}{addr}",
        f"{letter}{addr:X}",
    )
    for c in direct_candidates:
        if c in config:
            return c

    # Y/M: 0x0107 → Y107, 0x0109 → Y109 (상위 1바이트=1, 하위=십진 번호처럼 07→7, 09→9 → 1*100+7=107)
    if letter in ("Y", "M") and (addr & 0xFF00) == 0x0100:
        normalized = (addr >> 8) * 100 + (addr & 0xFF)
        for c in (f"{letter}{normalized}", f"{letter}{normalized:X}"):
            if c in config:
                return c
    if letter in ("Y", "M") and addr >= 0x100:
        legacy = addr - 0x100
        for c in (f"{letter}{legacy}", f"{letter}{legacy:X}"):
            if c in config:
                return c
    return None


def match_request(body: bytes, config: dict) -> str | None:
    """요청 바디를 파싱해 config에 있는 키(예: D140, M300)를 반환. 없으면 None."""
    if len(body) < 8:
        return None
    cmd = body[2] | (body[3] << 8)
    if cmd == 0x0401 and len(body) >= 12:
        addr = body[6] | (body[7] << 8) | (body[8] << 16)
        device = body[9]
        letter = DEVICE_CODE_TO_LETTER.get(device)
        if letter is not None:
            key = _addr_to_config_key(letter, addr, config)
            if key is not None:
                return key
    elif cmd == 0x0403 and len(body) >= 12:
        word_size, dword_size = body[6], body[7]
        total_devices = word_size + dword_size
        expected_len = 8 + total_devices * 4
        if total_devices > 0 and len(body) >= expected_len:
            # devicedata 4바이트: addr(3) + device(1)
            # 먼저 word 목록, 다음 dword 목록 순서.
            offset = 8
            for _ in range(total_devices):
                addr = body[offset] | (body[offset + 1] << 8) | (body[offset + 2] << 16)
                device = body[offset + 3]
                letter = DEVICE_CODE_TO_LETTER.get(device)
                if letter is not None:
                    key = _addr_to_config_key(letter, addr, config)
                    if key is not None:
                        return key
                offset += 4
    return None

REQUEST_BODY_LEN = 12
MIN_REQUEST_LEN = RESPONSE_HEADER_LEN + REQUEST_BODY_LEN  # 21


def handle_client(conn: socket.socket):
    data = b""
    while len(data) < MIN_REQUEST_LEN:
        chunk = conn.recv(4096)
        if not chunk:
            return
        data += chunk
    body = data[RESPONSE_HEADER_LEN : MIN_REQUEST_LEN]
    if len(body) < 12:
        print(f"  → 바디 부족: {len(body)} bytes, hex={body.hex()}")
        return
    config = load_mc_fake_values()
    kind = match_request(body, config)
    if kind and kind in config:
        read_data = build_read_data_from_entry(config[kind])
    else:
        read_data = word_to_le_bytes(0)
        if kind is None:
            addr = body[6] | (body[7] << 8) | (body[8] << 16)
            device = body[9]
            points = body[10] | (body[11] << 8)
            print(f"  → 미매칭: body(hex)={body.hex()}, addr=0x{addr:X} device=0x{device:X} points={points}")
    resp = build_3e_response(read_data)
    conn.sendall(resp)
    if kind:
        print(f"  → {kind}, read_data={read_data.hex()}, 응답 {len(resp)} bytes")


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind((LISTEN_HOST, LISTEN_PORT))
    except OSError as e:
        print(f"오류: 바인드 실패 {LISTEN_HOST}:{LISTEN_PORT} - {e}", file=sys.stderr)
        sys.exit(1)
    server.listen(5)
    config = load_mc_fake_values()
    keys = ", ".join(sorted(config.keys())) if config else "(없음)"
    print(f"3E 가짜 응답 서버 대기 중: {LISTEN_HOST}:{LISTEN_PORT}")
    print(f"  설정: {MC_FAKE_VALUES_PATH}")
    print(f"  항목: {keys}")
    while True:
        conn, addr = server.accept()
        print(f"연결: {addr}")
        try:
            handle_client(conn)
        except Exception as e:
            print(f"  오류: {e}", file=sys.stderr)
        finally:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()


if __name__ == "__main__":
    main()
