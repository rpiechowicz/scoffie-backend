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
 * P-256 — ten sam kształt, co u Apple, łącznie ze ZNACZNIKAMI ról Apple:
 * pośredni niesie rozszerzenie 1.2.840.113635.100.6.2.1 (WWDR), liść
 * 1.2.840.113635.100.6.11.1 (podpis App Store). `verifyAppleJws` przyjmuje
 * `rootPem`, więc test przypina TEN korzeń zamiast Apple'owego i sprawdza
 * dokładnie tę samą ścieżkę kodu.
 *
 * Obok łańcucha „dobrego” leżą trzy złe, spod TEGO SAMEGO korzenia — tak
 * wygląda atak certyfikatem Apple, który nie służy do podpisu App Store
 * (np. Apple Pay spod WWDR G2 → Apple Root CA - G3): liść bez znacznika
 * App Store, pośredni bez znacznika WWDR i liść z kluczem P-384.
 * Pliki wygenerowane biblioteką `cryptography` (Python) 7.10.2026.
 *
 * KLUCZ PRYWATNY W REPOZYTORIUM JEST TU BEZPIECZNY: nie chroni niczego, nie ma
 * odpowiednika po stronie Apple i nie jest przypięty nigdzie poza testami.
 * Ważność 1.01.2020 – 1.01.2120, żeby suita nie zaczęła padać na dacie ani nie
 * zależała od chwili wygenerowania plików.
 */

export const TEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIB2zCCAWCgAwIBAgIUZlpjRa4y1PZT1myoqlfKs/mkHxowCgYIKoZIzj0EAwMw
QzEdMBsGA1UEAwwUU2NvZmZpZSBUZXN0IFJvb3QgQ0ExFTATBgNVBAoMDFNjb2Zm
aWUgVGVzdDELMAkGA1UEBhMCUEwwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEw
MDAwMDBaMEMxHTAbBgNVBAMMFFNjb2ZmaWUgVGVzdCBSb290IENBMRUwEwYDVQQK
DAxTY29mZmllIFRlc3QxCzAJBgNVBAYTAlBMMHYwEAYHKoZIzj0CAQYFK4EEACID
YgAEOLQVg93ASVrAQVnTW4ZAMzcm2ku3VdkRE0rueDE6wUJj4ySW52s5lJhylT/3
FhltFXFLXC22c3OeQUqyV630aD9kFn2EWG8ACca6ZWdbwHRKsjY2Aqf+3Be7rBLX
2CPqoxMwETAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMDA2kAMGYCMQDelpGU
ZAfUxSZJy6+kjCs+Hid9NVP/kpHZMY00Nqjl2cP+T9zmP7YCGIIGLB1M2+kCMQD/
EfakydKJdR9GHphkOmWBkNC4cH3fp83Fm0nqIDprvM2Qqv0f4/3tgTfrBl/rdIs=
-----END CERTIFICATE-----`;

export const TEST_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIB2DCCAV2gAwIBAgIULX5i0jIJxMYYoegSGFJP9mqbD78wCgYIKoZIzj0EAwMw
QzEdMBsGA1UEAwwUU2NvZmZpZSBUZXN0IFJvb3QgQ0ExFTATBgNVBAoMDFNjb2Zm
aWUgVGVzdDELMAkGA1UEBhMCUEwwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEw
MDAwMDBaMEgxIjAgBgNVBAMMGVNjb2ZmaWUgVGVzdCBJbnRlcm1lZGlhdGUxFTAT
BgNVBAoMDFNjb2ZmaWUgVGVzdDELMAkGA1UEBhMCUEwwWTATBgcqhkjOPQIBBggq
hkjOPQMBBwNCAATeaHgMfVAHQqcE99B4zlXfifynnWIiDPiaBB1KFRwdwIiv17pp
B1McZdaSrWAgmW7V5idJBR/QQZxTsJmjSI4VoygwJjASBgNVHRMBAf8ECDAGAQH/
AgEAMBAGCiqGSIb3Y2QGAgEEAgUAMAoGCCqGSM49BAMDA2kAMGYCMQD+DhEKv4S1
KLH0MC0YJ2LKqkiSskcye1+eizg/22/u8oeS9nrxg6hs3Sl6LlHSz4oCMQCS8U9T
lGzS+9X4Pdi2IHzL/qvzDhEKlxH3sTt/C06/CNK21mYah0f0IeSiMXXz2x0=
-----END CERTIFICATE-----`;

