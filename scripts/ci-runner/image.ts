import { link } from "node:fs/promises";

export const playwrightVersion = "1.64.1";
export const playwrightIntegrity = "sha512-BC4s8y6SEVA6Q1rSxZTto8hI1KUI3xXlHGZgvGqP4IqPdI/a6FX9H29IDNz7vKo9l21b6LfYosScPL6M3xxyDQ==";
export const imageVersion = `ubuntu-24.04-node26.13.1-playwright${playwrightVersion}-v2`;
export const baseImage = `ci-base-v2-playwright-${playwrightVersion}.qcow2`;
export const imageIdentityPath = "/etc/bun-wasm-ci-image";

export function validatePreparationTarget(target: string | undefined): void {
  if (target !== baseImage) throw new Error(`Preparation requires explicit target ${baseImage}`);
}

export function validatePreparationIdle(controller: string, vm: string, jobs: number): void {
  const idle = (state: string) => state === "inactive" || state === "failed" || state === "";
  if (!idle(controller) || !idle(vm) || jobs !== 0) throw new Error("Image preparation requires a stopped controller, idle VM service and empty jobs directory");
}

export async function publishPreparedImage(candidate: string, target: string): Promise<void> {
  await link(candidate, target);
}

export function browserPreparation(): string[] {
  const checksum = Buffer.from(playwrightIntegrity.slice("sha512-".length), "base64").toString("hex");
  return ["bash", "-euc", `
    source /etc/os-release
    test "$ID-$VERSION_ID-$(uname -m)" = ubuntu-24.04-x86_64
    test "$(/opt/node/bin/node --version)" = v26.13.1
    test "$(/opt/actions-runner/bin/Runner.Listener --version)" = 2.338.2
    test ! -e ${imageIdentityPath}
    mkdir -p /work/provision/browser-deps
    trap 'rm -rf -- /work/provision/browser-deps' EXIT
    curl --fail --silent --show-error --location --connect-timeout 20 --max-time 180 --retry 2 --retry-max-time 400 --max-filesize 16777216 -o /work/provision/browser-deps/core.tgz https://registry.npmjs.org/playwright-core/-/playwright-core-${playwrightVersion}.tgz
    echo '${checksum}  /work/provision/browser-deps/core.tgz' | sha512sum --check --status
    tar -xzf /work/provision/browser-deps/core.tgz -C /work/provision/browser-deps
    test "$(/opt/node/bin/node -p "require('/work/provision/browser-deps/package/package.json').version")" = ${playwrightVersion}
    sed -i 's|http://archive\\.ubuntu\\.com/ubuntu|https://archive.ubuntu.com/ubuntu|g; s|http://security\\.ubuntu\\.com/ubuntu|https://security.ubuntu.com/ubuntu|g' /etc/apt/sources.list.d/ubuntu.sources
    export DEBIAN_FRONTEND=noninteractive
    timeout --signal=TERM --kill-after=10s 15m /opt/node/bin/node /work/provision/browser-deps/package/cli.js install-deps chromium firefox webkit
    /opt/node/bin/node /work/provision/browser-deps/package/cli.js install-deps --dry-run chromium firefox webkit
    dpkg-query -W > /opt/bun-wasm-ci/image-packages.tsv
    apt-get clean
    printf '%s\\n' '${imageVersion}' > ${imageIdentityPath}
    chmod 0444 ${imageIdentityPath} /opt/bun-wasm-ci/image-packages.tsv
  `];
}
