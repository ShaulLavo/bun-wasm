(module
  (import "e" "g" (global $g (mut f32)))
  (export "g" (global $g))
  (func (export "get") (result f32) global.get $g)
  (func (export "set") (param f32) local.get 0 global.set $g))