export const TEST_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBrjCCAVSgAwIBAgIUM7bOZWNNugVIC3IRCWYtJMVUVfcwCgYIKoZIzj0EAwIw
SDEiMCAGA1UEAwwZU2NvZmZpZSBUZXN0IEludGVybWVkaWF0ZTEVMBMGA1UECgwM
U2NvZmZpZSBUZXN0MQswCQYDVQQGEwJQTDAgFw0yMDAxMDEwMDAwMDBaGA8yMTIw
MDEwMTAwMDAwMFowQDEaMBgGA1UEAwwRU2NvZmZpZSBUZXN0IExlYWYxFTATBgNV
BAoMDFNjb2ZmaWUgVGVzdDELMAkGA1UEBhMCUEwwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATTXnG0aFflPKLEpg1KywILNPi1NSX5mhA6T5F1XmuTirYzGsfCimiC
d2ZA9/EdinFeHWsg+2uk4FhrYuM96DszoyIwIDAMBgNVHRMBAf8EAjAAMBAGCiqG
SIb3Y2QGCwEEAgUAMAoGCCqGSM49BAMCA0gAMEUCIQDdssERYt+mJ8Ebxp3TCZWK
Ft2OkAXJz7TwfBSX65tKwwIgBOIPCSDUToYPkK5PUC24bdozLH4l+vzmpbllb/Es
MBQ=
-----END CERTIFICATE-----`;

/** Klucz liścia (PKCS#8) — nim test PODPISUJE token. */
export const TEST_LEAF_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgXZD2yfAOL5jJBYq/
y9Xrk3LSU5FVwSDV2vwJigacPyuhRANCAATTXnG0aFflPKLEpg1KywILNPi1NSX5
mhA6T5F1XmuTirYzGsfCimiCd2ZA9/EdinFeHWsg+2uk4FhrYuM96Dsz
-----END PRIVATE KEY-----`;

/** Liść spod dobrego pośredniego, ale BEZ znacznika App Store (1.2.840.113635.100.6.11.1). */
export const TEST_UNMARKED_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBozCCAUigAwIBAgIUabC05N/IG5v03ugCVgIoGApi9nQwCgYIKoZIzj0EAwIw
SDEiMCAGA1UEAwwZU2NvZmZpZSBUZXN0IEludGVybWVkaWF0ZTEVMBMGA1UECgwM
U2NvZmZpZSBUZXN0MQswCQYDVQQGEwJQTDAgFw0yMDAxMDEwMDAwMDBaGA8yMTIw
MDEwMTAwMDAwMFowRjEgMB4GA1UEAwwXU2NvZmZpZSBUZXN0IE90aGVyIExlYWYx
FTATBgNVBAoMDFNjb2ZmaWUgVGVzdDELMAkGA1UEBhMCUEwwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQJoYXrFrb2AO4mA1fTd64Sft+Y1oVQDzBtRAJMbEBrk+TT
QltZRhlsWvEOcvzuGOwQCdbqjbMiX406wt2Swq+AoxAwDjAMBgNVHRMBAf8EAjAA
MAoGCCqGSM49BAMCA0kAMEYCIQCxbHQlfZfWMz+PYtSj7Sj0EQpUevXXjh26T8KR
/nwgxgIhAPqGkCbySBHXqhmr3KGISP3Eq79eFqx9IgE5nJAMpMN2
-----END CERTIFICATE-----`;

export const TEST_UNMARKED_LEAF_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWsRH1gTWIqiKvxjk
8OKiwWKRJNQZUgW8/IPS87bErGihRANCAAQJoYXrFrb2AO4mA1fTd64Sft+Y1oVQ
DzBtRAJMbEBrk+TTQltZRhlsWvEOcvzuGOwQCdbqjbMiX406wt2Swq+A
-----END PRIVATE KEY-----`;

