---
name: feedback-no-lint-after-every-change
description: Nie puszczać prettiera / eslinta / tsc po każdej zmianie — na tym Macu trwa to wieki.
metadata:
  type: feedback
---

Nie uruchamiaj `prettier`, `eslint` ani `tsc` po każdej edycji pliku. Rafał zgłosił to
wprost: „nie rob prettiera i tsc po kazdym zapytaniu bo to trwa wieki".

**Dlaczego:** na tym Macu te narzędzia potrafią mielić minutami albo się zawieszać
(patrz [[project-mac-resources-exhausted]]). Hook `husky` + `lint-staged` w backendzie
przy `git commit` wywala się z tego samego powodu — `eslint --fix` nie kończy się
w rozsądnym czasie i zostawia po sobie stashe „lint-staged automatic backup".

**Jak stosować:** pisz kod od razu w stylu repo i nie weryfikuj go linterem rutynowo.
Do sprawdzenia poprawności iOS wystarczy `xcodebuild` (jest szybki i i tak łapie błędy).
Lint odpalaj tylko wtedy, gdy Rafał o to poprosi albo gdy CI się na tym wywali.
Przy commicie w backendzie licz się z tym, że hook zawiśnie — uzgodnij `--no-verify`
zamiast czekać. Powiązane: [[project-docker-no-auto-migrate]].
