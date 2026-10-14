/* Implementations for the declarations in wasi-compat.h (temporary files). */
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void fill_template(char* t)
{
    static unsigned long counter;
    size_t n = strlen(t);
    unsigned long v = (unsigned long)time(0) ^ (++counter * 2654435761u);
    for (size_t i = n; i > 0 && t[i - 1] == 'X'; --i) {
        t[i - 1] = "abcdefghijklmnopqrstuvwxyz0123456789"[v % 36];
        v = v / 36 + counter * 7919;
    }
}

int mkostemp(char* tmpl, int flags)
{
    char saved[4096];
    strncpy(saved, tmpl, sizeof saved - 1);
    for (int tries = 0; tries < 100; ++tries) {
        strcpy(tmpl, saved);
        fill_template(tmpl);
        int fd = open(tmpl, O_RDWR | O_CREAT | O_EXCL | (flags & ~O_ACCMODE), 0600);
        if (fd >= 0 || errno != EEXIST)
            return fd;
    }
    return -1;
}

char* mkdtemp(char* tmpl)
{
    char saved[4096];
    strncpy(saved, tmpl, sizeof saved - 1);
    for (int tries = 0; tries < 100; ++tries) {
        strcpy(tmpl, saved);
        fill_template(tmpl);
        if (!mkdir(tmpl, 0700))
            return tmpl;
        if (errno != EEXIST)
            return 0;
    }
    return 0;
}
