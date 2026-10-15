const server = Bun.serve({
  port: 0,
  routes: { "/": (req) => {
    const cookies = req.cookies;
    const before = cookies.get("session");
    cookies.set("session", "updated", { httpOnly: true });
    cookies.delete("__Host-id");
    cookies.set("unicode", "读");
    return Response.json({ before, cookies });
  } },
});
try {
  const response = await fetch(server.url, { headers: { Cookie: "session=original; __Host-id=old; untouched=ok" } });
  console.log(JSON.stringify(await response.json()));
  console.log(JSON.stringify(response.headers.getSetCookie()));
} finally {
  await server.stop(true);
}
