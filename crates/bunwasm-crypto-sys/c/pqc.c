// ML-KEM, ML-DSA and ChaCha20-Poly1305 over BoringSSL's public API, for WebCrypto.
// Keys cross this boundary as bytes: the FIPS seed for a private key and the encoded
// public key. BoringSSL's private key structures are large and opaque, so they are
// heap-allocated here and cleared before they are freed.
#include <stdlib.h>
#include <string.h>
#include <openssl/aead.h>
#include <openssl/bytestring.h>
#include <openssl/mem.h>
#include <openssl/mldsa.h>
#include <openssl/mlkem.h>

enum { MLKEM768 = 0, MLKEM1024 = 1, MLDSA44 = 2, MLDSA65 = 3, MLDSA87 = 4 };

// Sizes by kind: what 0 is the public key, 1 the seed, 2 the ciphertext or signature.
size_t bunwasm_pqc_size(int kind, int what) {
  static const size_t sizes[5][3] = {
      {MLKEM768_PUBLIC_KEY_BYTES, MLKEM_SEED_BYTES, MLKEM768_CIPHERTEXT_BYTES},
      {MLKEM1024_PUBLIC_KEY_BYTES, MLKEM_SEED_BYTES, MLKEM1024_CIPHERTEXT_BYTES},
      {MLDSA44_PUBLIC_KEY_BYTES, MLDSA_SEED_BYTES, MLDSA44_SIGNATURE_BYTES},
      {MLDSA65_PUBLIC_KEY_BYTES, MLDSA_SEED_BYTES, MLDSA65_SIGNATURE_BYTES},
      {MLDSA87_PUBLIC_KEY_BYTES, MLDSA_SEED_BYTES, MLDSA87_SIGNATURE_BYTES},
  };
  if (kind < 0 || kind > 4 || what < 0 || what > 2) return 0;
  return sizes[kind][what];
}

static void *alloc_key(size_t size) { return calloc(1, size); }
static void free_key(void *key, size_t size) {
  if (!key) return;
  OPENSSL_cleanse(key, size);
  free(key);
}

// The encoded public key of the private key `seed` derives, into `public_out`.
#define PUBLIC_FROM_SEED(NAME, DERIVE)                                               \
  static int NAME##_public(const uint8_t *seed, size_t seed_len, uint8_t *out,      \
                           size_t out_len) {                                         \
    struct NAME##_private_key *priv = alloc_key(sizeof(*priv));                      \
    struct NAME##_public_key *pub = alloc_key(sizeof(*pub));                         \
    CBB cbb;                                                                         \
    int ok = priv && pub && NAME##_private_key_from_seed(priv, seed, seed_len) &&    \
             DERIVE(NAME, pub, priv) && CBB_init_fixed(&cbb, out, out_len) &&       \
             NAME##_marshal_public_key(&cbb, pub) && CBB_len(&cbb) == out_len;       \
    free_key(priv, sizeof(*priv));                                                   \
    free_key(pub, sizeof(*pub));                                                     \
    return ok;                                                                       \
  }
// ML-KEM's public_from_private cannot fail; ML-DSA's returns 1 on success.
#define KEM_PUBLIC(NAME, pub, priv) (NAME##_public_from_private(pub, priv), 1)
#define DSA_PUBLIC(NAME, pub, priv) NAME##_public_from_private(pub, priv)
PUBLIC_FROM_SEED(MLKEM768, KEM_PUBLIC)
PUBLIC_FROM_SEED(MLKEM1024, KEM_PUBLIC)
PUBLIC_FROM_SEED(MLDSA44, DSA_PUBLIC)
PUBLIC_FROM_SEED(MLDSA65, DSA_PUBLIC)
PUBLIC_FROM_SEED(MLDSA87, DSA_PUBLIC)

// Writes the public key for `seed`; returns 1 on success, 0 for a bad seed.
int bunwasm_pqc_public(int kind, const uint8_t *seed, size_t seed_len, uint8_t *out,
                       size_t out_len) {
  if (out_len != bunwasm_pqc_size(kind, 0)) return 0;
  switch (kind) {
    case MLKEM768: return MLKEM768_public(seed, seed_len, out, out_len);
    case MLKEM1024: return MLKEM1024_public(seed, seed_len, out, out_len);
    case MLDSA44: return MLDSA44_public(seed, seed_len, out, out_len);
    case MLDSA65: return MLDSA65_public(seed, seed_len, out, out_len);
    case MLDSA87: return MLDSA87_public(seed, seed_len, out, out_len);
    default: return 0;
  }
}

#define KEM_OPS(NAME)                                                                \
  static int NAME##_encap_bytes(const uint8_t *pub_bytes, size_t pub_len,           \
                                uint8_t *ct, uint8_t *ss) {                          \
    struct NAME##_public_key *pub = alloc_key(sizeof(*pub));                         \
    CBS cbs;                                                                         \
    CBS_init(&cbs, pub_bytes, pub_len);                                              \
    int ok = pub && NAME##_parse_public_key(pub, &cbs) && CBS_len(&cbs) == 0;        \
    if (ok) NAME##_encap(ct, ss, pub);                                               \
    free_key(pub, sizeof(*pub));                                                     \
    return ok;                                                                       \
  }                                                                                  \
  static int NAME##_decap_bytes(const uint8_t *seed, size_t seed_len,               \
                                const uint8_t *ct, size_t ct_len, uint8_t *ss) {     \
    struct NAME##_private_key *priv = alloc_key(sizeof(*priv));                      \
    int ok = priv && NAME##_private_key_from_seed(priv, seed, seed_len) &&           \
             NAME##_decap(ss, ct, ct_len, priv);                                     \
    free_key(priv, sizeof(*priv));                                                   \
    return ok;                                                                       \
  }
