#include <string.h>
#include <limits.h>
#include <openssl/bio.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/bn.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/rsa.h>

static const EVP_MD *digest(int bits) {
  switch (bits) {
    case 1: return EVP_sha1();
    case 224: return EVP_sha224();
    case 256: return EVP_sha256();
    case 384: return EVP_sha384();
    case 512: return EVP_sha512();
    default: return NULL;
  }
}

int bunwasm_rsa(int op, const unsigned char *der, size_t der_len, int hash,
                int pss, int salt, const unsigned char *label, size_t label_len,
                const unsigned char *input, size_t input_len,
                unsigned char *output, size_t *output_len) {
  RSA *rsa = (op == 0 || op == 3) ? RSA_private_key_from_bytes(der, der_len)
                                  : RSA_public_key_from_bytes(der, der_len);
  EVP_PKEY *key = EVP_PKEY_new();
  if (!rsa || !key || !digest(hash)) {
    RSA_free(rsa);
    EVP_PKEY_free(key);
    return -1;
  }
  if (!EVP_PKEY_assign_RSA(key, rsa)) {
    RSA_free(rsa);
    EVP_PKEY_free(key);
    return -1;
  }
  EVP_MD_CTX *md = NULL;
  EVP_PKEY_CTX *ctx = NULL;
  int ok = 0;
  if (op == 0 || op == 1) {
    md = EVP_MD_CTX_new();
    if (!md) goto done;
    ok = op == 0 ? EVP_DigestSignInit(md, &ctx, digest(hash), NULL, key)
                 : EVP_DigestVerifyInit(md, &ctx, digest(hash), NULL, key);
    if (!ok) goto done;
    ok = EVP_PKEY_CTX_set_rsa_padding(ctx, pss ? RSA_PKCS1_PSS_PADDING : RSA_PKCS1_PADDING);
    if (!ok) goto done;
    if (pss && !EVP_PKEY_CTX_set_rsa_pss_saltlen(ctx, salt)) { ok = 0; goto done; }
    if (op == 0) ok = EVP_DigestSign(md, output, output_len, input, input_len);
    else ok = EVP_DigestVerify(md, output, *output_len, input, input_len);
    goto done;
  }
  ctx = EVP_PKEY_CTX_new(key, NULL);
  if (!ctx) goto done;
  ok = op == 2 ? EVP_PKEY_encrypt_init(ctx) : EVP_PKEY_decrypt_init(ctx);
  if (!ok) goto done;
  if (!EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_OAEP_PADDING) ||
      !EVP_PKEY_CTX_set_rsa_oaep_md(ctx, digest(hash)) ||
      !EVP_PKEY_CTX_set_rsa_mgf1_md(ctx, digest(hash))) { ok = 0; goto done; }
  if (label_len) {
    unsigned char *owned = OPENSSL_memdup(label, label_len);
    if (!owned) { ok = 0; goto done; }
    if (!EVP_PKEY_CTX_set0_rsa_oaep_label(ctx, owned, label_len)) {
      OPENSSL_free(owned); ok = 0; goto done;
    }
  }
  ok = op == 2 ? EVP_PKEY_encrypt(ctx, output, output_len, input, input_len)
               : EVP_PKEY_decrypt(ctx, output, output_len, input, input_len);
done:
  if (md) EVP_MD_CTX_free(md);
  else EVP_PKEY_CTX_free(ctx);
  EVP_PKEY_free(key);
  return ok;
}

void *bunwasm_rsa_generate(int bits, const unsigned char *exponent, size_t exponent_len) {
  RSA *key = RSA_new();
  BIGNUM *e = BN_bin2bn(exponent, exponent_len, NULL);
  int ok = key && e && RSA_generate_key_ex(key, bits, e, NULL);
  BN_free(e);
  if (ok) return key;
  RSA_free(key);
  return NULL;
}

void bunwasm_rsa_free(void *key) { RSA_free(key); }

void *bunwasm_rsa_from_jwk(const unsigned char *const *fields, const size_t *lengths, int private_key) {
  BIGNUM *parts[8] = {NULL};
  RSA *key = RSA_new();
  int ok = 0;
  if (!key) return NULL;
  for (int i = 0; i < (private_key ? 8 : 2); i++) {
    if (!lengths[i] || !(parts[i] = BN_bin2bn(fields[i], lengths[i], NULL))) goto done;
  }
  if (!RSA_set0_key(key, parts[0], parts[1], parts[2])) goto done;
  parts[0] = parts[1] = parts[2] = NULL;
  if (private_key) {
    if (!RSA_set0_factors(key, parts[3], parts[4])) goto done;
    parts[3] = parts[4] = NULL;
    if (!RSA_set0_crt_params(key, parts[5], parts[6], parts[7])) goto done;
    parts[5] = parts[6] = parts[7] = NULL;
  }
  ok = RSA_check_key(key);
done:
  for (int i = 0; i < 8; i++) BN_clear_free(parts[i]);
  if (ok) return key;
  RSA_free(key);
  return NULL;
}

