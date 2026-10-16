#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/rsa.h>

static const EVP_MD *digest(int bits) {
  switch (bits) {
    case 1: return EVP_sha1();
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
