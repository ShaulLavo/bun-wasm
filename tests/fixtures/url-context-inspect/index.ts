import util from "node:util";

// util.inspect(url, { showHidden: true }) adds Node's URLContext: ada's
// component offsets into the href.
const urls = [
  "foo:/.//?x",
  "https://user:pass@example.com:8080/a/b?q=1#frag",
  "https://user@example.com/",
  "https://:secret@example.com/",
  "http://example.com:80/",
  "https://example.com/path?#",
  "https://example.com?",
  "file:///tmp/a.txt",
  "ws://h:1/",
  "wss://h/",
  "ftp://h/x",
  "mailto:someone@example.com",
  "blob:https://example.com/id",
  "web+demo:/a/b",
  "data:,hi#x",
];

for (const href of urls) {
  console.log(util.inspect(new URL(href), { showHidden: true }));
}

// Without showHidden the context stays hidden.
console.log(util.inspect(new URL("https://example.com/?a=1")));
console.log(Bun.inspect(new URL("https://example.com/")));
