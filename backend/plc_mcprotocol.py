#!/usr/bin/env python3
"""
pymcprotocol(Type3E) 읽기 + 요청/응답 HEX 덤프
- 라이브러리 재해석 레이어 제거
- Boolean, Word, Dword, String 처리
- 패킷 캡처 가능
"""
import argparse
import sys

try:
    import pymcprotocol
except ImportError:
    print("오류: pymcprotocol 필요. pip install pymcprotocol", file=sys.stderr)
    sys.exit(1)

PLC_HOST = "192.168.0.5"
PLC_PORT = 5002

def parse_address(s: str) -> int:
    """주소 문자열 해석. 0x 접두사 있으면 16진수, 없으면 10진수."""
    s = (s or "").strip()
    if not s:
        raise ValueError("주소가 비어 있음")
    return int(s, 16) if s.lower().startswith("0x") else int(s, 10)

def device_to_headdevice(device: str, address: int) -> str:
    """(device, address) → pymcprotocol 헤드 디바이스 문자열."""
    d = device.upper()
    # Mitsubishi Y는 주소를 16진 문자열로 넘겨야 한다. (예: 0x14C -> Y14C)
    if d == "Y":
        return f"{d}{address:X}"
    return f"{d}{address}"


def read_mc_variables(host: str, port: int, entries: list) -> dict:
    """
    host:port에 pymcprotocol API만으로 읽기. 반환: {변수명: 값}. 실패 시 '-'.
    변수마다 새 연결(가짜 서버는 연결당 요청 1개).
    """
    result = {name: "-" for name, *_ in entries}
    for name, device, address, data_type, length in entries:
        headdevice = device_to_headdevice(device, address)
        try:
            plc = pymcprotocol.Type3E()
            plc.connect(host, port)
        except Exception:
            continue
        try:
            t = (data_type or "").strip().lower()
            if t == "boolean":
                vals = plc.batchread_bitunits(headdevice, readsize=length)
                result[name] = vals[0] if vals else "-"
            elif t == "word":
                vals = plc.batchread_wordunits(headdevice, readsize=length)
                result[name] = vals[0] if vals else "-"
            elif t == "dword":
                _, dword_vals = plc.randomread(word_devices=[], dword_devices=[headdevice])
                result[name] = dword_vals[0] if dword_vals else "-"
            elif t == "string":
                words = plc.batchread_wordunits(headdevice, readsize=(length + 1) // 2)
                b = b"".join(bytes([w & 0xFF, (w >> 8) & 0xFF]) for w in words)
                s = b[:length].decode("ascii", errors="replace").rstrip("\x00")
                result[name] = s or "-"
            else:
                vals = plc.batchread_wordunits(headdevice, readsize=max(1, length))
                result[name] = vals[0] if vals else "-"
        except Exception:
            pass
        finally:
            try:
                plc.close()
            except Exception:
                pass
    return result


def hex_dump(data: bytes, bytes_per_line: int = 16) -> str:
    """간단 HEX 덤프"""
    lines = []
    for i in range(0, len(data), bytes_per_line):
        chunk = data[i : i + bytes_per_line]
        hex_part = " ".join(f"{b:02x}" for b in chunk)
        lines.append(f"{i:04x}   {hex_part}")
    return "\n".join(lines) if lines else ""

# socket 패치로 패킷 캡처
class PacketCaptureSocket:
    _real_socket_class = None

    def __init__(self, family, type_, proto=-1):
        cls = PacketCaptureSocket._real_socket_class or __import__("socket").socket
        self._sock = cls(family, type_, proto)
        self._last_sent = b""
        self._last_received = b""

    def __getattr__(self, name):
        return getattr(self._sock, name)

    def sendall(self, data, *args, **kwargs):
        self._last_sent = data
        return self._sock.sendall(data, *args, **kwargs)

    def send(self, data, *args, **kwargs):
        self._last_sent = data if isinstance(data, bytes) else self._last_sent + (data or b"")
        return self._sock.send(data, *args, **kwargs)

    def recv(self, bufsize, *args, **kwargs):
        data = self._sock.recv(bufsize, *args, **kwargs)
        if data:
            self._last_received += data
        return data

def main():
    parser = argparse.ArgumentParser(description="pymcprotocol Type3E 읽기 + HEX 덤프")
    parser.add_argument("--device", required=True, choices=["Y", "M", "D"], help="디바이스 (Y, M, D)")
    parser.add_argument("--address", type=parse_address, required=True, help="시작 주소")
    parser.add_argument("--type", dest="data_type", required=True,
                        choices=["boolean", "word", "dword", "string"], help="데이터 타입")
    parser.add_argument("--length", type=int, required=True, help="읽을 개수 / 문자열 길이")
    parser.add_argument("--host", default=PLC_HOST, help="PLC IP")
    parser.add_argument("--port", type=int, default=PLC_PORT, help="PLC 포트")
    args = parser.parse_args()

    headdevice = device_to_headdevice(args.device, args.address)

    # 패킷 캡처 소켓 패치
    import socket
    real_socket = socket.socket
    PacketCaptureSocket._real_socket_class = real_socket
    capture_sock = None
    def capturing_socket(family, type_, proto=-1):
        nonlocal capture_sock
        capture_sock = PacketCaptureSocket(family, type_, proto)
        return capture_sock
    socket.socket = capturing_socket

    plc = pymcprotocol.Type3E()
    try:
        plc.connect(args.host, args.port)
    except Exception as e:
        print(f"PLC 연결 실패: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        socket.socket = real_socket

    vals = None
    try:
        t = args.data_type.lower()
        if t == "boolean":
            vals = plc.batchread_bitunits(headdevice, readsize=args.length)
        elif t == "word":
            vals = plc.batchread_wordunits(headdevice, readsize=args.length)
        elif t == "dword":
            _, dword_vals = plc.randomread(word_devices=[], dword_devices=[headdevice])
            vals = dword_vals
        elif t == "string":
            words = plc.batchread_wordunits(headdevice, readsize=(args.length + 1) // 2)
            b = b"".join(bytes([w & 0xFF, (w >> 8) & 0xFF]) for w in words)
            vals = [b[:args.length].decode("ascii", errors="replace").rstrip("\x00")]
    except Exception as e:
        print(f"읽기 실패: {e}", file=sys.stderr)
        vals = None
    finally:
        try:
            plc.close()
        except Exception:
            pass

    # 패킷 출력
    if capture_sock:
        print(f"[요청 패킷] ({len(capture_sock._last_sent)} bytes)")
        print(hex_dump(capture_sock._last_sent))
        print(f"[응답 패킷] ({len(capture_sock._last_received)} bytes)")
        print(hex_dump(capture_sock._last_received))

    print(f"{args.device}{args.address} ({args.data_type}) = {vals}")

if __name__ == "__main__":
    main()