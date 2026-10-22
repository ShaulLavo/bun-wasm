
#include <ctype.h>
#include <stdarg.h>
#include <sys/mman.h>
#include <unistd.h>
#define __exception
#define CP_LS 0x2028
#define CP_PS 0x2029
#define JS_ATOM_NULL 0
#define ATOD_ACCEPT_BIN_OCT 1
#define ATOD_ACCEPT_LEGACY_OCTAL 2
#define ATOD_ACCEPT_UNDERSCORES 4
#define ATOD_ACCEPT_SUFFIX 8
#define is_digit(c) ((c) >= '0' && (c) <= '9')
#define JS_VALUE_IS_NAN(x) 0
#define JS_IsException(x) 0
typedef unsigned long JSValue;
typedef unsigned JSAtom;
typedef struct JSContext { void *rt; } JSContext;
typedef struct JSFunctionDef { bool is_strict_mode; } JSFunctionDef;
typedef struct StringBuffer { int dummy; } StringBuffer;
static int string_buffer_init(JSContext *c, StringBuffer *b, int n) { (void)c; (void)b; (void)n; return 0; }
static int string_buffer_putc(StringBuffer *b, uint32_t c) { (void)b; (void)c; return 0; }
static int string_buffer_putc8(StringBuffer *b, uint32_t c) { return string_buffer_putc(b,c); }
static JSValue string_buffer_end(StringBuffer *b) { (void)b; return 0; }
static void string_buffer_free(StringBuffer *b) { (void)b; }
static int js_check_stack_overflow(void *rt, int n) { (void)rt; (void)n; return 0; }
static void JS_ThrowStackOverflow(JSContext *c) { (void)c; abort(); }
static void JS_FreeValue(JSContext *c, JSValue v) { (void)c; (void)v; }
static JSValue js_atof(JSContext *c, const char *p, const char **end, int base, int flags) { (void)c;(void)p;(void)end;(void)base;(void)flags; abort(); }
static int lre_parse_escape(const uint8_t **p, int utf16) { (void)p; (void)utf16; abort(); }
static int lre_js_is_ident_first(int c) { return (c >= 0 && c < 128 && (isalpha(c) || c == '_' || c == '$')); }
static int lre_js_is_ident_next(int c) { return lre_js_is_ident_first(c) || (c >= '0' && c <= '9'); }
static int lre_is_space(int c) { return c == 0xfeff || c == 0xa0 || c == 0x3000; }

__TOKENS__
__TOKEN_STRUCT__
__STATE_STRUCT__
__POSITION_STRUCT__

static int js_parse_error(JSParseState *s, const char *format, ...) { (void)s; (void)format; return -1; }
static void free_token(JSParseState *s, JSToken *t) { (void)s; (void)t; }
static void update_token_ident(JSParseState *s) { (void)s; }
static JSAtom parse_ident(JSParseState *s, const uint8_t **p, bool *esc, int first, bool priv) {
    (void)s; (void)esc; (void)first; (void)priv;
    while (lre_js_is_ident_next(**p)) ++*p;
    return 1;
}
static size_t scanned_bytes;
static uint32_t counted_decode(const uint8_t *p, size_t n, const uint8_t **next) {
    uint32_t c = utf8_decode_len(p, n, next);
    assert(*next > p && *next <= p+n);
    scanned_bytes += *next - p;
    return c;
}
