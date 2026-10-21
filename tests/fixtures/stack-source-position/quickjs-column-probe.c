#include "cutils.h"

#include "quickjs-lexer-stubs.h"
#include <quickjs-lexer.h>

#define utf8_decode_len counted_decode
__COLUMN_HELPER__
#undef utf8_decode_len

__PARSE_INIT__
__GET_POSITION__
__SEEK_TOKEN__

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

static void token_position(JSParseState *s, const uint8_t *source)
{
    int column = callee_position(s);
    assert(identifier_position(s) == column);
    assert(constructor_position(s) == column);
    assert(property_position(s) == column);
    printf("%zu %d %zu %zu %d %zu %zu %zu %zu %d %d %d %d %d\n", (size_t)(s->token.ptr - source),
           s->token.line_num, (size_t)(s->token.line_start - source),
           (size_t)(s->line_start - source), column, scanned_bytes,
           (size_t)(s->eol - source), (size_t)(s->mark - source),
           (size_t)(s->buf_ptr - source), s->line_num, s->token.val,
           s->token.col_num, s->last_line_num, s->last_col_num);
}

static void resume_template(JSParseState *s, bool *in_template)
{
    free_token(s, &s->token);
    s->got_lf = false;
    s->last_line_num = s->token.line_num;
    s->last_col_num = s->token.col_num;
    assert(js_parse_template_part(s, s->buf_ptr) == 0);
    *in_template = s->token.u.str.sep != '`';
}

static void scan_tokens(JSParseState *s, const uint8_t *source, JSParsePos *saved,
                        size_t save_index, bool volume)
{
    bool in_template = false;
    size_t count = 0;
    while (true) {
        assert(next_token(s) == 0);
        if (s->token.val == TOK_EOF) break;
        if (s->token.val == '}' && in_template) {
            resume_template(s, &in_template);
            continue;
        }
        if (s->token.val == TOK_TEMPLATE) in_template = s->token.u.str.sep != '`';
        if (saved && count == save_index) js_parse_get_pos(s, saved);
        if (!volume) token_position(s, source);
        if (volume) js_parse_call_column(s);
        if (s->token.val == '/') {
            s->buf_ptr--;
            assert(js_parse_regexp(s) == 0);
        }
        count++;
    }
    if (saved) assert(count > save_index);
    if (volume) printf("%zu %zu\n", count, scanned_bytes);
}

static void scan_error(JSParseState *s)
{
    int result;
    do {
        result = next_token(s);
    } while (!result && s->token.val != TOK_EOF);
    printf("%d %d\n", result, s->token.line_num);
}

static void lexer_positions(const char *source, size_t length, const char *mode,
                            size_t save_index)
{
    JSContext context = {0};
    JSFunctionDef function = {0};
    JSParseState state;
    memset(&state, 0xa5, sizeof(state));
    initialize(&state, source, length);
    state.ctx = &context;
    state.cur_func = &function;
    if (!strcmp(mode, "error")) {
        scan_error(&state);
        return;
    }
    JSParsePos saved;
    bool seek = !strcmp(mode, "seek");
    scan_tokens(&state, (const uint8_t *)source, seek ? &saved : NULL,
                save_index, !strcmp(mode, "volume"));
    if (!seek) return;
    for (int repeat = 0; repeat < 3; repeat++) {
        assert(js_parse_seek_token(&state, &saved) == 0);
        printf("rewound ");
        token_position(&state, (const uint8_t *)source);
        scan_tokens(&state, (const uint8_t *)source, NULL, 0, false);
    }
}

int main(int argc, char **argv)
{
    assert(argc >= 2 && argc <= 4);
    size_t length;
    char *source = read_source(argv[1], &length);
    if (argc >= 3) {
        lexer_positions(source, length, argv[2], argc == 4 ? strtoul(argv[3], NULL, 10) : 0);
        free(source);
        return 0;
    }
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
        state->token.line_start = state->line_start;
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
