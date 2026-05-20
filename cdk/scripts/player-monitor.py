#!/usr/bin/env python3
"""
Minecraft プレイヤー数モニター

ゲームサーバー上で systemd timer により 5 分おきに実行される。
Minecraft Query Protocol (UDP) でプレイヤー数を取得し、
プレイヤーが 1 人以上いる場合に SSM Parameter Store の
/minecraft/last_player_seen を現在のタイムスタンプで更新する。
"""

import logging
import os
import socket
import struct
import time

import boto3

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("player-monitor")

REGION = os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-1")
MC_HOST = "127.0.0.1"
MC_QUERY_PORT = 25565
SSM_PARAM = "/minecraft/last_player_seen"
TIMEOUT = 5  # UDP タイムアウト秒数


def get_player_count() -> int:
    """
    Minecraft Query Protocol (UDP) でプレイヤー数を取得する。
    サーバーが応答しない場合は 0 を返す。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(TIMEOUT)
    try:
        session_id = 1  # 任意の 31bit 正整数

        # ─── Handshake ───────────────────────────────────────
        # Magic(2) + Type(1) + SessionID(4)
        handshake = struct.pack(">HBI", 0xFEFD, 0x09, session_id)
        sock.sendto(handshake, (MC_HOST, MC_QUERY_PORT))
        data, _ = sock.recvfrom(1024)

        # レスポンス: Type(1) + SessionID(4) + ChallengeToken(null終端文字列)
        if len(data) < 6:
            return 0
        challenge_str = data[5:].split(b"\x00")[0].decode("ascii")
        challenge_token = int(challenge_str)

        # ─── Full Stat リクエスト ────────────────────────────
        # Magic(2) + Type(1) + SessionID(4) + PaddedToken(4) + Padding(4)
        padded_token = struct.pack(">i", challenge_token)
        full_stat = struct.pack(">HBI", 0xFEFD, 0x00, session_id) \
            + padded_token \
            + b"\x00\x00\x00\x00"
        sock.sendto(full_stat, (MC_HOST, MC_QUERY_PORT))
        data, _ = sock.recvfrom(4096)

        # レスポンスを文字列として解析
        # "numplayers\x00<count>\x00" の部分を探す
        text = data.decode("latin-1")
        if "numplayers" not in text:
            return 0
        idx = text.index("numplayers") + len("numplayers") + 1
        end = text.index("\x00", idx)
        count = int(text[idx:end])
        log.info("プレイヤー数: %d", count)
        return count

    except (socket.timeout, OSError, ValueError, struct.error) as e:
        log.warning("クエリ失敗: %s", e)
        return 0
    finally:
        sock.close()


def update_last_player_seen() -> None:
    ssm = boto3.client("ssm", region_name=REGION)
    ts = str(int(time.time()))
    ssm.put_parameter(
        Name=SSM_PARAM,
        Value=ts,
        Type="String",
        Overwrite=True,
    )
    log.info("SSM 更新: %s = %s", SSM_PARAM, ts)


def main() -> None:
    count = get_player_count()
    if count > 0:
        update_last_player_seen()
    else:
        log.info("プレイヤー不在 - SSM は更新しない")


if __name__ == "__main__":
    main()
