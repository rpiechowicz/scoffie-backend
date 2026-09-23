# Nocna kopia bazy produkcyjnej — osobny serwis cron w projekcie Railway.
#
# Obraz Postgresa 17, bo niesie wszystko naraz: `pg_dump`/`pg_restore` w wersji
# serwera (Railway: 17.x; klient starszy od serwera odmawia zrzutu) ORAZ sam
# serwer do próby odtworzenia w tymczasowym klastrze. `age` szyfruje,
# `awscli` wysyła do R2 (API S3).
FROM postgres:17-bookworm

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends age awscli ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY backup.sh /usr/local/bin/scoffie-backup
RUN chmod 0755 /usr/local/bin/scoffie-backup

# Nadpisuje ENTRYPOINT obrazu Postgresa: ten kontener nie jest bazą, tylko
# jednorazowym zadaniem — uruchamia się z crona, robi kopię i kończy.
ENTRYPOINT ["/usr/local/bin/scoffie-backup"]