KEM_OPS(MLKEM768)
KEM_OPS(MLKEM1024)

int bunwasm_mlkem_encap(int kind, const uint8_t *pub, size_t pub_len, uint8_t *ct,
                        uint8_t *ss) {
  if (kind == MLKEM768) return MLKEM768_encap_bytes(pub, pub_len, ct, ss);
  if (kind == MLKEM1024) return MLKEM1024_encap_bytes(pub, pub_len, ct, ss);
  return 0;
}

int bunwasm_mlkem_decap(int kind, const uint8_t *seed, size_t seed_len,
                        const uint8_t *ct, size_t ct_len, uint8_t *ss) {
  if (kind == MLKEM768) return MLKEM768_decap_bytes(seed, seed_len, ct, ct_len, ss);
  if (kind == MLKEM1024) return MLKEM1024_decap_bytes(seed, seed_len, ct, ct_len, ss);
  return 0;
}

#define DSA_OPS(NAME)                                                                \
  static int NAME##_sign_bytes(const uint8_t *seed, size_t seed_len,                \
                               const uint8_t *msg, size_t msg_len,                   \
                               const uint8_t *ctx, size_t ctx_len, uint8_t *sig) {   \
    struct NAME##_private_key *priv = alloc_key(sizeof(*priv));                      \
    int ok = priv && NAME##_private_key_from_seed(priv, seed, seed_len) &&           \
             NAME##_sign(sig, priv, msg, msg_len, ctx, ctx_len);                     \
    free_key(priv, sizeof(*priv));                                                   \
    return ok;                                                                       \
  }                                                                                  \
  static int NAME##_verify_bytes(const uint8_t *pub_bytes, size_t pub_len,          \
                                 const uint8_t *sig, size_t sig_len,                 \
                                 const uint8_t *msg, size_t msg_len,                 \
                                 const uint8_t *ctx, size_t ctx_len) {               \
    struct NAME##_public_key *pub = alloc_key(sizeof(*pub));                         \
    CBS cbs;                                                                         \
    CBS_init(&cbs, pub_bytes, pub_len);                                              \
    int ok = pub && NAME##_parse_public_key(pub, &cbs) &&                            \
             NAME##_verify(pub, sig, sig_len, msg, msg_len, ctx, ctx_len);           \
    free_key(pub, sizeof(*pub));                                                     \
    return ok;                                                                       \
  }
DSA_OPS(MLDSA44)
DSA_OPS(MLDSA65)
DSA_OPS(MLDSA87)

int bunwasm_mldsa_sign(int kind, const uint8_t *seed, size_t seed_len,
                       const uint8_t *msg, size_t msg_len, const uint8_t *ctx,
                       size_t ctx_len, uint8_t *sig) {
  switch (kind) {
    case MLDSA44: return MLDSA44_sign_bytes(seed, seed_len, msg, msg_len, ctx, ctx_len, sig);
    case MLDSA65: return MLDSA65_sign_bytes(seed, seed_len, msg, msg_len, ctx, ctx_len, sig);
    case MLDSA87: return MLDSA87_sign_bytes(seed, seed_len, msg, msg_len, ctx, ctx_len, sig);
    default: return 0;
  }
}

// 1 for a valid signature, 0 otherwise (including an unparsable public key).
int bunwasm_mldsa_verify(int kind, const uint8_t *pub, size_t pub_len,
                         const uint8_t *sig, size_t sig_len, const uint8_t *msg,
                         size_t msg_len, const uint8_t *ctx, size_t ctx_len) {
  switch (kind) {
    case MLDSA44: return MLDSA44_verify_bytes(pub, pub_len, sig, sig_len, msg, msg_len, ctx, ctx_len);
    case MLDSA65: return MLDSA65_verify_bytes(pub, pub_len, sig, sig_len, msg, msg_len, ctx, ctx_len);
    case MLDSA87: return MLDSA87_verify_bytes(pub, pub_len, sig, sig_len, msg, msg_len, ctx, ctx_len);
    default: return 0;
  }
}

// ChaCha20-Poly1305 seal (encrypt != 0) or open with a 32-byte key and 12-byte nonce,
// and a 16-byte tag appended to the ciphertext. `out` holds in_len + 16 bytes; the
// written length goes to *out_len. Returns 1 on success, 0 on failure.
int bunwasm_chacha20_poly1305(int encrypt, const uint8_t *key, size_t key_len,
                              const uint8_t *nonce, size_t nonce_len,
                              const uint8_t *ad, size_t ad_len, const uint8_t *in,
                              size_t in_len, uint8_t *out, size_t *out_len) {
  const EVP_AEAD *aead = EVP_aead_chacha20_poly1305();
  EVP_AEAD_CTX *ctx = EVP_AEAD_CTX_new(aead, key, key_len, EVP_AEAD_DEFAULT_TAG_LENGTH);
  if (!ctx) return 0;
  size_t capacity = *out_len;
  int ok = encrypt
               ? EVP_AEAD_CTX_seal(ctx, out, out_len, capacity, nonce, nonce_len, in, in_len, ad, ad_len)
               : EVP_AEAD_CTX_open(ctx, out, out_len, capacity, nonce, nonce_len, in, in_len, ad, ad_len);
  EVP_AEAD_CTX_free(ctx);
  return ok;
}
