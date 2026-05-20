#!/usr/bin/env python3
"""
Minecraft Java Edition Wake-on-Demand Proxy

ポート 25565 でリッスンし、ゲームサーバー EC2 が停止中なら起動してから接続を転送する。
プレイヤーには起動中メッセージを表示し、EC2 が running になったら TCP をプロキシする。
"""

import asyncio
import boto3
import json
import logging
import os
import struct
import time
from concurrent.futures import ThreadPoolExecutor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("mc-proxy")

GAME_INSTANCE_ID = os.environ["GAME_INSTANCE_ID"]
GAME_PORT = int(os.environ.get("GAME_PORT", 25565))
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", 25565))
REGION = os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-1")

ec2 = boto3.client("ec2", region_name=REGION)
executor = ThreadPoolExecutor(max_workers=4)

# EC2 情報のキャッシュ (AWS API 呼び出し削減)
_cache: dict = {"state": None, "private_ip": None, "ts": 0}
CACHE_TTL = 5  # 秒

# StartInstances の連続呼び出し防止
_last_start_ts: float = 0
START_COOLDOWN = 30  # 秒


# ─── VarInt ────────────────────────────────────────────────

def read_varint(data: bytes, offset: int = 0) -> tuple[int, int]:
    value, shift = 0, 0
    while True:
        if offset >= len(data):
            raise ValueError("VarInt データ不足")
        b = data[offset]
        offset += 1
        value |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
        if shift >= 32:
            raise ValueError("VarInt が長すぎる")
    return value, offset


def write_varint(value: int) -> bytes:
    result = []
    while True:
        if (value & ~0x7F) == 0:
            result.append(value)
            break
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(result)


def write_string(s: str) -> bytes:
    encoded = s.encode("utf-8")
    return write_varint(len(encoded)) + encoded


def make_packet(packet_id: int, payload: bytes) -> bytes:
    body = write_varint(packet_id) + payload
    return write_varint(len(body)) + body


# ─── EC2 操作 ────────────────────────────────────────────────

def _fetch_game_server_info() -> tuple[str, str]:
    resp = ec2.describe_instances(InstanceIds=[GAME_INSTANCE_ID])
    inst = resp["Reservations"][0]["Instances"][0]
    return inst["State"]["Name"], inst.get("PrivateIpAddress", "")


async def get_game_server_info() -> tuple[str, str]:
    now = time.monotonic()
    if now - _cache["ts"] < CACHE_TTL and _cache["state"]:
        return _cache["state"], _cache["private_ip"]
    loop = asyncio.get_event_loop()
    state, ip = await loop.run_in_executor(executor, _fetch_game_server_info)
    _cache.update({"state": state, "private_ip": ip, "ts": now})
    return state, ip


def _start_instance() -> None:
    ec2.start_instances(InstanceIds=[GAME_INSTANCE_ID])
    log.info("StartInstances 呼び出し完了: %s", GAME_INSTANCE_ID)


async def start_game_server() -> None:
    global _last_start_ts
    now = time.monotonic()
    if now - _last_start_ts < START_COOLDOWN:
        log.info("StartInstances はクールダウン中のためスキップ")
        return
    _last_start_ts = now
    # キャッシュを無効化
    _cache["state"] = None
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(executor, _start_instance)


# ─── Minecraft プロトコルレスポンス ───────────────────────────

MOTD_STARTING = (
    "§eサーバー起動中...\n§71〜2分後に再接続してください"
)
MOTD_OFFLINE = (
    "§cサーバー停止中\n§e接続すると自動起動します"
)
DISCONNECT_STARTING = "§eサーバーが起動しています。\n§71〜2分後に再接続してください。"
DISCONNECT_OFFLINE = "§eサーバーを起動しています。\n§71〜2分後に再接続してください。"


def make_status_response(state: str) -> bytes:
    motd = MOTD_OFFLINE if state == "stopped" else MOTD_STARTING
    payload = {
        "version": {"name": "起動中...", "protocol": 769},
        "players": {"max": 0, "online": 0, "sample": []},
        "description": {"text": motd},
        "enforcesSecureChat": False,
    }
    return make_packet(0x00, write_string(json.dumps(payload)))


def make_login_disconnect(state: str) -> bytes:
    text = DISCONNECT_OFFLINE if state == "stopped" else DISCONNECT_STARTING
    reason = json.dumps({"text": text})
    return make_packet(0x00, write_string(reason))


# ─── TCP パイプ ───────────────────────────────────────────────

async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await src.read(4096)
            if not data:
                break
            dst.write(data)
            await dst.drain()
    except Exception:
        pass
    finally:
        try:
            dst.close()
        except Exception:
            pass


# ─── 接続ハンドラ ─────────────────────────────────────────────

async def handle_client(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    peer = writer.get_extra_info("peername")
    log.info("接続: %s", peer)
    try:
        # Handshake パケットを読み取る
        raw = await asyncio.wait_for(reader.read(4096), timeout=10.0)
        if not raw:
            return

        # パケット長とIDを解析
        _pkt_len, off = read_varint(raw, 0)
        pkt_id, off = read_varint(raw, off)
        if pkt_id != 0x00:
            return  # Handshake 以外は無視

        # プロトコルバージョン・アドレス・ポートを読み飛ばし
        _proto_ver, off = read_varint(raw, off)
        str_len, off = read_varint(raw, off)
        off += str_len  # server address
        off += 2        # server port (unsigned short)
        next_state, _ = read_varint(raw, off)

        state, private_ip = await get_game_server_info()
        log.info("ゲームサーバー状態: %s (next_state=%d)", state, next_state)

        if state == "running" and private_ip:
            # EC2 が running → ゲームサーバーへ TCP プロキシ
            try:
                game_r, game_w = await asyncio.wait_for(
                    asyncio.open_connection(private_ip, GAME_PORT),
                    timeout=5.0,
                )
                log.info("%s → %s:%d をプロキシ中", peer, private_ip, GAME_PORT)
                game_w.write(raw)
                await asyncio.gather(
                    pipe(reader, game_w),
                    pipe(game_r, writer),
                )
                return
            except (asyncio.TimeoutError, ConnectionRefusedError, OSError):
                # EC2 は running だが Minecraft がまだ起動中
                log.info("Minecraft プロセス未起動 (EC2 は running)")
                state = "pending"

        if next_state == 1:  # Status (サーバーリストピン)
            writer.write(make_status_response(state))
            await writer.drain()
            # Ping/Pong をエコー
            try:
                ping = await asyncio.wait_for(reader.read(16), timeout=5.0)
                if ping:
                    writer.write(ping)
                    await writer.drain()
            except asyncio.TimeoutError:
                pass

        elif next_state == 2:  # Login
            # EC2 が停止中なら起動する（ログイン試行時のみ）
            if state == "stopped":
                await start_game_server()
            # Login Start パケットを読み捨て
            try:
                await asyncio.wait_for(reader.read(256), timeout=5.0)
            except asyncio.TimeoutError:
                pass
            writer.write(make_login_disconnect(state))
            await writer.drain()

    except asyncio.TimeoutError:
        log.warning("タイムアウト: %s", peer)
    except Exception as exc:
        log.error("エラー (%s): %s", peer, exc)
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


# ─── メイン ──────────────────────────────────────────────────

async def main() -> None:
    server = await asyncio.start_server(handle_client, "0.0.0.0", LISTEN_PORT)
    log.info("Minecraft プロキシ起動: ポート %d", LISTEN_PORT)
    log.info("ゲームサーバーインスタンス: %s", GAME_INSTANCE_ID)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
