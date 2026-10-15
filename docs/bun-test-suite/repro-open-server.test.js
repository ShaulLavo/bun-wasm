test("an open server must not keep bun test alive after its report", () => {
  Bun.serve({ port: 0, fetch() { return new Response("ok"); } });
});
