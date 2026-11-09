// Generated from @emnapi/wasi-threads 2.2.0 src/proxy.ts; MIT license in wasi-threads-LICENSE.txt.
const kIsProxy = Symbol('kIsProxy');
function createInstanceProxy(instance, memory) {
    if (instance[kIsProxy])
        return instance;
    const originalExports = instance.exports;
    const createHandler = function (target) {
        const handlers = [
            'apply',
            'construct',
            'defineProperty',
            'deleteProperty',
            'get',
            'getOwnPropertyDescriptor',
            'getPrototypeOf',
            'has',
            'isExtensible',
            'ownKeys',
            'preventExtensions',
            'set',
            'setPrototypeOf'
        ];
        const handler = {};
        for (let i = 0; i < handlers.length; i++) {
            const name = handlers[i];
            handler[name] = function () {
                const args = Array.prototype.slice.call(arguments, 1);
                args.unshift(target);
                return Reflect[name].apply(Reflect, args);
            };
        }
        return handler;
    };
    const handler = createHandler(originalExports);
    const _initialize = () => { };
    const _start = () => 0;
    handler.get = function (_target, p, receiver) {
        if (p === 'memory') {
            return (typeof memory === 'function' ? memory() : memory) ?? Reflect.get(originalExports, p, receiver);
        }
        if (p === '_initialize') {
            return p in originalExports ? _initialize : undefined;
        }
        if (p === '_start') {
            return p in originalExports ? _start : undefined;
        }
        return Reflect.get(originalExports, p, receiver);
    };
    handler.has = function (_target, p) {
        if (p === 'memory')
            return true;
        return Reflect.has(originalExports, p);
    };
    const exportsProxy = new Proxy(Object.create(null), handler);
    return new Proxy(instance, {
        get(target, p, receiver) {
            if (p === 'exports') {
                return exportsProxy;
            }
            if (p === kIsProxy) {
                return true;
            }
            return Reflect.get(target, p, receiver);
        }
    });
}

export { createInstanceProxy };
