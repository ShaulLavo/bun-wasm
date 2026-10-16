// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/node/querystring.ts.
(function (intrinsics) {
"use strict";
var $, ArrayIsArray = intrinsics.Array.isArray, MathAbs = Math.abs, NumberIsFinite = Number.isFinite, ObjectKeys = Object.keys, StringPrototypeCharCodeAt = intrinsics.String.prototype.charCodeAt, StringPrototypeSlice = intrinsics.String.prototype.slice, StringPrototypeToUpperCase = intrinsics.String.prototype.toUpperCase, NumberPrototypeToString = Number.prototype.toString, __commonJS = (cb, mod = intrinsics.undefined) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports), require_src = __commonJS((exports, module) => {
    function encodeStr(str, noEscapeTable, hexTable) {
        let len = str.length;
        if (len === 0)
            return "";
        let out = "", lastPos = 0, i = 0;
        outer: for (; i < len; i++) {
            let c = intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(str, i);
            while (c < 128) {
                if (noEscapeTable[c] !== 1) {
                    if (lastPos < i)
                        out += intrinsics.uncurry(StringPrototypeSlice, "call")(str, lastPos, i);
                    lastPos = i + 1, out += hexTable[c];
                }
                if (++i === len)
                    break outer;
                c = intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(str, i);
            }
            if (lastPos < i)
                out += intrinsics.uncurry(StringPrototypeSlice, "call")(str, lastPos, i);
            if (c < 2048) {
                lastPos = i + 1, out += hexTable[192 | c >> 6] + hexTable[128 | c & 63];
                continue;
            }
            if (c < 55296 || c >= 57344) {
                lastPos = i + 1, out += hexTable[224 | c >> 12] + hexTable[128 | c >> 6 & 63] + hexTable[128 | c & 63];
                continue;
            }
            if (++i, i >= len)
                throw intrinsics.makeErrorWithCode(133);
            let c2 = intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(str, i) & 1023;
            lastPos = i + 1, c = 65536 + ((c & 1023) << 10 | c2), out += hexTable[240 | c >> 18] + hexTable[128 | c >> 12 & 63] + hexTable[128 | c >> 6 & 63] + hexTable[128 | c & 63];
        }
        if (lastPos === 0)
            return str;
        if (lastPos < len)
            return out + intrinsics.uncurry(StringPrototypeSlice, "call")(str, lastPos);
        return out;
    }
    let hexTable = new intrinsics.Array(256);
    for (let i = 0; i < 256; ++i)
        hexTable[i] = "%" + intrinsics.uncurry(StringPrototypeToUpperCase, "call")((i < 16 ? "0" : "") + intrinsics.uncurry(NumberPrototypeToString, "call")(i, 16));
    let isHexTable = new Int8Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
    ]), QueryString = module.exports = {
        unescapeBuffer,
        unescape: qsUnescape,
        escape: qsEscape,
        stringify,
        encode: stringify,
        parse,
        decode: parse
    }, unhexTable = new Int8Array([
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        10,
        11,
        12,
        13,
        14,
        15,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        10,
        11,
        12,
        13,
        14,
        15,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1
    ]);
    function unescapeBuffer(s, decodeSpaces) {
        let out = intrinsics.Buffer.allocUnsafe(s.length), index = 0, outIndex = 0, currentChar, nextChar, hexHigh, hexLow, maxLength = s.length - 2, hasHex = !1;
        while (index < s.length) {
            if (currentChar = intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(s, index), currentChar === 43 && decodeSpaces) {
                out[outIndex++] = 32, index++;
                continue;
            }
            if (currentChar === 37 && index < maxLength)
                if (currentChar = intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(s, ++index), hexHigh = unhexTable[currentChar], !(hexHigh >= 0)) {
                    out[outIndex++] = 37;
                    continue;
                }
                else if (nextChar = intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(s, ++index), hexLow = unhexTable[nextChar], !(hexLow >= 0))
                    out[outIndex++] = 37, index--;
                else
                    hasHex = !0, currentChar = hexHigh * 16 + hexLow;
            out[outIndex++] = currentChar, index++;
        }
        return hasHex ? out.slice(0, outIndex) : out;
    }
    function qsUnescape(s, decodeSpaces) {
        try {
            return decodeURIComponent(s);
        }
        catch {
            return QueryString.unescapeBuffer(s, decodeSpaces).toString();
        }
    }
    let noEscape = new Int8Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
        0,
        0,
        1,
        1,
        0,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        0,
        0,
        0,
        1,
        0
    ]);
    function qsEscape(str) {
        if (typeof str !== "string")
            if (typeof str === "object")
                str = intrinsics.String(str);
            else
                str += "";
        return encodeStr(str, noEscape, hexTable);
    }
    function stringifyPrimitive(v) {
        if (typeof v === "string")
            return v;
        if (typeof v === "number" && NumberIsFinite(v))
            return "" + v;
        if (typeof v === "bigint")
            return "" + v;
        if (typeof v === "boolean")
            return v ? "true" : "false";
        return "";
    }
    function encodeStringified(v, encode) {
        if (typeof v === "string")
            return v.length ? encode(v) : "";
        if (typeof v === "number" && NumberIsFinite(v))
            return MathAbs(v) < 1000000000000000000000 ? "" + v : encode("" + v);
        if (typeof v === "bigint")
            return "" + v;
        if (typeof v === "boolean")
            return v ? "true" : "false";
        return "";
    }
    function encodeStringifiedCustom(v, encode) {
        return encode(stringifyPrimitive(v));
    }
    function stringify(obj, sep, eq, options) {
        sep ||= "&", eq ||= "=";
        let encode = QueryString.escape;
        if (options) {
            let encodeURIComponentOption = options.encodeURIComponent;
            if (typeof encodeURIComponentOption === "function")
                encode = encodeURIComponentOption;
        }
        let convert = encode === qsEscape ? encodeStringified : encodeStringifiedCustom;
        if (obj !== null && typeof obj === "object") {
            let keys = ObjectKeys(obj), len = keys.length, fields = "";
            for (let i = 0; i < len; ++i) {
                let k = keys[i], v = obj[k], ks = convert(k, encode);
                if (ks += eq, ArrayIsArray(v)) {
                    let vlen = v.length;
                    if (vlen === 0)
                        continue;
                    if (fields)
                        fields += sep;
                    for (let j = 0; j < vlen; ++j) {
                        if (j)
                            fields += sep;
                        fields += ks, fields += convert(v[j], encode);
                    }
                }
                else {
                    if (fields)
                        fields += sep;
                    fields += ks, fields += convert(v, encode);
                }
            }
            return fields;
        }
        return "";
    }
    function charCodes(str) {
        if (str.length === 0)
            return [];
        if (str.length === 1)
            return [intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(str, 0)];
        let ret = new intrinsics.Array(str.length);
        for (let i = 0; i < str.length; ++i)
            ret[i] = intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(str, i);
        return ret;
    }
    let defSepCodes = [38], defEqCodes = [61];
    function addKeyVal(obj, key, value, keyEncoded, valEncoded, decode) {
        if (key.length > 0 && keyEncoded)
            key = decodeStr(key, decode);
        if (value.length > 0 && valEncoded)
            value = decodeStr(value, decode);
        if (obj[key] === intrinsics.undefined)
            obj[key] = value;
        else {
            let curValue = obj[key];
            if (curValue.pop)
                curValue[curValue.length] = value;
            else
                obj[key] = [curValue, value];
        }
    }
    function parse(qs, sep, eq, options) {
        let obj = Object.create(null);
        if (typeof qs !== "string" || qs.length === 0)
            return obj;
        let sepCodes = !sep ? defSepCodes : charCodes(intrinsics.String(sep)), eqCodes = !eq ? defEqCodes : charCodes(intrinsics.String(eq)), sepLen = sepCodes.length, eqLen = eqCodes.length, pairs = 1000, decode = QueryString.unescape;
        if (options) {
            let { maxKeys, decodeURIComponent: decodeURIComponentOption } = options;
            if (typeof maxKeys === "number")
                pairs = maxKeys > 0 ? maxKeys : -1;
            if (typeof decodeURIComponentOption === "function")
                decode = decodeURIComponentOption;
        }
        let customDecode = decode !== qsUnescape, lastPos = 0, sepIdx = 0, eqIdx = 0, key = "", value = "", keyEncoded = customDecode, valEncoded = customDecode, plusChar = customDecode ? "%20" : " ", encodeCheck = 0;
        for (let i = 0; i < qs.length; ++i) {
            let code = intrinsics.uncurry(StringPrototypeCharCodeAt, "call")(qs, i);
            if (code === sepCodes[sepIdx]) {
                if (++sepIdx === sepLen) {
                    let end = i - sepIdx + 1;
                    if (eqIdx < eqLen) {
                        if (lastPos < end)
                            key += intrinsics.uncurry(StringPrototypeSlice, "call")(qs, lastPos, end);
                        else if (key.length === 0) {
                            if (--pairs === 0)
                                return obj;
                            lastPos = i + 1, sepIdx = eqIdx = 0;
                            continue;
                        }
                    }
                    else if (lastPos < end)
                        value += intrinsics.uncurry(StringPrototypeSlice, "call")(qs, lastPos, end);
                    if (addKeyVal(obj, key, value, keyEncoded, valEncoded, decode), --pairs === 0)
                        return obj;
                    keyEncoded = valEncoded = customDecode, key = value = "", encodeCheck = 0, lastPos = i + 1, sepIdx = eqIdx = 0;
                }
            }
            else {
                if (sepIdx = 0, eqIdx < eqLen) {
                    if (code === eqCodes[eqIdx]) {
                        if (++eqIdx === eqLen) {
                            let end = i - eqIdx + 1;
                            if (lastPos < end)
                                key += intrinsics.uncurry(StringPrototypeSlice, "call")(qs, lastPos, end);
                            encodeCheck = 0, lastPos = i + 1;
                        }
                        continue;
                    }
                    else if (eqIdx = 0, !keyEncoded) {
                        if (code === 37) {
                            encodeCheck = 1;
                            continue;
                        }
                        else if (encodeCheck > 0)
                            if (isHexTable[code] === 1) {
                                if (++encodeCheck === 3)
                                    keyEncoded = !0;
                                continue;
                            }
                            else
                                encodeCheck = 0;
                    }
                    if (code === 43) {
                        if (lastPos < i)
                            key += intrinsics.uncurry(StringPrototypeSlice, "call")(qs, lastPos, i);
                        key += plusChar, lastPos = i + 1;
                        continue;
                    }
                }
                if (code === 43) {
                    if (lastPos < i)
                        value += intrinsics.uncurry(StringPrototypeSlice, "call")(qs, lastPos, i);
                    value += plusChar, lastPos = i + 1;
                }
                else if (!valEncoded) {
                    if (code === 37)
                        encodeCheck = 1;
                    else if (encodeCheck > 0)
                        if (isHexTable[code] === 1) {
                            if (++encodeCheck === 3)
                                valEncoded = !0;
                        }
                        else
                            encodeCheck = 0;
                }
            }
        }
        if (lastPos < qs.length) {
            if (eqIdx < eqLen)
                key += intrinsics.uncurry(StringPrototypeSlice, "call")(qs, lastPos);
            else if (sepIdx < sepLen)
                value += intrinsics.uncurry(StringPrototypeSlice, "call")(qs, lastPos);
        }
        else if (eqIdx === 0 && key.length === 0)
            return obj;
        return addKeyVal(obj, key, value, keyEncoded, valEncoded, decode), obj;
    }
    function decodeStr(s, decoder) {
        try {
            return decoder(s);
        }
        catch {
            return QueryString.unescape(s, !0);
        }
    }
});
$ = require_src();
return $;
})
