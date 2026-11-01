#include <openssl/err.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {
constexpr size_t kBioCapacity = 16 * 1024;
constexpr size_t kFrameLimit = 16 * 1024;
constexpr char kPayload[] = "tls-probe-payload";

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "tls-probe error=%s\n", message);
  std::exit(2);
}

void read_all(void* out, size_t size) {
  auto* bytes = static_cast<unsigned char*>(out);
  while (size != 0) {
    const size_t count = std::fread(bytes, 1, size, stdin);
    if (count == 0) fail("stdin-eof");
    bytes += count;
    size -= count;
  }
}

void emit_frame(const unsigned char* data, size_t size) {
  if (size > kFrameLimit) fail("frame-too-large");
  const std::array<unsigned char, 4> header = {
      static_cast<unsigned char>(size >> 24),
      static_cast<unsigned char>(size >> 16),
      static_cast<unsigned char>(size >> 8),
      static_cast<unsigned char>(size),
  };
  if (std::fwrite(header.data(), 1, header.size(), stdout) != header.size()) fail("stdout");
  if (size != 0 && std::fwrite(data, 1, size, stdout) != size) fail("stdout");
  if (std::fflush(stdout) != 0) fail("stdout-flush");
}

void drain(BIO* network) {
  std::array<unsigned char, kFrameLimit> buffer{};
  while (BIO_ctrl_pending(network) != 0) {
    const int count = BIO_read(network, buffer.data(), buffer.size());
    if (count <= 0) fail("bio-read");
    emit_frame(buffer.data(), static_cast<size_t>(count));
  }
}

void receive(BIO* network) {
  std::array<unsigned char, 4> header{};
  read_all(header.data(), header.size());
  const size_t size = (static_cast<size_t>(header[0]) << 24) |
                      (static_cast<size_t>(header[1]) << 16) |
                      (static_cast<size_t>(header[2]) << 8) | header[3];
  if (size > kFrameLimit || size > BIO_ctrl_get_write_guarantee(network)) fail("incoming-capacity");
  if (size == 0) {
    BIO_shutdown_wr(network);
    return;
  }
  std::array<unsigned char, kFrameLimit> bytes{};
  read_all(bytes.data(), size);
  if (BIO_write(network, bytes.data(), size) != static_cast<int>(size)) fail("bio-write");
}

int step_error(SSL* ssl, int result) {
  return result > 0 ? SSL_ERROR_NONE : SSL_get_error(ssl, result);
}

bool wait_for_io(int error, BIO* network) {
  drain(network);
  if (error == SSL_ERROR_WANT_READ) {
    receive(network);
    return true;
  }
  return error == SSL_ERROR_WANT_WRITE;
}

struct Client {
  SSL_CTX* context = nullptr;
  SSL* ssl = nullptr;
  BIO* network = nullptr;
  ~Client() {
    SSL_free(ssl);
    BIO_free(network);
    SSL_CTX_free(context);
  }
};

int handshake(Client& client) {
  for (unsigned turn = 0; turn < 1024; ++turn) {
    ERR_clear_error();
    const int result = SSL_do_handshake(client.ssl);
    const int error = step_error(client.ssl, result);
    if (result == 1) {
      drain(client.network);
      return 0;
    }
    const long verify = SSL_get_verify_result(client.ssl);
    if (error == SSL_ERROR_SSL && verify != X509_V_OK) {
      drain(client.network);
      std::fprintf(stderr, "tls-probe rejected verify=%ld\n", verify);
      return 10;
    }
    if (!wait_for_io(error, client.network)) fail("handshake-protocol");
  }
  fail("handshake-turn-limit");
}

