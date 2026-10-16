#!/usr/bin/env bash
# Usage:
#   transcode.sh job                      download $SOURCE_URL, process, upload to R2 (container mode)
#   transcode.sh process <input> <output> process a local file and print its duration
set -Eeuo pipefail

WORK_DIR="${WORK_DIR:-/work}"
STATE_FILE="${STATE_FILE:-$WORK_DIR/state}"
LOG_FILE="${LOG_FILE:-$WORK_DIR/log}"
JOB_ID="${JOB_ID:-local}"
MAX_KEYFRAME_GAP=4

write_state() {
	{
		echo "job=$JOB_ID"
		printf '%s\n' "$@"
	} >"$STATE_FILE.tmp"
	mv "$STATE_FILE.tmp" "$STATE_FILE"
}

on_error() {
	set +e
	local reason
	reason=$(tail -n "+$((${STEP_LOG_OFFSET:-0} + 1))" "$LOG_FILE" 2>/dev/null | tail -n 5 | tr '\n' ' ' | cut -c1-500)
	local label
	case ${CURRENT_STEP:-} in
	downloading) label="다운로드" ;;
	probing) label="형식 확인" ;;
	transcoding) label="변환" ;;
	uploading) label="업로드" ;;
	*) label="알 수 없는 단계" ;;
	esac
	write_state "phase=failed" "error=${label} 실패: ${reason:-로그 없음}"
	exit 1
}

step() {
	CURRENT_STEP=$1
	STEP_LOG_OFFSET=$(wc -l <"$LOG_FILE" 2>/dev/null || echo 0)
	shift
	write_state "phase=$CURRENT_STEP" "$@"
}

max_keyframe_gap() {
	ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 "$1" 2>>"$LOG_FILE" |
		awk -F, -v duration="$DURATION" '
			$2 ~ /K/ && $1 != "N/A" {
				if (count++ && $1 - last > max) max = $1 - last
				last = $1
			}
			END {
				if (count == 0) { print 1e9; exit }
				if (duration != "" && duration - last > max) max = duration - last
				print max + 0
			}'
}

probe() {
	local input=$1 info video audio codec profile pix_fmt gap
	info=$(ffprobe -v error -of json \
		-show_entries format=duration:stream=codec_type,codec_name,profile,pix_fmt "$input" 2>>"$LOG_FILE")
	DURATION=$(jq -r '.format.duration // empty' <<<"$info")
	video=$(jq -c '[.streams[] | select(.codec_type == "video")][0] // empty' <<<"$info")
	audio=$(jq -c '[.streams[] | select(.codec_type == "audio")][0] // empty' <<<"$info")
	if [[ -z $video ]]; then
		echo "no video stream" >>"$LOG_FILE"
		return 1
	fi

	codec=$(jq -r '.codec_name' <<<"$video")
	profile=$(jq -r '.profile // ""' <<<"$video")
	pix_fmt=$(jq -r '.pix_fmt // ""' <<<"$video")
	VIDEO_CODEC=$codec
	VIDEO_ACTION=encode
	if [[ $codec == h264 && $pix_fmt == yuv420p && $profile =~ ^(Constrained\ Baseline|Baseline|Main|High)$ ]] ||
		[[ $codec == hevc && $pix_fmt =~ ^yuv420p(10le)?$ && $profile =~ ^(Main|Main\ 10)$ ]]; then
		gap=$(max_keyframe_gap "$input")
		if awk -v gap="$gap" -v max="$MAX_KEYFRAME_GAP" 'BEGIN { exit !(gap <= max) }'; then
			VIDEO_ACTION=copy
		fi
	fi

	AUDIO_ACTION=none
	if [[ -n $audio ]]; then
		codec=$(jq -r '.codec_name' <<<"$audio")
		profile=$(jq -r '.profile // ""' <<<"$audio")
		AUDIO_ACTION=encode
		if [[ $codec =~ ^(mp3|opus)$ ]] || [[ $codec == aac && $profile =~ ^(LC|HE-AAC|HE-AACv2)$ ]]; then
			AUDIO_ACTION=copy
		fi
	fi
	echo "probe: duration=$DURATION video=$VIDEO_CODEC/$VIDEO_ACTION audio=$AUDIO_ACTION" >>"$LOG_FILE"
}

convert() {
	local input=$1 output=$2 key value
	local args=(-hide_banner -nostdin -y -i "$input" -map 0:v:0)
	if [[ $AUDIO_ACTION != none ]]; then
		args+=(-map 0:a:0)
	fi
	if [[ $VIDEO_ACTION == copy ]]; then
		args+=(-c:v copy)
		if [[ $VIDEO_CODEC == hevc ]]; then
			args+=(-tag:v hvc1)
		fi
	else
		args+=(-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p
			-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"
			-force_key_frames "expr:gte(t,n_forced*2)")
	fi
	case $AUDIO_ACTION in
	copy) args+=(-c:a copy) ;;
	encode) args+=(-c:a aac -b:a 128k) ;;
	esac
	args+=(-movflags +faststart -f mp4 -progress pipe:1 -nostats "$output")

	ffmpeg "${args[@]}" 2>>"$LOG_FILE" | while IFS='=' read -r key value; do
		if [[ $key == out_time_us && $value =~ ^[0-9]+$ && -n $DURATION ]]; then
			write_state "phase=transcoding" "progress=$(awk -v t="$value" -v d="$DURATION" \
				'BEGIN { p = t / 1e6 / d; printf "%.4f", (p > 1 ? 1 : p) }')"
		fi
	done
}

process() {
	step probing
	probe "$1"
	step transcoding "progress=0"
	convert "$1" "$2"
}

run_job() {
	local input="$WORK_DIR/input" output="$WORK_DIR/output.mp4" headers=() line size
	mkdir -p "$WORK_DIR"
	rm -f "$input" "$output"
	: >"$LOG_FILE"
	trap on_error ERR

	step downloading
	while IFS= read -r line; do
		if [[ -n $line ]]; then
			headers+=(-H "$line")
		fi
	done <<<"${SOURCE_HEADERS:-}"
	curl --fail --silent --show-error --location --retry 3 "${headers[@]}" \
		-o "$input" "$SOURCE_URL" 2>>"$LOG_FILE"

	process "$input" "$output"

	step uploading
	curl --fail-with-body --silent --show-error --retry 3 \
		--aws-sigv4 "aws:amz:auto:s3" --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
		-H "Content-Type: video/mp4" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
		--upload-file "$output" "$R2_ENDPOINT/$R2_BUCKET/$OBJECT_KEY" >>"$LOG_FILE" 2>&1

	size=$(stat -c %s "$output")
	rm -f "$input" "$output"
	write_state "phase=done" "size=$size" "duration=$DURATION"
}

case "${1:-}" in
job)
	run_job
	;;
process)
	mkdir -p "$WORK_DIR"
	: >"$LOG_FILE"
	trap 'tail -n 20 "$LOG_FILE" >&2; on_error' ERR
	process "$2" "$3"
	echo "$DURATION"
	;;
*)
	echo "usage: $0 job | process <input> <output>" >&2
	exit 64
	;;
esac
