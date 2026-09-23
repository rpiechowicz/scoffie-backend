# Nocna kopia bazy produkcyjnej — osobny serwis cron w projekcie Railway.
#
# Obraz Postgresa W WERSJI SERWERA, bo niesie wszystko naraz: `pg_dump`/
# `pg_restore` (klient starszy od serwera odmawia zrzutu: „server version
# mismatch”) ORAZ sam serwer do próby odtworzenia w tymczasowym klastrze.
# Produkcja to Postgres 18 (18.6, sprawdzone 23.09.2026 — pierwszy przebieg na
# obrazie 17 padł właśnie na tym). Podbicie wersji bazy na Railwayu = podbicie
# tutaj. Bookworm, nie trixie: `age` i `awscli` z tych samych pakietów Debiana.
# `age` szyfruje, `awscli` wysyła do R2 (API S3).
FROM postgres:18-bookworm

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends age awscli ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY backup.sh /usr/local/bin/scoffie-backup
RUN chmod 0755 /usr/local/bin/scoffie-backup

# Nadpisuje ENTRYPOINT obrazu Postgresa: ten kontener nie jest bazą, tylko
# jednorazowym zadaniem — uruchamia się z crona, robi kopię i kończy.
ENTRYPOINT ["/usr/local/bin/scoffie-backup"]
