(module
  (import "e" "g" (global $g (mut f64)))
  (export "g" (global $g))
  (func (export "get") (result f64) global.get $g)
  (func (export "set") (param f64) local.get 0 global.set $g))
