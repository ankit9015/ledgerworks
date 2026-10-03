# Shadow database image (C2.1, DECISIONS.md D29). Postgres 16 + pg_stat_statements + HypoPG.
# Everything is pinned: the base image by digest (Debian bookworm, PostgreSQL 16.15) and HypoPG by
# exact package version from the PGDG apt repository that the base image is already configured for.
# pg_stat_statements ships with PostgreSQL itself (contrib); the runner preloads it with -c flags.
FROM postgres:16-bookworm@sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67

ARG HYPOPG_VERSION=1.4.3-1.pgdg12+2

RUN apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-16-hypopg=${HYPOPG_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

LABEL ledgerworks.image="shadow-postgres" \
      ledgerworks.hypopg="${HYPOPG_VERSION}"
