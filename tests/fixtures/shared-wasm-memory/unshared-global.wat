(module
  (import "env" "l" (global $l i64))
  (func (export "l") (result i64) global.get $l))