void exchange(Client& client) {
  for (unsigned turn = 0; turn < 1024; ++turn) {
    ERR_clear_error();
    const int result = SSL_write(client.ssl, kPayload, sizeof(kPayload) - 1);
    const int error = step_error(client.ssl, result);
    if (result == static_cast<int>(sizeof(kPayload) - 1)) break;
    if (result > 0 || !wait_for_io(error, client.network)) fail("payload-write");
  }
  drain(client.network);
  std::string response;
  for (unsigned turn = 0; turn < 1024; ++turn) {
    std::array<char, 1024> buffer{};
    ERR_clear_error();
    const int result = SSL_read(client.ssl, buffer.data(), buffer.size());
    const int error = step_error(client.ssl, result);
    if (result > 0) {
      response.append(buffer.data(), static_cast<size_t>(result));
      if (response.size() > sizeof(kPayload) - 1) fail("payload-overflow");
      continue;
    }
    if (error == SSL_ERROR_ZERO_RETURN) {
      if (response != kPayload) fail("payload-mismatch");
      return;
    }
    if (!wait_for_io(error, client.network)) fail("payload-read");
  }
  fail("payload-turn-limit");
}

void shutdown(Client& client) {
  ERR_clear_error();
  const int result = SSL_shutdown(client.ssl);
  const int error = step_error(client.ssl, result);
  drain(client.network);
  if (result != 1 || error != SSL_ERROR_NONE) fail("close-notify");
  const int required = SSL_SENT_SHUTDOWN | SSL_RECEIVED_SHUTDOWN;
  if (SSL_get_shutdown(client.ssl) != required) fail("shutdown-state");
  emit_frame(nullptr, 0);
}

int run(int argc, char** argv) {
  if (argc != 4) fail("arguments-ca-host-version");
  const uint16_t version = std::strcmp(argv[3], "1.2") == 0 ? TLS1_2_VERSION : TLS1_3_VERSION;
  Client client;
  client.context = SSL_CTX_new(TLS_client_method());
  if (client.context == nullptr) fail("ctx");
  SSL_CTX_set_verify(client.context, SSL_VERIFY_PEER, nullptr);
  if (SSL_CTX_load_verify_locations(client.context, argv[1], nullptr) != 1) fail("ca");
  if (SSL_CTX_set_min_proto_version(client.context, version) != 1 ||
      SSL_CTX_set_max_proto_version(client.context, version) != 1) fail("version");
  client.ssl = SSL_new(client.context);
  if (client.ssl == nullptr) fail("ssl");
  if (SSL_set_tlsext_host_name(client.ssl, argv[2]) != 1 || SSL_set1_host(client.ssl, argv[2]) != 1) fail("hostname");
  constexpr unsigned char alpn[] = {7, 'p', 'r', 'o', 'b', 'e', '/', '1'};
  if (SSL_set_alpn_protos(client.ssl, alpn, sizeof(alpn)) != 0) fail("alpn");
  BIO* inside = nullptr;
  if (BIO_new_bio_pair(&inside, kBioCapacity, &client.network, kBioCapacity) != 1) fail("bio-pair");
  SSL_set_bio(client.ssl, inside, inside);
  SSL_set_connect_state(client.ssl);
  const int result = handshake(client);
  if (result != 0) return result;
  const unsigned char* selected = nullptr;
  unsigned selected_size = 0;
  SSL_get0_alpn_selected(client.ssl, &selected, &selected_size);
  if (selected_size != 7 || std::memcmp(selected, "probe/1", 7) != 0) fail("alpn-selection");
  if (SSL_get_verify_result(client.ssl) != X509_V_OK || SSL_version(client.ssl) != version) fail("verified-protocol");
  exchange(client);
  shutdown(client);
  std::fprintf(stderr, "tls-probe success version=%s alpn=probe/1 verify=0 payload=ok close-notify=ok\n", SSL_get_version(client.ssl));
  return 0;
}
}  // namespace

int main(int argc, char** argv) {
  std::setvbuf(stdin, nullptr, _IONBF, 0);
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  std::array<unsigned char, 32> entropy{};
  if (RAND_bytes(entropy.data(), entropy.size()) != 1) fail("entropy");
#if defined(TLS_PROBE_BASELINE)
  std::fprintf(stderr, "tls-probe crypto-only-baseline\n");
  return 0;
#else
  return run(argc, argv);
#endif
}
