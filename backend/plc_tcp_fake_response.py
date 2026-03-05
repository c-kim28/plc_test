#!/usr/bin/env python3
"""
plc_tcp_send.py / plc_mcprotocol.py 가 보내는 3E 읽기 요청에 대해
하드코딩된 응답 패킷을 돌려주는 TCP 서버.

아래 4가지 요청만 구분해서 응답합니다. 값 바꾸려면 아래 상수만 수정하면 됨.
  - D140   word 1개
  - Y107   boolean 1비트
  - D1810  dword 1개 (2워드)
  - D1560  string 16바이트 (8워드)

※ FAKE_* 상수 수정 후 반드시 이 서버를 재시작해야 새 값이 적용됩니다.

사용법:
  1) 이 서버 실행: python3 backend/plc_tcp_fake_response.py
  2) 클라이언트는 PLC 대신 이 PC IP + 5002 로 연결해서 요청
     예: python3 backend/plc_tcp_send.py --host 127.0.0.1 --device D --address 140 --type word --length 1
"""
import socket
import sys

# --------------- 여기만 수정해서 응답 값 바꿀 수 있음 ---------------
# D140 word 1개 (1워드 = 2바이트, 빅엔디안). 예: 255 → 0x00FF
FAKE_D140_WORD = 255

# Y107 boolean 1비트. 0 또는 1 (1워드로 전송, 하위 비트만 사용)
FAKE_Y107_BIT = 1

# D1810 dword 1개 (하위워드, 상위워드 순서, 각 워드 빅엔디안). 예: 12345678
FAKE_D1810_DWORD = 12345678

# D1560 string 16바이트 (ASCII, 8워드). 16자 미만이면 공백으로 채움
FAKE_D1560_STRING = "Cathy Daebak"
# ---------------------------------------------------------------

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


# 요청 구분: 바디 = timer(2) + cmd(2) + subcmd(2) + ...
# 0401: + addr3(3) + device(1) + points(2)  → 12바이트
# 0403: + word_size(1) + dword_size(1) + devicedata 4바이트씩
def match_request(body: bytes) -> str | None:
    if len(body) < 8:
        return None
    cmd = body[2] | (body[3] << 8)
    if cmd == 0x0401:
        if len(body) < 12:
            return None
        addr = body[6] | (body[7] << 8) | (body[8] << 16)
        device = body[9]
        points = body[10] | (body[11] << 8)
        if device == 0xA8 and addr == 0x8C and points == 1:
            return "D140_word"
        if device == 0x9D and (addr == 0x6B or addr == 0x107) and points == 1:
            return "Y107_bool"
        if device == 0xA8 and addr == 0x712 and points == 2:
            return "D1810_dword"
        if device == 0xA8 and addr == 0x618 and points == 8:
            return "D1560_string"
    elif cmd == 0x0403 and len(body) >= 12:
        word_size, dword_size = body[6], body[7]
        if word_size == 0 and dword_size == 1 and body[8] == 0x12 and body[9] == 0x07 and body[10] == 0 and body[11] == 0xA8:
            return "D1810_dword_random"
    return None


# kind → read_data 바이트 (pymcprotocol이 기대하는 형식: LE, 비트패킹)
# batchread_bitunits: 비트 0 = 첫 바이트의 bit4 → 1이면 0x10
FAKE_RESPONSES = {
    "D140_word": lambda: word_to_le_bytes(FAKE_D140_WORD),
    "Y107_bool": lambda: bytes([0x10 if FAKE_Y107_BIT else 0x00, 0x00]),
    "D1810_dword": lambda: dword_to_read_data_le(FAKE_D1810_DWORD),
    "D1810_dword_random": lambda: dword_to_read_data_le(FAKE_D1810_DWORD),
    "D1560_string": lambda: string_to_read_data(FAKE_D1560_STRING, 16),
}

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
    kind = match_request(body)
    if kind and kind in FAKE_RESPONSES:
        read_data = FAKE_RESPONSES[kind]()
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
    print(f"3E 가짜 응답 서버 대기 중: {LISTEN_HOST}:{LISTEN_PORT}")
    print(f"  현재 FAKE_Y107_BIT={FAKE_Y107_BIT}, FAKE_D140_WORD={FAKE_D140_WORD}")
    print("  D140 word, Y107 boolean, D1810 dword, D1560 string  요청만 응답")
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
