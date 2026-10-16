FROM debian:trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl ffmpeg jq \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir /work

COPY transcode.sh /usr/local/bin/transcode.sh

CMD ["sleep", "infinity"]
