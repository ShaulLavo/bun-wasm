(function () {
  "use strict";
  return function removePairs(list: [string, string][], name: string, value?: string, start = 0) {
    let write = start;
    for (let read = start; read < list.length; read++) {
      const pair = list[read];
      if (pair[0] === name && (value === undefined || pair[1] === value)) continue;
      list[write++] = pair;
    }
    list.length = write;
  };
})
