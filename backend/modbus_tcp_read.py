#!/usr/bin/env python3
"""
단순 TCP 소켓 1회 읽기 스크립트.
PLC(host:port)에 TCP 연결 후 수신한 바이트를 io_variables.json 순서·길이로 파싱해 변수별 값 출력.
(pymodbus 미사용)

사용 예:
  python backend/modbus_tcp_read.py --host 192.168.0.5 --port 5002
  python backend/modbus_tcp_read.py --host 192.168.0.5 --send "0100" --little-endian
"""
import argparse
import json
import re
import socket
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
IO_VARIABLES_PATH = REPO_ROOT / "io_variables.json"


def _is_variable_entry(name: str, info: dict) -> bool:
    """변수 엔트리인지(길이/타입 있음). mitsubishi_d_start 등 메타 키 제외."""
    if not isinstance(info, dict):
        return False
    return info.get("length") is not None or (info.get("dataType") or "").strip() != ""


def load_io_variables():
    """io_variables.json 순서대로 로드. [(name, info), ...] (변수만, 메타 키 제외)."""
    with open(IO_VARIABLES_PATH, "r", encoding="utf-8") as f:
        obj = json.load(f)
    return [(k, v) for k, v in obj.items() if _is_variable_entry(k, v)]


def get_mitsubishi_options_from_io_variables() -> tuple[str, int, int | None]:
    """
    io_variables.json 루트에서 미쯔비시 요청 옵션 반환. (device, start_address, words 또는 None)
    mitsubishi_words: 지정 시 해당 워드 수만 요청(예: 1=Y107 1비트). None이면 전체 블록.
    """
    with open(IO_VARIABLES_PATH, "r", encoding="utf-8") as f:
        obj = json.load(f)
    device = "D"
    start = 0
    words: int | None = None
    if "mitsubishi_device" in obj and str(obj["mitsubishi_device"]).strip().upper() in ("Y", "M", "D"):
        device = str(obj["mitsubishi_device"]).strip().upper()
    m = obj.get("mitsubishi")
    if isinstance(m, dict):
        if m.get("device") and str(m["device"]).strip().upper() in ("Y", "M", "D"):
            device = str(m["device"]).strip().upper()
        if "d_start" in m:
            try:
                start = int(m["d_start"])
            except (TypeError, ValueError):
                pass
        if "words" in m:
            try:
                w = int(m["words"])
                if w > 0:
                    words = w
            except (TypeError, ValueError):
                pass
    if "mitsubishi_d_start" in obj:
        try:
            start = int(obj["mitsubishi_d_start"])
        except (TypeError, ValueError):
            pass
    if "mitsubishi_words" in obj:
        try:
            w = int(obj["mitsubishi_words"])
            if w > 0:
                words = w
        except (TypeError, ValueError):
            pass
    return device, start, words


def _total_bytes(entries):
    total_bits = sum(int(info.get("length", 0)) if isinstance(info, dict) else 0 for _, info in entries)
    return (total_bits + 7) // 8


def _device_group(name: str) -> str | None:
    m = re.search(r"_([YMDX])[\dA-Za-z]*$", name, re.IGNORECASE)
    return m.group(1).upper() if m else None


# ----- 미쯔비시 MELSEC MC 프로토콜 3E 프레임 (QnA 호환) -----
# 3E: Subheader 5000(요청)/D000(응답), 0401=워드 배치 읽기. 헤더+바디 한 패킷으로 전송.
# Y107 1비트(1워드) 읽기 예시 패킷: 50 00 00 FF FF 03 00 0C 00 10 00 01 04 01 00 07 01 00 9D 01 00
# 디바이스 코드: Y=0x9D(해당 PLC), M=0x90, D=0xA8
MITSUBISHI_3E_RESPONSE_HEADER_LEN = 11  # Subheader(2)+Network(1)+PC(1)+I/O(2)+Station(1)+DataLen(2)+Reserved(2)
MITSUBISHI_3E_END_CODE_LEN = 2
MITSUBISHI_3E_DEVICE_CODES = {"Y": 0x9D, "M": 0x90, "D": 0xA8}