void *bunwasm_rsa_parse(const unsigned char *der, size_t length, int private_key) {
  RSA *key = private_key ? RSA_private_key_from_bytes(der, length) : RSA_public_key_from_bytes(der, length);
  if (key && RSA_check_key(key)) return key;
  RSA_free(key);
  return NULL;
}

size_t bunwasm_rsa_field(const void *key, int index, unsigned char *output, size_t capacity) {
  const BIGNUM *parts[] = {RSA_get0_n(key), RSA_get0_e(key), RSA_get0_d(key), RSA_get0_p(key), RSA_get0_q(key), RSA_get0_dmp1(key), RSA_get0_dmq1(key), RSA_get0_iqmp(key)};
  if (index < 0 || index >= 8 || !parts[index]) return 0;
  size_t size = BN_num_bytes(parts[index]);
  if (capacity >= size) BN_bn2bin(parts[index], output);
  return size;
}

size_t bunwasm_rsa_der(const void *key, int private_key, unsigned char *output, size_t capacity) {
  unsigned char *der = NULL;
  size_t size = 0;
  int ok = private_key ? RSA_private_key_to_bytes(&der, &size, key) : RSA_public_key_to_bytes(&der, &size, key);
  if (ok && capacity >= size) memcpy(output, der, size);
  OPENSSL_free(der);
  return ok ? size : 0;
}

struct key_password { const unsigned char *bytes; size_t length; };
static int key_password(char *out, int capacity, int writing, void *context) {
  (void)writing;
  const struct key_password *password = context;
  if (capacity < 0 || password->length > (size_t)capacity) return 0;
  memcpy(out, password->bytes, password->length);
  return (int)password->length;
}

size_t bunwasm_key_encoding(int op, const unsigned char *input, size_t input_len,
                           const unsigned char *password, size_t password_len,
                           const char *cipher_name, unsigned char *output,
                           size_t capacity) {
  struct key_password pass = {password, password_len};
  BIO *source = NULL, *dest = NULL;
  EVP_PKEY *key = NULL;
  CBB cbb;
  CBB_zero(&cbb);
  unsigned char *encoded = NULL;
  const unsigned char *contents = NULL;
  size_t size = 0;
  int ok = 0;
  if (input_len > INT_MAX || password_len > INT_MAX) goto done;
  source = BIO_new_mem_buf(input, (int)input_len);
  if (!source) goto done;
  if (op == 0) {
    key = PEM_read_bio_PrivateKey(source, NULL, key_password, &pass);
  } else {
    CBS cbs;
    CBS_init(&cbs, input, input_len);
    key = EVP_parse_private_key(&cbs);
    if (key && CBS_len(&cbs)) { EVP_PKEY_free(key); key = NULL; }
    if (!key && op == 1) {
      ERR_clear_error();
      key = d2i_PKCS8PrivateKey_bio(source, NULL, key_password, &pass);
    }
  }
  if (!key) goto done;
  if (op <= 1) {
    if (!CBB_init(&cbb, input_len) || !EVP_marshal_private_key(&cbb, key) ||
        !CBB_finish(&cbb, &encoded, &size)) goto done;
    contents = encoded;
    ok = 1;
    goto copy;
  }
  const EVP_CIPHER *cipher = EVP_get_cipherbyname(cipher_name);
  if (!cipher) goto done;
  dest = BIO_new(BIO_s_mem());
  if (!dest) goto done;
  if (op == 2) ok = PEM_write_bio_PKCS8PrivateKey(dest, key, cipher, (const char *)password, (int)password_len, NULL, NULL);
  if (op == 3) ok = i2d_PKCS8PrivateKey_bio(dest, key, cipher, (const char *)password, (int)password_len, NULL, NULL);
  if (op == 4 && EVP_PKEY_id(key) == EVP_PKEY_RSA) ok = PEM_write_bio_RSAPrivateKey(dest, EVP_PKEY_get0_RSA(key), cipher, password, (int)password_len, NULL, NULL);
  if (op == 5 && EVP_PKEY_id(key) == EVP_PKEY_EC) ok = PEM_write_bio_ECPrivateKey(dest, EVP_PKEY_get0_EC_KEY(key), cipher, password, (int)password_len, NULL, NULL);
  if (!ok || !BIO_mem_contents(dest, &contents, &size)) { ok = 0; goto done; }
copy:
  if (ok && size <= capacity) memcpy(output, contents, size);
  else ok = 0;
done:
  OPENSSL_free(encoded);
  CBB_cleanup(&cbb);
  EVP_PKEY_free(key);
  BIO_free(source);
  BIO_free(dest);
  ERR_clear_error();
  return ok ? size : 0;
}
