import { readFileSync } from "node:fs";

export const imageVersion = "ubuntu-24.04-node26.13.1-v1";
export const workspace = "/work/w/bun-wasm/bun-wasm";
export const cacheRoot = "/work/ci-runner/bun-wasm/cache";

export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cloudConfig(publicKey: string, prepare: boolean, mountCache = true): string {
  const configuration = {
    hostname: "bun-wasm-ci",
    ssh_pwauth: false,
    disable_root: true,
    users: [{ name: "runner", shell: "/bin/bash", sudo: "ALL=(ALL) NOPASSWD:ALL", lock_passwd: true, ssh_authorized_keys: [publicKey.trim()] }],
    package_update: prepare,
    packages: prepare ? ["sudo", "util-linux", "openssh-server", "curl", "xz-utils", "ca-certificates", "git", "build-essential", "cmake", "ninja-build", "nasm", "clang", "libclang-dev", "pkg-config", "ruby", "gperf", "bison", "llvm", "autoconf2.13", "python3-dev", "python3-venv", "python3-packaging", "python3-setuptools", "libffi-dev", "zlib1g-dev", "zstd", "libicu74"] : [],
    write_files: [
      { path: "/etc/environment", content: `ImageVersion=${imageVersion}\nRUNNER_TEMP=/work/t\nTMPDIR=/work/t\n` },
      { path: "/opt/bun-wasm-ci/guard-hook.ts", owner: "root:root", permissions: "0444", content: readFileSync(new URL("./guard-hook.ts", import.meta.url), "utf8") },
      { path: "/opt/bun-wasm-ci/guard-hook.sh", owner: "root:root", permissions: "0555", content: "#!/bin/bash\nset +x\nunset BASH_ENV ENV NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH\nexec /opt/node/bin/node /opt/bun-wasm-ci/guard-hook.ts\n" },
      { path: "/opt/bun-wasm-ci/runner-guest.ts", owner: "root:root", permissions: "0444", content: readFileSync(new URL("./runner-guest.ts", import.meta.url), "utf8") },
      { path: "/opt/bun-wasm-ci/cache.ts", owner: "root:root", permissions: "0444", content: readFileSync(new URL("./cache.ts", import.meta.url), "utf8") },
      { path: "/opt/bun-wasm-ci/host.ts", owner: "root:root", permissions: "0444", content: readFileSync(new URL("./host.ts", import.meta.url), "utf8") },
    ],
    runcmd: preparation(prepare).concat([
      ["bash", "-euc", `mkdir -p ${workspace} /work/w/_temp /work/t /work/runner /etc/bun-wasm-ci ${cacheRoot}; mount --bind /work/t /work/w/_temp; if ! blkid /dev/disk/by-id/virtio-bunwasmcache >/dev/null; then mkfs.ext4 -q -L BUNWASMCACHE /dev/disk/by-id/virtio-bunwasmcache; fi; ${mountCache ? `mount /dev/disk/by-id/virtio-bunwasmcache ${cacheRoot}; chown runner:runner ${cacheRoot};` : ""} chown -R runner:runner /work/w /work/t /work/runner; chmod 700 /work/t; touch /var/lib/bun-wasm-ci-ready`],
    ]),
  };
  return `#cloud-config\n${JSON.stringify(configuration)}\n`;
}

function preparation(prepare: boolean): string[][] {
  if (!prepare) return [];
  const checksum = "5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864";
  return [["bash", "-euc", `mkdir -p /work/provision /opt/node /opt/actions-runner; curl --fail --silent --show-error --location --connect-timeout 20 --max-time 180 --retry 2 -o /work/provision/node.tar.xz https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz; echo '${checksum}  /work/provision/node.tar.xz' | sha256sum --check --status; tar -xJf /work/provision/node.tar.xz -C /opt/node --strip-components=1; ln -sf /opt/node/bin/node /usr/local/bin/node; ln -sf /opt/node/bin/npm /usr/local/bin/npm; ln -sf /opt/node/bin/npx /usr/local/bin/npx; rm /work/provision/node.tar.xz; test "$(node --version)" = v26.13.1; curl --fail --silent --show-error --location --connect-timeout 20 --max-time 300 --retry 2 -o /work/provision/runner.tar.gz https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-x64-2.338.2.tar.gz; echo 'baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40  /work/provision/runner.tar.gz' | sha256sum --check --status; tar -xzf /work/provision/runner.tar.gz -C /opt/actions-runner; rm /work/provision/runner.tar.gz; test "$(/opt/actions-runner/bin/Runner.Listener --version)" = 2.338.2`]];
}

export function guestCommand(argv: readonly string[]): string {
  return `cd ${workspace} && exec env ImageVersion=${quote(imageVersion)} GITHUB_WORKSPACE=${workspace} RUNNER_TEMP=/work/t TMPDIR=/work/t BUN_WASM_PC_CACHE_ROOT=${cacheRoot} ${argv.map(quote).join(" ")}`;
}
