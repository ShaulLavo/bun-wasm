#include "cutils.h"

typedef void JSContext;
typedef struct JSToken {
    int val, line_num, col_num;
    const uint8_t *ptr;
} JSToken;
typedef struct JSParseState {
    JSContext *ctx;
    const char *filename;
    int line_num, col_num;
    const uint8_t *buf_start, *buf_ptr, *buf_end;
    JSToken token;
__CURSOR_FIELDS__
} JSParseState;

static size_t scanned_bytes;
static inline uint32_t counted_decode(const uint8_t *p, size_t length,
                                     const uint8_t **next)
{
    uint32_t result = utf8_decode_len(p, length, next);
    scanned_bytes += *next - p;
    return result;
}

#define utf8_decode_len counted_decode
__COLUMN_HELPER__
#undef utf8_decode_len

__PARSE_INIT__

static int callee_position(JSParseState *s)
{
    return __CALLEE_COLUMN__;
}
static int identifier_position(JSParseState *s)
{
    return __IDENTIFIER_COLUMN__;
}
static int constructor_position(JSParseState *s)
{
    return __CONSTRUCTOR_COLUMN__;
}
static int property_position(JSParseState *s)
{
    return __PROPERTY_COLUMN__;
}

static char *read_source(const char *path, size_t *length)
{
    FILE *file = fopen(path, "rb");
    assert(file);
    assert(fseek(file, 0, SEEK_END) == 0);
    long size = ftell(file);
    assert(size >= 0);
    rewind(file);
    char *source = malloc((size_t)size + 1);
    assert(source);
    assert(fread(source, 1, (size_t)size, file) == (size_t)size);
    source[size] = '\0';
    assert(fclose(file) == 0);
    *length = (size_t)size;
    return source;
}

static void initialize(JSParseState *state, const char *source, size_t length)
{
    js_parse_init(NULL, state, source, length, "probe.js", 1);
__CURSOR_INIT_ASSERTS__
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    size_t length;
    char *source = read_source(argv[1], &length);
    JSParseState states[2];
    memset(states, 0xa5, sizeof(states));
    initialize(&states[0], source, length);
    initialize(&states[1], source, length);
    int parser, reset;
    size_t line, token;
    while (scanf("%d %d %zu %zu", &parser, &reset, &line, &token) == 4) {
        assert(parser >= 0 && parser < 2 && line <= token && token <= length);
        JSParseState *state = &states[parser];
        if (reset) initialize(state, source, length);
        state->line_start = (const uint8_t *)source + line;
        state->token.ptr = (const uint8_t *)source + token;
        int callee = callee_position(state);
        int identifier = identifier_position(state);
        int constructor = constructor_position(state);
        int property = property_position(state);
        printf("%d %d %d %d %zu\n", callee, identifier, constructor, property, scanned_bytes);
    }
    assert(feof(stdin));
    free(source);
    return 0;
}
