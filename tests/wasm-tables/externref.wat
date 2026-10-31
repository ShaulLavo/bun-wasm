(module
  (table (export "references") 2 4 externref)
  (func (export "echo") (param externref) (result externref) local.get 0))
