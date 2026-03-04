#!/usr/bin/env python3
"""
Packet sender처럼 PLC(192.168.0.5:5002)로 TCP 요청 패킷 전송 후 응답 패킷만 출력.
이 PC는 192.168.0.41:2025 로 나감.
"""
import socket
import sys

# 요청 패킷 (Y107 1비트 읽기)
REQUEST_Y107 = "500000FFFF03000C001000010401000701009D0100"

PLC_HOST = "192.168.0.5"
PLC_PORT = 5002
LOCAL_IP = "192.168.0.41"
LOCAL_PORT = 2025
TIMEOUT = 5.0


def main():
    raw = bytes.fromhex(REQUEST_Y107.replace(" ", ""))
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(TIMEOUT)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((LOCAL_IP, LOCAL_PORT))
    except OSError as e:
        print(f"바인드 실패 {LOCAL_IP}:{LOCAL_PORT}: {e}", file=sys.stderr)
        sys.exit(1)
    try:
        sock.connect((PLC_HOST, PLC_PORT))
        sock.sendall(raw)
        data = b""
        while True:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
    finally:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()

    if not data:
        print("(응답 없음)", file=sys.stderr)
        sys.exit(1)
    # 응답 패킷 HEX만 출력 (2자리마다 공백)
    print(" ".join(data.hex().upper()[i : i + 2] for i in range(0, len(data.hex()), 2)))


if __name__ == "__main__":
    main()
