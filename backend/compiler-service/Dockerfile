FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.elan/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    git \
    bash \
    && rm -rf /var/lib/apt/lists/*

RUN curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh -s -- -y --default-toolchain stable

WORKDIR /workspace
COPY compile.sh /usr/local/bin/compile-lean
RUN chmod +x /usr/local/bin/compile-lean

ENTRYPOINT ["/usr/local/bin/compile-lean"]