/** Pośredni spod korzenia, ale BEZ znacznika WWDR (1.2.840.113635.100.6.2.1). */
export const TEST_UNMARKED_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIByzCCAVGgAwIBAgIUO5ug9BMsDvYjlt4umwZ2T+haQFcwCgYIKoZIzj0EAwMw
QzEdMBsGA1UEAwwUU2NvZmZpZSBUZXN0IFJvb3QgQ0ExFTATBgNVBAoMDFNjb2Zm
aWUgVGVzdDELMAkGA1UEBhMCUEwwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEw
MDAwMDBaME4xKDAmBgNVBAMMH1Njb2ZmaWUgVGVzdCBQbGFpbiBJbnRlcm1lZGlh
dGUxFTATBgNVBAoMDFNjb2ZmaWUgVGVzdDELMAkGA1UEBhMCUEwwWTATBgcqhkjO
PQIBBggqhkjOPQMBBwNCAAQg/mPSnE70Wx8eBe2uLdPIfJiPk0qLYBedxzeDQJBa
jq6Uiu+uMgseAbi0iNiOEMEaAfbeFKW30wcGK1C+j+QJoxYwFDASBgNVHRMBAf8E
CDAGAQH/AgEAMAoGCCqGSM49BAMDA2gAMGUCMQDjn4YUslkj+LIpp6VYzctVwwQP
5JvlW+Pczrmxx5rIQGQU/dOgOPdc7ngtkyiJFDICMBec3AfR6AXGw2jur0yWMaqg
kwywRrUqkS8MtmGau9Y27GyqPxuEPyE29HQFF5V1pw==
-----END CERTIFICATE-----`;

/** Liść ze znacznikiem App Store, podpisany przez pośredni bez znacznika. */
export const TEST_LEAF_UNDER_UNMARKED_PEM = `-----BEGIN CERTIFICATE-----
MIIBtTCCAVqgAwIBAgIUV7b0LorZkuxp4M176uXTiuqyFO8wCgYIKoZIzj0EAwIw
TjEoMCYGA1UEAwwfU2NvZmZpZSBUZXN0IFBsYWluIEludGVybWVkaWF0ZTEVMBMG
A1UECgwMU2NvZmZpZSBUZXN0MQswCQYDVQQGEwJQTDAgFw0yMDAxMDEwMDAwMDBa
GA8yMTIwMDEwMTAwMDAwMFowQDEaMBgGA1UEAwwRU2NvZmZpZSBUZXN0IExlYWYx
FTATBgNVBAoMDFNjb2ZmaWUgVGVzdDELMAkGA1UEBhMCUEwwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAATs5YQCzqo1Ihh1O/vU8DGVzhqc9aBSjj/894aJkI+h6Atj
KuuFYE/9F4oPBO+HwIMHK34MtmvL6FS/zBRUz9rhoyIwIDAMBgNVHRMBAf8EAjAA
MBAGCiqGSIb3Y2QGCwEEAgUAMAoGCCqGSM49BAMCA0kAMEYCIQC8tWMzAAX7Aw7a
myeDAoRfmgSGHeY3K42q562i105/7wIhAPVu79nIZPYyqeGtEdtfICFa3kvSBqSn
nMHwRMvNl/Ab
-----END CERTIFICATE-----`;

export const TEST_LEAF_UNDER_UNMARKED_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgVS8wcCyM3yEHgt0y
XM4rAir/1M8EgCZh33KZZ6z1U3WhRANCAATs5YQCzqo1Ihh1O/vU8DGVzhqc9aBS
jj/894aJkI+h6AtjKuuFYE/9F4oPBO+HwIMHK34MtmvL6FS/zBRUz9rh
-----END PRIVATE KEY-----`;

/** Liść ze znacznikiem, ale z kluczem P-384 — Apple podpisuje ES256, czyli P-256. */
export const TEST_P384_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIB0DCCAXagAwIBAgIUUVpXseTbn2EAGFHoWV39gjkX52IwCgYIKoZIzj0EAwIw
SDEiMCAGA1UEAwwZU2NvZmZpZSBUZXN0IEludGVybWVkaWF0ZTEVMBMGA1UECgwM
U2NvZmZpZSBUZXN0MQswCQYDVQQGEwJQTDAgFw0yMDAxMDEwMDAwMDBaGA8yMTIw
MDEwMTAwMDAwMFowRTEfMB0GA1UEAwwWU2NvZmZpZSBUZXN0IFAzODQgTGVhZjEV
MBMGA1UECgwMU2NvZmZpZSBUZXN0MQswCQYDVQQGEwJQTDB2MBAGByqGSM49AgEG
BSuBBAAiA2IABKz6D0JwpRmHqdwSJJV0WZkQ5K+qgcMoXCQxa2KLNRTjYqvuflVa
C80u3/8HidzMhtsZUNRwczf2GUk6gUK2yWzUwJyfktqvfPFuLAV2W8sbwFW8YsbD
63N3jCBEOX/3I6MiMCAwDAYDVR0TAQH/BAIwADAQBgoqhkiG92NkBgsBBAIFADAK
BggqhkjOPQQDAgNIADBFAiEA5QzBLWYMPFiiX2twqjOP8yIWfndc2wBpOIa4UUOx
A6QCIFLR54Jx507TWzKYMf/ce8ZdkeN5qmrfTWJir2vyp4DH
-----END CERTIFICATE-----`;

export const TEST_P384_LEAF_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDA+qZjYC0BGI6mnRNQC
V6AvlhR2mCsdzLVUiVc5gHa5FjsEeQ02aFXRnRueS0gJWWWhZANiAASs+g9CcKUZ
h6ncEiSVdFmZEOSvqoHDKFwkMWtiizUU42Kr7n5VWgvNLt//B4nczIbbGVDUcHM3
9hlJOoFCtsls1MCcn5Lar3zxbiwFdlvLG8BVvGLGw+tzd4wgRDl/9yM=
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
