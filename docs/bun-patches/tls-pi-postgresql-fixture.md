# Pi PostgreSQL TLS qualification fixture

Original repository adapter, not copied from Bun, Node, WebKit or PostgreSQL source.
The selected official PostgreSQL image is immutable by arm64 manifest digest in
`tests/servers/tls.ts`. There is no vendored upstream patch.

- `tests/servers/tls.ts` runs disposable PostgreSQL under rootless Podman on Pi,
  retains the native certificate-failure observer, and owns run-local secrets,
  container, volume and home/tmp cleanup. The image is parent-prepared and held.
- `web/tests/tls-relay-services.ts` owns the existing PC Pi lock, private remote
  protocol, resource ledger and physical post-stop absence checks.
- `scripts/tls-qualification.ts` inventories the actual Pi tools and Podman state,
  not a host PostgreSQL installation or a remote `/work` mount.

Only the Pi Tailscale socket is published. Rootless forwarding can rewrite peer
addresses, so all container TCP authentication requires TLS and SCRAM. The browser
client's literal `ssl: true`, default verification, same-backend `pg_stat_ssl` and
independent failure controls are unchanged. The consumer never builds or repairs
sealed inputs, pulls images, installs host software, or changes the C1 interface.
