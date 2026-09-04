/**
 * Prawdziwy łańcuch certyfikatów do testów podpisu — TYLKO DO TESTÓW.
 *
 * PO CO TO ISTNIEJE. Wszystkie testy weryfikatora były ODMOWAMI: zły algorytm,
 * zerwany łańcuch, nieprzypięty korzeń, podrobiony podpis. Ani jeden nie
 * oglądał UDANEJ weryfikacji ES256 — czyli jedyna rzecz, którą ten kod ma
 * naprawdę robić, nie była sprawdzona ani razu. Weryfikator odrzucający
 * WSZYSTKO, także prawdziwe transakcje, przechodziłby tamten zestaw w
 * komplecie; z zewnątrz wygląda to jak awaria App Store, więc nikt nie szuka
 * błędu u siebie.
 *
 * Prawdziwych podpisów Apple nie da się trzymać w repozytorium, więc łańcuch
 * jest własny: korzeń P-384 podpisujący sam siebie, pośredni P-256 i liść
 * P-256 — ten sam kształt, co u Apple. `verifyAppleJws` przyjmuje `rootPem`,
 * więc test przypina TEN korzeń zamiast Apple'owego i sprawdza dokładnie tę
 * samą ścieżkę kodu.
 *
 * KLUCZ PRYWATNY W REPOZYTORIUM JEST TU BEZPIECZNY: nie chroni niczego, nie ma
 * odpowiednika po stronie Apple i nie jest przypięty nigdzie poza testami.
 * Ważność 1.01.2020 – 1.01.2120, żeby suita nie zaczęła padać na dacie ani nie
 * zależała od chwili wygenerowania plików.
 */

export const TEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICGjCCAaCgAwIBAgIUNAbco8VtGoCiPPEc5CvyNPVao0AwCgYIKoZIzj0EAwMw
QzEdMBsGA1UEAwwUU2NvZmZpZSBUZXN0IFJvb3QgQ0ExFTATBgNVBAoMDFNjb2Zm
aWUgVGVzdDELMAkGA1UEBhMCUEwwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEw
MDAwMDBaMEMxHTAbBgNVBAMMFFNjb2ZmaWUgVGVzdCBSb290IENBMRUwEwYDVQQK
DAxTY29mZmllIFRlc3QxCzAJBgNVBAYTAlBMMHYwEAYHKoZIzj0CAQYFK4EEACID
YgAEXCZFm0QkjuERGAXejV2sLcNTq75gm8z8YtrqpCLui5SIIv+EVIimuCadDrrG
fItGStVEFh/dCUS8R+YDk7FtyV5xspVDSmLPT9/lbhE5qP+Oga08TtfikA9mgOhp
kuwDo1MwUTAdBgNVHQ4EFgQUcl17UtpwzlpgUaAl/r0Jjp9Iop8wHwYDVR0jBBgw
FoAUcl17UtpwzlpgUaAl/r0Jjp9Iop8wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjO
PQQDAwNoADBlAjAzw31nePNEKiq9JxJ6J8DdNp7FtJQWvbQK3FnEkOFERARGeeQP
P/tGaQ9RJHx1meQCMQDwhR+9whlsV3cCKSIR/l/q5yekXB9yfiYKcfWsbu+xq4Qa
4apkvSgVadydavMdH2I=
-----END CERTIFICATE-----`;

export const TEST_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIICFTCCAZugAwIBAgIUcEIk1IAvoVW9BFJ1k7jgIY0V8UUwCgYIKoZIzj0EAwMw
QzEdMBsGA1UEAwwUU2NvZmZpZSBUZXN0IFJvb3QgQ0ExFTATBgNVBAoMDFNjb2Zm
aWUgVGVzdDELMAkGA1UEBhMCUEwwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEw
MDAwMDBaMEgxIjAgBgNVBAMMGVNjb2ZmaWUgVGVzdCBJbnRlcm1lZGlhdGUxFTAT
BgNVBAoMDFNjb2ZmaWUgVGVzdDELMAkGA1UEBhMCUEwwWTATBgcqhkjOPQIBBggq
hkjOPQMBBwNCAATVIbuuTAeuBeQVUcgdndtfxOCAkkNlzMkI5vrdaLVPgWd+JjM2
UKVc+5CBLhqkW3V6bvfCOLm72Dn9tFAEHChOo2YwZDASBgNVHRMBAf8ECDAGAQH/
AgEAMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQU2sEVRiZDDtE2X4Q8suDvqdMY
SdowHwYDVR0jBBgwFoAUcl17UtpwzlpgUaAl/r0Jjp9Iop8wCgYIKoZIzj0EAwMD
aAAwZQIwD0pu3GhfXXEZk/pOhS+AnjmzXhUm1a/+ZE+jz9zGQVNYyGaGLmSn9D0A
aVLFgptSAjEAh1CgEgac36JMRU/l73xHECej2vuMJvCLiUS9EpWLR/EM96J3xoGx
NWTiB1eMmVpF
-----END CERTIFICATE-----`;

export const TEST_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIB7DCCAZKgAwIBAgIUPm/7uUuNj29t587YBHEALg44xQgwCgYIKoZIzj0EAwIw
SDEiMCAGA1UEAwwZU2NvZmZpZSBUZXN0IEludGVybWVkaWF0ZTEVMBMGA1UECgwM
U2NvZmZpZSBUZXN0MQswCQYDVQQGEwJQTDAgFw0yMDAxMDEwMDAwMDBaGA8yMTIw
MDEwMTAwMDAwMFowQDEaMBgGA1UEAwwRU2NvZmZpZSBUZXN0IExlYWYxFTATBgNV
BAoMDFNjb2ZmaWUgVGVzdDELMAkGA1UEBhMCUEwwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQi+CBFlkYCGOHLLvuLBFxlnzQNUWiL7b7SGD1QIen6VeUMZjAanXLX
YrJ+yyyD6QgcfSRuS/gaeXrOylnmpobCo2AwXjAMBgNVHRMBAf8EAjAAMA4GA1Ud
DwEB/wQEAwIHgDAdBgNVHQ4EFgQUoMduFVY+bkzmJjRfSLd6ffa8oIwwHwYDVR0j
BBgwFoAU2sEVRiZDDtE2X4Q8suDvqdMYSdowCgYIKoZIzj0EAwIDSAAwRQIhALSA
N+bHoNxymu9C3XDi93N7eqAYy5lJuyMc8A8upwoeAiAJ52lcDNgRxwvoqfys9Lur
WB6YgFSS4eWa2qLDeGur7Q==
-----END CERTIFICATE-----`;

/** Klucz liścia (PKCS#8) — nim test PODPISUJE token. */
export const TEST_LEAF_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg8GS4LTzxhj+iOqss
WUyCxuyZCgDWvYVH4LjYd1sigb6hRANCAAQi+CBFlkYCGOHLLvuLBFxlnzQNUWiL
7b7SGD1QIen6VeUMZjAanXLXYrJ+yyyD6QgcfSRuS/gaeXrOylnmpobC
-----END PRIVATE KEY-----`;

/** PEM → gołe base64 DER, czyli postać oczekiwana w nagłówku `x5c`. */
export function derOf(pem: string): string {
  return pem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

/** Łańcuch w kolejności z RFC 7515: liść, pośredni, korzeń. */
export const TEST_X5C = [
  TEST_LEAF_PEM,
  TEST_INTERMEDIATE_PEM,
  TEST_ROOT_PEM,
].map(derOf);
