import socket
import binascii

# 수신할 IP와 포트
UDP_IP = "0.0.0.0"     # 모든 인터페이스에서 수신
UDP_PORT = 1020

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((UDP_IP, UDP_PORT))

print(f"Listening on UDP {UDP_PORT} ...")

while True:
    data, addr = sock.recvfrom(65535)  # 최대 64KB
    print("\n==============================")
    print(f"From: {addr[0]}:{addr[1]}")
    print(f"Length: {len(data)} bytes")

    # HEX 출력
    print("HEX:")
    print(binascii.hexlify(data).decode())

    # ASCII 출력 (가능한 경우)
    try:
        print("ASCII:")
        print(data.decode(errors="ignore"))
    except:
        pass