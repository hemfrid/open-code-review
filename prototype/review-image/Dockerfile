# SPDX-License-Identifier: Apache-2.0
# keyto-review: git + open-code-review (ocr) + org rules. See spec-hub-direct-relay-review.md §3.1.
FROM golang:1.26 AS build
ARG OCR_REF=v1.9.6
RUN git clone --depth 1 --branch "${OCR_REF}" https://github.com/alibaba/open-code-review /src \
 && cd /src && CGO_ENABLED=0 go build -ldflags="-s -w" -o /ocr ./cmd/opencodereview

FROM alpine:3.20
# git >= 2.41 is a hard OCR requirement; alpine 3.20 ships 2.45.
RUN apk add --no-cache git ca-certificates jq curl && adduser -D -u 1001 review
COPY --from=build /ocr /usr/local/bin/ocr
COPY rule.json /etc/keyto-review/rule.json
COPY review.sh /usr/local/bin/review.sh
RUN chmod 0555 /usr/local/bin/review.sh /usr/local/bin/ocr && mkdir -p /work /home/review && chown 1001:1001 /work /home/review
USER 1001
ENV HOME=/home/review
ENTRYPOINT ["/usr/local/bin/review.sh"]
