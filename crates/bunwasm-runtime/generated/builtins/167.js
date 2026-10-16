// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/node/punycode.ts.
(function (intrinsics) {
"use strict";
var $, maxInt = 2147483647, base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128, delimiter = "-", regexPunycode = /^xn--/, regexNonASCII = /[^\0-\x7F]/, regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, errors = {
    overflow: "Overflow: input needs wider integers to process",
    "not-basic": "Illegal input >= 0x80 (not a basic code point)",
    "invalid-input": "Invalid input"
}, baseMinusTMin = base - tMin, floor = Math.floor, stringFromCharCode = intrinsics.String.fromCharCode;
function error(type) {
    intrinsics.throwRangeError(errors[type]);
}
function mapDomain(domain, callback) {
    let parts = domain.split("@"), result = "";
    if (parts.length > 1)
        result = parts[0] + "@", domain = parts[1];
    domain = domain.replace(regexSeparators, ".");
    let encoded = domain.split(".").map(callback).join(".");
    return result + encoded;
}
function ucs2decode(string) {
    let output = [], counter = 0, length = string.length;
    while (counter < length) {
        let value = string.charCodeAt(counter++);
        if (value >= 55296 && value <= 56319 && counter < length) {
            let extra = string.charCodeAt(counter++);
            if ((extra & 64512) == 56320)
                output.push(((value & 1023) << 10) + (extra & 1023) + 65536);
            else
                output.push(value), counter--;
        }
        else
            output.push(value);
    }
    return output;
}
var ucs2encode = (codePoints) => intrinsics.String.fromCodePoint(...codePoints), basicToDigit = function (codePoint) {
    if (codePoint >= 48 && codePoint < 58)
        return 26 + (codePoint - 48);
    if (codePoint >= 65 && codePoint < 91)
        return codePoint - 65;
    if (codePoint >= 97 && codePoint < 123)
        return codePoint - 97;
    return base;
}, digitToBasic = function (digit, flag) {
    return digit + 22 + 75 * +(digit < 26) - (+(flag != 0) << 5);
}, adapt = function (delta, numPoints, firstTime) {
    let k = 0;
    delta = firstTime ? floor(delta / damp) : delta >> 1, delta += floor(delta / numPoints);
    for (; delta > baseMinusTMin * tMax >> 1; k += base)
        delta = floor(delta / baseMinusTMin);
    return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
}, decode = function (input) {
    let output = [], inputLength = input.length, i = 0, n = initialN, bias = initialBias, basic = input.lastIndexOf(delimiter);
    if (basic < 0)
        basic = 0;
    for (let j = 0; j < basic; ++j) {
        if (input.charCodeAt(j) >= 128)
            error("not-basic");
        output.push(input.charCodeAt(j));
    }
    for (let index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
        let oldi = i;
        for (let w = 1, k = base;; k += base) {
            if (index >= inputLength)
                error("invalid-input");
            let digit = basicToDigit(input.charCodeAt(index++));
            if (digit >= base)
                error("invalid-input");
            if (digit > floor((maxInt - i) / w))
                error("overflow");
            i += digit * w;
            let t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
            if (digit < t)
                break;
            let baseMinusT = base - t;
            if (w > floor(maxInt / baseMinusT))
                error("overflow");
            w *= baseMinusT;
        }
        let out = output.length + 1;
        if (bias = adapt(i - oldi, out, oldi == 0), floor(i / out) > maxInt - n)
            error("overflow");
        n += floor(i / out), i %= out, output.splice(i++, 0, n);
    }
    return intrinsics.String.fromCodePoint(...output);
}, encode = function (input_) {
    let output = [], input = ucs2decode(input_), inputLength = input.length, n = initialN, delta = 0, bias = initialBias;
    for (let currentValue of input)
        if (currentValue < 128)
            output.push(stringFromCharCode(currentValue));
    let basicLength = output.length, handledCPCount = basicLength;
    if (basicLength)
        output.push(delimiter);
    while (handledCPCount < inputLength) {
        let m = maxInt;
        for (let currentValue of input)
            if (currentValue >= n && currentValue < m)
                m = currentValue;
        let handledCPCountPlusOne = handledCPCount + 1;
        if (m - n > floor((maxInt - delta) / handledCPCountPlusOne))
            error("overflow");
        delta += (m - n) * handledCPCountPlusOne, n = m;
        for (let currentValue of input) {
            if (currentValue < n && ++delta > maxInt)
                error("overflow");
            if (currentValue === n) {
                let q = delta;
                for (let k = base;; k += base) {
                    let t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
                    if (q < t)
                        break;
                    let qMinusT = q - t, baseMinusT = base - t;
                    output.push(stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))), q = floor(qMinusT / baseMinusT);
                }
                output.push(stringFromCharCode(digitToBasic(q, 0))), bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength), delta = 0, ++handledCPCount;
            }
        }
        ++delta, ++n;
    }
    return output.join("");
}, toUnicode = function (input) {
    return mapDomain(input, function (string) {
        return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
    });
}, toASCII = function (input) {
    return mapDomain(input, function (string) {
        return regexNonASCII.test(string) ? "xn--" + encode(string) : string;
    });
};
$ = {
    version: "2.1.0",
    ucs2: {
        decode: ucs2decode,
        encode: ucs2encode
    },
    decode,
    encode,
    toASCII,
    toUnicode
};
return $;
})
