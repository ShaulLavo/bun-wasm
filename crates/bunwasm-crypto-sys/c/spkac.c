// Netscape SPKAC (crypto.Certificate) over BoringSSL, as ncrypto's VerifySpkac,
// ExportPublicKey and ExportChallenge do: trailing whitespace is ignored, then the
// base64 SPKI is decoded.
#include <ctype.h>
#include <string.h>
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/pem.h>
#include <openssl/x509.h>

static NETSCAPE_SPKI *decode_spkac(const char *data, size_t len) {
  while (len > 0 && isspace((unsigned char)data[len - 1])) len--;
  return NETSCAPE_SPKI_b64_decode(data, (ossl_ssize_t)len);
}

// mode 0: 1 when the SPKAC's signature verifies with its own key, else 0.
// mode 1: the public key as PEM; mode 2: the challenge as UTF-8. Both write at most
// `capacity` bytes and return the full length, or 0 on failure.
size_t bunwasm_spkac(int mode, const char *data, size_t len, unsigned char *out,
                     size_t capacity) {
  NETSCAPE_SPKI *spki = decode_spkac(data, len);
  if (!spki) return 0;
  size_t result = 0;
  if (mode == 2) {
    unsigned char *utf8 = NULL;
    int n = ASN1_STRING_to_UTF8(&utf8, spki->spkac->challenge);
    if (n >= 0) {
      result = (size_t)n;
      if (capacity >= result) memcpy(out, utf8, result);
    }
    OPENSSL_free(utf8);
    NETSCAPE_SPKI_free(spki);
    return result;
  }
  EVP_PKEY *pkey = NETSCAPE_SPKI_get_pubkey(spki);
  if (pkey && mode == 0) result = NETSCAPE_SPKI_verify(spki, pkey) > 0;
  if (pkey && mode == 1) {
    BIO *bio = BIO_new(BIO_s_mem());
    const uint8_t *pem = NULL;
    size_t pem_len = 0;
    if (bio && PEM_write_bio_PUBKEY(bio, pkey) && BIO_mem_contents(bio, &pem, &pem_len)) {
      result = pem_len;
      if (capacity >= result) memcpy(out, pem, result);
    }
    BIO_free(bio);
  }
  EVP_PKEY_free(pkey);
  NETSCAPE_SPKI_free(spki);
  return result;
}
