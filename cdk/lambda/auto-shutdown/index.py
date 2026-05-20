"""
Minecraft サーバー自動停止 Lambda

5 分おきに EventBridge から呼び出され、以下のロジックで本番 EC2 を停止する。

1. EC2 が running 状態でなければ何もしない
2. EC2 の起動時刻 (LaunchTime) が 30 分未満ならグレースピリオドとして何もしない
3. SSM Parameter Store の /minecraft/last_player_seen を読む
   - パラメータが存在しない → 現在時刻で初期化して終了
4. (現在時刻 - last_player_seen) >= 30 分 → StopInstances を呼ぶ
"""

import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger()
log.setLevel(logging.INFO)

# Lambda ランタイムは AWS_REGION を自動で設定する
REGION = os.environ.get("AWS_REGION", "ap-northeast-1")
GAME_INSTANCE_ID = os.environ["GAME_INSTANCE_ID"]
SHUTDOWN_THRESHOLD_SEC = 30 * 60  # 30 分
GRACE_PERIOD_SEC = 30 * 60        # 起動後 30 分はシャットダウンしない
SSM_PARAM = "/minecraft/last_player_seen"

ec2 = boto3.client("ec2", region_name=REGION)
ssm = boto3.client("ssm", region_name=REGION)


def get_instance_info() -> tuple[str, float]:
    """(state, launch_time_epoch) を返す"""
    resp = ec2.describe_instances(InstanceIds=[GAME_INSTANCE_ID])
    inst = resp["Reservations"][0]["Instances"][0]
    state = inst["State"]["Name"]
    launch_time = inst["LaunchTime"].timestamp()
    return state, launch_time


def get_last_player_seen() -> float | None:
    """SSM から last_player_seen のタイムスタンプを取得する。存在しない場合は None"""
    try:
        resp = ssm.get_parameter(Name=SSM_PARAM)
        return float(resp["Parameter"]["Value"])
    except ClientError as e:
        if e.response["Error"]["Code"] == "ParameterNotFound":
            return None
        raise


def init_last_player_seen() -> None:
    """last_player_seen を現在時刻で初期化する"""
    ssm.put_parameter(
        Name=SSM_PARAM,
        Value=str(int(time.time())),
        Type="String",
        Overwrite=True,
    )
    log.info("last_player_seen を初期化しました")


def stop_game_server() -> None:
    ec2.stop_instances(InstanceIds=[GAME_INSTANCE_ID])
    log.info("StopInstances 呼び出し完了: %s", GAME_INSTANCE_ID)


def handler(event: dict, context: object) -> None:
    now = time.time()

    # 1. EC2 状態確認
    state, launch_time = get_instance_info()
    log.info("EC2 状態: %s", state)
    if state != "running":
        log.info("running 以外のため終了")
        return

    # 2. 起動直後のグレースピリオド
    uptime_sec = now - launch_time
    if uptime_sec < GRACE_PERIOD_SEC:
        log.info(
            "グレースピリオド中 (起動から %.0f 分) - スキップ",
            uptime_sec / 60,
        )
        return

    # 3. last_player_seen を取得
    last_seen = get_last_player_seen()
    if last_seen is None:
        log.info("last_player_seen が未設定 - 現在時刻で初期化")
        init_last_player_seen()
        return

    # 4. 不在時間を確認
    idle_sec = now - last_seen
    log.info("プレイヤー不在時間: %.0f 分", idle_sec / 60)

    if idle_sec >= SHUTDOWN_THRESHOLD_SEC:
        log.info("30 分以上不在 → サーバーを停止します")
        stop_game_server()
    else:
        log.info("まだシャットダウン不要 (閾値まであと %.0f 分)", (SHUTDOWN_THRESHOLD_SEC - idle_sec) / 60)
