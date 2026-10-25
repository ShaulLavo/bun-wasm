import assert from "node:assert/strict";

function Header(name: string, value: string): MethodDecorator {
  return (_target, _key, descriptor) => {
    assert.equal(typeof descriptor.value, "function");
    Object.defineProperty(descriptor.value, name, { value });
  };
}

export const parameters: number[] = [];
function Param(): ParameterDecorator {
  return (_target, _key, index) => { parameters.push(index); };
}
function Controller(): ClassDecorator {
  return target => { assert.equal(typeof target, "function"); };
}

export class Dependency {}

@Controller()
export class ProductController {
  constructor(readonly dependency: Dependency) {}

  @Header("x-product-framework", "nestjs")
  item(@Param() id: number, @Param() tag: string): string {
    return `${id}:${tag}`;
  }
}