def build_mitsubishi_3e_0401_read(
    device: str,
    start_address: int,
    num_words: int,
    timer_value: int = 0x0010,
) -> bytes:
    """
    미쯔비시 3E 프레임 · 0401(워드 배치 읽기) 요청 패킷 생성. 헤더+바디 한 덩어리.
    device: "Y"|"M"|"D", start_address: 디바이스 번호(예: Y107→107, D140→140).
    Y일 때 주소는 0x0100+번호(예: Y107→0x0107→07 01 00)로 인코딩.
    """
    cmd = 0x0401
    device_code = MITSUBISHI_3E_DEVICE_CODES.get((device or "D").upper(), 0xA8)
    dev = (device or "D").upper()
    if dev == "Y":
        # Y107 → 1, 07 → 0x0107 → 07 01 00 (해당 PLC 주소 인코딩)
        addr24 = ((start_address // 100) << 8) | (start_address % 100)
        addr24 &= 0xFFFFFF
    else:
        addr24 = start_address & 0xFFFFFF
    addr3 = addr24.to_bytes(3, "little")
    points = num_words.to_bytes(2, "little")
    # 해당 PLC: 서브커맨드 01 00, 블록 개수 바이트 없이 addr3+device+points 바로 이어짐 (바디 12바이트)
    subcmd = (1).to_bytes(2, "little")
    request_body = (
        timer_value.to_bytes(2, "little")
        + cmd.to_bytes(2, "little")
        + subcmd
        + addr3
        + bytes([device_code])
        + points
    )
    request_data_len = len(request_body)

    subheader = b"\x50\x00"
    network_no = 0x00
    pc_no = 0xFF
    io_no = 0x03FF
    station = 0x00
    header = (
        subheader
        + bytes([network_no, pc_no])
        + io_no.to_bytes(2, "little")
        + bytes([station])
        + request_data_len.to_bytes(2, "little")
    )
    return header + request_body


def parse_bytes_to_variables(data: bytes, entries: list, little_endian: bool = False) -> dict:
    """
    바이트 스트림을 io_variables 순서·길이로 파싱.
    BE: 16/32비트 빅엔디안. LE: 32비트만 워드스왑(하위워드 먼저), 16비트는 BE 유지.
    """
    result = {}
    total_bits = len(data) * 8
    offset = 0
    entries = list(entries)
    i = 0
    while i < len(entries):
        name, info = entries[i]
        length_bit = int(info.get("length", 0)) if isinstance(info, dict) else 0
        data_type = (info.get("dataType") or "").strip().lower()
        length_bit = int(length_bit) or 0

        next_entry = entries[i + 1] if i + 1 < len(entries) else None
        next_name, next_info = (next_entry[0], next_entry[1]) if next_entry else (None, None)
        next_len = int(next_info.get("length", 0)) if isinstance(next_info, dict) else 0
        next_dt = (next_info.get("dataType") or "").strip().lower() if next_info else ""

        is_dword_low = data_type == "dword" and length_bit == 16 and next_dt == "dword" and next_len == 16
        m = re.match(r"^(.+)_D(\d+)$", name)
        n = re.match(r"^(.+)_D(\d+)$", next_name) if next_name else None
        same_pair = m and n and m.group(1) == n.group(1) and int(n.group(2)) == int(m.group(2)) + 1
        do_word_swap_32 = little_endian and is_dword_low and same_pair and (offset % 8 == 0) and (offset + 32 <= total_bits)

        if length_bit <= 0 or offset + length_bit > total_bits:
            result[name] = "-"
            if length_bit > 0:
                offset += length_bit
            i += 1
            continue

        if do_word_swap_32:
            start = offset >> 3
            low = ((data[start] << 8) | data[start + 1]) & 0xFFFF
            high = ((data[start + 2] << 8) | data[start + 3]) & 0xFFFF
            val = (high << 16) | low
            result[name] = val & 0xFFFF
            result[next_name] = (val >> 16) & 0xFFFF
            offset += 32
            i += 2
            continue

        byte_offset = offset >> 3
        length_byte = (length_bit + 7) // 8

        if length_bit <= 32 and length_bit > 0:
            if length_bit == 8 and byte_offset < len(data):
                result[name] = data[byte_offset] & 0xFF
            elif length_bit == 16 and byte_offset + 2 <= len(data):
                result[name] = ((data[byte_offset] << 8) | data[byte_offset + 1]) & 0xFFFF
            elif length_bit == 32 and byte_offset + 4 <= len(data):
                if little_endian:
                    low = ((data[byte_offset] << 8) | data[byte_offset + 1]) & 0xFFFF
                    high = ((data[byte_offset + 2] << 8) | data[byte_offset + 3]) & 0xFFFF
                    result[name] = ((high << 16) | low) & 0xFFFFFFFF
                else:
                    result[name] = (
                        (data[byte_offset] << 24)
                        | (data[byte_offset + 1] << 16)
                        | (data[byte_offset + 2] << 8)
                        | data[byte_offset + 3]
                    ) & 0xFFFFFFFF
            else:
                result[name] = "-"
        else:
            # 문자열: 바이트 그대로 hex
            chunk = data[byte_offset : byte_offset + length_byte]
            result[name] = chunk.hex() if chunk else "-"

        offset += length_bit
        i += 1

    return result


def run_tcp_read(
    host: str,
    port: int,
    timeout: float = 5.0,
    send_hex: str | None = None,
    trigger_1byte: bool = True,
    little_endian: bool = False,
    group: str | None = None,
    use_mitsubishi: bool = False,
    mitsubishi_device: str = "D",
    mitsubishi_d_start: int = 0,
    mitsubishi_words: int | None = None,
    bind_address: str | None = None,
    local_port: int | None = None,
) -> dict:
    """
    TCP 소켓으로 연결 → (선택) 전송 → 수신 바이트를 io_variables로 파싱해 반환.
    use_mitsubishi True면 3E 0401(헤더+바디) 요청 전송. device/start로 Y·M·D 주소 지정.
    PLC 쪽 포트는 port(기본 5002), 내쪽(클라이언트) 포트는 local_port(예: 2025). bind_address로 나가는 IP 지정 가능.
    """
    entries = load_io_variables()
    total = _total_bytes(entries)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    if bind_address or local_port is not None:
        addr = bind_address or ""
        port_bind = local_port if local_port is not None else 0
        try:
            sock.bind((addr, port_bind))
        except OSError as e:
            raise RuntimeError(
                f"소켓 바인드 실패 {addr or '0.0.0.0'}:{port_bind}. "
                "로컬 포트가 사용 중이거나, --bind 사용 시 해당 IP를 이 PC에 추가했는지 확인하세요."
            ) from e
    try:
        sock.connect((host, port))
    except OSError as e:
        raise RuntimeError(f"TCP 연결 실패 {host}:{port}: {e}") from e

    try:
        if use_mitsubishi:
            num_words = mitsubishi_words if mitsubishi_words is not None and mitsubishi_words > 0 else (total + 1) // 2
            packet = build_mitsubishi_3e_0401_read(
                mitsubishi_device, mitsubishi_d_start, num_words
            )
            sock.sendall(packet)
            # 먼저 헤더 11바이트 수신 후, 헤더의 "응답 데이터 길이"로 나머지 수신 (PLC가 1워드만 보내도 처리)
            data = b""
            while len(data) < MITSUBISHI_3E_RESPONSE_HEADER_LEN:
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    raise RuntimeError(
                        f"수신 타임아웃({timeout}초). 미쯔비시 3E 응답이 오지 않았습니다. "
                        "PLC 종류/주소/포트(5002), io_variables의 mitsubishi_device·mitsubishi_d_start를 확인하세요."
                    ) from None
                if not chunk:
                    break
                data += chunk
            if len(data) < MITSUBISHI_3E_RESPONSE_HEADER_LEN:
                raise RuntimeError(f"수신 부족: 헤더 {len(data)} bytes (필요 11)")
            # 헤더 바이트 7-8: 응답 데이터 길이(리틀엔디안) = End code 2바이트 + 읽기 데이터
            response_data_len = data[7] | (data[8] << 8)
            need = MITSUBISHI_3E_RESPONSE_HEADER_LEN + response_data_len
            while len(data) < need:
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    raise RuntimeError(
                        f"수신 타임아웃({timeout}초). 응답 데이터 수신 중."
                    ) from None
                if not chunk:
                    break
                data += chunk
            if len(data) < need:
                raise RuntimeError(f"수신 부족: {len(data)} bytes (필요 {need})")
            # 페이로드 = End code(2) 제외한 읽기 데이터. 114바이트 미만이면 0 패딩
            payload_start = MITSUBISHI_3E_RESPONSE_HEADER_LEN + MITSUBISHI_3E_END_CODE_LEN
            payload_len = response_data_len - MITSUBISHI_3E_END_CODE_LEN
            payload = data[payload_start : payload_start + payload_len]
            if len(payload) < total:
                payload = payload + b"\x00" * (total - len(payload))
            data = payload[:total]
        else:
            if send_hex:
                hex_clean = send_hex.replace(" ", "").strip()
                if len(hex_clean) % 2:
                    hex_clean = "0" + hex_clean
                if not re.match(r"^[0-9A-Fa-f]+$", hex_clean):
                    raise ValueError("--send: hex 문자열만 가능 (공백 제거 후 짝수 자리)")
                raw = bytes.fromhex(hex_clean)
                sock.sendall(raw)
            elif trigger_1byte:
                sock.sendall(b"\x01")
            data = b""
            while len(data) < total:
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    raise RuntimeError(
                        f"수신 타임아웃({timeout}초). PLC가 {total}바이트를 보내지 않았습니다. "
                        "연결만 하고 대기 중이면 PLC가 요청(--send) 후에만 응답할 수 있습니다. "
                        "미쯔비시 PLC면 --mitsubishi, 그 외 --timeout 증가 또는 --send로 요청 형식 전송."
                    ) from None
                if not chunk:
                    break
                data += chunk
            if len(data) < total:
                raise RuntimeError(f"수신 부족: {len(data)} bytes (필요 {total})")
            data = data[:total]
        result = parse_bytes_to_variables(data, entries, little_endian=little_endian)
        if group and str(group).strip().upper() in ("Y", "M", "D", "X"):
            g = str(group).strip().upper()
            result = {k: v for k, v in result.items() if _device_group(k) == g}
        return result
    finally:
        try:
            sock.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="TCP 소켓 1회 읽기 (io_variables.json 순서·길이로 파싱)")
    parser.add_argument("--host", default="127.0.0.1", help="PLC(서버) IP")
    parser.add_argument("--port", type=int, default=5002, help="PLC(서버) TCP 포트 (기본 5002)")
    parser.add_argument("--local-port", type=int, default=None, metavar="PORT", help="내쪽(클라이언트) 포트 (예: 2025). 지정 시 나가는 연결을 이 포트로 묶음")
    parser.add_argument("--bind", dest="bind_address", default=None, metavar="IP", help="나가는 연결을 묶을 로컬 IP. 예: --bind 192.168.0.41")
    parser.add_argument("--timeout", type=float, default=5.0, help="연결/수신 타임아웃(초)")
    parser.add_argument("--send", default=None, metavar="HEX", help="연결 후 전송할 바이트(hex 문자열). 없으면 기본으로 1바이트(0x01) 트리거 전송")
    parser.add_argument("--no-trigger", dest="trigger_1byte", action="store_false", help="--send 없을 때 1바이트 트리거 전송 안 함")
    parser.add_argument("--mitsubishi", dest="use_mitsubishi", action="store_true", help="미쯔비시 MELSEC 3E 0401(워드 배치 읽기) 요청 전송 후 응답 파싱")
    parser.add_argument("--mitsubishi-device", default=None, choices=["Y", "M", "D"], metavar="Y|M|D", help="미쯔비시 디바이스 (기본: io_variables의 mitsubishi_device 또는 D)")
    parser.add_argument("--mitsubishi-d-start", type=int, default=None, metavar="ADDR", help="미쯔비시 시작 주소 (예: Y107→107). 지정 안 하면 io_variables의 mitsubishi_d_start 사용")
    parser.add_argument("--mitsubishi-words", type=int, default=None, metavar="N", help="미쯔비시 요청 워드 수 (예: 1=Y107 1비트). 지정 안 하면 전체 블록")
    parser.add_argument("--little-endian", dest="little_endian", action="store_true", help="Dword 워드스왑(리틀엔디안) 적용")
    parser.add_argument("--group", default=None, choices=["Y", "M", "D", "X"], help="해당 디바이스 그룹만 파싱")
    parser.add_argument("--json", action="store_true", help="JSON 한 줄로 출력")
    args = parser.parse_args()

    if not IO_VARIABLES_PATH.exists():
        print(f"오류: {IO_VARIABLES_PATH} 없음", file=sys.stderr)
        sys.exit(1)

    mitsubishi_device = args.mitsubishi_device or "D"
    mitsubishi_d_start = args.mitsubishi_d_start if args.mitsubishi_d_start is not None else 0
    mitsubishi_words = args.mitsubishi_words
    if args.use_mitsubishi:
        dev, start, words = get_mitsubishi_options_from_io_variables()
        if args.mitsubishi_device is None:
            mitsubishi_device = dev
        if args.mitsubishi_d_start is None:
            mitsubishi_d_start = start
        else:
            mitsubishi_d_start = args.mitsubishi_d_start
        if args.mitsubishi_words is None and words is not None:
            mitsubishi_words = words

    try:
        result = run_tcp_read(
            args.host,
            args.port,
            timeout=args.timeout,
            send_hex=args.send,
            trigger_1byte=args.trigger_1byte,
            little_endian=args.little_endian,
            group=args.group,
            use_mitsubishi=args.use_mitsubishi,
            mitsubishi_device=mitsubishi_device,
            mitsubishi_d_start=mitsubishi_d_start,
            mitsubishi_words=mitsubishi_words,
            bind_address=args.bind_address,
            local_port=args.local_port,
        )
    except Exception as e:
        print(f"오류: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
        return

    for name, value in result.items():
        print(f"{name}\t{value}")


if __name__ == "__main__":
    main()
