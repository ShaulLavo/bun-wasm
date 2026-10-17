(module
  (import "env" "refs" (table 2 4 externref))
  (export "refs" (table 0))
  (func (export "get") (param i32) (result externref) (local.get 0) (table.get))
  (func (export "set") (param i32 externref) (local.get 0) (local.get 1) (table.set))
  (func (export "grow") (param externref i32) (result i32) (local.get 0) (local.get 1) (table.grow))
)
