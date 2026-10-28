// Original guest regression, linked against the installed WASI SDK's libc.
// The SDK scan must discover every preopen, then stop normally at EBADF.
#include <string.h>
#include <sys/stat.h>
#include <wasi/api.h>
#include <wasi/libc.h>

int main(void) {
  const char *names[] = {"/", "/bin", "/opt/bun", "/usr/bin"};
  for (unsigned fd = 3; fd < 7; ++fd) {
    __wasi_prestat_t pre;
    char name[32] = {0};
    if (__wasi_fd_prestat_get(fd, &pre) != 0 ||
        pre.tag != __WASI_PREOPENTYPE_DIR ||
        pre.u.dir.pr_name_len >= sizeof(name) ||
        __wasi_fd_prestat_dir_name(fd, (unsigned char *)name,
                                  pre.u.dir.pr_name_len) != 0 ||
        strcmp(name, names[fd - 3]) != 0)
      return 1;
  }
  __wasi_prestat_t end;
  if (__wasi_fd_prestat_get(7, &end) != __WASI_ERRNO_BADF)
    return 2;

  // This is the real library scan, not a locally reimplemented substitute.
  // Unexpected ENOTSUP terminates the guest with EX_OSERR before we return.
  __wasilibc_populate_preopens();
  const char *files[] = {"/bin/bun", "/bin/node",
                         "/opt/bun/quickjs/bin/bun", "/opt/bun/quickjs/bin/node",
                         "/opt/bun/jsc/bin/bun", "/opt/bun/jsc/bin/node"};
  for (unsigned i = 0; i < sizeof(files) / sizeof(files[0]); ++i) {
    struct stat st;
    if (stat(files[i], &st) != 0 || !S_ISREG(st.st_mode))
      return 3;
  }
  return 0;
}
