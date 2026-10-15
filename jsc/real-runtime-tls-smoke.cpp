#include <openssl/ssl.h>
#include <openssl/sha.h>
#include <openssl/rand.h>
#include <cstdio>
#include <cstring>
int main() {
  unsigned char hash[SHA256_DIGEST_LENGTH], random[32];
  constexpr unsigned char expected[] = {
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
    0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
    0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad
  };
  SHA256(reinterpret_cast<const unsigned char *>("abc"), 3, hash);
  if (std::memcmp(hash, expected, sizeof expected)) return 3;
  if (!RAND_bytes(random, sizeof random)) return 1;
  SSL_CTX *ctx = SSL_CTX_new(TLS_method());
  if (!ctx) return 2;
  SSL_CTX_free(ctx);
  for (unsigned char c : hash) std::printf("%02x", c);
  std::puts(" rand=ok ssl_ctx=ok");
}
